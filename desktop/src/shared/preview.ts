/**
 * What a preview is doing, as both sides see it.
 *
 * Lives here rather than in `main/preview/server.ts` for the reason `plan.ts` does: main
 * produces this and the renderer draws it, and a second declaration is how the two drift. The
 * first version of this file did not exist and `host.d.ts` reached across into the main module
 * for the type — which typechecked, and coupled the renderer's program to a module that imports
 * `node:child_process`.
 */

/**
 * Where a preview has got to.
 *
 * `starting` and `ready` are separate because they are separately wrong: a server that started
 * and never printed an address is a different problem from one that printed an address nothing
 * answers on, and a single "loading" would hide both behind a spinner.
 *
 * There is deliberately no `stopped`. Stopping removes the entry, so the next read is `idle` —
 * the same state as never having started, which is exactly what it is.
 */
export type PreviewStatus = "idle" | "starting" | "ready" | "failed";

export interface PreviewState {
  status: PreviewStatus;
  /** Loopback only, and only once something answered on it. */
  url: string | null;
  /** What was run, so the UI can say so without guessing. */
  label: string | null;
  /**
   * The server's own output — the thing to read when it will not start.
   *
   * The first 256KB, not the last: a server that will not start says why in its opening lines,
   * and one that has been up for an hour has a tail that is just request logs.
   */
  log: string;
  /** Set when the process ended by itself. Null while running. */
  exitCode: number | null;
  /** Why it failed, in one line, when it did. */
  error: string | null;
}
