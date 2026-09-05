import { cn } from "@/lib/utils";
import { DEMO_TESTS } from "./demo-content";

export type ConsoleState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; passed: number; total: number };

/**
 * Test strip under the editor.
 *
 * Mirrors `Editor/TestConsole.tsx` — the same green/red banner, the same
 * "N/M test cases passed" phrasing — because the demo is meant to be a
 * screenshot of the product rather than a mock of it.
 *
 * The one colour on an otherwise monochrome page lives here, and it earns its
 * place: a pass/fail signal that reads as grey is a pass/fail signal nobody can
 * read. It is confined to a 6px dot and a text label.
 */
export function DemoConsole({ state }: { state: ConsoleState }) {
  const allPassed = state.phase === "done" && state.passed === state.total;

  return (
    <div className="shrink-0 border-t border-line-strong bg-void-1">
      <div className="flex h-8 items-center gap-3 border-b border-line px-3">
        <span className="text-[11px] font-medium text-ink">Test Case</span>
        <span className="text-[11px] text-ink-3">Execution</span>

        {state.phase === "running" && (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border border-line-strong border-t-ink"
            />
            Running test cases…
          </span>
        )}

        {state.phase === "done" && (
          <span
            className={cn(
              "ml-auto text-[11px] font-medium",
              allPassed ? "text-green-400" : "text-red-400"
            )}
          >
            {allPassed ? "All Passed" : "Some Failed"} — {state.passed}/{state.total} test cases
            passed
          </span>
        )}

        {state.phase === "idle" && (
          <span className="ml-auto text-[11px] text-ink-3">Run your code to see results</span>
        )}
      </div>

      <ul className="divide-y divide-line">
        {DEMO_TESTS.map((test, i) => {
          // Only the third test discriminates — shape and mask are correct in
          // the starting buffer and stay correct through both fixes.
          const failed = state.phase === "done" && i >= state.passed;
          return (
            <li key={test.label} className="flex items-center gap-3 px-3 py-2">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  state.phase !== "done" && "bg-[#3a3a3a]",
                  state.phase === "done" && (failed ? "bg-red-400" : "bg-green-400")
                )}
              />
              <span className="font-mono text-[11px] text-ink-2">{test.label}</span>
              <span className="truncate font-mono text-[11px] text-ink-3">{test.detail}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
