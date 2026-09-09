/**
 * Reading a screenshot into facts.
 *
 * The prompt is **fixed and owned by main**, for the same reason the persona is (`personas.ts`)
 * and the tool list is (`types.ts`): a renderer that can write this prompt can ask the vision
 * model anything it likes about the user's screen and get the answer back through a channel
 * whose name says "locate this in my code". The image comes from the renderer; the question
 * asked about it does not.
 *
 * Structured extraction rather than prose, because the next step is a *search*. "The screenshot
 * shows a settings dialog with a blue Save button" cannot be searched for. `["Save", "Appearance",
 * "E_MODE_DENIED"]` can. Both providers report `grammar: true` and `assertCapable` already turns
 * a provider without it into an error rather than prose where JSON was required.
 */
import { completeChat } from "../inference/registry.js";
import type { ChatMessage, ProviderId } from "../inference/types.js";
import type { ScreenshotFacts } from "./crossref.js";

/**
 * The question, verbatim and unreachable from the renderer.
 *
 * Written to discourage the failure this whole feature exists to avoid: a model asked what it
 * sees will happily describe what it *expects* to see. Naming transcription as the job, and
 * saying that guessing is worse than an empty list, is the cheapest available counterweight —
 * and the ranking downstream is what actually contains the damage when it fails anyway.
 */
const EXTRACTION_PROMPT = `You are transcribing a screenshot so its contents can be located in a source repository.

Return JSON with exactly these keys:
{
  "visibleText": [],   // every string legible in the image, in reading order, transcribed EXACTLY
  "identifiers": [],   // code-like tokens: function names, CSS classes, error codes, routes, filenames
  "uiElements": [],    // control types present, e.g. "sidebar", "modal", "tab bar"
  "errorText": null,   // any error or stack trace, verbatim, else null
  "appearance": ""     // one short paragraph describing the layout
}

Rules:
- Transcribe, do not interpret. Copy strings character for character, including case and punctuation.
- If you cannot read something, leave it out. A missing string is fine; an invented one is not.
- Do not guess at framework names, file paths, or code that is not visibly written in the image.`;

/** Nothing legible. A real answer, and the caller must be able to tell it from a failure. */
export const NO_FACTS: ScreenshotFacts = {
  visibleText: [],
  identifiers: [],
  uiElements: [],
  errorText: null,
  appearance: "",
};

/** Bounds on what comes back, because the model decides the length and we decide the cost. */
const MAX_STRINGS = 60;
const MAX_STRING_LENGTH = 200;
const MAX_APPEARANCE = 1_000;

/**
 * Coerce one field into a list of usable strings.
 *
 * Model output is *structurally* untrusted even under a JSON grammar: `json: true` guarantees
 * parseable JSON, not the shape asked for. A model that returns `visibleText: "Save"` or
 * `[{text: "Save"}]` is not misbehaving in any way worth an error — it is being a model — so
 * take what is usable and drop the rest rather than failing the whole request.
 */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return stringList([value]);
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    out.push(trimmed.slice(0, MAX_STRING_LENGTH));
    if (out.length >= MAX_STRINGS) break;
  }
  return out;
}

/**
 * Parse the model's reply into facts.
 *
 * Separated from the call so the parsing — the part with all the edge cases — is testable
 * without a model. Returns `NO_FACTS` on anything unparseable, which flows through to "I
 * couldn't find these strings in the project" rather than to an exception the user has to
 * interpret.
 */
export function parseFacts(raw: string): ScreenshotFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some models fence JSON in markdown even under a grammar. One retry at finding an object
    // is worth it; anything beyond that is guessing at the reply's structure.
    const match = /\{[\s\S]*\}/.exec(raw);
    if (match === null) return NO_FACTS;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return NO_FACTS;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return NO_FACTS;

  /**
   * An array falls through here on purpose.
   *
   * It reads as an object whose every expected key is `undefined`, so each field coerces to
   * empty and the result is `NO_FACTS` regardless. An explicit `Array.isArray` check looked
   * like a guard and was one no test could distinguish from its own absence — mutating it out
   * changed nothing — so it is gone rather than sitting here implying a case is handled that
   * was never a separate case.
   */
  const object = parsed as Record<string, unknown>;

  const errorRaw = object["errorText"];
  const errorText =
    typeof errorRaw === "string" && errorRaw.trim() !== ""
      ? errorRaw.trim().slice(0, MAX_APPEARANCE)
      : null;

  const appearanceRaw = object["appearance"];
  const appearance =
    typeof appearanceRaw === "string" ? appearanceRaw.trim().slice(0, MAX_APPEARANCE) : "";

  return {
    visibleText: stringList(object["visibleText"]),
    identifiers: stringList(object["identifiers"]),
    uiElements: stringList(object["uiElements"]),
    errorText,
    appearance,
  };
}

/** Whether the model found anything worth searching for. */
export function hasFacts(facts: ScreenshotFacts): boolean {
  return (
    facts.visibleText.length > 0 ||
    facts.identifiers.length > 0 ||
    facts.errorText !== null ||
    facts.appearance !== ""
  );
}

/**
 * Run the vision model over one image.
 *
 * The image block arrives already validated by P5's boundary schema — closed media-type enum,
 * magic bytes checked against the declared type — and consent for a remote provider is taken by
 * the caller in `chat:open`'s gate, not here. This function assumes both, because putting the
 * consent prompt inside a helper that could be called from anywhere is how a consent gate
 * quietly acquires a second, unguarded path.
 */
export async function describeScreenshot(
  providerId: ProviderId,
  model: string,
  image: { data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" },
  signal?: AbortSignal
): Promise<ScreenshotFacts> {
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACTION_PROMPT },
    {
      role: "user",
      content: [
        { type: "image", data: image.data, mediaType: image.mediaType },
        { type: "text", text: "Transcribe this screenshot as JSON." },
      ],
    },
  ];

  const { text } = await completeChat(
    providerId,
    {
      model,
      messages,
      json: true,
      // Transcription, not writing. Sampling variety here shows up as invented strings, which
      // become searches for text that was never on screen.
      temperature: 0,
    },
    signal
  );

  return parseFacts(text);
}
