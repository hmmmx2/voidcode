/**
 * Finding the passages a tutor answer rests on.
 *
 * The failure this guards against is not "retrieval is mediocre". It is **a citation attached to
 * an answer about something the source does not mention** — which is worse than no citation,
 * because it tells the learner the claim was checked when it was not. So most of what follows is
 * about what retrieval refuses to return.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { searchReference, validateReference, conceptsForItem, ReferenceError } = await import(
  "../src/main/content/reference-search.js"
);
const { REFERENCE } = await import("../src/main/content/reference.js");
import type { ReferenceDoc } from "../src/main/content/reference.js";

const ids = (query: string, options?: Parameters<typeof searchReference>[1]) =>
  searchReference(query, options).map((p) => p.sectionId);

describe("the corpus", () => {
  it("validates", () => {
    expect(() => validateReference()).not.toThrow();
  });

  it("gives every passage a source and a date", () => {
    // The two fields the whole design turns on. A claim with no date cannot be found later and
    // cannot be replaced — you would have to re-derive whether it is still true from scratch.
    for (const doc of REFERENCE) {
      expect(doc.source.length, doc.id).toBeGreaterThan(10);
      expect(doc.asOf, doc.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("ties every document to concepts that exist", () => {
    // Checked by validate, asserted here so a concept rename fails in CI rather than orphaning
    // a document silently.
    for (const doc of REFERENCE) expect(doc.concepts.length, doc.id).toBeGreaterThan(0);
    expect(() => validateReference()).not.toThrow();
  });
});

describe("validateReference", () => {
  const doc = (over: Partial<ReferenceDoc>): ReferenceDoc => ({
    id: "d",
    title: "T",
    source: "Some Paper (2020), §1",
    asOf: "2026-01-01",
    concepts: ["attention"],
    sections: [{ id: "s", heading: "H", body: "B" }],
    ...over,
  });

  it("refuses a document with no sections", () => {
    expect(() => validateReference([doc({ sections: [] })])).toThrow(/no sections/);
  });

  it("refuses a document with no source", () => {
    // An uncitable passage is not reference material; it is an unattributed assertion.
    expect(() => validateReference([doc({ source: "  " })])).toThrow(/no source/);
  });

  it("refuses a date that is not one", () => {
    // A date that cannot be compared makes staleness unfindable, which is this field's only job.
    for (const asOf of ["yesterday", "2026", "06-08-2026", ""]) {
      expect(() => validateReference([doc({ asOf })]), asOf).toThrow(/malformed asOf/);
    }
  });

  it("refuses an unknown concept", () => {
    expect(() => validateReference([doc({ concepts: ["not-a-concept"] })])).toThrow(
      /unknown concept/
    );
  });

  it("refuses duplicate section ids", () => {
    // Section ids reach the learner as citations, so a collision makes two different passages
    // indistinguishable in an answer.
    expect(() =>
      validateReference([
        doc({ id: "a", sections: [{ id: "same", heading: "H", body: "B" }] }),
        doc({ id: "b", sections: [{ id: "same", heading: "H", body: "B" }] }),
      ])
    ).toThrow(ReferenceError);
  });

  it("refuses an empty body", () => {
    expect(() => validateReference([doc({ sections: [{ id: "s", heading: "H", body: " " }] })])).toThrow(
      /no body/
    );
  });
});

describe("what retrieval refuses", () => {
  it("returns nothing for a question the corpus does not cover", () => {
    /**
     * The case that drove the design.
     *
     * Before the query stopword list this returned a passage about LayerNorm — because every
     * question shares `what`, `is`, `the`, `of` with the corpus, and `what` in particular is
     * *rare* there (it appears in a few headings) so IDF scored it as highly discriminating.
     * IDF measures rarity in the corpus; these words are rare there and ubiquitous in queries,
     * and those are different measurements.
     */
    expect(ids("what is the capital of France")).toEqual([]);
    expect(ids("how do I cook a risotto")).toEqual([]);
  });

  it("returns nothing for a query made only of question scaffolding", () => {
    expect(ids("what is the")).toEqual([]);
    expect(ids("how does it")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("?!...")).toEqual([]);
  });
});

describe("what retrieval finds", () => {
  it("answers the question the scale factor exists for", () => {
    /**
     * Asserts the passage is retrieved and that the attention document leads — not which of two
     * attention passages ranks first.
     *
     * The first version pinned `attention-scaling` to position one. Adding the words "scaling
     * factor" to that passage — which fixed a real miss on "explain the scaling factor" — flipped
     * it behind `attention-definition` by **0.001**. Both are correct answers and both reach the
     * tutor; a test that fails on that margin measures nothing a learner would notice, and would
     * have argued against a corpus change that was an improvement.
     */
    const results = ids("why do we divide by sqrt of d_k in attention");
    expect(results).toContain("attention-scaling");
    expect(results[0]).toMatch(/^attention-/);
  });

  it("finds the scaling passage from the words a learner would use for it", () => {
    // The corpus has to contain the vocabulary people search with, which is a content property
    // rather than a scoring one. "Scaling factor" appears nowhere in the paper's phrasing.
    expect(ids("explain the scaling factor")[0]).toBe("attention-scaling");
    expect(ids("why scale the dot product")[0]).toBe("attention-scaling");
  });

  it("keeps compound identifiers whole", () => {
    /**
     * `d_k` is the term that discriminates, and a tokenizer splitting on underscore turns it
     * into `d` and `k` — two tokens so common they carry no signal, from the one term that
     * would have found the answer.
     */
    expect(searchReference("d_k").length).toBeGreaterThan(0);
    expect(ids("kv_heads")[0]).toBe("kv-cache-size");
  });

  it("prefers the passage about the exact thing asked", () => {
    // Both LayerNorm passages match; the one about epsilon should win an epsilon question.
    expect(ids("what does epsilon do in layernorm")[0]).toBe("layernorm-epsilon");
    expect(ids("which axis does layernorm normalise over")[0]).toBe("layernorm-axis");
  });

  it("finds a passage from a symptom rather than a term", () => {
    // "why is my kernel slow" names no concept in the corpus, but arithmetic intensity is the
    // passage that answers it.
    expect(ids("why is my kernel slow")).toContain("arithmetic-intensity");
  });

  it("caps how much it returns", () => {
    expect(searchReference("attention", { limit: 2 }).length).toBeLessThanOrEqual(2);
    expect(searchReference("attention").length).toBeLessThanOrEqual(3);
  });

  it("ranks by score, best first", () => {
    const scores = searchReference("attention softmax scale").map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("the concept boost", () => {
  it("lifts passages about what the learner is working on", () => {
    const plain = searchReference("scaling factor for the dot product");
    const boosted = searchReference("scaling factor for the dot product", {
      concepts: ["attention"],
    });

    const before = plain.find((p) => p.sectionId === "attention-scaling")?.score ?? 0;
    const after = boosted.find((p) => p.sectionId === "attention-scaling")?.score ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("is a boost and not a filter", () => {
    /**
     * Someone working on attention may still ask what fp16 underflow is. A hard filter would
     * answer that from weights while sitting on a passage about it.
     */
    const results = ids("fp16 underflow master weights", { concepts: ["attention"] });
    expect(results).toContain("fp16-underflow");
  });

  it("cannot summon a passage that matches nothing", () => {
    // The boost multiplies a score; it cannot create one. A concept-tagged passage that shares
    // no term with the question stays out.
    expect(ids("capital of France", { concepts: ["attention"] })).toEqual([]);
  });
});

describe("conceptsForItem", () => {
  it("maps a problem to its concepts, for scoping a search", () => {
    expect(conceptsForItem("scaled-dot-product-attention")).toContain("attention");
    expect(conceptsForItem("bpe-merge")).toContain("tokenization");
  });

  it("returns nothing for an item the taxonomy does not know", () => {
    expect(conceptsForItem("not-an-item")).toEqual([]);
  });
});
