/**
 * Turning a linter's answer into squiggles and rows.
 *
 * TWO KINDS OF MISTAKE LIVE HERE AND BOTH LOOK LIKE THE LINTER BEING WRONG. The first is
 * arithmetic: a position off by one underlines the line above or the character before, which reads
 * as a bad rule rather than a bad mapping. The second is vocabulary: `LintResult` carries five
 * fields instead of being an array *precisely* so an empty pane can say why it is empty, and a
 * status that renders as the wrong sentence claims a file is clean when nobody looked at it.
 *
 * `problems.test.ts` is taken by the Study problem store, hence the name.
 */
import { describe, it, expect } from "vitest";
import {
  FROM_LAST_SAVE,
  SCOPE_NOTE,
  countsFor,
  isLatest,
  markerSeverity,
  needsExplaining,
  rowsFor,
  sentenceFor,
  toMarker,
} from "@/lib/build/problems";
import type { Diagnostic, LintResult, LintStatus } from "@shared/diagnostics";

const SEVERITIES = { Error: 8, Warning: 4, Info: 2, Hint: 1 };

const diagnostic = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  path: "a.py",
  line: 12,
  column: 5,
  endLine: null,
  endColumn: null,
  severity: "error",
  message: "undefined name 'x'",
  code: "F821",
  source: "ruff",
  ...over,
});

const result = (over: Partial<LintResult> = {}): LintResult => ({
  path: "a.py",
  status: "ok",
  tool: "ruff",
  diagnostics: [],
  detail: null,
  truncated: false,
  ...over,
});

describe("positions", () => {
  it("passes 1-based line and column straight through", () => {
    /**
     * Both sides are 1-based — `shared/diagnostics.ts` says so, and says it was written that way
     * because every one of these tools reports 1-based and Monaco expects it. A conversion here
     * would be a bug in both directions at once.
     */
    const marker = toMarker(diagnostic({ line: 12, column: 5 }), SEVERITIES);
    expect(marker.startLineNumber).toBe(12);
    expect(marker.startColumn).toBe(5);
  });

  it("turns a missing end into an empty range at the start, not a guess", () => {
    /**
     * THE OFF-BY-ONE THAT WOULD LOOK CORRECT. ruff omits `end_location` for some rules and eslint
     * omits `endLine` for others. Monaco expands an empty marker range to the word at that
     * position, which is exactly the "highlights to the end of the token" behaviour the shared
     * type describes — so doing nothing is the handling. `column + 1` would underline a single
     * character of a name; `line + 1` would underline the following line.
     */
    const marker = toMarker(diagnostic({ endLine: null, endColumn: null }), SEVERITIES);
    expect(marker.endLineNumber).toBe(marker.startLineNumber);
    expect(marker.endColumn).toBe(marker.startColumn);
  });

  it("uses the end the tool gave when it gave one", () => {
    const marker = toMarker(diagnostic({ endLine: 12, endColumn: 9 }), SEVERITIES);
    expect(marker.endLineNumber).toBe(12);
    expect(marker.endColumn).toBe(9);
  });

  it("carries the rule code and the tool, which is what the row shows", () => {
    const marker = toMarker(diagnostic(), SEVERITIES);
    expect(marker.code).toBe("F821");
    expect(marker.source).toBe("ruff");
    // Omitted rather than empty-stringed when the tool names no rule: Monaco renders the code in
    // the hover, and an empty one renders as a stray separator.
    expect(toMarker(diagnostic({ code: null }), SEVERITIES).code).toBeUndefined();
  });
});

describe("severity", () => {
  it("maps every severity the shared type allows", () => {
    // Exhaustive over `DiagnosticSeverity`, so adding one without deciding what it means is a
    // type error rather than a silent Info.
    expect(markerSeverity("error", SEVERITIES)).toBe(SEVERITIES.Error);
    expect(markerSeverity("warning", SEVERITIES)).toBe(SEVERITIES.Warning);
    expect(markerSeverity("info", SEVERITIES)).toBe(SEVERITIES.Info);
  });

  it("does not collapse them onto one value", () => {
    const mapped = new Set(
      (["error", "warning", "info"] as const).map((s) => markerSeverity(s, SEVERITIES))
    );
    expect(mapped.size, "two severities render identically").toBe(3);
  });
});

describe("the rows", () => {
  it("are ordered by file, then position", () => {
    /**
     * Not by severity first. That scatters one file's problems down the list, so fixing them
     * means jumping between files rather than working down one.
     */
    /**
     * The severities are deliberately mixed and deliberately *disagree* with the path order.
     *
     * The first version of this test gave every fixture the default `error`, so sorting by
     * severity first produced the identical list and the mutation survived — the assertion was
     * about the data, not the rule. Here, severity-first would give b.py's warning before a.py's
     * info, which is exactly the scattering this ordering exists to prevent.
     */
    const rows = rowsFor([
      result({
        path: "b.py",
        diagnostics: [diagnostic({ path: "b.py", line: 1, column: 1, severity: "warning" })],
      }),
      result({
        path: "a.py",
        diagnostics: [
          diagnostic({ path: "a.py", line: 9, column: 2, severity: "error" }),
          diagnostic({ path: "a.py", line: 2, column: 7, severity: "info" }),
        ],
      }),
    ]);

    expect(rows.map((r) => `${r.path}:${String(r.line)}`)).toEqual([
      "a.py:2",
      "a.py:9",
      "b.py:1",
    ]);
  });

  it("breaks a tie at the same position by severity", () => {
    // Two tools can report the same line and column. The error goes first, because that is the
    // one that stops the file working.
    const rows = rowsFor([
      result({
        diagnostics: [
          diagnostic({ line: 3, column: 1, severity: "info", source: "ruff" }),
          diagnostic({ line: 3, column: 1, severity: "error", source: "tsc" }),
        ],
      }),
    ]);
    expect(rows.map((r) => r.severity)).toEqual(["error", "info"]);
  });

  it("counts errors and warnings separately, for the badge", () => {
    const counts = countsFor([
      result({
        diagnostics: [
          diagnostic({ severity: "error" }),
          diagnostic({ severity: "warning" }),
          diagnostic({ severity: "warning" }),
          diagnostic({ severity: "info" }),
        ],
      }),
    ]);
    expect(counts).toEqual({ errors: 1, warnings: 2 });
  });
});

describe("what an empty pane says", () => {
  const STATUSES: LintStatus[] = ["ok", "not-installed", "unsupported", "failed", "timed-out"];

  it("says something different for every status", () => {
    /**
     * THE ASSERTION THIS WHOLE FILE IS FOR. `ok` with nothing found and `not-installed` are the
     * same empty list; one is a clean file and the other is a tool that never ran. If they ever
     * render the same sentence, the pane is claiming something it does not know.
     */
    const sentences = STATUSES.map((status) =>
      sentenceFor(result({ status, diagnostics: [] }), false)
    );
    expect(new Set(sentences).size, `two statuses share a sentence: ${sentences.join(" | ")}`).toBe(
      STATUSES.length
    );
  });

  it("names the tool, so the reader knows what did or did not run", () => {
    expect(sentenceFor(result({ status: "ok" }), false)).toContain("ruff");
    expect(sentenceFor(result({ status: "not-installed" }), false)).toContain("ruff");
    expect(sentenceFor(result({ status: "timed-out" }), false)).toContain("ruff");
  });

  it("says where a missing tool was looked for", () => {
    // "ruff is not installed" invites "installed where?" — and the answer is not just PATH.
    const sentence = sentenceFor(result({ status: "not-installed" }), false);
    expect(sentence).toContain("PATH");
    expect(sentence.toLowerCase()).toContain("project");
  });

  it("names the extension nothing is wired up for", () => {
    expect(sentenceFor(result({ path: "notes.md", status: "unsupported", tool: null }), false)).toContain(
      ".md"
    );
  });

  it("adds the last-save sentence only while the buffer is dirty", () => {
    /**
     * `lintFile` runs the tool against the file ON DISK — it takes a path, not a buffer. Without
     * this sentence, a Problems pane showing nothing for a buffer full of new errors reads as
     * "clean", which is the single most misleading thing this pane could do.
     */
    expect(sentenceFor(result({ status: "ok" }), true)).toContain(FROM_LAST_SAVE);
    expect(sentenceFor(result({ status: "ok" }), false)).not.toContain(FROM_LAST_SAVE);
  });

  it("keeps the scope note honest about what is listed", () => {
    // Markers exist for open files only. "No problems" across two tabs says nothing about the
    // other four hundred files.
    expect(SCOPE_NOTE.toLowerCase()).toContain("open");
    expect(SCOPE_NOTE.toLowerCase()).toContain("nothing scans the project");
  });

  it("explains every status except a clean file with findings", () => {
    for (const status of STATUSES) {
      expect(needsExplaining(result({ status, diagnostics: [] })), status).toBe(true);
    }
    // The one quiet case: the tool ran and found things, which the rows already say.
    expect(needsExplaining(result({ status: "ok", diagnostics: [diagnostic()] }))).toBe(false);
  });
});

describe("dropping a stale answer", () => {
  it("keeps only the newest run for a path", () => {
    /**
     * `lint:run` is request/response with no cancellation in main — both `contract.ts` and
     * `src/main/lint/index.ts` say the renderer owns this. A run started before the last save
     * finishes and answers about text that is no longer on disk.
     */
    const seq = new Map([["a.py", 3]]);
    expect(isLatest(seq, "a.py", 3)).toBe(true);
    expect(isLatest(seq, "a.py", 2)).toBe(false);
  });

  it("treats an answer for a path nothing asked about as stale", () => {
    // A file closed while its lint was in flight: its counter is gone, and its answer must not
    // resurrect a row for a file that is no longer open.
    expect(isLatest(new Map(), "a.py", 1)).toBe(false);
  });

  it("does not care which order they resolve in", () => {
    // The newest wins even when it comes back first, which is the case a naive "last writer
    // wins" gets wrong and which `tsc` makes likely: it is project-scoped and slow.
    const seq = new Map([["a.py", 2]]);
    expect(isLatest(seq, "a.py", 2)).toBe(true);
    expect(isLatest(seq, "a.py", 1)).toBe(false);
  });
});
