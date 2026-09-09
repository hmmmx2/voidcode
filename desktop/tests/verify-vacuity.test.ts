/**
 * The census that finds cases carrying no weight.
 *
 * These tests do not run the real sandbox — `censusVacuousCases` takes its problems as an argument
 * precisely so its logic can be exercised against hand-built ones. The real run happens in
 * `npm run smoke`, where a Pyodide sandbox exists; what is checked here is that the census draws the
 * right conclusion from a grade, which is the part that can be wrong silently.
 *
 * **The count lives in `content-census.test.ts`, not in this paragraph.** It read "1 vacuous case of
 * 272" for long enough that both numbers had moved — the catalogue is 308 cases now and the actionable
 * count is 0 — which is the argument against restating a measurement in prose at all.
 *
 * The finding worth keeping is not the number. I had predicted two vacuous cases, expecting
 * `iq-implement-grad-clip-4` (key `[]`) alongside `iq-implement-auc-4` (key `None`). Only the second
 * was: a stub returns `None`, `None` is not `[]`, and that case rejects it correctly. The difference
 * between "keys that look empty" and "keys a stub actually produces" is the whole reason to measure
 * rather than reason, and it is why the census exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

/** Grades, scripted per submission, so the census can be driven without a sandbox. */
const grades = new Map<string, unknown>();
/**
 * Answer keys, so the census can tell an actionable vacuous case from an unavoidable one.
 *
 * A case whose correct answer is `None` can never reject a body-less template, because returning
 * nothing is what one does. That is a property of the contract, not a weak case.
 */
const keys = new Map<string, string[]>();

vi.mock("../src/main/exec/grader.js", () => ({
  gradeSubmission: (problem: { id: string }) => Promise.resolve(grades.get(problem.id)),
  derivedKeyOrReason: (problem: { id: string }) =>
    Promise.resolve({ key: keys.get(problem.id) ?? [] }),
}));

const { censusVacuousCases } = await import("../src/main/content/verify-vacuity.js");
import type { Problem } from "../src/main/content/problems.js";

const problem = (id: string, caseIds: string[]): Problem =>
  ({
    id,
    template: "def f():\n    ...\n",
    cases: caseIds.map((c) => ({ id: c, args: [], visible: false, label: c })),
  }) as unknown as Problem;

const verdict = (id: string, passed: boolean, error?: string) => ({
  id,
  label: id,
  visible: false,
  passed,
  elapsedMs: 1,
  ...(error === undefined ? {} : { error }),
});

beforeEach(() => {
  grades.clear();
  keys.clear();
});

describe("what counts as vacuous", () => {
  it("names a case the stub passed", async () => {
    grades.set("p", { verdicts: [verdict("a", false), verdict("b", true)] });
    keys.set("p", ["1", "2"]);
    const census = await censusVacuousCases([problem("p", ["a", "b"])]);
    expect(census.vacuous).toEqual(["p/b"]);
    expect(census.unavoidable).toEqual([]);
    expect(census.cases).toBe(2);
  });

  it("says nothing when every case rejects the stub", async () => {
    grades.set("p", { verdicts: [verdict("a", false), verdict("b", false)] });
    const census = await censusVacuousCases([problem("p", ["a", "b"])]);
    expect(census.vacuous).toEqual([]);
  });

  it("qualifies the id with the problem, so two cases named alike stay distinct", async () => {
    // Interview case ids are positional (`Hidden 1`), so `p/hidden-1` and `q/hidden-1` are
    // different cases with the same suffix. A bare case id would collapse them in the pinned list.
    grades.set("p", { verdicts: [verdict("hidden-1", true)] });
    grades.set("q", { verdicts: [verdict("hidden-1", true)] });
    keys.set("p", ["1"]);
    keys.set("q", ["1"]);
    const census = await censusVacuousCases([problem("p", ["hidden-1"]), problem("q", ["hidden-1"])]);
    expect(census.vacuous).toEqual(["p/hidden-1", "q/hidden-1"]);
  });

  it("sorts, so the pinned list does not churn", async () => {
    grades.set("b", { verdicts: [verdict("x", true)] });
    grades.set("a", { verdicts: [verdict("y", true)] });
    keys.set("b", ["1"]);
    keys.set("a", ["1"]);
    const census = await censusVacuousCases([problem("b", ["x"]), problem("a", ["y"])]);
    expect(census.vacuous).toEqual(["a/y", "b/x"]);
  });
});

describe("templates that do not run", () => {
  it("reports a template that raised on every case, rather than calling it strict", async () => {
    /**
     * The distinction that makes this worth separating. A stub should fail by comparing wrongly.
     * If instead every case errors, the buffer the learner is handed does not run at all — usually
     * an import the reference has and the template does not — and counting that as "no vacuous
     * cases" would report the healthiest possible result for a broken problem.
     */
    grades.set("p", {
      verdicts: [verdict("a", false, "NameError: np"), verdict("b", false, "NameError: np")],
    });
    const census = await censusVacuousCases([problem("p", ["a", "b"])]);
    expect(census.brokenTemplates).toHaveLength(1);
    expect(census.brokenTemplates[0]).toContain("raised on every case");
    expect(census.brokenTemplates[0]).toContain("NameError: np");
    // Not counted, because nothing was measured about them.
    expect(census.cases).toBe(0);
  });

  it("does not report a template that raised on only some cases", async () => {
    // Normal. A stub returning `None` errors wherever `normalise` touches the value and compares
    // wrongly elsewhere; that is a working template meeting strict cases.
    grades.set("p", { verdicts: [verdict("a", false, "TypeError"), verdict("b", false)] });
    const census = await censusVacuousCases([problem("p", ["a", "b"])]);
    expect(census.brokenTemplates).toEqual([]);
    expect(census.cases).toBe(2);
  });

  it("reports a broken reference separately, and stops measuring that problem", async () => {
    grades.set("p", { referenceBroken: "SyntaxError", verdicts: [] });
    const census = await censusVacuousCases([problem("p", ["a"])]);
    expect(census.brokenTemplates[0]).toContain("reference broken");
    expect(census.cases).toBe(0);
    expect(census.vacuous).toEqual([]);
  });
});

describe("vacuity a contract makes unavoidable", () => {
  /**
   * Found on content authored in D8, which is the census working as intended.
   *
   * `weighted-distribution-moments` returns `None` when the weights total zero — there is no
   * distribution, and inventing a uniform one would hide the bug a masked-out sampler produces. A
   * template with no body also returns `None`, so that case cannot reject a stub however it is
   * written. `iq-implement-auc-4` has exactly the same shape: AUC is undefined when a class is
   * absent.
   *
   * Reported apart rather than fixed. Returning a sentinel so the case discriminates would make the
   * API worse to teach a test something, and the mutant gate is where a plausible wrong answer is
   * caught. Counting them with the actionable ones would let the headline number drift upward for
   * justified reasons until it stopped being a signal.
   */
  it("separates a case whose correct answer is a null result", async () => {
    grades.set("p", { verdicts: [verdict("real", true), verdict("null-case", true)] });
    keys.set("p", ["42", "None"]);

    const census = await censusVacuousCases([problem("p", ["real", "null-case"])]);
    expect(census.vacuous).toEqual(["p/real"]);
    expect(census.unavoidable).toEqual(["p/null-case"]);
  });

  it("does not excuse a case merely because some other case is null", async () => {
    // Indexed, not "does this problem have any null answers". A problem with one legitimate null
    // case must not launder its weak ones through it.
    grades.set("p", { verdicts: [verdict("weak", true)] });
    keys.set("p", ["0"]);

    const census = await censusVacuousCases([problem("p", ["weak"])]);
    expect(census.vacuous).toEqual(["p/weak"]);
    expect(census.unavoidable).toEqual([]);
  });

  it("treats a broken reference as no excuse at all", async () => {
    // No key means no evidence that the answer is null, so the case stays actionable. The broken
    // reference is reported separately by the interview gate.
    grades.set("p", { verdicts: [verdict("a", true)] });
    const census = await censusVacuousCases([problem("p", ["a"])]);
    expect(census.vacuous).toEqual(["p/a"]);
  });
});
