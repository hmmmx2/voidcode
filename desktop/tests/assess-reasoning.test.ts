/**
 * What the assessor does with a model that thinks.
 *
 * Nothing read Ollama's `thinking` field, so a reasoning model that spent its budget
 * deliberating emitted no chunks at all and looked silent. `parse("")` then returned
 * `{ verdict: "unknown", feedback: "" }` — and `verdict.ts` documents `unknown` as the COMMON,
 * benign case, where a teaching-tuned model coaches instead of grading. So a transport gap was
 * indistinguishable from normal behaviour, and the stored record said the model had declined to
 * grade when in fact it had never been heard.
 *
 * Measured against `qwen3:8b` at the assessor's 700-token budget, five identical calls returned
 * 503, 200, 503 … — non-deterministic, with empty feedback on the failures. With `reasoning: false`
 * they returned five verdicts.
 *
 * These tests script the provider, because the question is what sequence of chunks produces what
 * outcome, and a live model cannot be made to reproduce a specific sequence.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { __scriptProvider, completeChat } = await import("../src/main/inference/registry.js");
const { assessAnswer, TutorUnavailableError } = await import(
  "../src/main/content/interview-assess.js"
);
import type {
  ChatChunk,
  ChatRequest,
  InferenceProvider,
} from "../src/main/inference/types.js";

/** A provider that yields a fixed sequence and records what it was asked for. */
function scripted(chunks: ChatChunk[]): InferenceProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    id: "ollama",
    label: "Scripted",
    capabilities: { tools: true, grammar: true, remote: false },
    available: async () => true,
    listModels: async () => [{ id: "scripted-model" }],
    seen,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *chat(request: ChatRequest) {
      seen.push(request);
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as InferenceProvider & { seen: ChatRequest[] };
}

/** Long enough to clear the assessor's `tooShort` guard, which runs before any model is asked. */
const REAL_ANSWER =
  "Cross-entropy is preferred because its gradient with respect to the logits reduces to the " +
  "predicted probability minus the one-hot target, which does not vanish when softmax saturates.";

/** A backend that is simply not there, so no probe leaves the process. */
function absent(id: "llamacpp" | "openrouter"): InferenceProvider {
  return {
    id,
    label: id,
    capabilities: { tools: false, grammar: false, remote: id === "openrouter" },
    available: async () => false,
    listModels: async () => [],
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error(`${id} is not scripted in this test`);
    },
  } as unknown as InferenceProvider;
}

/**
 * All three backends, not just the one under test.
 *
 * `assessAnswer` calls `firstUsableModel`, which calls `availableProviders`, which probes *every*
 * provider — so leaving llama.cpp and OpenRouter real meant a loopback connect and an internet
 * round trip on each of these tests. They passed, at 500ms to 1.3s each, and began timing out once
 * the machine was busy. A unit test should not depend on what is listening on port 8080.
 */
beforeEach(() => {
  __scriptProvider("llamacpp", absent("llamacpp"));
  __scriptProvider("openrouter", absent("openrouter"));
});

afterEach(() => {
  __scriptProvider("ollama", undefined);
  __scriptProvider("llamacpp", undefined);
  __scriptProvider("openrouter", undefined);
});

describe("completeChat", () => {
  it("keeps reasoning out of the text it returns", async () => {
    /**
     * The property that makes a separate chunk kind worth having, and the one whose absence
     * would be most damaging: the assessor stores `feedback`, and a model reasoning aloud about
     * an interview question states the reference answer as a matter of course. Folding reasoning
     * into the text would put it in the store, past `redactReference`, which is a best-effort
     * filter over the *answer* and was never meant to police a transcript of deliberation.
     */
    __scriptProvider(
      "ollama",
      scripted([
        { kind: "reasoning", text: "The reference says p minus y." },
        { kind: "token", text: "VERDICT: correct" },
        { kind: "done" },
      ])
    );

    const result = await completeChat("ollama", {
      model: "scripted-model",
      messages: [{ role: "user", content: "grade this" }],
    });

    expect(result.text).toBe("VERDICT: correct");
    expect(result.text).not.toContain("p minus y");
    expect(result.reasoned).toBe(true);
  });

  it("reports that no reasoning happened, rather than leaving it unknown", async () => {
    __scriptProvider("ollama", scripted([{ kind: "token", text: "ok" }, { kind: "done" }]));

    const result = await completeChat("ollama", {
      model: "scripted-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.reasoned).toBe(false);
  });
});

describe("the assessor", () => {
  it("asks the model not to reason", async () => {
    /**
     * Asserted on the request, not the outcome. Grading wants four short fixed-format lines
     * compared against a reference already in the prompt — there is nothing to work out, and the
     * deliberation competes with the answer for the same bounded budget.
     */
    const provider = scripted([
      { kind: "token", text: "VERDICT: correct\nSUMMARY: right." },
      { kind: "done" },
    ]);
    __scriptProvider("ollama", provider);

    await assessAnswer("why-cross-entropy-not-mse", REAL_ANSWER);

    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.reasoning).toBe(false);
  });

  it("reports unavailable when the model reasoned and never answered", async () => {
    /**
     * The bug, stated as a test. This sequence used to produce a stored `unknown` with empty
     * feedback — a verdict-shaped record of an event that never happened. The learner's answer
     * is saved either way, so the honest report costs them nothing and tells them the truth.
     */
    __scriptProvider(
      "ollama",
      scripted([{ kind: "reasoning", text: "Thinking about it..." }, { kind: "done" }])
    );

    await expect(assessAnswer("why-cross-entropy-not-mse", REAL_ANSWER)).rejects.toThrow(
      TutorUnavailableError
    );
    await expect(assessAnswer("why-cross-entropy-not-mse", REAL_ANSWER)).rejects.toThrow(
      /budget reasoning/
    );
  });

  it("still returns `unknown` when the model spoke but named no verdict", async () => {
    /**
     * The case that must keep working, and the reason the check is `text === "" && reasoned`
     * rather than either half alone. A model that coaches instead of grading has genuinely
     * produced an assessment — it just did not label one, which is what `unknown` means.
     * Turning that into an error would break the documented common case.
     */
    __scriptProvider(
      "ollama",
      scripted([
        { kind: "reasoning", text: "Let me think." },
        { kind: "token", text: "Have you considered what happens when softmax saturates?" },
        { kind: "done" },
      ])
    );

    const assessment = await assessAnswer("why-cross-entropy-not-mse", REAL_ANSWER);
    expect(assessment.verdict).toBe("unknown");
    expect(assessment.feedback).toContain("softmax saturates");
  });

  it("reports unavailable for a silent model too", async () => {
    // No reasoning, no tokens. Also nothing to store, and the same honest answer — but reached
    // by the empty-text half of the condition rather than the reasoning half.
    __scriptProvider("ollama", scripted([{ kind: "done" }]));

    const assessment = await assessAnswer("why-cross-entropy-not-mse", REAL_ANSWER);
    // Documented behaviour for a genuinely empty reply: `unknown` with nothing in it. Kept as a
    // fact rather than changed here, so the reasoning case above is visibly the only new throw.
    expect(assessment.verdict).toBe("unknown");
  });

  it("never asks a model to grade an answer too short to grade", async () => {
    // The guard that runs before any model is contacted, so it works with nothing installed.
    const provider = scripted([{ kind: "token", text: "x" }, { kind: "done" }]);
    __scriptProvider("ollama", provider);

    const assessment = await assessAnswer("why-cross-entropy-not-mse", "ewfwfe");
    expect(assessment.verdict).toBe("too_short");
    expect(assessment.model).toBeNull();
    expect(provider.seen).toHaveLength(0);
  });
});
