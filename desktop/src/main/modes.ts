/**
 * Window mode registry.
 *
 * Spec §2.2: mode is a property of the *window*, fixed when it opens and never
 * toggled at runtime. Study and Build have different privilege envelopes, so a
 * mutable mode would be a privilege-escalation primitive — flip to Build, call
 * `fs:read`, flip back. There is deliberately no setter beyond `assignMode`,
 * which refuses to overwrite an existing entry.
 *
 * The registry is keyed by `WebContents.id` rather than holding the WebContents
 * itself so a destroyed window cannot be resurrected through this map. Ids are
 * monotonically increasing within a session and never reused, so a late IPC
 * message from a dead window resolves to `undefined` rather than to whatever
 * window happens to occupy that slot next.
 */
import type { WebContents } from "electron";

export const WINDOW_MODES = ["study", "build"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];

/** The switch the preload reads to decide which namespaces to expose at all. */
export const MODE_ARGV_PREFIX = "--voidcode-mode=";

const modeByWebContentsId = new Map<number, WindowMode>();

/**
 * Record a window's mode. Called exactly once, by the window factory, before
 * the renderer has had any chance to run.
 *
 * Throws on a second call for the same WebContents: that would mean two code
 * paths disagree about what a window is, and guessing which one is right is
 * strictly worse than failing loudly during development.
 */
export function assignMode(webContents: WebContents, mode: WindowMode): void {
  const existing = modeByWebContentsId.get(webContents.id);
  if (existing !== undefined) {
    throw new Error(
      `WebContents ${webContents.id} already has mode "${existing}"; refusing to reassign to "${mode}"`
    );
  }

  // Captured before the listener. Reading a property off a destroyed WebContents throws,
  // and in main that is a modal dialog rather than a swallowed warning.
  const id = webContents.id;
  modeByWebContentsId.set(id, mode);
  webContents.once("destroyed", () => {
    modeByWebContentsId.delete(id);
  });
}

/** `undefined` for an unregistered or destroyed window — callers must treat that as deny. */
export function modeOf(webContents: WebContents): WindowMode | undefined {
  return modeByWebContentsId.get(webContents.id);
}

/** Test seam. Not exported through the app's public surface. */
export function __resetModeRegistry(): void {
  modeByWebContentsId.clear();
}
