/**
 * The concept graph, and the invariants that make it usable.
 *
 * `concepts.ts` is hand-authored, so every failure here is an authoring mistake rather than a
 * logic bug — and each one is silent without a check. A prerequisite naming a renamed concept, a
 * cycle added by one edge, a `teaches` pointing at a deleted problem: none of them throw on their
 * own. They produce a graph that walks wrong and an ordering that skips something.
 *
 * The invariants are ported from the web repo's `features/taxonomy.py`, which had already worked
 * out which ones matter. The cycle test asserts the *message names the cycle*, because "the graph
 * is cyclic" sends you through every edge and `a -> b -> a` does not.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { validate, taxonomy, coverage, TaxonomyError, MIN_CONCEPTS } = await import(
  "../src/main/content/taxonomy.js"
);
const { CONCEPTS, CONCEPT_CATEGORIES } = await import("../src/main/content/concepts.js");
const { listProblems } = await import("../src/main/content/problems.js");
const { QUESTIONS } = await import("../src/main/content/interview-bank.js");
import type { Concept } from "../src/main/content/concepts.js";

/** A minimal valid graph, for tests that break exactly one thing about it. */
const graph = (...concepts: Array<Partial<Concept> & { id: string }>): Concept[] =>
  concepts.map((c) => ({
    name: c.id,
    category: "foundations" as const,
    summary: "s",
    prerequisites: [],
    teaches: [],
    ...c,
  }));

/** Enough concepts to clear the floor, so a test about something else is not about the count. */
const padded = (...concepts: Array<Partial<Concept> & { id: string }>): Concept[] => [
  ...graph(...concepts),
  ...graph(...Array.from({ length: MIN_CONCEPTS }, (_, i) => ({ id: `pad-${String(i)}` }))),
];

describe("the authored graph", () => {
  it("validates", () => {
    // The one that matters. Everything below tests the checker; this tests the content.
    expect(() => validate()).not.toThrow();
  });

  it("has every content item taught by at least one concept", () => {
    /**
     * The property that makes concept-aware ordering possible at all.
     *
     * An item no concept claims still works — you can open and solve it — but it is invisible to
     * anything that orders by concept, so it would silently never be recommended.
     */
    expect(coverage().itemsWithoutConcept).toEqual([]);
  });

  it("records exactly the concepts that have no content yet", () => {
    /**
     * The permanent property: the report is derived from the data rather than maintained beside it.
     *
     * There used to be a `length > 0` here as well, to stop this passing vacuously while four
     * concepts had no content. D8 closed all four, so that guard became false — and the count now
     * belongs in `content-census.test.ts`, which pins it at zero and is the file an authoring batch
     * edits. Keeping the guard would have meant asserting the curriculum still had a hole.
     */
    expect(coverage().conceptsWithoutContent).toEqual(
      CONCEPTS.filter((c) => c.teaches.length === 0).map((c) => c.id)
    );
  });

  it("covers both halves of the curriculum", () => {
    // Curriculum problems and interview questions are different surfaces but both are things a
    // learner does, so both are taxonomy items. Counts live in `content-census.test.ts`.
    const taught = new Set(CONCEPTS.flatMap((c) => c.teaches));
    for (const problem of listProblems()) expect(taught.has(problem.id), problem.id).toBe(true);
    for (const question of QUESTIONS) expect(taught.has(question.slug), question.slug).toBe(true);
  });

  it("has real prerequisite structure, not a flat list", () => {
    // A taxonomy with no edges is a tag rename. The edges are the whole point.
    const withPrereqs = CONCEPTS.filter((c) => c.prerequisites.length > 0);
    expect(withPrereqs.length).toBeGreaterThan(CONCEPTS.length / 2);
    // And genuine depth, not one layer of roots plus one layer of leaves.
    const deepest = Math.max(...CONCEPTS.map((c) => taxonomy().ancestors(c.id).size));
    expect(deepest).toBeGreaterThanOrEqual(4);
  });

  it("uses only declared categories", () => {
    for (const concept of CONCEPTS) {
      expect(Object.keys(CONCEPT_CATEGORIES), concept.id).toContain(concept.category);
    }
  });
});

describe("validate", () => {
  it("refuses an unknown prerequisite", () => {
    // The commonest authoring mistake: a concept renamed, an edge left pointing at the old id.
    expect(() => validate(padded({ id: "a", prerequisites: ["nope"] }))).toThrow(TaxonomyError);
    expect(() => validate(padded({ id: "a", prerequisites: ["nope"] }))).toThrow(/nope/);
  });

  it("refuses an unknown category", () => {
    expect(() =>
      validate(padded({ id: "a", category: "astrology" as never }))
    ).toThrow(/unknown category/);
  });

  it("refuses a concept that is its own prerequisite", () => {
    // A self-edge is a cycle of length one, and the DFS would find it — but the message this
    // gives names the mistake rather than describing a loop.
    expect(() => validate(padded({ id: "a", prerequisites: ["a"] }))).toThrow(/own prerequisite/);
  });

  it("refuses a duplicate id", () => {
    // Built by hand rather than `new Map(concepts.map(...))`, which would keep the last of a
    // pair and leave the graph a concept short with nothing said.
    expect(() => validate(padded({ id: "a" }, { id: "a" }))).toThrow(/duplicate/);
  });

  it("refuses a teaches entry naming no real item", () => {
    // The check the web taxonomy did not need. Content can be renamed in the same commit that
    // renames a concept, and this is what catches the half of it that was forgotten.
    expect(() => validate(padded({ id: "a", teaches: ["not-a-problem"] }))).toThrow(
      /unknown item not-a-problem/
    );
  });

  it("accepts a teaches entry for either kind of item", () => {
    const problem = listProblems()[0]?.id;
    const question = QUESTIONS[0]?.slug;
    expect(problem).toBeDefined();
    expect(question).toBeDefined();
    expect(() =>
      validate(padded({ id: "a", teaches: [problem as string, question as string] }))
    ).not.toThrow();
  });

  it("refuses a graph too small to be one", () => {
    // Catches a truncated or half-written file, which is what the floor is for — not a quality
    // bar on how many concepts a curriculum ought to have.
    expect(() => validate(graph({ id: "a" }))).toThrow(/concepts/);
  });

  describe("cycles", () => {
    it("refuses a two-concept cycle and names it", () => {
      const cyclic = padded(
        { id: "a", prerequisites: ["b"] },
        { id: "b", prerequisites: ["a"] }
      );
      expect(() => validate(cyclic)).toThrow(TaxonomyError);
      // The detail that makes the failure fixable rather than a hunt.
      expect(() => validate(cyclic)).toThrow(/cyclic: .*a.*->.*b.*->.*a|cyclic: .*b.*->.*a.*->.*b/);
    });

    it("refuses a longer cycle", () => {
      const cyclic = padded(
        { id: "a", prerequisites: ["b"] },
        { id: "b", prerequisites: ["c"] },
        { id: "c", prerequisites: ["a"] }
      );
      expect(() => validate(cyclic)).toThrow(/cyclic/);
    });

    it("accepts a diamond, which is not a cycle", () => {
      /**
       * The shape a naive "have I seen this node" check rejects.
       *
       * `d` is reached twice, by two different paths, and that is a perfectly ordinary
       * prerequisite graph — `normalisation-layers` depends on both `feature-scaling` and
       * `backpropagation`, which share ancestors. Only grey-on-the-current-path is a cycle.
       */
      expect(() =>
        validate(
          padded(
            { id: "a", prerequisites: ["b", "c"] },
            { id: "b", prerequisites: ["d"] },
            { id: "c", prerequisites: ["d"] },
            { id: "d" }
          )
        )
      ).not.toThrow();
    });
  });
});

describe("graph queries", () => {
  it("returns transitive prerequisites", () => {
    // `normalisation-layers` needs backpropagation, which needs matrix-calculus, which needs
    // linear-algebra — so the walk has to go past the first hop.
    const ancestors = taxonomy().ancestors("normalisation-layers");
    expect(ancestors.has("backpropagation")).toBe(true);
    expect(ancestors.has("matrix-calculus")).toBe(true);
    expect(ancestors.has("linear-algebra")).toBe(true);
  });

  it("returns nothing for a root", () => {
    expect(taxonomy().ancestors("tensor-shapes").size).toBe(0);
  });

  it("does not include the concept itself", () => {
    expect(taxonomy().ancestors("attention").has("attention")).toBe(false);
  });

  it("orders every prerequisite before its dependents", () => {
    // The property the whole graph exists to provide.
    const order = taxonomy().topological();
    expect(order).toHaveLength(CONCEPTS.length);

    const position = new Map(order.map((c, i) => [c.id, i]));
    for (const concept of CONCEPTS) {
      for (const prerequisite of concept.prerequisites) {
        expect(
          (position.get(prerequisite) ?? -1) < (position.get(concept.id) ?? -1),
          `${prerequisite} must come before ${concept.id}`
        ).toBe(true);
      }
    }
  });

  it("finds every concept that teaches an item", () => {
    // Some items are taught by more than one concept, which is correct: `expectation-of-dropout`
    // is both a probability exercise and a regularisation one.
    expect(taxonomy().conceptsFor("scaled-dot-product-attention").map((c) => c.id)).toContain(
      "attention"
    );
    expect(taxonomy().conceptsFor("expectation-of-dropout").length).toBeGreaterThan(1);
    expect(taxonomy().conceptsFor("not-an-item")).toEqual([]);
  });
});
