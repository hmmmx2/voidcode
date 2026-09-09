/**
 * Running the project's own linter over one file.
 *
 * **The renderer never names the command.** It sends a path; everything about *what* to run is
 * decided here. That is the pty's rule and the reason this is safe to reach from a save — a
 * channel that took a command string would be `run_command` with none of the consent around it.
 *
 * **The project's tool, not ours.** A repo pins its linter and its rules, and running a different
 * version reports problems the project does not have. So a project-local binary
 * (`node_modules/.bin/eslint`, `.venv/bin/ruff`) wins over whatever is on PATH, and if neither
 * exists the answer is `not-installed` rather than a guess.
 *
 * **Three tools, one per file, chosen by extension.** ruff for Python, eslint for JS/TS where the
 * project has it, and `tsc --noEmit` as the fallback for TypeScript. That last one is not padding:
 * this repo has no ruff config and no root eslint, so without it Problems would be a feature that
 * could never be demonstrated in the codebase it ships from — which is the codebase where anyone
 * would notice it breaking.
 *
 * **`lint:run` is request/response.** There is no cancellation in main; a stale run finishes and
 * its result is dropped by the renderer's request id. Saying so plainly beats an `AbortSignal`
 * parameter that nothing ever aborts.
 *
 * **A parse failure is reported, never swallowed.** `status: "failed"` with the raw output
 * attached. Folding it into an empty list would render as a clean file, and the user would change
 * nothing because nothing was reported.
 */
import { access, constants } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic, LintResult, LintStatus } from "../../shared/diagnostics.js";
import { runProcess } from "../proc/spawn.js";
import { sanitisedEnv } from "../terminal/shell.js";
import { parseEslint, parseRuff, parseTsc } from "./parse.js";

/**
 * Long enough for `tsc` over a real project, short enough that a wedged tool is not the session.
 *
 * Deliberately well under `MAX_COMMAND_MS`: this runs on every save, and a linter that takes two
 * minutes has already failed at its job even if it eventually answers.
 */
export const MAX_LINT_MS = 60_000;

type ToolName = "ruff" | "eslint" | "tsc";

const BY_EXTENSION: Record<string, readonly ToolName[]> = {
  // First match that is actually installed wins, so a JS project with eslint gets eslint and a
  // TypeScript project without one still gets type errors.
  py: ["ruff"],
  pyi: ["ruff"],
  js: ["eslint"],
  jsx: ["eslint"],
  mjs: ["eslint"],
  cjs: ["eslint"],
  ts: ["eslint", "tsc"],
  tsx: ["eslint", "tsc"],
  mts: ["eslint", "tsc"],
  cts: ["eslint", "tsc"],
};

/** Where a project keeps each tool, relative to its root. Checked before PATH. */
const LOCAL_BINARIES: Record<ToolName, readonly string[]> = {
  eslint: ["node_modules/.bin/eslint"],
  tsc: ["node_modules/.bin/tsc"],
  ruff: [".venv/bin/ruff", ".venv/Scripts/ruff.exe", "venv/bin/ruff", "venv/Scripts/ruff.exe"],
};

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable to run, preferring the project's own copy.
 *
 * Returns the bare name when no local copy is found, which leaves it to PATH — and to `spawn`
 * failing with ENOENT, which is how `not-installed` is detected. Windows needs `.cmd` for
 * npm-installed shims, because `spawn` without a shell will not find `eslint` on its own.
 */
async function binaryFor(tool: ToolName, root: string): Promise<string> {
  for (const candidate of LOCAL_BINARIES[tool]) {
    const absolute = join(root, candidate);
    if (await exists(absolute)) return absolute;
    if (process.platform === "win32" && (await exists(`${absolute}.cmd`))) return `${absolute}.cmd`;
  }
  return process.platform === "win32" && tool !== "ruff" ? `${tool}.cmd` : tool;
}

/** `C:\proj\src\a.ts` under `C:\proj` → `src/a.ts`. Null when it is not under the root at all. */
function projectRelative(root: string, absolute: string): string | null {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function fail(path: string, tool: string | null, status: LintStatus, detail: string | null): LintResult {
  return { path, status, tool, diagnostics: [], detail, truncated: false };
}

/**
 * Lint one file.
 *
 * `absolutePath` has already been through `resolveWithin`, so it is inside the project — this
 * function does no confinement of its own and must not be called with a renderer string directly.
 */
export async function lintFile(root: string, absolutePath: string): Promise<LintResult> {
  const path = projectRelative(root, absolutePath);
  if (path === null) return fail(absolutePath, null, "unsupported", "Not inside the project");

  const tools = BY_EXTENSION[extensionOf(path)];
  if (tools === undefined) {
    return fail(path, null, "unsupported", "No linter is wired up for this file type");
  }

  let lastMissing: ToolName | null = null;
  for (const tool of tools) {
    const result = await runTool(tool, root, absolutePath, path);
    if (result.status === "not-installed") {
      lastMissing = tool;
      continue;
    }
    return result;
  }
  return fail(path, lastMissing, "not-installed", `${lastMissing ?? "The linter"} is not installed`);
}

async function runTool(
  tool: ToolName,
  root: string,
  absolutePath: string,
  path: string
): Promise<LintResult> {
  const file = await binaryFor(tool, root);
  const args =
    tool === "ruff"
      ? ["check", "--output-format", "json", "--force-exclude", absolutePath]
      : tool === "eslint"
        ? ["--format", "json", "--no-error-on-unmatched-pattern", absolutePath]
        : // tsc is project-scoped by nature: it cannot type-check one file without its program.
          ["--noEmit", "--pretty", "false"];

  const result = await runProcess({
    file,
    args,
    cwd: root,
    timeoutMs: MAX_LINT_MS,
    env: sanitisedEnv(),
  });

  if (result.spawnError !== null) {
    // ENOENT is the tool not being there. Anything else is a real failure worth showing.
    const missing = /ENOENT/.test(result.spawnError);
    return fail(
      path,
      tool,
      missing ? "not-installed" : "failed",
      missing ? `${tool} is not installed` : result.spawnError
    );
  }
  if (result.timedOut) {
    return fail(path, tool, "timed-out", `${tool} took longer than ${MAX_LINT_MS / 1000}s`);
  }

  const parsed = parse(tool, result.stdout, root, absolutePath, path);
  if (parsed === null) {
    // The tool ran and said something this cannot read. Reported, with what it said — an empty
    // list here would render as "no problems", which is the one wrong answer available.
    const detail = (result.stderr.trim() || result.stdout.trim() || "no output").slice(0, 2000);
    return fail(path, tool, "failed", detail);
  }

  return { path, status: "ok", tool, diagnostics: parsed, detail: null, truncated: result.truncated };
}

function parse(
  tool: ToolName,
  stdout: string,
  root: string,
  absolutePath: string,
  path: string
): Diagnostic[] | null {
  if (tool === "ruff") return parseRuff(stdout, path);
  if (tool === "eslint") return parseEslint(stdout, path);

  const all = parseTsc(stdout);
  if (all === null) return null;

  /**
   * tsc reports the whole program, so its findings are filtered to the file that was saved.
   *
   * Its paths are relative to the tsconfig it used, which is not necessarily the project root —
   * so they are resolved against the root and compared as absolutes rather than as strings.
   */
  const target = resolve(absolutePath).split(sep).join("/").toLowerCase();
  return all
    .filter((d) => resolve(root, d.rawPath).split(sep).join("/").toLowerCase() === target)
    .map(({ rawPath: _rawPath, ...d }) => ({ ...d, path }));
}
