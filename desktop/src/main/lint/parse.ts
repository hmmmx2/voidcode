/**
 * Turning three tools' output into one shape.
 *
 * Pure, and separate from the spawning for that reason: every interesting case here is a string
 * that a real tool produced, and a test should be able to hand one over without a subprocess.
 * The fixtures in `tests/lint-parse.test.ts` are captured output, not invented.
 *
 * **A parse failure is never an empty result.** Each of these returns `null` when it cannot read
 * what it was given, and the caller turns that into `status: "failed"` with the raw text
 * attached. Returning `[]` instead would render as a clean file, which is the one wrong answer a
 * linter can give — the user changes nothing because nothing was reported, and the reason was
 * that the reporting broke.
 */
import type { Diagnostic, DiagnosticSeverity } from "../../shared/diagnostics.js";

/** Positive integer or nothing. Tools occasionally emit `0`, `null`, or a string. */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * ruff `check --output-format json`.
 *
 * A JSON array. `location` is 1-based in both axes; `end_location` is present for most rules and
 * absent for a few, which is exactly the case the shape's nullable ends exist for.
 *
 * Every ruff finding is a lint violation with no severity axis — there is no "warning" in the
 * output — so they all arrive as warnings rather than errors. Calling an unused import an error
 * would put a red underline under working code.
 */
export function parseRuff(stdout: string, path: string): Diagnostic[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: Diagnostic[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const location = (item.location ?? {}) as Record<string, unknown>;
    const end = (item.end_location ?? {}) as Record<string, unknown>;

    const line = positive(location.row);
    const column = positive(location.column);
    if (line === null || column === null) continue;

    out.push({
      path,
      line,
      column,
      endLine: positive(end.row),
      endColumn: positive(end.column),
      severity: "warning",
      message: typeof item.message === "string" ? item.message : "",
      code: typeof item.code === "string" ? item.code : null,
      source: "ruff",
    });
  }
  return out;
}

/**
 * eslint `--format json`.
 *
 * An array of file reports, one per file asked about, each with a `messages` array. `severity` is
 * `2` for error and `1` for warning — a numeric code, not a word, and the one field most likely
 * to be got backwards.
 *
 * A message with `severity: 2` and no `ruleId` is a *parse* error in the linted file, which is
 * worth keeping: it is the most important thing eslint has to say when it happens.
 */
export function parseEslint(stdout: string, path: string): Diagnostic[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: Diagnostic[] = [];
  for (const rawFile of parsed) {
    if (typeof rawFile !== "object" || rawFile === null) continue;
    const messages = (rawFile as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) continue;

    for (const raw of messages) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;

      const line = positive(item.line);
      const column = positive(item.column);
      if (line === null || column === null) continue;

      out.push({
        path,
        line,
        column,
        endLine: positive(item.endLine),
        endColumn: positive(item.endColumn),
        severity: item.severity === 2 ? "error" : "warning",
        message: typeof item.message === "string" ? item.message : "",
        code: typeof item.ruleId === "string" ? item.ruleId : null,
        source: "eslint",
      });
    }
  }
  return out;
}

/**
 * `tsc --noEmit --pretty false`.
 *
 * Text, not JSON — tsc has no machine-readable diagnostic output that does not involve running it
 * as a library. One finding per line:
 *
 *     src/main/lint/index.ts(42,7): error TS2304: Cannot find name 'foo'.
 *
 * Continuation lines are indented and belong to the finding above; they carry the useful half of
 * a type mismatch, so they are appended to its message rather than dropped.
 *
 * **Filtered to one file by the caller, not here.** tsc is project-scoped: it reports the whole
 * program because that is the only way it can tell you anything, and the paths it prints are
 * relative to the tsconfig's directory rather than to the project root.
 */
export function parseTsc(stdout: string): Array<Diagnostic & { rawPath: string }> | null {
  const lines = stdout.split(/\r?\n/);
  const out: Array<Diagnostic & { rawPath: string }> = [];
  let seenAny = false;

  for (const line of lines) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s*(.*)$/.exec(line);
    if (match === null) {
      // An indented continuation belongs to the finding above it.
      if (out.length > 0 && /^\s+\S/.test(line)) {
        const previous = out[out.length - 1]!;
        previous.message = `${previous.message} ${line.trim()}`;
      }
      continue;
    }
    seenAny = true;

    const [, rawPath, lineText, columnText, level, code, message] = match;
    const severity: DiagnosticSeverity =
      level === "error" ? "error" : level === "warning" ? "warning" : "info";

    out.push({
      rawPath: rawPath!.replace(/\\/g, "/"),
      path: rawPath!.replace(/\\/g, "/"),
      line: Number(lineText),
      column: Number(columnText),
      // tsc names a start and no end. Monaco underlines to the end of the token, which is what
      // tsc's own editor integration does.
      endLine: null,
      endColumn: null,
      severity,
      message: message ?? "",
      code: code ?? null,
      source: "tsc",
    });
  }

  /**
   * Empty output is a clean program, and that is a real answer — unlike the JSON parsers, there
   * is nothing here that can fail to parse. The only unreadable case is output that has lines but
   * none of them in the expected form, which means the format changed.
   */
  if (!seenAny && lines.some((line) => line.trim() !== "" && !/^\s/.test(line))) {
    return null;
  }
  return out;
}
