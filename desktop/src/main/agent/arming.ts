/**
 * Whether a window has been armed for Auto mode.
 *
 * Auto is the only mode that writes to disk without a per-batch dialog, so it needs its own
 * consent — and this is it. One `Map`, keyed the way `workspace.ts` keys its project roots:
 * by `WebContents.id`, because "armed" is a fact about one window and its open folder, not
 * about the application.
 *
 * ## Three properties, and each is load-bearing
 *
 * **Never persisted.** Not to the database, not to `userData`, not to the session. An armed
 * state that survived a restart would be a standing grant nobody remembers making — the user
 * would open the app tomorrow and the assistant would already be able to write to their
 * project unattended. Consent that outlives the memory of giving it is not consent.
 *
 * **Bound to a project root, not just to a window.** Arming names a folder. Opening a
 * different project in the same window drops the arming, because the thing the user agreed to
 * was "this assistant may change *this* code", and a window is a container, not a subject.
 *
 * **Granted through a window main owns.** The approval window is the second party — the
 * renderer that asked has no handle to it, and the decision is checked against both the sender
 * and a per-request token. `arm()` never resolves true without a click on it.
 *
 * What arming does NOT bound is worth stating in the same breath, because the rest of Auto's
 * safety rests on knowing it: a command can do anything the user can do, anywhere on the
 * machine and over the network. `cwd` is pinned to the project and the checkpoint can undo the
 * run's *file* writes, but `npm install`, a database migration and `git push` are all outside
 * both.
 */
import { BrowserWindow, type WebContents } from "electron";
import { askApproval } from "./approval-window.js";

interface Armed {
  root: string;
  armedAt: number;
}

const armed = new Map<number, Armed>();

/**
 * Ask the user, and record the answer.
 *
 * Every path that does not end in a click on main's own window returns false. There is no
 * argument, environment variable or stored preference that arms a window.
 */
export async function armAuto(sender: WebContents, root: string): Promise<boolean> {
  const approved = await askApproval({
    parent: BrowserWindow.fromWebContents(sender),
    subject: { kind: "armAuto", projectRoot: root },
  });
  if (!approved) return false;

  /**
   * The id is captured before the listener is registered.
   *
   * `sender.id` throws once the WebContents is destroyed, so reading it inside the handler is
   * a crash at teardown — the exact bug this codebase has already fixed twice in registries
   * shaped like this one.
   */
  const id = sender.id;
  armed.set(id, { root, armedAt: Date.now() });
  sender.once("destroyed", () => armed.delete(id));
  return true;
}

/** Turn it off. Always available, and never asks. */
export function disarmAuto(sender: WebContents): void {
  armed.delete(sender.id);
}

/**
 * Is this window armed for this project?
 *
 * The root is compared, not merely presence. A window armed for one folder and then pointed at
 * another is not armed: the grant named a project.
 */
export function isArmed(sender: WebContents, root: string): boolean {
  const entry = armed.get(sender.id);
  return entry !== undefined && entry.root === root;
}

/** For the status line and the panel. Null when this window is not armed. */
export function armedState(sender: WebContents): { root: string; armedAt: number } | null {
  return armed.get(sender.id) ?? null;
}

/** Test seam. Production has no path that arms a window without the approval window. */
export function __setArmedForTest(
  sender: WebContents,
  value: { root: string } | undefined
): void {
  if (value === undefined) armed.delete(sender.id);
  else armed.set(sender.id, { root: value.root, armedAt: Date.now() });
}

/** Test seam: forget everything, so one test cannot arm another. */
export function __resetArming(): void {
  armed.clear();
}
