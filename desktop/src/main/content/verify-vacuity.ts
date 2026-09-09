/**
 * Which test cases carry no weight.
 *
 * A hidden case exists to reject a wrong answer. One that a *stub* satisfies rejects nothing, and
 * it is worse than absent: it inflates "4 tests, 3 shown" into a promise the grader does not keep,
 * and `solved` requires every case to pass — so a vacuous case makes solving marginally easier
 * while looking like it makes it harder.
 *
 * ## The stub is already in the data
 *
 * Every problem ships a `template`, and a template is a signature with a docstring and no body —
 * which in Python returns `None`. So there is nothing to author: grading each problem against its
 * own starter buffer is the stub test, for every problem in the catalogue, forever, at zero
 * per-item cost — which is the point, and why no count belongs in this sentence.
 *
 * That is the whole argument for doing this before authoring 150 more items. The mutant gate is
 * stronger — it proves a *plausible* wrong answer fails, not merely an empty one — but it costs
 * 20–40 minutes of design per item. This costs nothing per item and covers everything.
 *
 * ## What it proves, and what it does not
 *
 * It proves a case rejects `None`. It does not prove the case rejects a wrong answer that tries.
 * Both checks belong; neither substitutes for the other. `verify-interviews.ts` states its own
 * limit in the same terms, and this file is held to that standard.
 *
 * ## Reported and pinned, not thrown
 *
 * The house pattern, following `taxonomy.ts`'s `coverage()` and `selection.ts`'s `gatedConcepts`:
 * a curriculum gap is an argument for the next authoring batch, not a reason for the app to refuse
 * to start. The suite pins the count, which is where the pressure to close it belongs — and which
 * makes closing one show up as a failing test rather than passing silently.
 */
import { gradeSubmission, derivedKeyOrReason } from "../exec/grader.js";
import { listProblems, getProblem } from "./problems.js";
import { INTERVIEW_PROBLEMS } from "./interview-problems.js";
import type { Problem } from "./problems.js";

export interface VacuityCensus {
  /** How many cases were examined. */
  cases: number;
  /**
   * Case ids a stub satisfies that could be made to reject one, `problemId/caseId`.
   *
   * These are the actionable ones: the case has a real expected value and still lets a body-less
   * function through. Sorted, so a diff names what changed.
   */
  vacuous: string[];
  /**
   * Cases a stub satisfies because the correct answer *is* a null result.
   *
   * Reported apart from `vacuous` because no authoring can fix them, and counting them together
   * would make the headline number drift upward for justified reasons until it stopped being a
   * signal. `iq-implement-auc-4` (AUC undefined when a class is absent) and
   * `iq-weighted-distribution-moments-all-zero` (no distribution to describe) are both cases whose
   * whole point is that the honest answer is nothing — and "return nothing" is what a template with
   * no body already does.
   *
   * The right response is not to change the contract. Returning a sentinel so the case discriminates
   * would make the API worse to teach a test something. The hidden cases beside them carry the
   * weight, `solved` still requires every case, and the mutant gate is where a plausible wrong
   * answer gets caught.
   */
  unavoidable: string[];
  /**
   * Problems whose own template failed to run at all.
   *
   * Distinct from a vacuous case and more serious: a template that raises is one a learner is
   * handed as a starting point, and it means the buffer they open is broken before they type.
   */
  brokenTemplates: string[];
}

/** Both catalogues. A vacuous case is a vacuous case wherever it lives. */
function everyProblem(): Problem[] {
  const curriculum = listProblems()
    .map((p) => getProblem(p.id))
    .filter((p): p is Problem => p !== undefined);
  return [...curriculum, ...INTERVIEW_PROBLEMS.map(({ problem }) => problem)];
}

/**
 * Grade every problem against its own template and report what still passed.
 *
 * Sequential because the sandbox runs one job at a time (`exec/host.ts`) — a `Promise.all` here
 * would not be faster, it would queue the same work while making the timing report meaningless.
 */
export async function censusVacuousCases(
  problems: readonly Problem[] = everyProblem()
): Promise<VacuityCensus> {
  const vacuous: string[] = [];
  const unavoidable: string[] = [];
  const brokenTemplates: string[] = [];
  let cases = 0;

  for (const problem of problems) {
    const stub = await gradeSubmission(problem, problem.template);

    if (stub.referenceBroken !== undefined) {
      // The reference, not the template. A different bug, and `verify-interviews.ts` already
      // reports it — recorded here rather than silently skipped so the counts stay honest.
      brokenTemplates.push(`${problem.id}: reference broken — ${stub.referenceBroken}`);
      continue;
    }

    /**
     * A template that raises on *every* case is broken, not strict.
     *
     * A stub returning `None` should fail cases by comparing wrongly, which surfaces as a failed
     * verdict. If instead every case carries an `error`, the buffer the learner is handed does not
     * run — usually a missing import in the template that the reference has.
     */
    const errored = stub.verdicts.filter((v) => v.error !== undefined).length;
    if (errored === stub.verdicts.length && stub.verdicts.length > 0) {
      brokenTemplates.push(
        `${problem.id}: template raised on every case — ${stub.verdicts[0]?.error ?? "no reason given"}`
      );
      continue;
    }

    // Counted only past the two bail-outs above, because `cases` means "examined for vacuity" and
    // a problem whose template never ran was not examined. Counting them would report coverage of
    // exactly the problems this census learned nothing about.
    cases += problem.cases.length;

    if (!stub.verdicts.some((v) => v.passed)) continue;

    /**
     * The answer key, to tell an actionable vacuous case from an unavoidable one.
     *
     * Derived rather than read off the verdicts: `CaseVerdict.expected` is populated only for
     * visible cases, and every vacuous case found so far has been hidden. `derivedKeyOrReason`
     * caches, so this is not a second full execution for problems the caller has already graded.
     */
    const key = await derivedKeyOrReason(problem);
    const expected = "broken" in key ? [] : key.key;

    stub.verdicts.forEach((verdict, index) => {
      if (!verdict.passed) return;
      const id = `${problem.id}/${verdict.id}`;
      // `None` is what a body-less template returns, so a case whose correct answer is `None` can
      // never reject one. That is a property of the contract, not a weakness in the case.
      if (expected[index] === "None") unavoidable.push(id);
      else vacuous.push(id);
    });
  }

  return {
    cases,
    vacuous: vacuous.sort(),
    unavoidable: unavoidable.sort(),
    brokenTemplates,
  };
}
