/**
 * What the tutor is shown, and what it is told to do with it.
 *
 * Handing a model sources does not make it cite them; it makes it *able* to. The two properties
 * worth guarding are that the right passages are found from a realistic turn — the renderer
 * prepends the problem statement and the learner's code, so most of the message is not the
 * question — and that **nothing is fabricated when retrieval misses**. A tutor that silently
 * falls back to its weights is worse than one with no sources, because the citations on its other
 * answers imply a rigour it is not applying uniformly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { groundingFor } = await import("../src/main/content/grounding.js");

const user = (content: string) => ({ role: "user", content });

/** What the renderer actually sends: problem, then code, then the question last. */
const realisticTurn = (question: string) =>
  user(
    `[PROBLEM DESCRIPTION]\nImplement scaled dot-product attention. Return the weighted values.\n\n` +
      `[SOURCE CODE]\n1 def attention(q, k, v):\n2     scores = q @ k.T\n3     return softmax(scores) @ v\n\n` +
      question
  );

describe("groundingFor", () => {
  it("finds the passage that answers the question", () => {
    const { passages, block } = groundingFor([realisticTurn("why divide by sqrt of d_k?")]);
    expect(passages.map((p) => p.sectionId)).toContain("attention-scaling");
    expect(block).toContain("attention-scaling");
  });

  it("searches the question, not the context wrapped around it", () => {
    /**
     * The reason only the last paragraph is searched.
     *
     * A learner on the attention problem asking about float16 has a message dominated by the
     * word "attention" — from the problem statement and their own code. Searching the whole
     * thing retrieves attention passages and answers a question nobody asked.
     */
    const { passages } = groundingFor([realisticTurn("what is fp16 underflow and why does it happen")]);
    expect(passages.map((p) => p.sectionId)).toContain("fp16-underflow");
    expect(passages.map((p) => p.sectionId)).not.toContain("attention-scaling");
  });

  it("returns nothing when the notes do not cover it", () => {
    // Empty rather than the least-bad passage. An irrelevant citation says the claim was
    // checked when it was not.
    const { block, passages } = groundingFor([user("what is the capital of France?")]);
    expect(passages).toEqual([]);
    expect(block).toBe("");
  });

  it("returns nothing for an empty or contentless turn", () => {
    expect(groundingFor([user("")]).block).toBe("");
    expect(groundingFor([user("   ")]).block).toBe("");
    expect(groundingFor([]).block).toBe("");
  });

  it("reads the latest question, not the first", () => {
    // A conversation moves on. Grounding the fourth turn on the first question would cite
    // whatever they opened with.
    const { passages } = groundingFor([
      user("tell me about bpe merges"),
      { role: "assistant", content: "..." },
      user("actually, how big does the kv cache get?"),
    ]);
    expect(passages.map((p) => p.sectionId)).toContain("kv-cache-size");
  });

  it("skips past a trailing assistant turn", () => {
    /**
     * The role check, which the "latest question" test above cannot exercise — its last message
     * is already the user's, so dropping the check changes nothing there.
     *
     * A caller passing history that ends on the model's reply would otherwise ground the next
     * turn on what the *model* last said, which is both wrong and self-reinforcing: the tutor
     * would retrieve sources for its own previous answer.
     */
    const { passages } = groundingFor([
      user("how does bpe decide which pair to merge?"),
      // Deliberately about something else. A first version had the assistant echo the same
      // topic, so taking the wrong turn retrieved the same passages and the check looked
      // unnecessary — the fixture defeated its own test.
      { role: "assistant", content: "Epsilon goes inside the square root, before it is taken." },
    ]);
    expect(passages.map((p) => p.sectionId)).toContain("bpe-merges");
    expect(passages.map((p) => p.sectionId)).not.toContain("layernorm-epsilon");
  });

  it("reads text out of a multimodal turn", () => {
    // The channel accepts content blocks for a vision model, and a question asked alongside an
    // image is still a question.
    const { passages } = groundingFor([
      {
        role: "user",
        content: [
          { type: "text", text: "why does layernorm add epsilon before the square root" },
          { type: "image", data: "abc", mediaType: "image/png" },
        ],
      },
    ]);
    expect(passages.map((p) => p.sectionId)).toContain("layernorm-epsilon");
  });

  it("scopes by what the learner is working on", () => {
    const question = [user("explain the scaling factor")];
    const plain = groundingFor(question);
    const scoped = groundingFor(question, "scaled-dot-product-attention");

    const before = plain.passages.find((p) => p.sectionId === "attention-scaling")?.score ?? 0;
    const after = scoped.passages.find((p) => p.sectionId === "attention-scaling")?.score ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("survives an item id the taxonomy does not know", () => {
    // Costs relevance, not correctness — the tutor is reachable without a problem open, and a
    // renderer naming something stale must not break the turn.
    expect(() => groundingFor([user("what is bpe")], "no-such-item")).not.toThrow();
    expect(groundingFor([user("how does bpe merge pairs")], "no-such-item").passages.length)
      .toBeGreaterThan(0);
  });
});

describe("the instruction block", () => {
  const block = groundingFor([user("why divide by sqrt of d_k in attention?")]).block;

  it("carries the source and the date for every passage", () => {
    // A claim with no date cannot be found later and cannot be replaced. This is the field the
    // whole corpus design turns on, so it has to reach the model.
    expect(block).toMatch(/Source: .+\. Checked \d{4}-\d{2}-\d{2}\./);
  });

  it("tells the model to cite by id, and only ids it was given", () => {
    expect(block).toContain("cite it by its bracketed id");
    expect(block).toContain("Cite only ids that appear above");
  });

  it("tells the model what to do when the passages do not cover the question", () => {
    // The instruction that stops a silent fallback to weights with a citation attached anyway.
    expect(block).toContain("do NOT cover");
    expect(block).toContain("Do not attach a citation");
  });

  it("tells the model to prefer the notes over its own recollection", () => {
    // The whole reason the corpus exists: the notes were checked and have a date, and the
    // model's training data has neither from its own point of view.
    expect(block).toContain("Prefer these over your own recollection");
  });
});
