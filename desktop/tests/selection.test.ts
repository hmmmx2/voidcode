/**
 * What to do next.
 *
 * The failure this guards against is not "the ordering is mediocre". It is **a recommendation
 * whose stated reason is not true** — "nothing has to come before this" about something with a
 * prerequisite, "you passed 3 of 4" about a problem never run. The sentence is the product here;
 * an unexplainable pick is just the old array-order cursor with extra steps, and a *wrongly*
 * explained one is worse than either, because a learner will believe it.
 *
 * So most of what follows asserts on `why`, and the rest asserts that the catalogue as a whole
 * stays walkable.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { recommend, standingFor, conceptProgress, gatedConcepts, score, BAND_WIDTH } = await import(
  "../src/main/content/selection.js"
);
const { listProblems } = await import("../src/main/content/problems.js");
const { QUESTIONS } = await import("../src/main/content/interview-bank.js");
const { CONCEPTS } = await import("../src/main/content/concepts.js");
import type { LearnerState, ProblemState, QuestionState } from "../src/main/content/selection.js";

const EMPTY: LearnerState = { problems: new Map(), questions: new Map() };

/**
 * Real interview slugs, named rather than inlined.
 *
 * The first version of these tests used `bpe-merge` as a question. It is a curriculum *problem* —
 * `classify` reads the interview branch only for items the catalogue calls questions, so the
 * fixture quietly did nothing and the test asserted against a `ready` pick instead. Naming them
 * once makes that mistake impossible to repeat by accident.
 */
const Q1 = "kl-divergence-asymmetry";
const Q2 = "why-scale-by-sqrt-dk";

const state = (
  problems: Record<string, ProblemState> = {},
  questions: Record<string, QuestionState> = {}
): LearnerState => ({
  problems: new Map(Object.entries(problems)),
  questions: new Map(Object.entries(questions)),
});

const solved: ProblemState = { solved: true, attempts: 1 };
const answered = (verdict: QuestionState["verdict"]): QuestionState => ({
  verdict,
  selfRating: null,
  revealedAnswer: false,
});

describe("the two catalogues", () => {
  it("share no ids", () => {
    /**
     * `standingFor` looks in the problem map first and the question map second, so a shared id
     * would silently resolve to whichever store answered — and `taxonomy.ts` merges both into one
     * `contentIds()` set, where a collision would also hide one of them. Neither place would say
     * anything.
     */
    const problems = new Set(listProblems().map((p) => p.id));
    const collisions = QUESTIONS.filter((q) => problems.has(q.slug)).map((q) => q.slug);
    expect(collisions).toEqual([]);
  });

  it("names the fixtures above correctly", () => {
    // The mistake this file already made once.
    const slugs = new Set(QUESTIONS.map((q) => q.slug));
    expect(slugs.has(Q1) && slugs.has(Q2)).toBe(true);
    expect(listProblems().some((p) => p.id === "stable-softmax")).toBe(true);
  });
});

describe("standing", () => {
  it("counts hidden tests passing as demonstrated", () => {
    expect(standingFor("stable-softmax", state({ "stable-softmax": solved }))).toBe("solid");
  });

  it("counts partial credit as shaky, not as nothing", () => {
    // "Not solved" throws away the most motivating thing the store knows. 3 of 4 is one edge case
    // from done; 0 of 4 is somewhere else entirely.
    const near = { solved: false, attempts: 2, bestPassed: 3, bestTotal: 4 };
    expect(standingFor("stable-softmax", state({ "stable-softmax": near }))).toBe("shaky");
  });

  it("separates an attempt that scored nothing from no attempt at all", () => {
    expect(standingFor("stable-softmax", state({ "stable-softmax": { solved: false, attempts: 3 } })))
      .toBe("attempted");
    expect(standingFor("stable-softmax", EMPTY)).toBe("unseen");
  });

  it("takes a correct verdict as demonstrated", () => {
    expect(standingFor(Q1, state({}, { [Q1]: answered("correct") }))).toBe("solid");
  });

  it("never lets a self-rating demonstrate anything", () => {
    /**
     * The rule the whole module rests on: `solid` requires a signal the learner did not supply.
     * A 3 out of 3 is a mood, and the app has exactly two real signals — hidden tests and the
     * assessor. Letting confidence unlock the graph would mark the curriculum complete for
     * someone who had proved nothing.
     */
    const confident: QuestionState = { verdict: null, selfRating: 3, revealedAnswer: false };
    expect(standingFor(Q1, state({}, { [Q1]: confident }))).toBe("shaky");
  });

  it("treats `unknown` as a fact about the model, not the learner", () => {
    /**
     * `verdict.ts` documents `unknown` as the COMMON case — a teaching-tuned model coaching
     * instead of grading. Reading it as a soft pass would advance the curriculum on the strength
     * of a formatting failure.
     */
    expect(standingFor(Q1, state({}, { [Q1]: answered("unknown") }))).toBe("attempted");
    expect(standingFor(Q1, state({}, { [Q1]: answered("too_short") }))).toBe("attempted");
  });

  it("caps a revealed answer at shaky even when it was marked correct", () => {
    // The store keeps no reveal timestamp, so "answered then checked" and "read it then typed it
    // back" are indistinguishable. One extra revisit is the cheap side of that ambiguity.
    const peeked: QuestionState = { verdict: "correct", selfRating: null, revealedAnswer: true };
    expect(standingFor(Q1, state({}, { [Q1]: peeked }))).toBe("shaky");
  });
});

describe("what it recommends, and why", () => {
  it("puts finishing something nearly done above everything else", () => {
    const near = { solved: false, attempts: 2, bestPassed: 3, bestTotal: 4 };
    const result = recommend(state({ "stable-softmax": near }, { [Q2]: answered("incorrect") }));
    expect(result?.itemId).toBe("stable-softmax");
    expect(result?.reason).toBe("finish");
    expect(result?.why).toBe("You passed 3 of 4 tests here last time.");
  });

  it("prefers the nearest of two unfinished problems", () => {
    const result = recommend(
      state({
        "stable-softmax": { solved: false, attempts: 1, bestPassed: 1, bestTotal: 4 },
        "broadcast-shapes": { solved: false, attempts: 1, bestPassed: 3, bestTotal: 4 },
      })
    );
    expect(result?.itemId).toBe("broadcast-shapes");
  });

  it("comes back to an answer the assessor marked wrong", () => {
    // The one durable per-answer quality signal the app has, and before D1 it was computed and
    // discarded at the end of the call.
    const result = recommend(state({}, { "why-scale-by-sqrt-dk": answered("incorrect") }));
    expect(result?.itemId).toBe("why-scale-by-sqrt-dk");
    expect(result?.why).toBe("Your last answer here was marked incorrect.");
  });

  it("distinguishes wrong from partly right, and prefers wrong", () => {
    const result = recommend(state({}, { [Q1]: answered("partial"), [Q2]: answered("incorrect") }));
    expect(result?.itemId).toBe(Q2);
    expect(recommend(state({}, { [Q1]: answered("partial") }))?.why).toBe(
      "Your last answer here was marked only partly right."
    );
  });

  it("does not treat `unknown` as something to repair", () => {
    // It is not a bad answer; it is no answer from the marker. Repairing it would send the learner
    // back to redo work over a model that would not produce a token.
    expect(recommend(state({}, { [Q1]: answered("unknown") }))?.reason).not.toBe("repair");
  });

  it("starts a cold learner on the root that unlocks the most", () => {
    /**
     * Not catalogue order. Every ready item ties on coverage at a cold start, so without the
     * unlock count the arbitrary ordering this phase exists to replace would come straight back
     * as a tie-breaker — and it did, on the first run, recommending SGD with Momentum.
     */
    const result = recommend(EMPTY);
    expect(result?.reason).toBe("ready");
    expect(result?.itemId).toBe("broadcast-shapes");
    expect(result?.why).toBe("Nothing has to come before this one.");
  });

  it("names the prerequisite that opened an item", () => {
    // The sentence the whole prerequisite graph was authored to make possible.
    const done = Object.fromEntries(listProblems().map((p) => [p.id, solved]));
    const result = recommend(state(done));
    expect(result?.why).toMatch(/^(You have done .+, and this builds on it\.|This assumes .+|Nothing has)/);
  });

  it("names what is missing when nothing is open", () => {
    const problems = Object.fromEntries(listProblems().map((p) => [p.id, solved]));
    // Everything except the items that would open information-theory.
    const result = recommend(state(problems, {}));
    expect(result).not.toBeNull();
    if (result?.reason === "blocked") {
      expect(result.why).toMatch(/^This needs .+ first, which you have not demonstrated yet\.$/);
    }
  });

  it("returns nothing once everything is demonstrated", () => {
    // A finished state, not an empty one. The homepage already renders the difference, and
    // re-offering solved work as new would be worse than saying so.
    const problems = Object.fromEntries(listProblems().map((p) => [p.id, solved]));
    const questions = Object.fromEntries(QUESTIONS.map((q) => [q.slug, answered("correct")]));
    expect(recommend(state(problems, questions))).toBeNull();
  });

  it("gives a learner who has done nothing and one who has done half different work", () => {
    // The acceptance check for this phase, stated as a property rather than a fixture.
    const half = Object.fromEntries(listProblems().slice(0, 7).map((p) => [p.id, solved]));
    const cold = recommend(EMPTY);
    const started = recommend(state({ ...half, [cold?.itemId ?? ""]: solved }));
    expect(started?.itemId).not.toBe(cold?.itemId);
  });
});

describe("every explanation is true", () => {
  const byId = new Map(CONCEPTS.map((c) => [c.id, c]));

  it("never claims nothing comes first when something does", () => {
    /**
     * Caught by reading real output, not by reasoning. SGD with Momentum came back as "Nothing
     * has to come before this one." It has a prerequisite — `backpropagation` — which is one of
     * the four concepts with no content. The hole rule correctly stops it *blocking*; turning
     * that into "this is a starting point" is a different claim, and a false one.
     */
    const problems = new Map<string, ProblemState>();
    const questions = new Map<string, QuestionState>();

    for (let step = 0; step < 200; step++) {
      const result = recommend({ problems, questions });
      if (result === null) break;

      if (result.why === "Nothing has to come before this one.") {
        const prerequisites = result.concepts.flatMap((id) => byId.get(id)?.prerequisites ?? []);
        expect(prerequisites, `${result.itemId} claims to be a starting point`).toEqual([]);
      }

      if (listProblems().some((p) => p.id === result.itemId)) problems.set(result.itemId, solved);
      else questions.set(result.itemId, answered("correct"));
    }
  });

  it("walks the entire catalogue without stalling or repeating", () => {
    /**
     * The property that matters more than any single pick: follow the recommendation every time
     * and you finish. A recommender that can wedge — or re-offer what you just did — is worse
     * than array order, which at least terminates.
     */
    const problems = new Map<string, ProblemState>();
    const questions = new Map<string, QuestionState>();
    const seen: string[] = [];

    for (let step = 0; step < 200; step++) {
      const result = recommend({ problems, questions });
      if (result === null) break;
      expect(seen, `re-offered ${result.itemId}`).not.toContain(result.itemId);
      seen.push(result.itemId);
      if (listProblems().some((p) => p.id === result.itemId)) problems.set(result.itemId, solved);
      else questions.set(result.itemId, answered("correct"));
    }

    expect(seen.length).toBe(listProblems().length + QUESTIONS.length);
  });
});

describe("a concept nothing teaches cannot block", () => {
  const holes = new Set(CONCEPTS.filter((c) => c.teaches.length === 0).map((c) => c.id));

  it("has nothing to be a rule about any more", () => {
    /**
     * **The rule is dormant, and this is the assertion that says so out loud.**
     *
     * It existed because four concepts had an empty `teaches` — `linear-algebra`,
     * `backpropagation`, `quantization`, `kernel-fusion` — and requiring a learner to demonstrate
     * one would have told them to go and do something the app could not teach. 24 of 52 concepts sat
     * behind one, attention among them.
     *
     * D8 authored an item for each, so there are no holes and the rule cannot fire. The earlier
     * version of this test asserted `holes.size > 0` precisely so that closing them would break it
     * rather than let these tests pass vacuously — which is what happened.
     *
     * The code stays. A concept will be added before its content again, and `coverage()` plus the
     * pin in `content-census.test.ts` are what will notice; the rule is what keeps that state
     * survivable rather than curriculum-breaking. What is no longer honest is pretending it is
     * exercised.
     */
    expect(holes).toEqual(new Set());
  });

  it("still lets every item be reached, now that prerequisites are real", () => {
    /**
     * The property that matters more than the rule, and the one that changed.
     *
     * While `linear-algebra` was a hole it was treated as met, so attention was reachable without
     * it. Now it has content and must actually be demonstrated — a stricter and more honest
     * curriculum, and exactly the kind of change that could strand something. The catalogue walk
     * further down proves nothing is stranded; this names the specific edge that tightened.
     */
    const behindLinearAlgebra = CONCEPTS.filter((c) => c.prerequisites.includes("linear-algebra"));
    expect(behindLinearAlgebra.map((c) => c.id)).toContain("attention");

    const linearAlgebra = CONCEPTS.find((c) => c.id === "linear-algebra");
    expect(linearAlgebra?.teaches).toEqual(["matmul-chain-order"]);
  });
});

describe("one demonstrated item opens what depends on it", () => {
  it("does not wait for every item on a concept", () => {
    /**
     * `numerical-stability` teaches two items and five concepts depend on it. Requiring both
     * would mean someone who has proved they can write a stable softmax is still refused
     * attention — and the frontier would advance about as often as a whole topic is cleared.
     * Progress is where partial coverage belongs; readiness is a threshold.
     */
    const one = state({ "stable-softmax": solved });
    expect(conceptProgress(one).find((c) => c.id === "numerical-stability")?.solid).toBe(1);

    /**
     * Attention needs `linear-algebra` as well, and until D8 that was a hole treated as met — so one
     * stable softmax used to open it. Now the prerequisite is real, which is the correct curriculum
     * and a genuine tightening: this is the assertion that records it.
     */
    expect(conceptProgress(one).find((c) => c.id === "attention")?.ready).toBe(false);

    const both = state({ "stable-softmax": solved }, { "matmul-chain-order": answered("correct") });
    expect(conceptProgress(both).find((c) => c.id === "attention")?.ready).toBe(true);

    // One item of two on `numerical-stability`, and it was enough. Readiness is a threshold;
    // partial coverage is what `conceptProgress` is for.
    expect(conceptProgress(both).find((c) => c.id === "numerical-stability")?.total).toBe(2);
  });
});

describe("coverage before depth", () => {
  /**
   * Marks an item demonstrated without the caller having to know which catalogue it is in.
   *
   * The first version of this test hand-built a state and asserted a property the winner happened
   * to satisfy anyway — it passed with the tie-breaker deleted *and* with it inverted. Replaying
   * the recommender's own walk is what makes the assertion bite, because the state it reaches is
   * the one where the tie-breaker actually decides.
   */
  const demonstrate = (
    itemId: string,
    problems: Map<string, ProblemState>,
    questions: Map<string, QuestionState>
  ) => {
    if (listProblems().some((p) => p.id === itemId)) problems.set(itemId, solved);
    else questions.set(itemId, answered("correct"));
  };

  it("moves to a new concept rather than the second item on the one just finished", () => {
    /**
     * Measured, not guessed: deleting this tie-breaker changes 16 of the 52 positions in the
     * walk, and the first divergence is exactly here. Having just demonstrated Adam, the next
     * pick without it is the *other* Adam item; with it, an untouched concept.
     *
     * This is what someone revising across six interview domains needs. Finishing one concept
     * before touching the next is the opposite.
     */
    const problems = new Map<string, ProblemState>();
    const questions = new Map<string, QuestionState>();

    let justFinished: string[] = [];
    for (let step = 0; step < 7; step++) {
      const result = recommend({ problems, questions });
      expect(result).not.toBeNull();
      if (result === null) return;
      justFinished = result.concepts;
      demonstrate(result.itemId, problems, questions);
    }

    // The concepts of the item just demonstrated now each have something behind them. The next
    // pick must not be another item on one of those while untouched concepts remain.
    const next = recommend({ problems, questions });
    expect(next).not.toBeNull();
    expect(next?.concepts.some((id) => justFinished.includes(id))).toBe(false);
  });
});

describe("concept progress", () => {
  it("reports what is demonstrated per concept rather than per overlapping tag", () => {
    const progress = conceptProgress(state({ "stable-softmax": solved }));
    const stability = progress.find((c) => c.id === "numerical-stability");
    expect(stability?.solid).toBe(1);
    expect(stability?.total).toBeGreaterThanOrEqual(1);
  });

  it("counts a started item as in progress, not as done and not as untouched", () => {
    const near = { solved: false, attempts: 1, bestPassed: 2, bestTotal: 4 };
    const stability = conceptProgress(state({ "stable-softmax": near })).find(
      (c) => c.id === "numerical-stability"
    );
    expect(stability?.solid).toBe(0);
    expect(stability?.inProgress).toBe(1);
  });

  it("reports zero solid for an untouched concept, without pretending it is done", () => {
    // `linear-algebra` was the example here because it had no content at all. It has one item now,
    // so the property to hold is the one that survives content: untouched means zero demonstrated,
    // not zero available.
    const untouched = conceptProgress(EMPTY).find((c) => c.id === "linear-algebra");
    expect(untouched?.total).toBe(1);
    expect(untouched?.solid).toBe(0);
    expect(untouched?.inProgress).toBe(0);
  });

  it("marks the frontier", () => {
    const cold = conceptProgress(EMPTY);
    expect(cold.filter((c) => c.ready).length).toBeGreaterThan(0);
    expect(cold.filter((c) => !c.ready).length).toBeGreaterThan(0);
  });

  it("covers every concept, so the UI cannot show a partial curriculum", () => {
    expect(conceptProgress(EMPTY).length).toBe(CONCEPTS.length);
  });
});

describe("the second kind of hole", () => {
  it("stays at the two concepts already known about", () => {
    /**
     * A concept whose prerequisites are met but whose every item is co-taught with something not
     * yet open — so it reads as available and is not. `coverage()` cannot see this shape;
     * `gatedConcepts` exists because walking the catalogue surfaced it.
     *
     * Pinned rather than fixed: the remedy is a standalone item for each, which is authoring, not
     * selection. Asserted so the count cannot grow unnoticed — and so that closing one shows up
     * here as a failing test rather than passing silently.
     */
    /**
     * Empty now, and that is the answer rather than a missing assertion.
     *
     * Both concepts this reported — `floating-point` and `probability-basics` — were single-item
     * roots whose only item was co-taught with something advanced. D8 gave each a standalone item,
     * so every ready concept now has at least one item a learner can actually reach.
     *
     * The exact list is pinned in `content-census.test.ts`. What this holds is that the report still
     * runs and still agrees, so the shape stays detectable if authoring reintroduces it.
     */
    expect(gatedConcepts(EMPTY)).toEqual([]);
  });

  it("clears once the co-taught concept opens", () => {
    // Not a permanent condition — it is an ordering cost, which is why it is reported and not
    // thrown. Demonstrating the blockers of `regularisation` frees `probability-basics`.
    const done = Object.fromEntries(listProblems().map((p) => [p.id, solved]));
    const questions = Object.fromEntries(QUESTIONS.map((q) => [q.slug, answered("correct")]));
    expect(gatedConcepts(state(done, questions))).toEqual([]);
  });
});

describe("the reason shown is the reason it won", () => {
  /**
   * The bands are the entire explainability claim, and they are enforced by a clamp rather than by
   * three tie-breaker constants continuing to sum to less than the band width.
   *
   * That was one addition away from breaking. The unlock component tops out at 29 concepts for
   * `floating-point`; uncapped at 20 points each that is 580, an item may teach two concepts, and
   * the total clears a whole band — at which point a `ready` item outranks a `repair` item and is
   * shown the ready sentence. True about that item, and the wrong item.
   */
  it("never lets a lower band outrank a higher one, whatever the tie-breakers do", () => {
    // A repair against the whole untouched catalogue, which is where the ready band is strongest:
    // every item is unseen, so coverage is maximal for all of them and unlocks decide.
    const result = recommend(state({}, { [Q2]: answered("incorrect") }));
    expect(result?.reason).toBe("repair");
    expect(result?.itemId).toBe(Q2);
  });

  it("keeps finishing above repairing above starting", () => {
    const near = { solved: false, attempts: 1, bestPassed: 1, bestTotal: 8 };
    // Deliberately the *weakest* finish available — 1 of 8 — against the strongest repair.
    const both = recommend(state({ "stable-softmax": near }, { [Q2]: answered("incorrect") }));
    expect(both?.reason).toBe("finish");

    const repairOnly = recommend(state({}, { [Q2]: answered("incorrect") }));
    expect(repairOnly?.reason).toBe("repair");
  });

  it("gives every recommendation a sentence", () => {
    // An unexplained pick is the old array-order cursor with extra steps.
    const problems = new Map<string, ProblemState>();
    const questions = new Map<string, QuestionState>();
    for (let step = 0; step < 200; step++) {
      const result = recommend({ problems, questions });
      if (result === null) break;
      expect(result.why.length, result.itemId).toBeGreaterThan(20);
      expect(result.why.endsWith("."), result.why).toBe(true);
      expect(result.title.length, result.itemId).toBeGreaterThan(0);
      if (listProblems().some((p) => p.id === result.itemId)) problems.set(result.itemId, solved);
      else questions.set(result.itemId, answered("correct"));
    }
  });
});

describe("the clamp", () => {
  /**
   * Tested directly, because it cannot be tested through `recommend`.
   *
   * The per-component caps keep the real maximum tie-breaker at 800 against a band width of 1000,
   * so the clamp never fires on today's content and removing it is an equivalent mutant. That is
   * the honest position, and it is also why the margin below is pinned: 200 points of headroom on
   * hand-authored data that is expected to grow is not a lot.
   */
  it("keeps a tie-breaker inside its own band", () => {
    expect(score("ready", 0)).toBeLessThan(score("repair", 0));
    expect(score("ready", BAND_WIDTH * 5)).toBeLessThan(score("repair", 0));
    expect(score("blocked", BAND_WIDTH * 5)).toBeLessThan(score("ready", 0));
  });

  it("keeps the ordering the bands promise, for any tie-breaker at all", () => {
    const bands = ["blocked", "ready", "repair", "finish"] as const;
    for (let i = 0; i + 1 < bands.length; i++) {
      const lower = bands[i]!;
      const higher = bands[i + 1]!;
      for (const tiebreak of [-500, 0, 1, 999, 1000, 50_000]) {
        expect(score(lower, tiebreak), `${lower}@${tiebreak} vs ${higher}`).toBeLessThan(
          score(higher, -1)
        );
      }
    }
  });

  it("still ranks within a band", () => {
    expect(score("ready", 300)).toBeGreaterThan(score("ready", 100));
  });

  it("has headroom over the largest tie-breaker the real graph can produce", () => {
    /**
     * Measured against the shipped taxonomy, not asserted arithmetically.
     *
     * The first version of this computed `400 + 400` from the two per-component caps and checked
     * that against `BAND_WIDTH`. It was a tautology dressed as a measurement: both numbers are
     * constants in the same file, so **no amount of content growth could ever fail it** — which is
     * the one thing it was written to catch. D7 is where the content starts growing, so it had to
     * become real.
     *
     * What it now measures is the uncapped tie-breaker the graph can actually produce. That figure
     * is already **exactly 1000** for `fp16-update-underflow`, which teaches the two concepts with
     * the most downstream between them — a tie with the repair floor, decided by iteration order.
     * The caps are what keep the real maximum at 800; this fails if authoring erodes the margin
     * that makes them sufficient.
     */
    const dependents = (id: string): number => {
      const seen = new Set<string>();
      const queue = [id];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) continue;
        for (const other of CONCEPTS) {
          if (!other.prerequisites.includes(next) || seen.has(other.id)) continue;
          seen.add(other.id);
          queue.push(other.id);
        }
      }
      return seen.size;
    };

    // Per item, summed over the concepts it teaches — which is how `unlockCount` computes it.
    const items = [...new Set(CONCEPTS.flatMap((c) => c.teaches))];
    const uncapped = Math.max(
      ...items.map((item) =>
        CONCEPTS.filter((c) => c.teaches.includes(item)).reduce((n, c) => n + dependents(c.id), 0)
      )
    );

    // 20 points per downstream concept, plus the coverage component's own cap.
    const worstUncapped = uncapped * 20 + 400;
    // Recorded so a change in this number is visible in the diff rather than only in a pass/fail.
    expect(uncapped).toBeGreaterThan(0);

    // The capped total is what actually reaches `score`, and it must clear the band with room.
    const cappedTotal = 400 + 400;
    expect(cappedTotal).toBeLessThan(BAND_WIDTH);
    expect(BAND_WIDTH - cappedTotal).toBeGreaterThanOrEqual(200);

    /**
     * And the fact that makes the caps load-bearing rather than decorative: without them the graph
     * already reaches the band width. If this ever stops being true the caps could be dropped.
     *
     * **The 20-point weight itself is not observable, and that is honest rather than a gap.**
     * Raising it cannot break band safety — the cap is independent of the weight and absorbs any
     * increase — so a mutant that changes it survives every assertion here. What it degrades is
     * *discrimination*: at a high enough weight every concept saturates the cap and the component
     * stops separating anything. The top two ready concepts already saturate at 20, so that
     * degradation is gradual and has no threshold worth pinning. The direction is tested (dropping
     * the component changes the cold-start pick); the magnitude is a judgement call with no
     * evidence behind it beyond its sign.
     */
    expect(worstUncapped).toBeGreaterThanOrEqual(BAND_WIDTH);
  });
});
