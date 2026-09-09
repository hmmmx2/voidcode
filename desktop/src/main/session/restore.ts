/**
 * Bringing the last session back.
 *
 * Every launch used to create exactly one window, at a hard-coded size, wherever the OS put
 * it, with no project and no tabs. Quitting with three projects open cost three folder-pickers
 * and a dozen file clicks to get back to work.
 *
 * The interesting decisions here are both about *refusing* to restore something:
 *
 *   - A remembered `projectRoot` is re-granted only if it is still in `recent_projects`. That
 *     table is the record of what the user has actually consented to, and a session row is
 *     not a second, weaker source of that consent — if they cleared the folder from their
 *     recents, it should not come back because a window happened to have it open.
 *   - A path arriving in a second instance's argv is honoured only under the same rule. It is
 *     not the same authorisation as a folder dialog: `voidcode.exe C:\\somewhere` from a
 *     shortcut, or from anything that can spawn a process, would otherwise widen the sandbox
 *     with no prompt at all.
 */
import { BrowserWindow, screen } from "electron";
import { createWindow } from "../windows.js";
import { restorableWindows, clampToDisplays, dropWindow } from "../store/session.js";
import { recentProjects } from "../store/recents.js";
import { openRecentProject } from "../workspace.js";

/**
 * Reopen last session's windows. Returns how many opened.
 *
 * Zero means there was nothing to restore — a first run, or a session where every window was
 * closed deliberately — and the caller opens a fresh window instead.
 */
export function restoreSession(): number {
  const remembered = restorableWindows();
  if (remembered.length === 0) return 0;

  const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds }));
  let opened = 0;

  for (const stored of remembered) {
    try {
      const window = createWindow({
        mode: stored.mode,
        route: stored.route,
        sessionId: stored.id,
        // Clamped before the window is built, not after: a window created off-screen flashes
        // there first, and on some platforms cannot be moved back until it has been shown.
        bounds: clampToDisplays(stored.bounds, displays),
      });

      if (stored.maximised) window.maximize();
      if (stored.fullScreen) window.setFullScreen(true);

      // The grant is re-checked, not assumed. `openRecentProject` refuses anything not in the
      // recents table, which is the same rule File ▸ Open Recent goes through.
      if (stored.projectRoot !== null) {
        // Re-granted in main only. The renderer asks for it on mount via `fs:currentProject`
        // rather than being told: a push here has to land after React has attached its
        // listener, and `did-finish-load` fires before the effects run — so the window came
        // back with the root granted and an empty sidebar. A pull has no such race.
        openRecentProject(window.webContents, stored.projectRoot);
      }

      opened += 1;
    } catch {
      // A window that cannot be recreated — a mode that no longer exists, a route that is
      // gone — is dropped rather than retried on every launch. One bad row must not make the
      // app unable to start.
      dropWindow(stored.id);
    }
  }

  return opened;
}

/**
 * A folder named on a second instance's command line.
 *
 * Returns it only if the user has already granted it through a dialog at some point. Anything
 * else returns `undefined` and the caller just focuses the existing window — which is what the
 * app did for every argv before this, and remains the safe default.
 */
export function projectFromArgv(argv: readonly string[]): string | undefined {
  const known = new Set(recentProjects().map((p) => p.path));
  // Last match wins, matching how a shell would treat a trailing path argument. Flags are
  // ignored outright rather than parsed — there is no option this needs to understand.
  return [...argv].reverse().find((arg) => !arg.startsWith("-") && known.has(arg));
}

/** Focus an existing window, opening the named project in it when one was supplied. */
export function handleSecondInstance(argv: readonly string[]): void {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing === undefined) return;

  if (existing.isMinimized()) existing.restore();
  existing.focus();

  const project = projectFromArgv(argv);
  if (project === undefined) return;

  const root = openRecentProject(existing.webContents, project);
  if (root === undefined) return;

  // The renderer owns the tree and the tabs, so it is told to open the folder rather than
  // having main reach into it — the same intent File ▸ Open Recent already sends.
  existing.webContents.send("shell:command", { command: "file.openRecent", path: root });
}
