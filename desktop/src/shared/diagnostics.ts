/**
 * What a linter said about a file.
 *
 * Import-free and shared by both tsconfigs, the same arrangement as `hardware-types.ts` and for
 * the same reason: hand-mirroring a shape across the IPC boundary is the mistake
 * `agent-event-parity.test.ts` and `chat-chunk-parity.test.ts` exist to police, and one
 * declaration cannot drift from itself.
 *
 * **`T | null`, never `T?`.** `exactOptionalPropertyTypes` is on for the main tsconfig and off
 * for the renderer's, so an optional property means two different things depending on which
 * project is reading it. An explicit null means one thing in both.
 *
 * **"No linter installed" is a state, not an empty result.** This is the shape's whole reason for
 * existing in more than one field. A Problems tab showing nothing has to be able to say *why* it
 * is showing nothing — "ruff is not installed" and "ruff found no problems" look identical if the
 * only thing crossing the boundary is an array, and one of them is a clean file while the other
 * is a tool that never ran. `isTerminalAvailable()` draws the same distinction for the same
 * reason.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  /** Project-relative, forward slashes — the same convention as `BuildTreeNode.path`. */
  path: string;
  /** 1-based, as every one of these tools reports and as Monaco expects. */
  line: number;
  column: number;
  /**
   * Null where the tool does not say.
   *
   * ruff omits `end_location` for some rules and eslint omits `endLine` for others; a marker
   * without an end is a valid marker that highlights to the end of the token, and inventing
   * `line + 1` would underline the wrong code.
   */
  endLine: number | null;
  endColumn: number | null;
  severity: DiagnosticSeverity;
  message: string;
  /** `F401`, `no-unused-vars`, `TS2304`. Null when the tool does not name a rule. */
  code: string | null;
  /** Which tool said so. Shown in the row, because the answer differs by tool. */
  source: string;
}

/**
 * Why the diagnostics list looks the way it does.
 *
 * - `ok` — the tool ran and this is what it found, empty or not.
 * - `not-installed` — the tool for this file type is not on PATH or in the project. The file may
 *   be perfect; nobody looked.
 * - `unsupported` — no tool is wired up for this extension. Also not a clean bill of health.
 * - `failed` — the tool ran and its output could not be read. A parse error here is reported,
 *   never swallowed into an empty list, because a silent `ok` would claim the file is clean.
 * - `timed-out` — it ran too long and was killed, tree and all.
 */
export type LintStatus = "ok" | "not-installed" | "unsupported" | "failed" | "timed-out";

export interface LintResult {
  /** The file that was asked about, project-relative. */
  path: string;
  status: LintStatus;
  /** `ruff`, `eslint`, `tsc`. Null only when nothing was wired up for the extension. */
  tool: string | null;
  diagnostics: Diagnostic[];
  /** The parse error or the tool's own stderr, for a status that needs explaining. Else null. */
  detail: string | null;
  /** The tool's output hit its cap, so this is a prefix of what it said. */
  truncated: boolean;
}
