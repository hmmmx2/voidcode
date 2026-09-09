/**
 * Running a program and reporting what it did.
 *
 * Lifted out of `agent/run-command.ts`, which had all of this and one caller. The linter needs
 * the same machinery — capped output, a timeout, a kill that takes the whole process tree — and
 * `run-command.ts`'s header says loudly that it is reached only through the `run_command` tool
 * that only Auto mode binds. Importing it from a path the renderer triggers on every save would
 * have made that claim false, and the claim is the point of it.
 *
 * **This module takes a file and an argument vector, never a command string.** `spawn(file, args)`
 * with no shell means nothing here can be injected into; a caller that genuinely wants a shell
 * passes the shell as `file` and `["-c", …]` as `args`, which is what `runCommand` does, in one
 * place, with the reasoning attached.
 *
 * ## The decisions worth keeping
 *
 * **stdin is closed.** `git commit` opening an editor, `npm login` prompting: with a tty attached
 * those block until the timeout with nobody to answer. At EOF they fail immediately, which is a
 * *result* rather than two minutes of nothing.
 *
 * **stdout and stderr stay separate.** A tty merges them. "It printed to stderr and still exited
 * 0" is common, and it is the difference between a warning and a failure.
 *
 * **The process TREE is killed, not the process.** `sh -c "npm test"` makes the shell the child
 * and the runner the grandchild, so killing the child leaves the runner holding a port after the
 * app quits. This is the part most likely to be got wrong quietly, because the happy path looks
 * identical either way.
 *
 * **Output is capped by not appending, never by destroying the pipe.** Past the cap the data is
 * dropped and the stream keeps being read. Destroying it instead gives the child `EPIPE` on its
 * next write, which kills it — losing the exit code the whole call exists to report.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Per stream, counted in bytes as they arrive rather than characters at the end. */
export const MAX_STREAM_BYTES = 256 * 1024;

export interface ProcessResult {
  /** Null when the process was killed — by the timeout, or by the caller's signal. */
  exitCode: number | null;
  /** The signal that ended it, when one did. Distinguishes a timeout kill from a clean exit. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Either stream hit its cap, so what is above is a prefix and not the whole output. */
  truncated: boolean;
  timedOut: boolean;
  /**
   * The process never started at all — the binary is missing, most often.
   *
   * Distinct from a non-zero exit, and the distinction is load-bearing for the linter: "ruff is
   * not installed" and "ruff found nothing" have to be different answers.
   */
  spawnError: string | null;
}

/** Collects up to a cap and then keeps reading without keeping. */
export class Capped {
  private readonly parts: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.size >= MAX_STREAM_BYTES) {
      // Deliberately still consuming the chunk and throwing it away: the stream must stay
      // flowing or the child blocks on a full pipe buffer and never exits.
      this.truncated = true;
      return;
    }
    const room = MAX_STREAM_BYTES - this.size;
    if (chunk.length > room) {
      this.parts.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.parts.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.parts).toString("utf8");
  }
}

/**
 * Kill a child and everything it started.
 *
 * Two implementations because the platforms genuinely differ, and the naive version is wrong
 * on both:
 *
 *   - **POSIX**: `detached: true` makes the child a process-group leader, so `process.kill(-pid)`
 *     signals the whole group. Without `detached` there is no group to signal and the
 *     grandchildren survive. `SIGTERM` first so a well-behaved process can clean up, `SIGKILL`
 *     after a grace period for one that will not.
 *   - **Windows**: there is no signalable process group. `child.kill()` terminates `cmd.exe` and
 *     orphans everything under it, which is how a test runner keeps a port after the app is
 *     gone. `taskkill /T /F` walks the tree.
 *
 * Every failure here is swallowed. The process being already dead is the common case — it is a
 * race with normal exit, not an error — and a throw from a kill path would surface as an
 * unhandled rejection in main, which is a modal dialog.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    /**
     * `taskkill` ALONE, and `child.kill()` only if it fails.
     *
     * Calling both was the first version and it was wrong in a way that took a probe to see:
     * `child.kill()` terminates `cmd.exe` within a millisecond, so `taskkill` — a separate
     * process that has to start — arrives to find its target already gone and reports
     * `ERROR: The process "N" not found`, exit 128. The tree is never walked.
     *
     * The grandchildren then outlive the shell **holding the inherited stdout and stderr
     * handles open**, which has a second consequence: `close` never fires, because it waits
     * for the stdio to be closed and nothing will close them. The call hangs forever.
     *
     * With taskkill on its own it reports terminating each grandchild and then the shell, and
     * `close` arrives normally.
     */
    let killed = false;
    try {
      // Spawned rather than exec'd, so nothing here is a shell string the command could be
      // smuggled into.
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      tk.on("exit", (code) => {
        killed = code === 0;
        // 128 is "no such process", which means it exited on its own between the decision to
        // kill and the attempt. Nothing left to do either way.
        if (!killed && code !== 128) {
          try {
            child.kill();
          } catch {
            // Ignored — see above.
          }
        }
      });
      tk.on("error", () => {
        // taskkill missing from PATH. Fall back to the single-process kill, which is worse
        // but better than nothing.
        try {
          child.kill();
        } catch {
          // Ignored.
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        // Ignored.
      }
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // No such group, most likely because it already exited.
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignored.
    }
  }

  // A process that ignores SIGTERM gets three seconds, then goes regardless.
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ignored.
    }
  }, 3_000);
  escalate.unref();
  child.once("exit", () => clearTimeout(escalate));
}

/**
 * Every process still running, so quitting does not leave one behind.
 *
 * `killAllTerminals` exists for the same reason and this is its counterpart: a run's port
 * closing kills its tree, but an app torn down without that handshake completing — which
 * `quit.ts` documents as the normal case on shutdown — would otherwise orphan whatever was
 * started.
 */
const live = new Set<ChildProcess>();

export function killAllProcesses(): void {
  for (const child of [...live]) killTree(child);
  live.clear();
}

export interface RunProcessOptions {
  /** The executable. Never a command string — see the header. */
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run it, and resolve with what happened.
 *
 * **A non-zero exit is not an error.** It resolves like any other result, because "it failed and
 * here is why" is the answer the caller needs — a linter reporting problems exits non-zero by
 * design. The promise never rejects; a process that could not start resolves with `spawnError`.
 */
export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const { file, args, cwd, timeoutMs, env, signal } = options;

  return await new Promise<ProcessResult>((resolve) => {
    const out = new Capped();
    const err = new Capped();
    let timedOut = false;
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        cwd,
        ...(env === undefined ? {} : { env }),
        windowsHide: true,
        // Closed stdin, piped output. See the header — this is what turns an interactive
        // prompt into an immediate, readable failure.
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX only: makes the child a group leader so the whole tree can be signalled.
        // On Windows `detached` opens a console window instead, which is not what is wanted.
        detached: process.platform !== "win32",
      });
    } catch (spawnError) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        spawnError: String(spawnError),
      });
      return;
    }

    const finish = (
      exitCode: number | null,
      exitSignal: string | null,
      spawnError: string | null
    ): void => {
      if (settled) return;
      settled = true;
      live.delete(child);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: out.text(),
        stderr: err.text(),
        truncated: out.truncated || err.truncated,
        timedOut,
        spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();

    live.add(child);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    // `error` fires when the process could not be spawned or killed. It is terminal and
    // `close` may never follow, so it settles. ENOENT arrives here, which is how "not
    // installed" is told apart from "found nothing".
    child.on("error", (e) => {
      finish(null, null, String(e));
    });

    /**
     * `close` normally, `exit` plus a grace period as the backstop.
     *
     * `exit` fires when the process ends; `close` fires when its stdio have *also* been fully
     * consumed. `close` is the semantically correct one to resolve on, so it is the primary
     * path.
     *
     * The backstop is here because **`close` can genuinely never arrive**. Any surviving
     * descendant that inherited the pipes holds them open, and the promise then hangs for the
     * lifetime of the app. That is not hypothetical — it is precisely what the first version
     * of the Windows kill produced, and it presented as a run that never finished rather than
     * as an error, which is the worst way for it to present.
     */
    child.on("close", (code, sig) => finish(code, sig, null));

    child.on("exit", (code, sig) => {
      const grace = setTimeout(() => finish(code, sig, null), 2_000);
      grace.unref();
    });
  });
}
