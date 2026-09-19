/**
 * Turning a linter's answer into markers and rows a person can act on.
 *
 * Pure, so the mapping can be asserted without a Monaco or a linter — and because the two things
 * most likely to be wrong here are both arithmetic that produces a plausible-looking underline in
 * the wrong place, which no amount of looking at the screen would settle.
 *
 * THE HONESTY PROBLEM IS THE REASON THIS FILE IS MORE THAN A `map`. `LintResult` has five fields
 * instead of being an array precisely so a Problems pane showing nothing can say *why* it is
 * showing nothing: "ruff found no problems" and "ruff is not installed" look identical when all
 * that crosses the boundary is an empty list, and one of them is a clean file while the other is a
 * tool that never ran. `sentenceFor` is where that distinction becomes words.
 */
import type {
  Diagnostic,
  DiagnosticSeverity,
  LintResult,
  LintStatus,
} from "@shared/diagnostics";

/** Monaco's `MarkerSeverity`, read off the live namespace rather than imported. */
export interface MarkerSeverities {
  readonly Error: number;
  readonly Warning: number;
  readonly Info: number;
  readonly Hint: number;
}

/** The shape `monaco.editor.setModelMarkers` takes, declared structurally. */
export interface Marker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  source: string;
  code?: string;
}

/**
 * One diagnostic as a Monaco marker.
 *
 * POSITIONS PASS THROUGH UNCHANGED. Both sides are 1-based — `shared/diagnostics.ts` says so, and
 * says it was written that way because every one of these tools reports 1-based and Monaco
 * expects it. An off-by-one here underlines the line above or the character before, which looks
 * like the linter being wrong.
 *
 * A MISSING END BECOMES AN EMPTY RANGE AT THE START, NOT A GUESS. ruff omits `end_location` for
 * some rules and eslint omits `endLine` for others. Monaco's marker decorations expand an empty
 * range to the word at that position, which is exactly the "highlights to the end of the token"
 * behaviour the shared type describes — so doing nothing is the correct handling. Inventing
 * `line + 1` would underline the following line; inventing `column + 1` would underline one
 * character of a name.
 */
export function toMarker(
  diagnostic: Diagnostic,
  severities: MarkerSeverities
): Marker {
  const marker: Marker = {
    startLineNumber: diagnostic.line,
    startColumn: diagnostic.column,
    endLineNumber: diagnostic.endLine ?? diagnostic.line,
    endColumn: diagnostic.endColumn ?? diagnostic.column,
    severity: markerSeverity(diagnostic.severity, severities),
    message: diagnostic.message,
    source: diagnostic.source,
  };
  if (diagnostic.code !== null) marker.code = diagnostic.code;
  return marker;
}

/** Exhaustive over `DiagnosticSeverity`, so a new one is a type error rather than a silent Info. */
export function markerSeverity(
  severity: DiagnosticSeverity,
  severities: MarkerSeverities
): number {
  switch (severity) {
    case "error":
      return severities.Error;
    case "warning":
      return severities.Warning;
    case "info":
      return severities.Info;
  }
}

/** A row in the Problems pane. */
export interface ProblemRow {
  path: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  code: string | null;
  source: string;
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Every diagnostic across every open file, in reading order.
 *
 * Path, then line, then column, then severity. Sorting by severity *first* is the obvious
 * alternative and is worse: it scatters one file's problems down the list, so fixing them means
 * jumping between files instead of working down one.
 */
export function rowsFor(results: readonly LintResult[]): ProblemRow[] {
  const rows = results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      severity: diagnostic.severity,
      message: diagnostic.message,
      code: diagnostic.code,
      source: diagnostic.source,
    }))
  );

  return rows.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}

/** Errors and warnings across everything, for the tab badge. */
export function countsFor(results: readonly LintResult[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity === "error") errors += 1;
      else if (diagnostic.severity === "warning") warnings += 1;
    }
  }
  return { errors, warnings };
}

/**
 * What to say about one file, given what happened when it was checked.
 *
 * EXHAUSTIVE OVER `LintStatus`, so adding a status without deciding what it says is a type error.
 * That is the whole point: the statuses exist to be distinguishable, and the failure this prevents
 * is a new one silently rendering as the `ok` sentence — which claims a file is clean when nobody
 * looked at it.
 */
export function sentenceFor(result: LintResult, dirty: boolean): string {
  const tool = result.tool ?? "the linter";

  switch (result.status) {
    case "ok":
      return result.diagnostics.length === 0
        ? `${tool} found no problems.${dirty ? " " + FROM_LAST_SAVE : ""}`
        : `${tool} reported ${describeCount(result.diagnostics.length)}.${
            dirty ? " " + FROM_LAST_SAVE : ""
          }`;
    case "not-installed":
      return (
        `${tool} is not installed, so nothing checked this file. ` +
        "It is looked for in the project first (.venv/bin, node_modules/.bin) and then on PATH."
      );
    case "unsupported":
      return `No linter is wired up for ${extensionOf(result.path)} files.`;
    case "failed":
      return `${tool} ran and its output could not be read.`;
    case "timed-out":
      return `${tool} took too long and was stopped, so this file was not checked.`;
  }
}

/**
 * The sentence that keeps an empty pane from lying.
 *
 * `lintFile` in main runs the tool against the file ON DISK — it takes a path, not a buffer — so
 * everything above describes the last save. Without this said out loud, a Problems pane showing
 * nothing for a buffer full of new errors reads as "clean".
 */
export const FROM_LAST_SAVE = "From the last save; save to re-check.";

/**
 * The scope, said once.
 *
 * Markers only exist for files that are open, so this pane is not a project scan and must not be
 * mistaken for one. "No problems" across two open files says nothing about the other four hundred.
 */
export const SCOPE_NOTE = "Problems lists the files you have open. Nothing scans the project.";

function describeCount(n: number): string {
  return n === 1 ? "1 problem" : `${String(n)} problems`;
}

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "these" : `.${name.slice(dot + 1)}`;
}

/**
 * Which lint answers are still worth showing.
 *
 * A stale run is dropped by request id, which the contract says is the renderer's job: main has no
 * cancellation, so a run started before the last save finishes and answers about text that is no
 * longer on disk. `tsc --noEmit` is project-scoped and can take tens of seconds under its 60 s
 * cap, so this is not a rare case — it is what a burst of saves produces.
 */
export function isLatest(
  seq: ReadonlyMap<string, number>,
  path: string,
  answered: number
): boolean {
  return (seq.get(path) ?? 0) === answered;
}

/** Statuses to keep in a status list. `ok` with no diagnostics is the quiet case. */
export function needsExplaining(result: LintResult): boolean {
  return result.status !== "ok" || result.diagnostics.length === 0;
}
