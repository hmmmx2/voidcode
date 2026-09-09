/**
 * What to do next, and why.
 *
 * Before this, "what next" was `dashboard.ts` taking the first unsolved problem in array order.
 * That is not a recommendation, it is a cursor: it ignores that you got 3 of 4 cases on something,
 * that an assessor marked an answer incorrect, and that the graph now knows what has to come
 * first.
 *
 * ## Explainable by construction, not by explanation
 *
 * There is no learned ranker here and there should not be: one user, no cross-user data, no IRT.
 * More to the point, a score a learner cannot argue with is a score they cannot act on.
 *
 * So the reason is not derived from the score afterwards — **the reason produces the score.** Each
 * candidate is matched against four situations in priority order, the first that fits sets its
 * band, and tie-breakers only move an item *within* its band. Whatever wins therefore carries the
 * sentence that made it win, and that sentence is a fact about stored data rather than a summary
 * of arithmetic.
 *
 * ## Solid means a signal the learner did not supply
 *
 * The only proficiency-shaped numbers in this app are hidden-test results, assessor verdicts, and
 * a self-rating the learner types themselves. The first two are evidence; the third is a mood.
 * `solid` — the standing that removes an item from consideration and unlocks what depends on it —
 * requires one of the first two. A self-rating can say "attempted"; it can never say "known".
 *
 * `unknown` is not evidence either, and that is not a technicality: `verdict.ts` documents it as
 * the *common* case, produced when a teaching-tuned model coaches instead of grading. It says
 * something about the model and nothing about the learner, and treating it as a soft pass would
 * quietly mark the curriculum complete on the strength of a formatting failure.
 *
 * ## A concept nothing teaches cannot block
 *
 * A concept with an empty `teaches` is treated as met. The rule came from measuring rather than
 * reasoning, and it is worth keeping the measurement because **it does not fire today**: D8 closed
 * every hole, so `coverage().conceptsWithoutContent` is empty and this branch is currently inert.
 * `tests/selection.test.ts` asserts that emptiness rather than assuming it — its earlier version
 * asserted the opposite, deliberately, so that closing the holes would break it and force this note
 * to be rewritten. This is that rewrite.
 *
 * **What it was measured against.** While `linear-algebra`, `backpropagation`, `quantization` and
 * `kernel-fusion` taught nothing, most of the concept graph — including attention, the most
 * important thing in the catalogue — sat behind one of them.
 *
 * **The harm was not unreachability.** That was the first version of this note and it was wrong;
 * mutation testing caught it. Removing the rule left every item reachable, because the `blocked`
 * band eventually picks them. What changed was the size of `blocked`, and that each newly blocked
 * item arrived carrying *"This needs Linear Algebra first, which you have not demonstrated yet"* —
 * an instruction with nothing behind it, because there was no Linear Algebra content. The learner
 * could not act on it, could not find what was missing, and had been told the curriculum expected
 * something of them it did not offer.
 *
 * So the rule is about honesty rather than reachability: you cannot be required to prove something
 * on material that does not exist. **It stays because the next authoring gap recreates the
 * situation**, and a hole reappearing should not also require rediscovering why holes are harmless
 * to the frontier and harmful to the instruction text. `coverage()` and `gatedConcepts` below are
 * what report the gap when there is one; counts live in `tests/content-census.test.ts`.
 */
import { CONCEPTS, type Concept } from "./concepts.js";
import { taxonomy } from "./taxonomy.js";
import { listProblems } from "./problems.js";
import { QUESTIONS } from "./interview-bank.js";
import type { Verdict } from "./verdict.js";

/** What the store knows about a curriculum problem. */
export interface ProblemState {
  solved: boolean;
  attempts: number;
  /** The furthest any submission got. Absent when nothing has been run. */
  bestPassed?: number;
  bestTotal?: number;
}

/** What the store knows about an interview question. */
export interface QuestionState {
  /** Null means never assessed — distinct from `unknown`, which means the model declined. */
  verdict: Verdict | null;
  selfRating: number | null;
  revealedAnswer: boolean;
}

export interface LearnerState {
  problems: ReadonlyMap<string, ProblemState>;
  questions: ReadonlyMap<string, QuestionState>;
}

/**
 * How far along one item is.
 *
 * Four values rather than solved/unsolved, because the three middle states want different things
 * from the recommender: `shaky` should come back soon, `attempted` should come back eventually,
 * and `unseen` is where coverage grows.
 */
export type Standing = "unseen" | "attempted" | "shaky" | "solid";

export type Reason = "finish" | "repair" | "ready" | "blocked";

export interface Recommendation {
  itemId: string;
  kind: "problem" | "question";
  title: string;
  reason: Reason;
  /** One sentence, stating the stored fact that chose this. */
  why: string;
  /** The concepts this item teaches, for the UI to show what it is worth. */
  concepts: string[];
}

export interface ConceptProgress {
  id: string;
  name: string;
  category: Concept["category"];
  /** Items that teach it. Zero for a known hole. */
  total: number;
  solid: number;
  /** Started but not demonstrated — `shaky` and `attempted` together. */
  inProgress: number;
  /** Whether its prerequisites are met, so the UI can show the frontier. */
  ready: boolean;
}

/** Both catalogues, since both are things a learner does. */
function titles(): Map<string, { title: string; kind: "problem" | "question" }> {
  const map = new Map<string, { title: string; kind: "problem" | "question" }>();
  for (const problem of listProblems()) map.set(problem.id, { title: problem.title, kind: "problem" });
  for (const question of QUESTIONS) map.set(question.slug, { title: question.title, kind: "question" });
  return map;
}

/**
 * How far along one item is, from whatever the store has.
 *
 * The interview branch is where the judgement is. `correct` is the only verdict that demonstrates
 * anything, `unknown` deliberately demonstrates nothing, and a self-rating tops out at `shaky` no
 * matter how confident it is.
 *
 * **A revealed answer caps the item at `shaky` even when the verdict is `correct`.** The store
 * keeps no reveal timestamp, so there is no way to tell "answered, then checked" from "gave up,
 * read it, typed it back" — and only the second is worth catching. Scheduling one extra revisit is
 * the cheap side of that ambiguity; recording recall that never happened is the expensive one.
 */
export function standingFor(itemId: string, state: LearnerState): Standing {
  const problem = state.problems.get(itemId);
  if (problem !== undefined) {
    if (problem.solved) return "solid";
    // Partial credit on the hidden cases. Real evidence, just not enough of it.
    if (problem.bestTotal !== undefined && (problem.bestPassed ?? 0) > 0) return "shaky";
    return problem.attempts > 0 ? "attempted" : "unseen";
  }

  const question = state.questions.get(itemId);
  if (question === undefined) return "unseen";

  if (question.verdict === "correct") return question.revealedAnswer ? "shaky" : "solid";
  if (question.verdict === "partial" || question.verdict === "incorrect") return "shaky";
  // `too_short` and `unknown`: they turned up, and nothing was established about them.
  if (question.verdict !== null) return "attempted";

  return question.selfRating === null ? "unseen" : "shaky";
}

/** A concept is met when something that teaches it has been demonstrated — or nothing does. */
function metConcepts(state: LearnerState): Set<string> {
  const met = new Set<string>();
  for (const concept of CONCEPTS) {
    // The hole rule. See the header: without it, 17 items are recommended with an
    // instruction the learner has no way to follow.
    if (concept.teaches.length === 0) {
      met.add(concept.id);
      continue;
    }
    if (concept.teaches.some((item) => standingFor(item, state) === "solid")) met.add(concept.id);
  }
  return met;
}

/**
 * One demonstrated item, not all of them.
 *
 * "Every item solid" sounds stricter and is worse: several concepts teach four or five items, so
 * the frontier would advance about as often as someone clears a whole topic, and a learner who has
 * proved they can do scaled dot-product attention would still be told they may not look at causal
 * masking. One verified success is the least evidence that means anything, and the *progress*
 * numbers — reported separately — are where partial coverage belongs.
 */
function unmetPrerequisites(concept: Concept, met: ReadonlySet<string>): string[] {
  return concept.prerequisites.filter((id) => !met.has(id));
}

/** Bands, not weights. A tie-breaker must never lift an item out of the band its reason set. */
const BAND: Record<Reason, number> = {
  finish: 4000,
  repair: 3000,
  ready: 2000,
  blocked: 1000,
};

export const BAND_WIDTH = 1000;

/**
 * Place a candidate inside its band, and make leaving it impossible.
 *
 * The bands are the whole explainability claim: the reason a learner is shown must be the reason
 * the item won. A tie-breaker that overflowed would silently break that — a `ready` item scoring
 * 3160 would beat a `repair` item at 3000 and then be shown the *ready* sentence, which is a true
 * statement about the wrong item.
 *
 * That was one addition away from happening. Measured over the real graph, the largest tie-breaker
 * any item can produce with the per-component caps removed is **exactly 1000** —
 * `fp16-update-underflow`, which teaches `floating-point` (29 transitive dependents) and
 * `mixed-precision` (1). At the band width, a `ready` item ties the `repair` floor and the winner
 * becomes iteration order.
 *
 * The caps below keep the real maximum at 800, so this clamp does not currently fire, and no test
 * over today's content can make it fire — deleting it is an equivalent mutant, honestly. It stays
 * because the margin is 200 points on hand-authored data that is expected to grow, three constants
 * have to keep summing correctly for it to hold, and nothing else in the file said so. The clamp is
 * unit-tested directly, and `selection.test.ts` pins the margin so a content change that eats it
 * fails loudly rather than silently reordering the bands.
 */
export function score(reason: Reason, tiebreak: number): number {
  return BAND[reason] + Math.min(Math.max(tiebreak, 0), BAND_WIDTH - 1);
}

/**
 * What to do next, or null when everything is demonstrated.
 *
 * Null rather than a made-up suggestion: the homepage already renders a finished state, and it is
 * a better answer than re-offering solved work as though it were new.
 */
export function recommend(state: LearnerState): Recommendation | null {
  const graph = taxonomy();
  const met = metConcepts(state);
  const names = titles();

  let best: { score: number; recommendation: Recommendation } | null = null;

  for (const [itemId, { title, kind }] of names) {
    const standing = standingFor(itemId, state);
    if (standing === "solid") continue;

    const concepts = graph.conceptsFor(itemId);
    const blockers = concepts.flatMap((c) => unmetPrerequisites(c, met));

    const { reason, why, tiebreak } = classify(itemId, kind, concepts, blockers, met, state);
    const total = score(reason, tiebreak);

    if (best === null || total > best.score) {
      best = {
        score: total,
        recommendation: { itemId, kind, title, reason, why, concepts: concepts.map((c) => c.id) },
      };
    }
  }

  return best?.recommendation ?? null;
}

/**
 * Which situation an item is in, and the sentence that says so.
 *
 * Order is the priority. Finishing something nearly done beats repairing something wrong, which
 * beats starting something new, which beats starting something whose groundwork is missing.
 */
function classify(
  itemId: string,
  kind: "problem" | "question",
  concepts: readonly Concept[],
  blockers: readonly string[],
  met: ReadonlySet<string>,
  state: LearnerState
): { reason: Reason; why: string; tiebreak: number } {
  const problem = state.problems.get(itemId);

  // 1. Nearly done. The store already knows how near, and saying the number is the whole point:
  //    "3 of 4" is a reason to sit back down, "unsolved" is not.
  if (problem?.bestTotal !== undefined && (problem.bestPassed ?? 0) > 0) {
    const passed = problem.bestPassed ?? 0;
    const total = problem.bestTotal;
    return {
      reason: "finish",
      // Closest to done wins, scaled to stay inside the band.
      tiebreak: Math.round((passed / total) * 900),
      why: `You passed ${String(passed)} of ${String(total)} tests here last time.`,
    };
  }

  // 2. Marked wrong by the assessor. The one durable per-answer quality signal the app has, and
  //    before D1 it was computed and thrown away.
  const question = kind === "question" ? state.questions.get(itemId) : undefined;
  if (question?.verdict === "incorrect" || question?.verdict === "partial") {
    return {
      reason: "repair",
      tiebreak: question.verdict === "incorrect" ? 500 : 400,
      why:
        question.verdict === "incorrect"
          ? "Your last answer here was marked incorrect."
          : "Your last answer here was marked only partly right.",
    };
  }

  // 3. Groundwork missing. Named, because "not yet" is not actionable and "you have not done
  //    backpropagation, and this needs it" is.
  if (blockers.length > 0) {
    const missing = blockers[0] ?? "";
    return {
      reason: "blocked",
      // Fewest missing pieces first: it is the nearest thing to available.
      tiebreak: Math.max(0, 900 - blockers.length * 100),
      why: `This needs ${nameOf(missing)} first, which you have not demonstrated yet.`,
    };
  }

  // 4. Open.
  return {
    reason: "ready",
    /**
     * Two components, both bounded so neither can push an item out of its band.
     *
     * **Coverage**: an item teaching a concept with nothing behind it beats a fourth item on a
     * concept already demonstrated.
     *
     * **Unlocks**: how much of the graph opens up behind this concept. Without it every ready
     * item ties at a cold start and catalogue order decides — which is the arbitrary ordering
     * this phase exists to replace, quietly reinstated as a tie-breaker. It is also the one
     * ranking the prerequisite edges were authored to support: the thing most other things
     * depend on is where to start.
     */
    tiebreak:
      Math.max(0, 400 - solidCount(concepts, state) * 100) +
      Math.min(400, unlockCount(concepts) * 20),
    why: openingSentence(concepts, met),
  };
}

/**
 * Why this one is open, in a sentence that is true.
 *
 * Three cases rather than two, and the third was a bug caught by reading real output: SGD with
 * Momentum came back as "Nothing has to come before this one." It has a prerequisite —
 * `backpropagation` — which at the time was one of four concepts with no content. The hole rule
 * correctly stops it blocking, but silently turning "we cannot teach this yet" into "this is a
 * starting point" is a false claim about the curriculum, and precisely the kind a learner would
 * believe.
 *
 * All four have content now, and `content-census.test.ts` asserts `conceptsWithoutContent` is empty —
 * so the *example* is history while the rule is not. The third case still fires for any concept whose
 * prerequisites are unteachable, which is a state authoring can re-enter at any time.
 */
function openingSentence(concepts: readonly Concept[], met: ReadonlySet<string>): string {
  const prerequisites = concepts.flatMap((c) => c.prerequisites);
  if (prerequisites.length === 0) return "Nothing has to come before this one.";

  const graph = taxonomy();
  const opener = prerequisites.find(
    (id) => met.has(id) && (graph.concepts.get(id)?.teaches.length ?? 0) > 0
  );
  if (opener !== undefined) return `You have done ${nameOf(opener)}, and this builds on it.`;

  // Everything it rests on is a hole. Say so — `coverage()` already records the gap, and this is
  // the one place a learner would otherwise be told the opposite.
  return `This assumes ${nameOf(prerequisites[0] ?? "")}, which the curriculum does not cover yet.`;
}

/**
 * How many concepts sit downstream of these, transitively.
 *
 * Computed against the static graph, so it is memoised per concept — `recommend` asks for every
 * candidate and the answer cannot change between calls.
 */
const unlocks = new Map<string, number>();

function unlockCount(concepts: readonly Concept[]): number {
  let total = 0;
  for (const concept of concepts) {
    const cached = unlocks.get(concept.id);
    if (cached !== undefined) {
      total += cached;
      continue;
    }

    const seen = new Set<string>();
    const queue = [concept.id];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      for (const other of CONCEPTS) {
        if (!other.prerequisites.includes(id) || seen.has(other.id)) continue;
        seen.add(other.id);
        queue.push(other.id);
      }
    }

    unlocks.set(concept.id, seen.size);
    total += seen.size;
  }
  return total;
}

/** How much of these concepts is already demonstrated, for the coverage tie-breaker. */
function solidCount(concepts: readonly Concept[], state: LearnerState): number {
  let count = 0;
  for (const concept of concepts) {
    for (const item of concept.teaches) if (standingFor(item, state) === "solid") count += 1;
  }
  return count;
}

/** A concept's human name, falling back to the id so an explanation is never blank. */
function nameOf(conceptId: string): string {
  return taxonomy().concepts.get(conceptId)?.name ?? conceptId;
}

/**
 * Concepts that are open but have nothing you can actually do yet.
 *
 * A second kind of hole, and `coverage()` cannot see it: the concept has content and its own
 * prerequisites are met, but **every item teaching it also teaches something whose prerequisites
 * are not**. So it reads as available and is not.
 *
 * Found by walking the whole catalogue rather than by inspection. Two concepts are in this shape
 * today — `floating-point` and `probability-basics`, both roots with a single item that is
 * co-taught with an advanced concept — and the effect is that a root cannot be demonstrated until
 * unrelated work is done. Nothing breaks: the `blocked` band eventually picks the item and says
 * honestly what is missing. The ordering is just worse than the graph implies.
 *
 * Reported rather than thrown, for the same reason `coverage()` is: it is an argument for the next
 * authoring batch — a standalone item for each of those roots — not a reason to refuse to start.
 * The test suite asserts on it so the count cannot grow unnoticed.
 */
export function gatedConcepts(state: LearnerState): string[] {
  const graph = taxonomy();
  const met = metConcepts(state);
  const isReady = (id: string): boolean =>
    (graph.concepts.get(id)?.prerequisites ?? []).every((prerequisite) => met.has(prerequisite));

  return CONCEPTS.filter(
    (concept) =>
      concept.teaches.length > 0 &&
      isReady(concept.id) &&
      concept.teaches.every((item) => graph.conceptsFor(item).some((other) => !isReady(other.id)))
  ).map((concept) => concept.id);
}

/**
 * Per-concept progress, replacing counts that overlap and do not sum.
 *
 * `dashboard.ts` reports per-category `{total, solved}` where a problem tagged both DL and LLM
 * counts in each — deliberately, and documented, but it answers "how much DL is there" rather than
 * "what do I know". These do the second: a concept, what it is worth, and whether it is open.
 */
export function conceptProgress(state: LearnerState): ConceptProgress[] {
  const met = metConcepts(state);

  return CONCEPTS.map((concept) => {
    let solid = 0;
    let inProgress = 0;
    for (const item of concept.teaches) {
      const standing = standingFor(item, state);
      if (standing === "solid") solid += 1;
      else if (standing !== "unseen") inProgress += 1;
    }

    return {
      id: concept.id,
      name: concept.name,
      category: concept.category,
      total: concept.teaches.length,
      solid,
      inProgress,
      ready: unmetPrerequisites(concept, met).length === 0,
    };
  });
}
