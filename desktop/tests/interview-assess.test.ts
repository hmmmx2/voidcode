/**
 * Marking a written answer.
 *
 * The model is stubbed. What is being tested is everything around it, which is where this
 * endpoint's history of failure actually is: the web version shipped confidently grading an
 * answer nobody wrote, because the grading prompt never reached the model and the short-answer
 * guard did not exist.
 *
 * So: that a non-answer is rejected before a request is made, that the verdict is parsed out
 * of prose a real model produces rather than the format it was asked for, that `unknown` is
 * treated as ordinary, and that the reference cannot come back in the feedback.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

/** What the stubbed model will say next, and what it was asked. */
let reply = "";
let asked: Array<{ role: string; content: string }> = [];
let calls = 0;
let failWith: Error | undefined;

vi.mock("../src/main/inference/registry.js", async () => {
  class NoModelAvailableError extends Error {}
  return {
    NoModelAvailableError,
    firstUsableModel: async () => ({ provider: "ollama", model: "stub" }),
    completeChat: async (
      _provider: string,
      request: { messages: Array<{ role: string; content: string }> }
    ) => {
      calls += 1;
      asked = request.messages;
      if (failWith !== undefined) throw failWith;
      return { text: reply, model: "stub" };
    },
  };
});

const { assessAnswer, tooShort, TutorUnavailableError } = await import(
  "../src/main/content/interview-assess.js"
);
const { QUESTIONS, getQuestion, UnknownQuestionError } = await import(
  "../src/main/content/interviews.js"
);

const SLUG = QUESTIONS[0]!.slug;
const REAL_ANSWER =
  "Cross-entropy, because the log cancels the softmax Jacobian and the gradient " +
  "collapses to p minus y, which stays full strength when the model is confidently wrong.";

beforeEach(() => {
  reply = "VERDICT: correct\nSUMMARY: right for the right reason.";
  asked = [];
  calls = 0;
  failWith = undefined;
});

describe("the short-answer guard", () => {
  it("rejects a non-answer without asking the model", async () => {
    const result = await assessAnswer(SLUG, "ewfwfe");

    expect(result.verdict).toBe("too_short");
    // The whole point. The web version sent this to the model, which duly invented a
    // `random.shuffle` implementation to criticise.
    expect(calls).toBe(0);
  });

  it("rejects on words as well as characters", () => {
    // Long enough by characters, but one token — a pasted identifier, not an answer.
    expect(tooShort("supercalifragilisticexpialidocious_and_then_some_more")).toBe(true);
    expect(tooShort("short")).toBe(true);
    expect(tooShort(REAL_ANSWER)).toBe(false);
  });

  it("lets a real answer through", async () => {
    await assessAnswer(SLUG, REAL_ANSWER);
    expect(calls).toBe(1);
  });
});

describe("the prompt", () => {
  it("carries the reference, and is built here rather than by the caller", async () => {
    await assessAnswer(SLUG, REAL_ANSWER);
    const question = getQuestion(SLUG);

    expect(asked[0]!.role).toBe("system");
    expect(asked[0]!.content).toContain("You are grading");
    // No persona prepends to it. The web bug was the grading instructions being replaced
    // wholesale by a tutoring prompt, which is why this asserts the system turn is ours.
    expect(asked[0]!.content).toContain("Do not reproduce the reference answer");

    expect(asked[1]!.content).toContain(question.prompt);
    expect(asked[1]!.content).toContain(question.modelAnswer);
    expect(asked[1]!.content).toContain(REAL_ANSWER);
  });

  it("refuses an unknown question before sending anything", async () => {
    await expect(assessAnswer("no-such-question", REAL_ANSWER)).rejects.toThrow(
      UnknownQuestionError
    );
    expect(calls).toBe(0);
  });
});

describe("parsing the verdict", () => {
  it("takes the verdict and drops its line from the feedback", async () => {
    reply = "VERDICT: partial\nSUMMARY: the gradient is right, the reason is not.";
    const result = await assessAnswer(SLUG, REAL_ANSWER);

    expect(result.verdict).toBe("partial");
    // The client renders the verdict as a badge, so leaving the line in shows the same
    // word twice.
    expect(result.feedback).not.toContain("VERDICT");
    expect(result.feedback).toContain("the gradient is right");
  });

  it("survives the markdown nobody asked for", async () => {
    reply = "**VERDICT:** `incorrect`\nSUMMARY: it is the other way round.";
    expect((await assessAnswer(SLUG, REAL_ANSWER)).verdict).toBe("incorrect");
  });

  it("returns unknown when the model coaches instead of grading", async () => {
    // The common case, not the error case: the tutor model ignores the format and teaches.
    reply = "What happens to the gradient when p_true approaches zero? Work that through.";
    const result = await assessAnswer(SLUG, REAL_ANSWER);

    expect(result.verdict).toBe("unknown");
    // The feedback is the value; manufacturing a grade to fill the badge would be worse
    // than admitting there is none.
    expect(result.feedback).toContain("What happens to the gradient");
  });

  it("does not accept a verdict word it was not offered", async () => {
    reply = "VERDICT: excellent\nSUMMARY: nice work.";
    expect((await assessAnswer(SLUG, REAL_ANSWER)).verdict).toBe("unknown");
  });
});

describe("the reference cannot come back", () => {
  it("drops a line that quotes the reference verbatim", async () => {
    const question = getQuestion(SLUG);
    const quote = question.modelAnswer
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 20)
      .join(" ");

    reply = `VERDICT: partial\nSUMMARY: close.\n${quote}`;
    const result = await assessAnswer(SLUG, REAL_ANSWER);

    expect(result.feedback).not.toContain(quote);
    // Said out loud rather than silently truncated — feedback that just stops reads as a
    // model failure rather than as a deliberate removal.
    expect(result.feedback).toContain("quoted the reference answer and was removed");
    // The verdict still stands; only the quoting line went.
    expect(result.verdict).toBe("partial");
  });

  it("leaves ordinary feedback alone, including shared technical phrasing", async () => {
    reply =
      "VERDICT: partial\n" +
      "SUMMARY: you identified the gradient but not why it matters.\n" +
      "MISSING: the behaviour as the true-class probability approaches zero.\n" +
      "WRONG: nothing.";
    const result = await assessAnswer(SLUG, REAL_ANSWER);

    expect(result.feedback).toContain("MISSING");
    expect(result.feedback).not.toContain("was removed");
  });
});

describe("when the tutor is not there", () => {
  it("says so, and says the answer is saved", async () => {
    failWith = new Error("connect ECONNREFUSED 127.0.0.1:11434");

    // Every failure is the same failure to the person waiting: the marking did not happen.
    // Saying the answer is saved is the difference between a pause and apparent lost work.
    await expect(assessAnswer(SLUG, REAL_ANSWER)).rejects.toThrow(TutorUnavailableError);
    await expect(assessAnswer(SLUG, REAL_ANSWER)).rejects.toThrow(/Your answer is saved/);
  });
});
