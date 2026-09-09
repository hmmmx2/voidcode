/**
 * A design, as a specification rather than a picture.
 *
 * **The recommendation this implements: design is generated as real UI code plus a structured
 * spec, not as images.** An image generator produces mockups nobody can ship — someone still has
 * to read the picture and write the code, and every ambiguity in it is resolved twice, differently.
 * A spec composes with the rest of the platform instead: it is written by a tool the way a plan
 * is, the result renders in the live preview, and iterating on it is ordinary agent editing.
 *
 * **What makes it code rather than prose is that a section names tokens.** A spec saying
 * "a muted grey border" is a sentence someone has to interpret; one saying `color-line` is a
 * claim that can be checked against the project's own CSS — and `unknownTokens` below is that
 * check. A design naming three tokens the project does not have is a design that will not build,
 * and that is worth knowing before anyone starts rather than after.
 *
 * Shape enforced by a tool's argument schema, for the reason `plan.ts` gives at length: the
 * inference layer's `json` flag is a boolean rather than a schema, and `agent/dispatch.ts`
 * validates every tool call strictly and hands the model back its own errors.
 */

/** One part of the design — a component, a region, a state. */
export interface DesignSection {
  name: string;
  /** What it is for, and what it does. One or two sentences. */
  purpose: string;
  /**
   * Token names this section uses, without the leading dashes.
   *
   * The checkable part of the whole document. Names rather than values on purpose: a value
   * pins a colour that the project may change next week, while a name goes on being right —
   * which is the entire argument for tokens in the first place.
   */
  tokens?: string[];
  /** States, behaviour, accessibility — whatever the purpose cannot carry. */
  notes?: string[];
}

export interface DesignSpec {
  title: string;
  /** What this design is for, in a paragraph. The part a reader reads first. */
  intent: string;
  sections: DesignSection[];
}

/**
 * The persisted envelope.
 *
 * A version beside the document, following `window_workspace.state` and `plan.ts`: this shape
 * will change, and a stored document that cannot say which shape it is has to be guessed at.
 */
export const DESIGN_SPEC_VERSION = 1;

export interface StoredDesignSpec {
  version: number;
  doc: DesignSpec;
}

/**
 * Read a stored spec, or nothing.
 *
 * Total, and strict about exactly the parts a renderer would otherwise have to defend against:
 * a section with no name renders as an empty heading, and a `tokens` array holding a number
 * becomes a chip with nothing in it. Both fail by looking slightly wrong, which is the failure
 * mode that survives longest.
 */
export function parseStoredDesignSpec(value: unknown): DesignSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const outer = value as Partial<StoredDesignSpec>;
  if (outer.version !== DESIGN_SPEC_VERSION) return null;

  const doc = outer.doc;
  if (typeof doc !== "object" || doc === null) return null;
  const { title, intent, sections } = doc as Partial<DesignSpec>;
  if (typeof title !== "string" || title.length === 0) return null;
  if (typeof intent !== "string") return null;
  if (!Array.isArray(sections) || sections.length === 0) return null;

  const parsed: DesignSection[] = [];
  for (const section of sections) {
    if (typeof section !== "object" || section === null) return null;
    const s = section as Partial<DesignSection>;
    if (typeof s.name !== "string" || s.name.length === 0) return null;
    if (typeof s.purpose !== "string") return null;
    parsed.push({
      name: s.name,
      purpose: s.purpose,
      ...(isStringArray(s.tokens) ? { tokens: s.tokens } : {}),
      ...(isStringArray(s.notes) ? { notes: s.notes } : {}),
    });
  }

  return { title, intent, sections: parsed };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Which tokens this spec names that the project does not have.
 *
 * The check the whole shape exists for. A model designing against a codebase it has only partly
 * read will invent `color-primary` because that is what most codebases call it — and the panel
 * saying so is the difference between finding out now and finding out when the CSS compiles to
 * nothing.
 *
 * **Compared with leading dashes stripped on both sides**, because the two halves come from
 * different places and disagree about them: `tokens.ts` reports `color-ink` from
 * `--color-ink: …`, and a model writes whichever it saw last. That difference is not a
 * disagreement worth reporting to anyone.
 *
 * Returns names in the spec's own spelling, so a reader can find them in the document.
 */
export function unknownTokens(spec: DesignSpec, known: readonly string[]): string[] {
  const available = new Set(known.map(normaliseToken));
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const section of spec.sections) {
    for (const token of section.tokens ?? []) {
      const key = normaliseToken(token);
      // Empty after normalising — a bare `--`, or whitespace. Not a token, and not worth
      // reporting as a missing one either.
      if (key === "") continue;
      if (available.has(key) || seen.has(key)) continue;
      seen.add(key);
      missing.push(token);
    }
  }

  return missing;
}

function normaliseToken(name: string): string {
  return name.trim().replace(/^--/, "");
}
