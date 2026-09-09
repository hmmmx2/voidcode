/**
 * How a child process gets a shell and an environment.
 *
 * Lifted out of `pty.ts` when `agent/run-command.ts` needed the same two answers. Copying them
 * would have been three lines and a permanent liability: `ELECTRON_RUN_AS_NODE` has to be
 * stripped in both places, and a second copy is a second thing to forget the next time
 * something needs stripping.
 */
import { TELEMETRY_VARS } from "../agent/telemetry.js";

/**
 * The user's shell, chosen by main.
 *
 * `ComSpec` and `SHELL` are the OS's own answer to "what shell does this user have". Falling
 * back to `/bin/sh` rather than bash: POSIX guarantees it exists, bash does not.
 */
export function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

/**
 * The environment a child starts in.
 *
 * Inherited, minus the variables that would make the child think it is Electron. Leaving
 * `ELECTRON_RUN_AS_NODE` in place makes `node` inside the terminal behave strangely, and it is
 * the kind of thing that produces a bug report about the user's own toolchain.
 *
 * The LangSmith keys go too, from `telemetry.ts`'s own list rather than a copy of it — the
 * library accepts both a `LANGSMITH_` and a legacy `LANGCHAIN_` spelling of each, and a
 * hand-written subset here would silently stop covering whichever one gets added next.
 *
 * `sealTelemetry` unsets them in *this* process so an inherited variable cannot turn on run
 * upload. A child that inherited them would defeat that by being a second process with the
 * tracer enabled — and under Auto mode the children are commands the model chose, which is
 * exactly where quiet upload would be least welcome.
 */
export function sanitisedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  for (const name of TELEMETRY_VARS) delete env[name];
  return env;
}
