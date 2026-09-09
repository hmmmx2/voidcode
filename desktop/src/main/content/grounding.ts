/**
 * Putting sources in front of the tutor, and requiring it to cite them.
 *
 * ## Retrieved and injected, not offered as a tool
 *
 * The obvious design gives the tutor a `search_reference` tool. It is the wrong one here, and for
 * a reason specific to this app: **the tutor has no tools, and that is load-bearing.**
 * `personas.ts` returns an empty tool list for the tutor surface, and that is what lets both
 * assistants share a window safely — a paper's text can try as hard as it likes to talk the tutor
 * into reading a file, and there is nothing bound for it to reach. Adding one tool to fetch
 * passages would spend that property to save a round trip.
 *
 * So main retrieves before the turn starts and puts the passages in the system message. The tutor
 * gains grounding and stays toolless.
 *
 * ## The instruction is as important as the passages
 *
 * Handing a model sources does not make it cite them; it makes it *able* to. The block below says
 * what to do with them, and — the part that matters — says what to do when they do not cover the
 * question. A tutor that silently falls back to its weights when retrieval misses is worse than
 * one with no sources at all, because the citations on its other answers imply a rigour it is not
 * applying uniformly.
 */
import { searchReference, conceptsForItem, type Passage } from "./reference-search.js";

/** How many passages to put in front of the model. */
const LIMIT = 3;

export interface Grounding {
  /** Appended to the system prompt. Empty when nothing was found. */
  block: string;
  /** What was retrieved, for the caller to log or show. */
  passages: Passage[];
}

/**
 * The last thing the learner actually asked.
 *
 * The renderer prepends the problem statement and the learner's source code, so the raw turn is
 * mostly context. Searching all of it matches on whatever the problem happens to mention rather
 * than on the question — a learner working on attention who asks about float16 retrieves
 * attention passages, because the surrounding text is full of the word. That is not hypothetical;
 * it is what the first version of this did.
 *
 * **The last paragraph, not the last N characters.** A character tail was the first attempt and
 * it fails on exactly the turns that matter: a short context block fits inside the window, so the
 * whole message comes back and nothing is stripped. Paragraphs are what the renderer separates
 * its blocks with and what a person types their question as, so the boundary is real rather than
 * a number someone picked.
 *
 * The cap still exists for a single enormous paragraph — a pasted stack trace with no blank line
 * in it — where there is no structure to use.
 */
const QUESTION_CAP_CHARS = 600;

function questionFrom(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ type?: string; text?: string }> | undefined)
            ?.filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n") ?? "";

    const paragraphs = text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((block) => block !== "");
    const last = paragraphs[paragraphs.length - 1] ?? text.trim();
    return last.slice(-QUESTION_CAP_CHARS);
  }
  return "";
}

/**
 * Sources for this turn, or nothing.
 *
 * `itemId` scopes the search to what the learner is working on, through the concept graph. It is
 * optional because the tutor is reachable without a problem open, and a missing id costs
 * relevance rather than correctness.
 */
export function groundingFor(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  itemId?: string
): Grounding {
  const question = questionFrom(messages);
  if (question.trim() === "") return { block: "", passages: [] };

  const concepts = itemId === undefined ? [] : conceptsForItem(itemId);
  const passages = searchReference(question, { concepts, limit: LIMIT });
  if (passages.length === 0) return { block: "", passages: [] };

  return { block: renderBlock(passages), passages };
}

/**
 * The sources, and what to do with them.
 *
 * Each passage carries its own id, source and date, so a citation is checkable: the learner can
 * be told where a claim came from and when it was last verified, and a stale entry is findable
 * rather than a matter of re-deriving the whole thing.
 */
function renderBlock(passages: readonly Passage[]): string {
  const sources = passages
    .map(
      (p) =>
        `[${p.sectionId}] ${p.title} — ${p.heading}\n` +
        `Source: ${p.source}. Checked ${p.asOf}.\n` +
        `${p.body}`
    )
    .join("\n\n");

  return [
    "",
    "REFERENCE PASSAGES",
    "",
    "These are from the course's own reference notes. They are current as of the dates shown.",
    "",
    sources,
    "",
    "USING THEM",
    "- When one of these answers the question, say so and cite it by its bracketed id, e.g.",
    "  [attention-scaling]. Cite only ids that appear above.",
    "- Prefer these over your own recollection where they disagree. They were checked; your",
    "  training data has a date and no way to tell you what it is.",
    "- If they do NOT cover what was asked, say plainly that the notes do not cover it and answer",
    "  from your own knowledge, marked as such. Do not attach a citation to a claim these",
    "  passages do not support.",
  ].join("\n");
}
