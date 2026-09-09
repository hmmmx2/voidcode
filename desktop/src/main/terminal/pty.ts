/**
 * The terminal.
 *
 * `pty:spawn` has been declared in the contract since Phase 1 with no handler, and the
 * Terminal menu carried two hardcoded `enabled: false` placeholders saying so. This is the
 * handler.
 *
 * WHY A FORK, AND WHY A BETA. `store/db.ts` rejects native modules by name — "every
 * contributor needs a working C++ toolchain, and every release needs a prebuild matrix across
 * three platforms and two architectures" — which is why this app uses `node:sqlite` rather
 * than `better-sqlite3`. Upstream `node-pty` is exactly that: node-gyp, plus `@electron/rebuild`
 * because Electron's ABI differs from Node's, plus four native builds per release.
 *
 * `@lydell/node-pty` is N-API, so one prebuilt binary works across Node *and* Electron
 * versions with no rebuild step, and it ships all six platform binaries as optional
 * dependencies. The objection in `db.ts` is satisfied on its own terms rather than argued
 * away. It has only ever published betas, which is a real cost and the reason the version is
 * pinned exactly.
 *
 * THE RENDERER NEVER NAMES THE COMMAND, and that is the whole security design. The contract
 * takes `{cols, rows}` and nothing else — no shell, no cwd, no env. Main chooses the shell,
 * sets the working directory to the project root, and requires a project to be open, so the
 * folder-picker consent has already happened. A PTY is arbitrary code execution by design;
 * the containment argument is not "it cannot run things", it is that a renderer which could
 * name the command would have code execution outside the sandbox with no dialog at all —
 * a larger hole than anything in `fs:*`.
 */
import { defaultShell, sanitisedEnv } from "./shell.js";
import path from "node:path";
import { currentProjectRoot } from "../workspace.js";

/** Matches the subset of `@lydell/node-pty` used here, so the lazy require stays typed. */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv; name: string }
  ): PtyProcess;
}

export class TerminalUnavailableError extends Error {
  constructor(reason: string) {
    super(`Terminal is unavailable: ${reason}`);
    this.name = "TerminalUnavailableError";
  }
}

/**
 * More than this per window and something is wrong.
 *
 * The only denial-of-service surface here: without a cap, a compromised renderer forks shells
 * until the machine stops. Eight is more terminals than anyone opens deliberately.
 */
const MAX_TERMINALS_PER_WINDOW = 8;

const live = new Map<Electron.WebContents, Set<PtyProcess>>();

/**
 * Loaded on first use, not at module scope.
 *
 * Two reasons. The unit tests import main modules under vitest, where a native binary for the
 * *Electron* ABI has no business being loaded — and where the optional prebuild may not be
 * installed at all. And a missing prebuild should disable the Terminal menu, not stop the app
 * from starting.
 */
let ptyModule: PtyModule | undefined;
let ptyLoadError: string | undefined;

function loadPty(): PtyModule {
  if (ptyModule !== undefined) return ptyModule;
  if (ptyLoadError !== undefined) throw new TerminalUnavailableError(ptyLoadError);

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require("@lydell/node-pty") as PtyModule;
    return ptyModule;
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    throw new TerminalUnavailableError(ptyLoadError);
  }
}

/** Is a terminal possible at all? Used to decide whether the menu items may be enabled. */
export function isTerminalAvailable(): boolean {
  try {
    loadPty();
    return true;
  } catch {
    return false;
  }
}

export interface SpawnedTerminal {
  pid: number;
  shell: string;
  child: PtyProcess;
}

export function spawnTerminal(
  sender: Electron.WebContents,
  cols: number,
  rows: number
): SpawnedTerminal {
  // This window's project, not "the" project: with two Build windows open, a terminal must
  // start in the folder its own window is showing.
  const root = currentProjectRoot(sender);
  // A terminal with no project would open in whatever the process cwd happens to be — for a
  // packaged app, somewhere inside the installation directory. Requiring a project also means
  // the user has already granted this folder through a native dialog.
  if (root === undefined) throw new TerminalUnavailableError("open a project first");

  const existing = live.get(sender);
  if ((existing?.size ?? 0) >= MAX_TERMINALS_PER_WINDOW) {
    throw new TerminalUnavailableError("too many terminals are already open");
  }

  const pty = loadPty();
  const shell = defaultShell();
  const child = pty.spawn(shell, [], {
    cwd: root,
    cols,
    rows,
    env: sanitisedEnv(),
    // xterm-color rather than the default, so tools that check TERM emit colour.
    name: "xterm-color",
  });

  const set = existing ?? new Set<PtyProcess>();
  set.add(child);
  live.set(sender, set);

  return { pid: child.pid, shell: path.basename(shell), child };
}

export function forgetTerminal(sender: Electron.WebContents, child: PtyProcess): void {
  const set = live.get(sender);
  if (set === undefined) return;
  set.delete(child);
  if (set.size === 0) live.delete(sender);
}

/** Kill everything a window owns. Called when its `WebContents` goes away, and on quit. */
export function killTerminalsFor(sender: Electron.WebContents): void {
  for (const child of live.get(sender) ?? []) {
    try {
      child.kill();
    } catch {
      // Already gone. Nothing to do and nothing worth reporting.
    }
  }
  live.delete(sender);
}

export function killAllTerminals(): void {
  for (const sender of [...live.keys()]) killTerminalsFor(sender);
}

export type { PtyProcess };
