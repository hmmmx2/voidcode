/**
 * The gate for the 38 interview problems, and for every one authored after them.
 *
 * ## What this used to be, and why it had to change
 *
 * These problems arrived from a web platform where they had already run on Judge0 against the same
 * cases, so the values it produced were known. Re-deriving every answer key here and comparing
 * against those values checked the whole conversion at once — the dedented class, the recovered
 * arguments, the replayed output transform — against an oracle that was never ours to get wrong.
 *
 * That was the right gate for a port, and it is not a gate for authoring. **D0 retired the
 * generator that produced `interview-answer-key.ts`**, so a newly written question has no entry,
 * and a missing entry was a hard failure: `no web answer key to compare against`, once per case.
 * Authoring one question produced five or six red failures on three CI platforms, and the only way
 * to green them was to hand-type values into a file whose own header forbids exactly that.
 *
 * So the oracle is frozen rather than removed, and three assertions that need no oracle take over.
 * See `verify-spec.ts` for what they are and why the second is *stronger* than the key it replaces.
 *
 * ## The derivation was never the problem
 *
 * Worth stating because it inverts the obvious plan. `derivedKeyOrReason` already executes every
 * reference in the real Pyodide sandbox, and always did — a different interpreter from the CPython
 * that produced the key, which is the one thing no oracle can check. Nothing had to be built to
 * derive keys locally. What was missing was something to *assert* about a derived key once there was
 * no oracle to compare it to.
 *
 * ## The standard applies from the first new item
 *
 * An item is "legacy" exactly when the frozen oracle covers its cases. Anything else was authored
 * after the freeze, and must carry a spec — a correct variant and a named mutant. Without that rule
 * the freeze would be a hole: new content would pass with nothing checked but "the reference runs".
 *
 * The 38 legacy items are deliberately **not** backfilled. Their hidden cases were inherited rather
 * than designed against named traps, so retrofitting means first discovering which of the 126 are
 * vacuous — weeks of remediation that unblocks nothing. `verify-vacuity.ts` covers them cheaply and
 * more weakly, which is the honest trade.
 */
import { derivedKeyOrReason } from "../exec/grader.js";
import { INTERVIEW_PROBLEMS } from "./interview-problems.js";
import { WEB_ANSWER_KEY, KNOWN_DIVERGENCES } from "./interview-answer-key.js";
import { INTERVIEW_SPECS } from "./verify-interview-specs.js";
import { verifyAgainstSpecs } from "./verify-spec.js";
import type { Problem } from "./problems.js";

export interface InterviewVerification {
  problems: number;
  cases: number;
  /** Cases whose derived key agrees with the frozen legacy oracle. */
  matched: number;
  /**
   * Cases the frozen oracle does not cover — content authored after the freeze.
   *
   * Reported rather than failed. This number growing is normal and expected; what would not be
   * normal is an uncovered item without a spec, which `failures` catches.
   */
  uncovered: number;
  /** Items carrying a correct variant and a named mutant. */
  gated: number;
  failures: string[];
  /** Slowest whole-reference derivation, including sandbox handoff. */
  slowestMs: number;
  /**
   * Total wall time across every derivation.
   *
   * The budget signal that matters for CI and did not exist. The sandbox runs one job at a time
   * (`exec/host.ts`), the spec gate adds two more executions per gated item, and this runs on three
   * OS matrix legs — so the number to watch as content grows is the total, not the worst single
   * reference. Measured before authoring rather than discovered when the smoke times out.
   */
  totalMs: number;
}

/**
 * `print(x)` and `repr(x)` are the same text for numbers, lists and None — but not for
 * strings, where the `json.dumps` drivers printed `[1, 2]` and a repr gives `'[1, 2]'`.
 * Same value, different spelling, so both are accepted.
 *
 * The multi-print driver is handled by the same rule: its normaliser returns a list of the
 * components, and the web printed them one per line.
 *
 * **Legacy comparisons only.** A `derivedKey` snapshot is produced by our own normalisation on both
 * sides, so it is compared with `===`; routing it through here would let a real change in our output
 * pass as a spelling difference.
 */
function agrees(derived: string, web: string): boolean {
  if (derived === web) return true;
  if (derived === JSON.stringify(web)) return true;
  if (derived === `'${web}'`) return true;

  // Multi-line: the driver printed each component of a returned tuple on its own line.
  const lines = web.split("\n");
  if (lines.length > 1 && derived.startsWith("[") && derived.endsWith("]")) {
    return derived === `[${lines.join(", ")}]`;
  }
  return false;
}

/** Interview problems are not in `listProblems()`; the gate needs its own lookup. */
function interviewProblem(id: string): Problem | undefined {
  return INTERVIEW_PROBLEMS.find(({ problem }) => problem.id === id)?.problem;
}

export async function verifyInterviewProblems(): Promise<InterviewVerification> {
  const failures: string[] = [];
  let cases = 0;
  let matched = 0;
  let uncovered = 0;
  let slowestMs = 0;
  let totalMs = 0;

  for (const entry of INTERVIEW_PROBLEMS) {
    const { problem } = entry;
    const startedAt = Date.now();
    const result = await derivedKeyOrReason(problem);
    const elapsed = Date.now() - startedAt;
    slowestMs = Math.max(slowestMs, elapsed);
    totalMs += elapsed;

    if ("broken" in result) {
      // The reference itself failed to run. Always our bug, never a learner's — and the
      // reason is carried, because "did not execute" is not something anyone can act on.
      failures.push(`${problem.id}: ${result.broken}`);
      continue;
    }
    const derived = result.key;

    /**
     * The snapshot, for content the oracle does not cover.
     *
     * Regression detection still needs a committed value — "the reference's output changed" is
     * otherwise unnoticeable. It lives on the wrapper rather than on `Problem` so that
     * `exec/grader.ts`, which imports only `type { Problem }`, *cannot* reach it. That makes "the
     * grader never grades against a hand-typed value" structural rather than a convention someone
     * has to remember, the same firewall `derivePlot` gets from its narrow parameter type.
     */
    if (entry.derivedKey !== undefined) {
      entry.derivedKey.forEach((snapshot, index) => {
        const key = derived[index] ?? "";
        // Exact. Both sides came from our own normalisation, so a difference is a difference.
        if (key !== snapshot) {
          failures.push(
            `${problem.id} case ${index}: derived ${key} but the recorded snapshot is ${snapshot}`
          );
        }
      });
      if (entry.derivedKey.length !== derived.length) {
        failures.push(
          `${problem.id}: snapshot has ${entry.derivedKey.length} values for ${derived.length} cases`
        );
      }
    }

    let legacyCases = 0;
    problem.cases.forEach((problemCase, index) => {
      cases += 1;
      const web = WEB_ANSWER_KEY[problemCase.id];
      if (web === undefined) {
        // Authored after the freeze. Not a failure — see `uncovered`.
        uncovered += 1;
        return;
      }
      legacyCases += 1;

      const key = derived[index] ?? "";
      if (agrees(key, web)) {
        matched += 1;
        return;
      }

      const excuse = KNOWN_DIVERGENCES[problemCase.id];
      if (excuse !== undefined) {
        matched += 1;
        return;
      }

      failures.push(`${problemCase.id}: derived ${key} but the web produced ${web}`);
    });

    /**
     * New content must carry a spec. This is what makes "required from item #1" real.
     *
     * Keyed on the oracle rather than on a date or a flag, because the oracle is the thing that
     * actually stops covering: an item none of whose cases the frozen key knows was authored after
     * the freeze, whatever anyone remembered to write down.
     *
     * A snapshot is not a substitute. It proves the reference still produces what it produced
     * yesterday; it says nothing about whether a wrong answer fails.
     */
    if (legacyCases === 0 && INTERVIEW_SPECS[problem.id] === undefined) {
      failures.push(
        `${problem.id}: authored after the answer key was frozen, so it needs a spec in ` +
          `verify-interview-specs.ts — a correct variant and one named mutant`
      );
    }
  }

  const specFailures = await verifyAgainstSpecs(
    INTERVIEW_SPECS,
    interviewProblem,
    "interview problem"
  );
  failures.push(...specFailures);

  return {
    problems: INTERVIEW_PROBLEMS.length,
    cases,
    matched,
    uncovered,
    gated: Object.keys(INTERVIEW_SPECS).length,
    failures,
    slowestMs,
    totalMs,
  };
}
