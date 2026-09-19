"use client";

import { IconWarning } from "@/components/icons";
import {
  SCOPE_NOTE,
  needsExplaining,
  rowsFor,
  sentenceFor,
  type ProblemRow,
} from "@/lib/build/problems";
import type { LintResult } from "@shared/diagnostics";

/**
 * What the linters said about the files you have open.
 *
 * TWO LISTS, AND THE SECOND IS THE ONE THAT KEEPS THIS HONEST. The rows are the diagnostics. The
 * strip beneath them is every file whose result needs explaining — a tool that is not installed, an
 * extension nothing is wired up for, output that could not be parsed, a run that timed out, and a
 * clean file, which is also worth saying. `LintResult` carries five fields instead of being an
 * array for exactly this: "ruff found no problems" and "ruff is not installed" are the same empty
 * list, and one of them is a clean file while the other is a tool that never ran.
 *
 * NOT A PROJECT SCAN, and it says so. Markers exist only for open files, so "no problems" across
 * two tabs says nothing about the other four hundred files. A pane that implied otherwise would be
 * worse than no pane.
 *
 * FROM THE LAST SAVE. `lintFile` in main takes a path and runs the tool against the file on disk,
 * so a dirty buffer's diagnostics describe what was saved, not what is on screen. That sentence
 * appears per file rather than once at the top, because it is only true of the dirty ones.
 */
export default function ProblemsPanel({
  results,
  dirtyPaths,
  running,
  onOpenLocation,
}: {
  results: readonly LintResult[];
  dirtyPaths: ReadonlySet<string>;
  /** Paths with a lint run in flight, so a slow `tsc` does not look like a hang. */
  running: ReadonlySet<string>;
  onOpenLocation: (path: string, line: number, column: number) => void;
}) {
  const rows = rowsFor(results);
  const explained = results.filter(needsExplaining);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {rows.length === 0 && explained.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] text-ink-3">No files open.</p>
          <p className="max-w-[46ch] text-[12px] text-ink-3">{SCOPE_NOTE}</p>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="min-w-0">
          {rows.map((row, index) => (
            <li key={`${row.path}:${String(row.line)}:${String(row.column)}:${String(index)}`}>
              <button
                type="button"
                onClick={() => onOpenLocation(row.path, row.line, row.column)}
                className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1 text-left transition-colors duration-150 ease-void hover:bg-ide-raised focus-visible:bg-ide-raised focus-visible:outline-none"
              >
                <Severity severity={row.severity} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
                  {row.message}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-3">
                  {row.code ?? row.source}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-3">
                  {row.path}:{row.line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {explained.length > 0 && (
        <div className="mt-auto border-t border-line px-3 py-2">
          {explained.map((result) => (
            <p key={result.path} className="text-[11px] text-ink-3">
              <span className="font-mono text-ink-2">{result.path}</span>
              {" — "}
              {running.has(result.path)
                ? "checking…"
                : sentenceFor(result, dirtyPaths.has(result.path))}
              {result.status === "failed" && result.detail !== null && (
                /* Verbatim, in a pre. Folding a parse error into an empty list would render as a
                   clean file, and the user would change nothing because nothing was reported. */
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-ide-code px-2 py-1 font-mono text-[10px] text-ink-3">
                  {result.detail}
                </pre>
              )}
            </p>
          ))}
          <p className="mt-2 text-[11px] text-ink-3">{SCOPE_NOTE}</p>
        </div>
      )}
    </div>
  );
}

function Severity({ severity }: { severity: ProblemRow["severity"] }) {
  const colour =
    severity === "error"
      ? "text-problem-error"
      : severity === "warning"
        ? "text-problem-warn"
        : "text-ink-3";
  return (
    <span aria-label={severity} title={severity} className={`shrink-0 ${colour}`}>
      <IconWarning size={12} />
    </span>
  );
}
