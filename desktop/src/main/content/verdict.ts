/**
 * What an assessment can conclude.
 *
 * Its own module, and that is not tidiness. `store/interviews.ts` has to validate a verdict
 * before writing it — the column has no CHECK constraint, so this list is the only thing between
 * a typo and a stored value nothing can interpret — and importing it from `interview-assess.ts`
 * would drag the inference registry into the store layer. A store that transitively imports a
 * model client is a store that cannot be tested without one.
 *
 * One list, exported as both a value and a type, so the runtime check and the compile-time check
 * cannot disagree. Two hand-maintained copies is the arrangement `agent-event-parity.test.ts`
 * exists to police elsewhere in this codebase, and a five-item list does not need that ceremony
 * when one declaration serves both.
 */

export const VERDICTS = ["correct", "partial", "incorrect", "unknown", "too_short"] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * `unknown` is the COMMON case, not the error case.
 *
 * A model tuned for teaching ignores the requested format and coaches instead: the feedback
 * correctly identifies the flaw but carries no verdict token. Nothing manufactures a grade to
 * fill that gap, and nothing downstream may treat `unknown` as a failure to record — it is a
 * true statement about what the model did.
 *
 * `too_short` is decided locally, before any model is contacted, so it has no model attributed
 * to it. It is stored rather than skipped: a resubmission too short to grade must replace an
 * earlier verdict, or the panel would go on showing a `correct` earned by different text.
 */
export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}
