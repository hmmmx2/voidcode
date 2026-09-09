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
  rootByWebContentsId.set(id, root);
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
