/**
 * The gate a content item passes to be trusted, and the one shape it takes.
 *
 * Extracted from `verify-curriculum.ts`, unchanged in substance. It was written for five
 * curriculum problems ported together; the interview problems need exactly the same three
 * assertions, and `gradeSubmission` already applies each problem's own `normalise`, so nothing
 * about them needs special casing.
 *
 * ## The three assertions, and why they need no oracle
 *
 * **The reference executes.** Cheap and the most valuable check for new content: the header of
 * `interview-problems.ts` records four distinct ways a ported reference failed to run — a dedented
 * class, `self` surviving into a free function, a missing import — and says every one of them
 * "failed silently first".
 *
 * **A correct-but-differently-written solution is accepted.** This is what replaces an oracle, and
 * for new content it is *stronger* than the answer key ever was. The key was produced by the same
 * source as the reference, so agreement proved the port was faithful — never that the reference was
 * right. Two independent implementations agreeing proves rather more.
 *
 * **A named mutant is rejected by a named case.** The requirement that carries the weight: naming
 * the case forces the author to say which case catches the trap, which forces a case to have been
 * designed for it. `top-p-sampling` has an `unsorted` case that exists for no other reason.
 *
 * ## One mutant per item, not one per hidden case
 *
 * Stated plainly because the alternative is tempting and unreachable. "Every hidden case proven
 * non-vacuous" is not what this delivers and would cost weeks; `verify-vacuity.ts` covers all cases
 * cheaply and more weakly. This proves that *one* named misconception per item is genuinely caught.
 */
import { gradeSubmission } from "../exec/grader.js";
import type { Problem } from "./problems.js";

export interface Spec {
  /** A correct solution written differently from the reference. */
  correct: string;
  /** `[label, source, the case id that must reject it]`. */
  mutants: Array<[string, string, string]>;
  /**
   * Cross-check against values an earlier source shipped, where known.
   *
   * A cross-check on a port, **never the key** — the key is always derived by executing the
   * reference. Only the five originally-ported curriculum problems have one, and nothing new
   * should acquire one: there is no upstream left to agree with.
   */
  seed?: Record<string, string>;
}

/**
 * Run the gate over a table of specs.
 *
 * `resolve` rather than a problem map, because the two catalogues are reached differently:
 * curriculum problems come from `getProblem`, interview problems from `INTERVIEW_PROBLEMS`. Passing
 * the lookup keeps this module ignorant of both.
 *
 * `label` prefixes the log lines so a run of two tables says which is speaking.
 */
export async function verifyAgainstSpecs(
  specs: Record<string, Spec>,
  resolve: (id: string) => Problem | undefined,
  label: string
): Promise<string[]> {
  const failures: string[] = [];

  for (const [id, spec] of Object.entries(specs)) {
    const problem = resolve(id);
    if (problem === undefined) {
      failures.push(`${label} '${id}' missing`);
      continue;
    }

    const good = await gradeSubmission(problem, spec.correct);
    if (good.referenceBroken !== undefined) {
      failures.push(good.referenceBroken);
      continue;
    }

    console.log(
      `[smoke] ${id}: ` +
        good.verdicts
          .filter((v) => v.visible)
          .map((v) => `${v.id}=${v.expected}`)
          .join("  ")
    );

    if (!good.solved) {
      failures.push(
        `${id}: correct variant rejected — ${good.verdicts
          .filter((v) => !v.passed)
          .map((v) => `${v.id} got=${v.actual ?? v.error}`)
          .join("; ")}`
      );
    }

    // Agreement with the original content is a cross-check on the port, never the key.
    for (const [caseId, expected] of Object.entries(spec.seed ?? {})) {
      const got = good.verdicts.find((v) => v.id === caseId)?.expected;
      if (got !== expected) {
        failures.push(`${id}/${caseId}: derived ${got}, original content had ${expected}`);
      }
    }

    for (const [mutantLabel, source, caseId] of spec.mutants) {
      /**
       * The named case must exist, and that is checked before the mutant is run.
       *
       * Without it a typo in the case id makes the assertion vacuous in the worst way: `caught`
       * is false, so it reports "not caught by the xyz case" — a failure that reads as a content
       * bug and is actually a typo in the gate. Naming the real problem is the difference between
       * a five-minute fix and an afternoon spent doubting a good hidden case.
       */
      if (!problem.cases.some((c) => c.id === caseId)) {
        failures.push(`${id}: "${mutantLabel}" names case ${caseId}, which does not exist`);
        continue;
      }

      const bad = await gradeSubmission(problem, source);
      const caught = bad.verdicts.some((v) => v.id === caseId && !v.passed);
      if (bad.solved || !caught) {
        failures.push(`${id}: "${mutantLabel}" not caught by the ${caseId} case`);
      } else {
        console.log(`[smoke] ${id}: rejected "${mutantLabel}"`);
      }
    }
  }

  return failures;
}
