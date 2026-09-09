"use client";

import { useState, useEffect } from "react";
import { Verdict, VerdictIcon } from "@/components/app";
import VisualizationPanel from "@/components/Visualize/VisualizationPanel";
import CaseTiming from "./CaseTiming";
import type { TestCase } from "@/lib/mock-data";
import type { ExecutionState, SubmissionState } from "@/lib/api/grading";

interface TestConsoleProps {
  testCases: TestCase[];
  executionState: ExecutionState;
  submissionState: SubmissionState;
  /** Drives the Visualize tab's step-data lookup. */
  problemSlug?: string;
}

export default function TestConsole({
  testCases,
  executionState,
  submissionState,
  problemSlug,
}: TestConsoleProps) {
  /* VISUALIZE IS THE DEFAULT, AND THE OTHER TWO ARE WHY.
     You arrive at a problem before running anything, so Test Case and
     Execution both open empty. Visualize is the only one of the three with
     something to say on arrival. The auto-switch effects below still move you
     to the results the moment you press Run or Submit, so nothing is buried. */
  const [activeTab, setActiveTab] = useState<
    "visualize" | "testcase" | "execution"
  >("visualize");
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set(["1"]));

  // Auto-switch to Execution tab when user clicks Run
  useEffect(() => {
    if (executionState.status === "running") {
      setActiveTab("execution");
    }
  }, [executionState.status]);

  // Auto-switch to Test Case tab when user clicks Submit
  useEffect(() => {
    if (submissionState.status === "running") {
      setActiveTab("testcase");
    }
  }, [submissionState.status]);

  const toggleCase = (id: string) => {
    setExpandedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Helper: find submission result for a given test case
  const getTestResult = (testCaseId: string) => {
    if (submissionState.status !== "success") return null;
    return submissionState.result.testCaseResults.find(
      (r) => r.testCaseId === testCaseId
    );
  };

  // Hidden cases have no entry in `testCases` — the problems endpoint filters
  // them out — so they can only be surfaced from the submission results.
  const hiddenResults =
    submissionState.status === "success"
      ? submissionState.result.testCaseResults.filter((r) => r.isHidden)
      : [];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-ide-panel">
      {/* Tab bar — bg #262626 */}
      <div className="flex items-center gap-4 px-3 py-2 bg-ide-bar border-b border-line flex-shrink-0">
        {(["visualize", "testcase", "execution"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`text-xs transition-colors ${
              activeTab === tab
                ? "text-ink font-medium"
                : "text-ink-3 hover:text-ink"
            }`}
          >
            {tab === "visualize"
              ? "Visualize"
              : tab === "testcase"
                ? "Test Case"
                : "Execution"}
          </button>
        ))}
      </div>

      {/* Body — bg #212121, scrollable */}
      <div
        className={
          activeTab === "visualize"
            ? "min-h-0 flex-1 overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto"
        }
      >
        {/* ── Test Case Tab ── */}
        {activeTab === "testcase" && (
          <div className="p-3 space-y-2">
            {/* Submission summary banner */}
            {submissionState.status === "success" && (
              <div
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium ${
                  submissionState.result.allPassed
                    ? "border border-line-strong bg-void-2 text-verdict-pass"
                    : "border border-line-strong bg-void-2 text-verdict-fail"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <VerdictIcon passed={submissionState.result.allPassed} />
                  {submissionState.result.allPassed ? "All Passed" : "Some Failed"}
                  {" — "}
                  {submissionState.result.passedTests}/{submissionState.result.totalTests} test cases passed
                </span>
                {submissionState.result.overallTime && (
                  <span className="text-ink-3">
                    {submissionState.result.overallTime}s
                    {submissionState.result.overallMemory
                      ? ` · ${Math.round(submissionState.result.overallMemory / 1024)}MB`
                      : ""}
                  </span>
                )}
              </div>
            )}

            {submissionState.status === "running" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-void-3 text-xs text-ink-3">
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                Running test cases…
              </div>
            )}

            {submissionState.status === "error" && (
              <div className="px-3 py-2 rounded-lg border border-line-strong bg-void-2 text-xs text-ink-2">
                Error: {submissionState.error}
              </div>
            )}

            {testCases.map((tc) => {
              const isExpanded = expandedCases.has(tc.id);
              const result = getTestResult(tc.id);

              return (
                <div key={tc.id}>
                  {/* Case button — rounded pill, bg #3A3A3A */}
                  <button
                    onClick={() => toggleCase(tc.id)}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-ide-raised text-xs text-ink font-medium hover:bg-line-strong transition-colors"
                  >
                    {/* Pass/Fail. The visible text is only the case label, so
                        the state reaches assistive tech through `Verdict`'s
                        own sr-only word rather than through the colour. */}
                    {result && <Verdict passed={result.passed} />}
                    {tc.label}
                    <svg
                      width="10"
                      height="7"
                      viewBox="0 0 10 7"
                      fill="none"
                      className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
                    >
                      <path
                        d="M1 1L5 5L9 1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>

                  {/* Expanded case details — bg #040407 */}
                  {isExpanded && (
                    <div className="mt-2 bg-ide-code rounded-lg p-3 space-y-3">
                      {/* Inputs */}
                      {tc.inputs.map((input) => (
                        <div key={input.name}>
                          <label className="text-ink-3 text-xs font-mono">
                            {input.name} =
                          </label>
                          <div className="text-ink text-xs font-mono mt-0.5">
                            {input.value}
                          </div>
                        </div>
                      ))}

                      {/* Expected output */}
                      {tc.expectedOutput && (
                        <div>
                          <label className="text-ink-3 text-xs font-mono">
                            Expected =
                          </label>
                          <div className="text-ink text-xs font-mono mt-0.5">
                            {tc.expectedOutput}
                          </div>
                        </div>
                      )}

                      {/* How long it took, against what it was allowed. A tick alone cannot
                          distinguish a comfortable pass from one that is 3ms off the limit. */}
                      {result && submissionState.status === "success" && (
                        <CaseTiming
                          elapsedMs={result.elapsedMs}
                          timeLimitMs={submissionState.result.timeLimitMs}
                        />
                      )}

                      {/* Actual output (only when submission results exist) */}
                      {result && (
                        <div>
                          <label className="text-ink-3 text-xs font-mono">
                            Actual =
                          </label>
                          <div
                            className={`text-xs font-mono mt-0.5 ${
                              result.passed ? "text-verdict-pass" : "text-verdict-fail"
                            }`}
                          >
                            {result.actualOutput ?? "(no output)"}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/*
              Hidden cases.

              This list iterates the submission RESULTS, not `testCases` —
              `GET /v1/problems/{slug}` filters hidden cases out, so they exist
              nowhere in the browser until a submission comes back. Without this
              block a learner failing only on hidden cases would see every
              visible case pass and no explanation for the failed submission.

              Pass/fail and the label are all there is to show. Input, expected
              and actual output are redacted server-side and arrive as null.
            */}
            {hiddenResults.length > 0 && (
              <div className="pt-1 space-y-2">
                <div className="text-ink-3 text-xs">
                  Hidden test cases
                  <span className="ml-1.5 text-ink-3/60">
                    — inputs and expected output are not shown
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {hiddenResults.map((result) => (
                    <div
                      key={result.testCaseId}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-ide-raised text-xs text-ink-2"
                    >
                      <Verdict passed={result.passed} />
                      {result.label || "Hidden"}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Execution Tab ── */}
        {activeTab === "execution" && (
          <div className="p-3">
            {executionState.status === "idle" && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <p className="text-xs text-ink-2">
                  Nothing has run yet.
                </p>
                <p className="max-w-[42ch] text-[11px] leading-relaxed text-ink-3">
                  <span className="text-ink-2">Run</span> evaluates every visible
                  case and shows what your code returned.{" "}
                  <span className="text-ink-2">Submit</span> grades the hidden
                  cases too, and records the attempt.
                </p>
              </div>
            )}

            {executionState.status === "running" && (
              <div className="flex items-center justify-center gap-2 py-8">
                <svg className="animate-spin h-4 w-4 text-ink-3" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                <span className="text-ink-3 text-xs">Running…</span>
              </div>
            )}

            {executionState.status === "error" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border border-line-strong bg-void-2 text-ink-2">
                    Error
                  </span>
                </div>
                <pre className="bg-ide-code rounded-lg p-3 text-xs text-ink-2 font-mono whitespace-pre-wrap overflow-x-auto">
                  {executionState.error}
                </pre>
              </div>
            )}

            {executionState.status === "success" && (
              <div className="space-y-3">
                {/* Status badge + stats */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                        executionState.result.statusId === 3
                          ? "border border-line-strong bg-void-2 text-verdict-pass"
                          : "border border-line-strong bg-void-2 text-verdict-fail"
                      }`}
                    >
                      {executionState.result.statusDescription}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-ink-3">
                    {executionState.result.time && (
                      <span>{executionState.result.time}s</span>
                    )}
                    {executionState.result.memory && (
                      <span>{Math.round(executionState.result.memory / 1024)}MB</span>
                    )}
                  </div>
                </div>

                {/*
                  What the code actually produced, per visible case.
                  
                  This is the answer to "I pressed Run and nothing happened". A solution that
                  defines a function and prints nothing has no stdout, so the panel had nothing
                  to show even though every case had been evaluated. Expected is shown only
                  when a case fails — on a pass it is the same string twice.
                */}
                {executionState.result.cases.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-ink-3 text-[10px] font-medium uppercase tracking-wider">
                      Visible cases
                    </label>
                    {executionState.result.cases.map((testCase, index) => (
                      <div
                        key={index}
                        className="rounded-lg border border-line bg-ide-code p-2.5"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-bold ${
                              testCase.passed ? "text-verdict-pass" : "text-verdict-fail"
                            }`}
                          >
                            {testCase.passed ? "PASS" : "FAIL"}
                          </span>
                          <span className="text-xs text-ink">{testCase.label}</span>
                          <span className="ml-auto text-[10px] text-ink-3">
                            {testCase.elapsedMs.toFixed(1)}ms
                          </span>
                        </div>

                        {testCase.actual !== null && (
                          <div className="mt-1.5">
                            <span className="text-[10px] uppercase tracking-wider text-ink-3">
                              Returned
                            </span>
                            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-ink">
                              {testCase.actual}
                            </pre>
                          </div>
                        )}

                        {!testCase.passed && testCase.expected !== null && (
                          <div className="mt-1.5">
                            <span className="text-[10px] uppercase tracking-wider text-ink-3">
                              Expected
                            </span>
                            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-verdict-pass">
                              {testCase.expected}
                            </pre>
                          </div>
                        )}

                        {testCase.error !== null && (
                          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-verdict-fail">
                            {testCase.error}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Stdout */}
                {executionState.result.stdout && (
                  <div>
                    <label className="text-ink-3 text-[10px] font-medium uppercase tracking-wider">
                      Output
                    </label>
                    <pre className="mt-1 bg-ide-code rounded-lg p-3 text-xs text-ink font-mono whitespace-pre-wrap overflow-x-auto">
                      {executionState.result.stdout}
                    </pre>
                  </div>
                )}

                {/* Stderr */}
                {executionState.result.stderr && (
                  <div>
                    <label className="text-ink-3 text-[10px] font-medium uppercase tracking-wider">
                      Stderr
                    </label>
                    <pre className="mt-1 bg-ide-code rounded-lg p-3 text-xs text-ink-2 font-mono whitespace-pre-wrap overflow-x-auto">
                      {executionState.result.stderr}
                    </pre>
                  </div>
                )}

                {/* Compile output */}
                {executionState.result.compileOutput && (
                  <div>
                    <label className="text-ink-3 text-[10px] font-medium uppercase tracking-wider">
                      Compile Output
                    </label>
                    <pre className="mt-1 bg-ide-code rounded-lg p-3 text-xs text-ink-2 font-mono whitespace-pre-wrap overflow-x-auto">
                      {executionState.result.compileOutput}
                    </pre>
                  </div>
                )}

                {/* No output at all */}
                {!executionState.result.stdout &&
                  !executionState.result.stderr &&
                  !executionState.result.compileOutput && (
                    <div className="text-ink-3 text-xs py-4 text-center">
                      No output produced
                    </div>
                  )}
              </div>
            )}
          </div>
        )}

        {/* ── Visualize Tab ── */}
        {activeTab === "visualize" && (
          <VisualizationPanel problemSlug={problemSlug} />
        )}
      </div>
    </div>
  );
}
