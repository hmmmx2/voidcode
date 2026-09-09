/**
 * The gate that decides whether a newly authored interview problem may ship.
 *
 * The failure this replaces was not subtle and was not detectable from inside the app: authoring one
 * question produced five or six red CI failures reading `no web answer key to compare against`, and
 * the only way to green them was to hand-type values into `interview-answer-key.ts` — a file whose
 * own header forbids exactly that, because D0 retired the generator that produced it.
 *
 * The whole change is in one decision: a missing oracle entry means *not covered*, not *wrong*. That
 * is one line, and on its own it would be a hole — new content would pass with nothing checked. So
 * these tests are mostly about the rule that closes it: content the oracle does not cover must carry
 * a spec.
 *
 * Content is mocked rather than real, because what is under test is the decision, and a synthetic
 * catalogue can contain the cases the shipped one deliberately does not — a post-freeze item, an
 * item with no spec, a drifted snapshot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

/** Per-problem derived keys, scripted so no sandbox is needed. */
const derived = new Map<string, { key: string[] } | { broken: string }>();
/** Per-submission grades, for the spec half. */
const grades = new Map<string, unknown>();

/** Milliseconds each scripted derivation should take, so the timing report has something to add up. */
const takes = new Map<string, number>();

vi.mock("../src/main/exec/grader.js", () => ({
  derivedKeyOrReason: async (problem: { id: string }) => {
    const delay = takes.get(problem.id) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return derived.get(problem.id) ?? { broken: "not scripted" };
  },
  gradeSubmission: (problem: { id: string }) =>
    Promise.resolve(grades.get(problem.id) ?? { verdicts: [], solved: false }),
}));

interface Entry {
  questionSlug: string;
  problem: { id: string; cases: Array<{ id: string; label: string; visible: boolean }> };
  derivedKey?: string[];
}

const catalogue: Entry[] = [];
const answerKey: Record<string, string> = {};
const specs: Record<string, unknown> = {};

vi.mock("../src/main/content/interview-problems.js", () => ({
  get INTERVIEW_PROBLEMS() {
    return catalogue;
  },
}));
vi.mock("../src/main/content/interview-answer-key.js", () => ({
  get WEB_ANSWER_KEY() {
    return answerKey;
  },
  KNOWN_DIVERGENCES: {},
}));
vi.mock("../src/main/content/verify-interview-specs.js", () => ({
  get INTERVIEW_SPECS() {
    return specs;
  },
}));

const { verifyInterviewProblems } = await import("../src/main/content/verify-interviews.js");

function entry(id: string, caseIds: string[], derivedKey?: string[]): Entry {
  return {
    questionSlug: id.replace(/^iq-/, ""),
    problem: { id, cases: caseIds.map((c) => ({ id: c, label: c, visible: false })) },
    ...(derivedKey === undefined ? {} : { derivedKey }),
  };
}

beforeEach(() => {
  catalogue.length = 0;
  for (const key of Object.keys(answerKey)) delete answerKey[key];
  for (const key of Object.keys(specs)) delete specs[key];
  derived.clear();
  grades.clear();
  takes.clear();
});

describe("content the frozen oracle covers", () => {
  it("matches, and needs no spec", async () => {
    catalogue.push(entry("iq-legacy", ["a", "b"]));
    answerKey["a"] = "1";
    answerKey["b"] = "2";
    derived.set("iq-legacy", { key: ["1", "2"] });

    const report = await verifyInterviewProblems();
    expect(report.failures).toEqual([]);
    expect(report.matched).toBe(2);
    expect(report.uncovered).toBe(0);
  });

  it("still fails when a derived key disagrees with the oracle", async () => {
    // The check the port was built on, and it keeps working — the oracle is frozen, not discarded.
    // It is the only surviving evidence that D0's conversion was faithful.
    catalogue.push(entry("iq-legacy", ["a"]));
    answerKey["a"] = "1";
    derived.set("iq-legacy", { key: ["999"] });

    const report = await verifyInterviewProblems();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("derived 999 but the web produced 1");
  });

  it("reports a reference that will not run, whatever else is true of it", async () => {
    catalogue.push(entry("iq-legacy", ["a"]));
    answerKey["a"] = "1";
    derived.set("iq-legacy", { broken: "NameError: np" });

    const report = await verifyInterviewProblems();
    expect(report.failures[0]).toContain("NameError: np");
  });
});

describe("content authored after the freeze", () => {
  it("counts a missing oracle entry as uncovered rather than failing", async () => {
    /**
     * The line that unblocks authoring. Before, each of these produced
     * `no web answer key to compare against` — a red CI failure with no legitimate remedy.
     */
    catalogue.push(entry("iq-new", ["x", "y"]));
    derived.set("iq-new", { key: ["1", "2"] });
    specs["iq-new"] = { correct: "def f(): pass", mutants: [] };
    grades.set("iq-new", { solved: true, verdicts: [] });

    const report = await verifyInterviewProblems();
    expect(report.failures).toEqual([]);
    expect(report.uncovered).toBe(2);
    expect(report.matched).toBe(0);
  });

  it("refuses an item with no spec", async () => {
    /**
     * What stops the freeze being a hole. Without this, a post-freeze item would pass having
     * proved only that its reference executes — and "it ran" is not a claim that a wrong answer
     * fails.
     *
     * Keyed on the oracle rather than a date or a flag, because the oracle is the thing that
     * actually stops covering. An item none of whose cases the frozen key knows was authored after
     * the freeze, whatever anyone remembered to record.
     */
    catalogue.push(entry("iq-new", ["x"]));
    derived.set("iq-new", { key: ["1"] });

    const report = await verifyInterviewProblems();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("authored after the answer key was frozen");
    expect(report.failures[0]).toContain("needs a spec");
  });

  it("does not accept a snapshot in place of a spec", async () => {
    // A snapshot proves the reference still produces what it produced yesterday. It says nothing
    // about whether a wrong answer fails, so it cannot discharge the spec requirement.
    catalogue.push(entry("iq-new", ["x"], ["1"]));
    derived.set("iq-new", { key: ["1"] });

    const report = await verifyInterviewProblems();
    expect(report.failures.some((f) => f.includes("needs a spec"))).toBe(true);
  });

  it("does not demand a spec from a legacy item that gained a case", async () => {
    // The rule is about items, not cases. A legacy item is already gated by the oracle, so adding
    // a case to it does not retroactively pull it into the new standard — which matters because
    // the alternative would make any edit to the 38 a request to write 38 specs.
    catalogue.push(entry("iq-legacy", ["a", "brand-new"]));
    answerKey["a"] = "1";
    derived.set("iq-legacy", { key: ["1", "2"] });

    const report = await verifyInterviewProblems();
    expect(report.failures).toEqual([]);
    expect(report.matched).toBe(1);
    expect(report.uncovered).toBe(1);
  });
});

describe("the recorded snapshot", () => {
  it("fails when the reference's output has drifted", async () => {
    catalogue.push(entry("iq-legacy", ["a"], ["1"]));
    answerKey["a"] = "1";
    derived.set("iq-legacy", { key: ["2"] });

    const report = await verifyInterviewProblems();
    expect(report.failures.some((f) => f.includes("the recorded snapshot is 1"))).toBe(true);
  });

  it("fails when it has the wrong number of values", async () => {
    // A case added without re-deriving. Silent otherwise: the extra case simply goes unchecked by
    // the snapshot, which is the failure mode a snapshot exists to prevent.
    catalogue.push(entry("iq-legacy", ["a", "b"], ["1"]));
    answerKey["a"] = "1";
    answerKey["b"] = "2";
    derived.set("iq-legacy", { key: ["1", "2"] });

    const report = await verifyInterviewProblems();
    expect(report.failures.some((f) => f.includes("1 values for 2 cases"))).toBe(true);
  });

  it("compares exactly, with none of the oracle's spelling latitude", async () => {
    /**
     * `agrees()` accepts four spellings of one value, and exists to bridge CPython's `json.dumps`
     * drivers against Pyodide's `repr`. Both sides of a snapshot come from our own normalisation,
     * so routing it through that would let a genuine change in our output pass as a spelling
     * difference.
     */
    catalogue.push(entry("iq-legacy", ["a"], ["[1, 2]"]));
    answerKey["a"] = "[1, 2]";
    derived.set("iq-legacy", { key: ["'[1, 2]'"] });

    const report = await verifyInterviewProblems();
    // The oracle accepts the quoted form; the snapshot does not.
    expect(report.matched).toBe(1);
    expect(report.failures.some((f) => f.includes("recorded snapshot"))).toBe(true);
  });
});

describe("the timing report", () => {
  it("reports a total, not only the worst single reference", async () => {
    /**
     * The budget signal that did not exist. One sandbox, one run at a time; the spec gate adds two
     * more executions per gated item; three OS matrix legs. The number that decides whether the
     * gate needs sharding is the total, and it is wanted before the content lands rather than when
     * the smoke times out.
     */
    catalogue.push(entry("iq-a", ["a"]), entry("iq-b", ["b"]));
    answerKey["a"] = "1";
    answerKey["b"] = "1";
    derived.set("iq-a", { key: ["1"] });
    derived.set("iq-b", { key: ["1"] });
    // Both slow enough to measure. Asserting `total >= slowest` alone was vacuous — with instant
    // mocks both are zero and the assertion holds however the total is computed, which mutation
    // testing caught by deleting the accumulation and watching the test pass.
    takes.set("iq-a", 30);
    takes.set("iq-b", 30);

    const report = await verifyInterviewProblems();
    expect(report.slowestMs).toBeGreaterThan(0);
    // Strictly greater: two references took ~30ms each, so a total that merely equals the worst
    // single one is not a total.
    expect(report.totalMs).toBeGreaterThan(report.slowestMs);
    expect(report.problems).toBe(2);
  });
});
