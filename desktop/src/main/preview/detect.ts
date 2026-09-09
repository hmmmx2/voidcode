/**
 * Deciding what a project's dev server is.
 *
 * **The renderer never names the command, and this is the reason this module exists.** A
 * `preview:start` channel that took a command string would be arbitrary code execution with a
 * friendly name on it: `run_command` is bound in exactly one mode, behind an explicit Auto-mode
 * grant, precisely so that "the app runs what it is told to run" is a decision the user makes
 * once and can see. A preview channel taking a command would route straight past that, from a
 * renderer, with no gate at all. So main reads the project's own `package.json` and decides;
 * the renderer asks for *a preview*, not for a process.
 *
 * That is the same argument `ipc/contract.ts` makes about `vision:locate` having no prompt
 * field, and `workspace.ts` makes about the project root coming from the sender rather than the
 * payload. The pattern is always: the renderer names the intent, main names the mechanism.
 *
 * **This still runs the project's code, and that is inherent rather than overlooked.** A dev
 * script can be anything; opening a folder does not mean consenting to execute it. What follows
 * from that is a UI decision rather than one this module can make — the command is returned so
 * it can be *shown* before it is run, and nothing here starts anything.
 *
 * Pure: it takes a parsed `package.json` and the names of the lockfiles present, so the choice
 * can be tested against real project shapes without a filesystem.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PreviewCommand {
  /** The executable, resolved for the platform. Never a command string — see `proc/spawn.ts`. */
  file: string;
  args: string[];
  /** The script this runs, so the UI can say what it is about to do. */
  script: string;
  /** What to show the user, e.g. `pnpm run dev`. Display only; never parsed or executed. */
  label: string;
}

/**
 * Which script to run, in order of preference.
 *
 * `dev` first because it is what the word means everywhere: a server that watches and reloads.
 * `start` second, and it is the ambiguous one — in Vite and CRA it is a dev server, in Next it
 * serves a production build and fails without one — so it is a fallback rather than a peer.
 * `serve` last, for projects that spell it that way.
 *
 * **`preview` is deliberately not here**, despite the name matching this feature's. Vite's
 * `preview` serves `dist/`, so on a project that has not been built it exits immediately with an
 * error about a missing directory — which would read as "the preview is broken" rather than as
 * "there is nothing built yet". A feature whose most confusing failure is its own name is worth
 * one fewer fallback.
 */
const SCRIPT_PREFERENCE = ["dev", "start", "serve"] as const;

/**
 * The package manager, from whichever lockfile is present.
 *
 * Order matters when several are: a repo with both `pnpm-lock.yaml` and `package-lock.json`
 * — which happens when someone runs the wrong install once — is a pnpm repo with a stray file,
 * because pnpm is the one that had to be chosen deliberately. `npm` is last for the same reason
 * it is the default: it is what you get without choosing.
 */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(filenames: readonly string[]): PackageManager {
  const present = new Set(filenames);
  for (const [file, manager] of LOCKFILES) {
    if (present.has(file)) return manager;
  }
  return "npm";
}

/**
 * The executable name for a manager on this platform.
 *
 * Windows needs `.cmd`: these are all npm-installed shims, and `spawn` without a shell will not
 * find `pnpm` on its own — the same rule `lint/index.ts` follows for `eslint`, and the same
 * failure if it is missed (ENOENT, which reads as "not installed"). Bun ships a real `.exe`, so
 * it is the exception.
 */
function executable(manager: PackageManager): string {
  if (process.platform !== "win32" || manager === "bun") return manager;
  return `${manager}.cmd`;
}

/**
 * `run` for everyone, and it is not redundant on any of them.
 *
 * `npm dev` is not a command — npm requires `run` for scripts and errors without it. pnpm, yarn
 * and bun all accept the bare form, and all accept `run` too, so spelling it consistently costs
 * nothing and removes a per-manager branch that would only ever be wrong in one direction.
 */
export function detectPreviewCommand(
  packageJson: unknown,
  filenames: readonly string[]
): PreviewCommand | null {
  if (typeof packageJson !== "object" || packageJson === null) return null;
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;

  const table = scripts as Record<string, unknown>;
  for (const script of SCRIPT_PREFERENCE) {
    // `Object.hasOwn` rather than `in` or a truthy read: `scripts` is parsed JSON, so
    // `scripts.constructor` is a function on every object that has no `constructor` script, and
    // `"toString" in table` is true for every project on earth.
    if (!Object.hasOwn(table, script)) continue;
    const body = table[script];
    // An empty or non-string script is a malformed package.json, not a runnable command.
    if (typeof body !== "string" || body.trim() === "") continue;

    const manager = detectPackageManager(filenames);
    return {
      file: executable(manager),
      args: ["run", script],
      script,
      label: `${manager} run ${script}`,
    };
  }

  return null;
}
