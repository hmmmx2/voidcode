/**
 * Marking a written interview answer against the reference.
 *
 * THE MODEL ANSWER NEVER LEAVES MAIN, AND THAT IS THE POINT.
 *
 * The obvious implementation sends the reference to the renderer and lets the existing tutor
 * panel compare locally. That would undo the whole staged reveal in one step: the answer
 * would sit in a payload for every question the moment you opened it, whether or not you
 * asked to see it. So the grading prompt is assembled here, the comparison happens here, and
 * what comes back is a verdict plus feedback. The answer text is only ever returned by
 * `interviews:reveal`, which records that you asked.
 *
 * It is also why this cannot reuse the seam's `POST /v1/chat/completions` route the way the
 * tutor panel does. That route picks a model in the *renderer* and streams tokens back to
 * it; both halves are in the wrong process for this.
 *
 * NO TUTOR PERSONA, AND THAT IS A BUG FIX INHERITED FROM THE WEB.
 *
 * The first version of the web endpoint went through the tutoring path, which keyword-detects
 * a mode and then replaces the system prompt entirely. The grading instructions never reached
 * the model, and a candidate who typed "ewfwfe" was told their `random.shuffle` implementation
 * was wrong. The system prompt below is the whole instruction set and nothing prepends to it —
 * grading is not teaching, and a persona tuned for Socratic questions pulls hard the wrong way.
 */
import { getQuestion } from "./interviews.js";
import { completeChat, firstUsableModel, NoModelAvailableError } from "../inference/registry.js";
// One declaration of the vocabulary, shared with the store, which must validate it before
// writing. See `content/verdict.ts` for why that list does not live in this file.
import type { Verdict } from "./verdict.js";
export { type Verdict } from "./verdict.js";

export interface Assessment {
  verdict: Verdict;
  feedback: string;
  /**
   * Which model produced the verdict, for the store to record beside it.
   *
   * Null for `too_short`, which is decided before any model is contacted. A verdict is only as
   * good as what produced it, and `firstUsableModel` picks whatever happens to be installed —
   * so two verdicts a month apart can come from different models, and without this nothing
   * would say which.
   */
  model: string | null;
}

/**
 * The half these helpers deal in: what the model said, before it is attributed to one.
 *
 * `parse` and `redactReference` operate on the reply text alone; which model produced it is the
 * caller's fact, and threading it through them would be a parameter neither reads.
 */
type Marking = Omit<Assessment, "model">;

export class TutorUnavailableError extends Error {
  constructor(cause: string) {
    super(`The tutor is unavailable. Your answer is saved. (${cause})`);
    this.name = "TutorUnavailableError";
  }
}

const SYSTEM = [
  "You are grading one answer to a technical interview question. You are given the question,",
  "a reference answer, and the candidate's answer.",
  "",
  "RULES",
  "- Judge ONLY the candidate's answer text as written. Do not imagine code, variables or",
  "  approaches the candidate did not mention.",
  "- If the candidate's answer is empty, nonsense, or unrelated to the question, say exactly",
  "  that. Do not invent an attempt to critique.",
  "- Do not ask the candidate questions. You are grading, not teaching.",
  "- Do not reproduce the reference answer.",
  "",
  "Reply in exactly this format:",
  "VERDICT: correct|partial|incorrect",
  "SUMMARY: one sentence on what they got right or wrong",
  "MISSING: what the reference covers that they did not (or 'nothing')",
  "WRONG: anything they stated that is untrue (or 'nothing')",
].join("\n");

/** Below this, there is no claim to grade. */
const MIN_CHARS = 40;
const MIN_WORDS = 8;

export function tooShort(answer: string): boolean {
  return answer.length < MIN_CHARS || answer.split(/\s+/).filter(Boolean).length < MIN_WORDS;
}

export async function assessAnswer(slug: string, answer: string): Promise<Assessment> {
  // Throws on an unknown slug, before anything is sent anywhere.
  const question = getQuestion(slug);
  const stripped = answer.trim();

  // Rejected here rather than sent to the model. Asking an LLM to grade "ewfwfe" invites it
  // to invent something to grade, which is exactly the failure this endpoint already had once.
  if (tooShort(stripped)) {
    return {
      verdict: "too_short",
      model: null,
      feedback:
        "There is not enough here to assess yet. Write out your actual reasoning — a few " +
        "sentences covering what you would do and why — and check it again.",
    };
  }

  let text: string;
  let reasoned: boolean;
  let graded: string;
  try {
    const { provider, model } = await firstUsableModel();
    graded = model;
    const result = await completeChat(provider, {
      model,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `QUESTION\n${question.prompt}\n\nREFERENCE ANSWER\n${question.modelAnswer}\n\nCANDIDATE ANSWER\n${stripped}`,
        },
      ],
      // Low, and bounded. Grading is not generation: a long answer here is a model that has
      // started teaching, which is the failure mode the persona note above describes.
      temperature: 0.2,
      maxTokens: 700,
      /**
       * No deliberation. The same argument as the budget above, and the reason the budget alone
       * was not enough: a reasoning model spends `maxTokens` thinking before it writes anything,
       * and against `qwen3:8b` it ran out before answering on two of three identical calls. What
       * came back was an empty assessment, stored as the benign-looking `unknown`.
       *
       * The output wanted here is four short fixed-format lines compared against a reference that
       * is already in the prompt. There is nothing to work out.
       */
      reasoning: false,
    });
    text = result.text.trim();
    reasoned = result.reasoned;
  } catch (err) {
    // Every failure is the same failure to the person waiting: the marking did not happen.
    // Their answer is already saved by `interviews:saveAttempt`, and saying so is the
    // difference between a recoverable pause and looking like lost work.
    throw new TutorUnavailableError(
      err instanceof NoModelAvailableError
        ? "no local model is available"
        : err instanceof Error
          ? err.message
          : String(err)
    );
  }

  /**
   * A model that thought and never answered has not marked anything.
   *
   * Outside the `catch` on purpose: that block turns every throw into "the marking did not
   * happen", which is the right message but would re-wrap this one for no reason.
   *
   * `parse("")` returns `{ verdict: "unknown", feedback: "" }`, and `unknown` is documented below
   * as the COMMON, benign case — a teaching-tuned model coaching instead of grading. So an empty
   * response stored as `unknown` was indistinguishable from normal behaviour, and neither was
   * distinguishable from the real cause: nothing read Ollama's `thinking` field, so a reasoning
   * model that spent its budget reasoning emitted no chunks at all and looked silent.
   *
   * `reasoned` separates the three. This one is genuinely a failure to mark rather than a
   * statement about the answer, so it reports as unavailable — the same treatment as a daemon
   * that is not running, because the learner's position is identical: their answer is saved and
   * the marking did not happen.
   *
   * Raising `maxTokens` might fix it for one model and is not the fix; a budget large enough for
   * one model's reasoning is not large enough for another's.
   */
  if (text === "" && reasoned) {
    throw new TutorUnavailableError(
      "the model spent its whole budget reasoning and produced no assessment"
    );
  }

  return { ...redactReference(parse(text), question.modelAnswer), model: graded };
}

/**
 * Pull the verdict out of the prose and drop that line from the feedback.
 *
 * The client renders the verdict as a badge, so leaving the line in shows the same word
 * twice — once as a heading and once as a label.
 *
 * `unknown` is the COMMON case, not the error case. A model tuned for teaching ignores the
 * format and coaches instead: the feedback correctly identifies the flaw but carries no
 * verdict token. `WrittenWorkspace` labels it "The tutor's read" for exactly that reason, so
 * this must not manufacture a grade to fill the gap.
 */
function parse(text: string): Marking {
  let verdict: Verdict = "unknown";
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    // Leading `*` and `#` because a model asked for `VERDICT:` frequently returns
    // `**VERDICT:**` — markdown it was never asked for, wrapping the one token being parsed.
    if (verdict === "unknown" && line.toUpperCase().replace(/^[*# ]+/, "").startsWith("VERDICT:")) {
      const value = line.split(":", 2)[1]?.trim().toLowerCase().replace(/[*`\s]/g, "") ?? "";
      for (const candidate of ["correct", "partial", "incorrect"] as const) {
        if (value.startsWith(candidate)) {
          verdict = candidate;
          break;
        }
      }
      continue;
    }
    kept.push(line);
  }

  return { verdict, feedback: kept.join("\n").trim() };
}

/** Words, lowercased, punctuation dropped — so a quote survives reformatting. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

const RUN = 12;

/**
 * Best effort against the model quoting the reference back.
 *
 * "Do not reproduce the reference answer" is an instruction, and an instruction is not a
 * control. This endpoint exists so the reference stays in main; a model that pastes a
 * paragraph of it into the feedback defeats that whether or not it was told not to. So the
 * feedback is checked for a long verbatim run of the reference and that line is dropped.
 *
 * Twelve words, deliberately long. Technical answers legitimately share phrases — "the
 * gradient of the loss with respect to the logits" is the question, not a leak — and a
 * shorter threshold would redact correct feedback. This catches wholesale reproduction, not
 * paraphrase, and does not pretend to catch a determined one.
 */
function redactReference(assessment: Marking, modelAnswer: string): Marking {
  const reference = words(modelAnswer);
  if (reference.length < RUN) return assessment;

  const runs = new Set<string>();
  for (let i = 0; i + RUN <= reference.length; i += 1) {
    runs.add(reference.slice(i, i + RUN).join(" "));
  }

  const lines = assessment.feedback.split("\n");
  const kept = lines.filter((line) => {
    const w = words(line);
    for (let i = 0; i + RUN <= w.length; i += 1) {
      if (runs.has(w.slice(i, i + RUN).join(" "))) return false;
    }
    return true;
  });

  if (kept.length === lines.length) return assessment;

  return {
    verdict: assessment.verdict,
    feedback:
      [...kept, "", "[Part of this feedback quoted the reference answer and was removed.]"]
        .join("\n")
        .trim(),
  };
}
