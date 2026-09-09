/**
 * Quitting.
 *
 * There was no `before-quit` and no `will-quit` at all. Every save opportunity came from the
 * per-window `close` handshake in `windows.ts`, which is fine when a user closes windows one
 * at a time and useless when they quit the app: on macOS ⌘Q, and on every platform a system
 * shutdown, windows are torn down without that handshake completing. `killAllTerminals` was
 * exported with no caller, and `closeDatabase` was called only from tests.
 *
 * The shape mirrors the per-window guard deliberately, including its hardest-won detail: a
 * grace period, from the same constant, so a renderer that has hung cannot make the app
 * unquittable. Getting that wrong is the difference between a pause and the task manager.
 */
import { app, BrowserWindow } from "electron";
import { CLOSE_GRACE_MS, quittingRef } from "./windows.js";
import { killAllTerminals } from "./terminal/pty.js";
import { killAllCommands } from "./agent/run-command.js";
import { killAllPreviews } from "./preview/server.js";
import { closeDatabase } from "./store/db.js";
import { stopTelemetry } from "./hardware/telemetry.js";
import { shutdownSandbox } from "./exec/host.js";

/** Just enough of a window to decide whether it still owes an answer. */
export interface PendingWindow {
  id: number;
  destroyed: boolean;
}

/**
 * Which windows have not finished saving.
 *
 * Pure, and separated for that reason: this is the whole decision, and the alternative — a
 * loop over live `BrowserWindow`s — cannot be tested without an Electron runtime. A destroyed
 * window has answered by definition; it is gone, and its renderer either saved or was already
 * beyond saving.
 */
export function stillPending(windows: readonly PendingWindow[]): number[] {
  return windows.filter((w) => !w.destroyed).map((w) => w.id);
}

let quitting = false;

/**
 * Ask every window to save, wait, then let the quit proceed.
 *
 * `preventDefault` exactly once, guarded by `quitting`: the second `app.quit()` below must be
 * allowed through, and without the flag this would intercept its own retry and never exit.
 */
export function installQuitHandlers(): void {
  app.on("before-quit", (event) => {
    if (quitting) return;

    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;

    quitting = true;
    // Tell `allowClose` this is a quit, not a deliberate close of each window: otherwise
    // every window would be marked un-restorable on the way out and the next launch would
    // open nothing.
    quittingRef.value = true;
    event.preventDefault();

    for (const window of windows) {
      if (window.webContents.isDestroyed()) continue;
      // The same intent the per-window guard sends, so the renderer needs no second handler
      // and there is one definition of "deal with unsaved work".
      window.webContents.send("shell:command", { command: "window.confirmClose" });
    }

    const deadline = Date.now() + CLOSE_GRACE_MS;
    const poll = setInterval(() => {
      const outstanding = stillPending(
        BrowserWindow.getAllWindows().map((w) => ({ id: w.id, destroyed: w.isDestroyed() }))
      );
      if (outstanding.length > 0 && Date.now() < deadline) return;

      clearInterval(poll);
      app.quit();
    }, 100);
  });

  /**
   * Last, and after the windows are gone.
   *
   * PTYs are reaped per-WebContents on `destroyed` today, which covers a window closing but
   * not a shell spawned by a window that never emitted it. `closeDatabase` matters less —
   * WAL plus process exit is safe — but calling it is cheap and makes the shutdown explicit
   * rather than relying on the OS.
   */
  app.on("will-quit", () => {
    killAllTerminals();
    // The interval is unref'd so it cannot hold the process open, but a poller that keeps
    // spawning nvidia-smi through a shutdown is noise in the logs at best.
    stopTelemetry();
    // The agent's commands too. A run's port closing kills its tree, but a shutdown that tears
    // windows down without that handshake — which this file documents as the normal case —
    // would otherwise leave whatever Auto started running after the app is gone.
    killAllCommands();
    // And the dev servers. These are the most visible leak of the three: a preview still holding
    // port 3000 after VoidCode has exited is something the user finds out about from the *next*
    // tool that cannot bind it.
    killAllPreviews();
    // And the Pyodide interpreter. `exec/host.ts` exported `shutdownSandbox` with a comment saying
    // it was "called on app quit so a live interpreter does not outlive the window" — and nothing
    // called it, so a utilityProcess that had graded anything outlived the app. Exactly the bug this
    // file's own header records fixing for `killAllTerminals`, in a sixth subsystem, two years of
    // comments later. `recycle()` kills rather than respawns, so this is safe here.
    shutdownSandbox();
    closeDatabase();
  });
}
