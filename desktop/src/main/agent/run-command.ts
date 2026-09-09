/**
 * Running one command and reporting what happened.
 *
 * **Not the PTY.** `terminal/pty.ts` exists and is the wrong tool: a pseudo-terminal is an
 * interactive byte stream with no notion of "this command finished, here is its output and its
 * exit code". Driving a shell by writing bytes and guessing when a prompt reappears is how that
 * goes wrong, and an agent needs request/response.
 *
 * Reached only through the `run_command` tool, which only Auto mode binds. It landed one
 * commit before anything could call it, so the capability could be read and judged on its own
 * before the consent and undo that bound it existed.
 *
 * **This is the one tool that leaves the app's file confinement behind.** Every other tool
 * resolves paths through `workspace.ts`; a shell command does not, and `dispatch.ts`'s header
 * says so where a reader will meet it.
 *
 * ## The decisions that matter
 *
 * **stdin is closed.** The single most important difference from the PTY. `git commit` opening
 * an editor, `npm login` prompting, `apt` asking y/n: with a tty attached those block until the
 * timeout with nobody to answer. At EOF they fail immediately — which is a *result* the model
 * can read and correct, rather than two minutes of nothing.
 *
 * **stdout and stderr stay separate.** A tty merges them. "It printed to stderr and still exited
 * 0" is common, and it is the difference between a warning and a failure.
 *
 * **The shell is named here and nowhere else.** `proc/spawn.ts` takes a file and an argument
 * vector and never a command string, which is what makes it safe to reach from a path the
 * renderer triggers. This module is the one place that hands it a shell and a `-c`, because this
 * is the one caller that is *meant* to run arbitrary text — under Auto mode, behind consent, with
 * a checkpoint to revert to.
 *
 * The process-tree kill, the output cap and the close/exit handling all moved to `proc/spawn.ts`
 * when the linter needed them. Their reasoning moved with them; none of it was specific to
 * running an agent's command.
 */
import { runProcess, MAX_STREAM_BYTES, killAllProcesses } from "../proc/spawn.js";
import { defaultShell, sanitisedEnv } from "../terminal/shell.js";

/** Long enough for a test suite, short enough that a hung command is not the whole run. */
export const MAX_COMMAND_MS = 120_000;

export { MAX_STREAM_BYTES };

export interface CommandResult {
  command: string;
  /** Null when the process was killed — by the timeout, or by the run being cancelled. */
  exitCode: number | null;
  /** The signal that ended it, when one did. Distinguishes a timeout kill from a clean exit. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Either stream hit its cap, so what is above is a prefix and not the whole output. */
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Every command still running, so quitting does not leave one behind.
 *
 * Now a alias for the shared registry — the linter's processes need killing on quit for the same
 * reason, and two registries would mean `quit.ts` had to know about both.
 */
export function killAllCommands(): void {
  killAllProcesses();
}

/**
 * Run `command` in `projectRoot` and resolve with what it did.
 *
 * **A non-zero exit is not an error.** It resolves like any other result, because "the build
 * failed and here is why" is the answer the model needs in order to fix it — the same rule
 * `dispatch.ts` follows for tool calls. The only rejections are things that mean the command
 * never ran at all, and there are none: a shell that cannot be spawned comes back as a result
 * with the reason in `stderr`.
 *
 * `signal` is the run's: closing the port aborts the run, which kills the tree. There is no
 * separate stop path to forget.
 */
export async function runCommand(
  projectRoot: string,
  command: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  const shell = defaultShell();
  // `/d /s /c` on cmd.exe: no AutoRun from the registry, strip the outer quotes, then the
  // command. Without `/d`, a per-user AutoRun key runs before every single command.
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

  const result = await runProcess({
    file: shell,
    args,
    cwd: projectRoot,
    timeoutMs: MAX_COMMAND_MS,
    env: sanitisedEnv(),
    ...(signal === undefined ? {} : { signal }),
  });

  return {
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    // A spawn failure is appended rather than replacing, matching what the inline version did:
    // whatever the shell managed to say before dying is still worth reading.
    stderr:
      result.spawnError === null
        ? result.stderr
        : `${result.stderr}
${result.spawnError}`.trimStart(),
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
}
