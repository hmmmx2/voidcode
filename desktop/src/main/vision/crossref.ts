/**
 * Turning what a screenshot says into where it lives in the code.
 *
 * Pure, and separated from both the model and the searches for that reason: the ranking is the
 * part that decides whether this feature is trustworthy, and it should be testable against
 * hand-built hit sets rather than against a VLM's mood.
 *
 * **EXACT SEARCH FIRST, EMBEDDINGS SECOND, and that ordering is the whole reliability
 * argument.** A literal string a user can see on screen — a button label, an error code, a
 * route — is usually in the source verbatim, and a plain-text search finds it with certainty.
 * Embeddings are for the case where there is no literal to find: "the sidebar is too narrow"
 * has no string to grep for. Leading with embeddings would answer every question with a
 * plausible file, which is precisely the failure this feature must not have.
 *
 * The other rule is that **finding nothing is a real answer**. A screenshot of an app this
 * project has never seen should produce an empty list and a sentence saying so, not a
 * confident guess at a file with a similar-sounding name.
 */

/** What the vision model is asked to pull out of an image. */
export interface ScreenshotFacts {
  /** Every legible string, in reading order. The most valuable field by a distance. */
  visibleText: string[];
  /** Code-looking tokens: identifiers, class names, routes, error codes. */
  identifiers: string[];
  uiElements: string[];
  /** A stack trace or error banner, verbatim, when one is present. */
  errorText: string | null;
  /** One paragraph, for the semantic pass when there is no literal to search for. */
  appearance: string;
}

/** One result from the plain-text pass. */
export interface ExactHit {
  path: string;
  line: number;
  /** Which extracted string found it, so the reason can name it. */
  query: string;
  preview: string;
}

/** One result from the memory index. */
export interface SemanticHit {
  path: string;
  line: number;
  symbol: string | null;
  score: number;
}

export interface LocatedCandidate {
  path: string;
  line: number;
  symbol: string | null;
  /** Why this file, in words the user can check rather than a number they cannot. */
  why: string;
  /** Both passes agreed, exact only, or semantic only. */
  confidence: "high" | "medium" | "low";
}

/**
 * How many strings get their own project-wide search.
 *
 * Each one is a full walk of the project — bounded by `search.ts`, but still a walk — so a
 * screenshot yielding thirty strings would mean thirty of them. Eight covers the labels and
 * error codes that actually identify a screen, and the rest are chrome.
 */
export const MAX_EXACT_QUERIES = 8;

/**
 * Shorter than this matches everything.
 *
 * `OK`, `x`, `>` appear in every file in a project. A search for one returns the whole
 * codebase ranked by nothing, which is worse than not searching.
 */
const MIN_QUERY_LENGTH = 4;

/** Words too common in software to identify anything. */
const STOP_WORDS = new Set([
  "error",
  "warning",
  "close",
  "cancel",
  "submit",
  "save",
  "open",
  "file",
  "edit",
  "view",
  "help",
  "settings",
  "loading",
  "search",
]);

/**
 * The strings worth searching for, best first.
 *
 * Identifiers before visible text, because `E_MODE_DENIED` or `handleSubmit` identifies one
 * place in a codebase and "Submit" identifies fifty. Error text is folded in early for the same
 * reason — a stack trace names files outright.
 */
export function searchableStrings(facts: ScreenshotFacts): string[] {
  const candidates = [
    ...facts.identifiers,
    ...(facts.errorText === null ? [] : facts.errorText.split(/\n+/)),
    ...facts.visibleText,
  ];

  const seen = new Set<string>();
  const chosen: string[] = [];

  for (const raw of candidates) {
    const value = raw.trim();
    if (value.length < MIN_QUERY_LENGTH) continue;
    // Lowercased for the duplicate check only — the search itself is case-insensitive, so
    // "Submit" and "submit" would otherwise both spend a walk to find the same lines.
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    if (STOP_WORDS.has(key)) continue;
    // A whole paragraph of prose read out of a screenshot will not appear verbatim in source,
    // and searching for it is a walk that cannot succeed.
    if (value.length > 120) continue;

    seen.add(key);
    chosen.push(value);
    if (chosen.length >= MAX_EXACT_QUERIES) break;
  }

  return chosen;
}

/**
 * Merge both passes into one ranked list.
 *
 * Deduped by *path*, not by line: a file that matches in four places is one answer with a best
 * line, not four results pushing everything else off the list.
 *
 * The confidence ordering is the useful part of the output. "Both passes agreed" is a genuinely
 * different claim from "this file reads a bit like the screenshot", and collapsing them into a
 * single score would hide exactly the distinction a user needs to decide whether to trust it.
 */
export function rankCandidates(
  exact: readonly ExactHit[],
  semantic: readonly SemanticHit[],
  limit = 8
): LocatedCandidate[] {
  const byPath = new Map<
    string,
    {
      path: string;
      line: number;
      symbol: string | null;
      queries: Set<string>;
      exactCount: number;
      bestScore: number;
    }
  >();

  for (const hit of exact) {
    const entry = byPath.get(hit.path) ?? {
      path: hit.path,
      line: hit.line,
      symbol: null,
      queries: new Set<string>(),
      exactCount: 0,
      bestScore: 0,
    };
    entry.queries.add(hit.query);
    entry.exactCount += 1;
    // Earliest line wins: the first occurrence in a file is usually the definition, and later
    // ones are uses.
    if (hit.line < entry.line) entry.line = hit.line;
    byPath.set(hit.path, entry);
  }

  for (const hit of semantic) {
    const entry = byPath.get(hit.path);
    if (entry === undefined) {
      byPath.set(hit.path, {
        path: hit.path,
        line: hit.line,
        symbol: hit.symbol,
        queries: new Set<string>(),
        exactCount: 0,
        bestScore: hit.score,
      });
      continue;
    }
    // A file found both ways keeps the exact line — the string is a place, the embedding is a
    // neighbourhood — but gains the symbol name the index knows for free.
    entry.symbol = entry.symbol ?? hit.symbol;
    entry.bestScore = Math.max(entry.bestScore, hit.score);
  }

  const ranked = [...byPath.values()].map((entry) => {
    const both = entry.exactCount > 0 && entry.bestScore > 0;
    const confidence: LocatedCandidate["confidence"] = both
      ? "high"
      : entry.exactCount > 0
        ? "medium"
        : "low";

    const named = [...entry.queries].slice(0, 3).map((q) => `"${q}"`).join(", ");
    const why = both
      ? `contains ${named}, and reads like the screenshot`
      : entry.exactCount > 0
        ? `contains ${named}`
        : "reads like the screenshot, but none of its text appears here";

    return {
      path: entry.path,
      line: entry.line,
      symbol: entry.symbol,
      why,
      confidence,
      // Sorting keys, dropped below.
      _rank: both ? 2 : entry.exactCount > 0 ? 1 : 0,
      _exact: entry.exactCount,
      _score: entry.bestScore,
    };
  });

  ranked.sort(
    (a, b) => b._rank - a._rank || b._exact - a._exact || b._score - a._score || a.path.localeCompare(b.path)
  );

  return ranked.slice(0, limit).map(({ _rank, _exact, _score, ...candidate }) => candidate);
}
