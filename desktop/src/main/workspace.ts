/**
 * The Build Mode workspace: one project root **per window**, chosen by the user.
 *
 * Spec §2.11: every file the agent touches must resolve inside this root. The root
 * itself can only be set from a native directory dialog — there is no IPC channel
 * that accepts a root path from the renderer, because that would let a compromised
 * renderer (or a model following injected instructions in a paper) simply widen
 * its own sandbox to `/`.
 *
 * PER WINDOW, NOT PER PROCESS. This was a single module-level `let`, which meant
 * File ▸ New Window followed by Open Folder silently repointed the *first* window's
 * root as well: window A would keep showing project A's tree while its `fs:read`
 * resolved against project B. Nothing crashed and nothing looked wrong — you got
 * the wrong file, or a `NoWorkspaceError` for a file plainly visible in the tree.
 *
 * Keyed by `WebContents.id`, and the reasoning is `modes.ts`'s verbatim: holding the
 * WebContents itself would let a destroyed window be resurrected through this map,
 * and ids are monotonic within a session and never reused, so a late IPC message
 * from a dead window resolves to `undefined` rather than to whatever window happens
 * to occupy that slot next. `undefined` means deny, exactly as it does for mode.
 */
import fs from "node:fs";
import { dialog } from "electron";
import type { WebContents } from "electron";
import { resolveWithin, resolveWithinAllowingNew } from "./paths.js";
import { rememberProject, recentProjects } from "./store/recents.js";

const rootByWebContentsId = new Map<number, string>();

export class NoWorkspaceError extends Error {
  constructor() {
    super("No project is open");
    this.name = "NoWorkspaceError";
  }
}

/**
 * The root as the filesystem spells it, which is the only spelling that can be compared with one.
 *
 * EVERY PATH THE USER SEES WAS COMPUTED AGAINST THE WRONG SPELLING UNTIL THIS EXISTED. The root was
 * stored exactly as the native dialog returned it, while every absolute it was compared against had
 * been through `realpath`. Containment was never at risk — `resolveWithin` resolves both sides on
 * every call, so they agree whatever spelling they agree on. What nothing canonicalised was the root
 * used for DISPLAY: `path.relative` between a raw root and a resolved absolute walks up out of one
 * spelling of a directory and back down into the other, so `main.py` was reported as
 * `../../../../../private/var/folders/…/main.py`. It is not cosmetic — `displayPath` is the key
 * `forgetFile` prunes the memory index by, the string the approval window shows before a write is
 * authorised, and what the agent's diff panel renders.
 *
 * It needed a symlinked or short-named parent to show, which is why it survived every local run:
 * this machine's `os.tmpdir()` is already canonical, and a project under `/Users/me/…` or
 * `C:\Users\me\…` is too. The CI runners are not — macOS resolves `/var/folders` to
 * `/private/var/folders`, and the Windows runner's `runneradmin` home has the 8.3 alias
 * `RUNNER~1`. Eleven tests failed there and none here.
 *
 * `fsops.ts`'s `realRootFor` carries a note claiming its `fs.realpath` makes `C:\PROGRA~1` and
 * `C:\Program Files` the same string. IT DOES NOT — measured below — and that note has been
 * corrected. The claim was harmless there because both sides of its comparison go through the same
 * non-expanding call; it was not harmless as a description, because it is exactly the sentence that
 * made the first version of this function use plain `realpathSync` and ship half a fix.
 *
 * Canonicalised HERE rather than at each reader, because a reader that forgot would be a silent
 * reintroduction of exactly this bug, and there is no assertion that could notice one call site
 * out of eight. Sync on purpose: binding happens once when a project is opened, `__setProjectRoot`
 * is a sync seam, and making this async would make every caller of it async for one `stat`.
 *
 * A root that cannot be resolved is stored as given. That is the pre-existing behaviour and the
 * right one — it is a directory the user just picked in a dialog, so the failure is a race
 * (unmounted, renamed) and `resolveWithin` will refuse it on the next call with a real error,
 * which is a better answer than throwing out of the dialog handler.
 */
function canonical(root: string): string {
  try {
    // `.native`, NOT plain `realpathSync`, AND THE DIFFERENCE IS NOT COSMETIC. The first version of
    // this used `fs.realpathSync`, which resolves symlinks and junctions — enough for macOS's
    // `/var` -> `/private/var` — and leaves a Windows 8.3 short name EXACTLY AS GIVEN. Measured on
    // this machine: `realpathSync("C:\PROGRA~1")` returns `C:\PROGRA~1`, while
    // `realpathSync.native("C:\PROGRA~1")` returns `C:\Program Files`. So the fix went out, macOS
    // went green, and nine tests kept failing on the Windows runner with `RUNNER~1` still in the
    // path. `.native` goes through the OS resolver and answers both cases with one call.
    return fs.realpathSync.native(root);
  } catch {
    return root;
  }
}

/**
 * Bind a root to a window and arrange for it to be forgotten when that window dies.
 *
 * The `destroyed` listener is registered per assignment rather than once per window
 * because a window may open several projects over its life; `once` on an already-
 * registered emitter is cheap and the map delete is idempotent.
 */
function bindRoot(sender: WebContents, root: string): void {
  // Captured now, not read in the callback: property access on a destroyed WebContents
  // throws, and an uncaught throw in main surfaces as a modal error dialog.
  const id = sender.id;
  rootByWebContentsId.set(id, canonical(root));
  sender.once("destroyed", () => {
    rootByWebContentsId.delete(id);
  });
}

/**
 * Ask the user for a project directory.
 *
 * The dialog *is* the authorisation. The user picking a folder is the grant, which
 * is why this takes no path argument and why the result is not overridable.
 */
export async function openProjectViaDialog(sender: WebContents): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: "Open project",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || result.filePaths[0] === undefined) return undefined;

  const root = result.filePaths[0];
  bindRoot(sender, root);
  rememberProject(root);
  return root;
}

/**
 * Open a folder the user picked earlier, from File > Open Recent.
 *
 * SEPARATE FROM THE DIALOG PATH, AND ONLY ACCEPTS A REMEMBERED PATH. `openProjectViaDialog`
 * takes no argument because the dialog *is* the authorisation; this one takes a path, so it
 * needs its own answer to "who authorised this". The answer is that the path must already be
 * in the recents table — which it can only be because the user chose it in that dialog once.
 * A renderer cannot widen its own sandbox by inventing a path here.
 *
 * Note that recents are deliberately process-wide, not per window: the list is a record of
 * what the *user* has granted, and a grant does not expire because a different window is
 * asking. What is per window is which of those grants is currently in effect.
 */
export function openRecentProject(sender: WebContents, candidate: string): string | undefined {
  const known = recentProjects().some((entry) => entry.path === candidate);
  if (!known) return undefined;

  bindRoot(sender, candidate);
  rememberProject(candidate);
  return candidate;
}

export function currentProjectRoot(sender: WebContents): string | undefined {
  return rootByWebContentsId.get(sender.id);
}

/** Resolve a renderer-supplied path for reading. Throws if it escapes the root. */
export async function readWorkspaceFile(sender: WebContents, candidate: string): Promise<string> {
  const root = rootByWebContentsId.get(sender.id);
  if (root === undefined) throw new NoWorkspaceError();
  return resolveWithin(root, candidate);
}

/** Resolve for writing — the target need not exist yet, its ancestors are still checked. */
export async function writeWorkspacePath(sender: WebContents, candidate: string): Promise<string> {
  const root = rootByWebContentsId.get(sender.id);
  if (root === undefined) throw new NoWorkspaceError();
  return resolveWithinAllowingNew(root, candidate);
}

/**
 * Test seam.
 *
 * Takes the same `WebContents` shape the real callers pass, so a test that binds a root is
 * exercising the real keying rather than a parallel path that could drift from it.
 */
export function __setProjectRoot(sender: WebContents, root: string | undefined): void {
  // Through `bindRoot`, not straight into the map: a seam that skipped the `destroyed`
  // registration would be a second, subtly different way to bind a root, and any test of
  // lifetime would be asserting against behaviour the real path does not share.
  if (root === undefined) rootByWebContentsId.delete(sender.id);
  else bindRoot(sender, root);
}

/** Test seam. Clears every binding, for suites that share the module. */
export function __resetWorkspaceRoots(): void {
  rootByWebContentsId.clear();
}
