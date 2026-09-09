/**
 * Screenshot in, ranked source locations out.
 *
 * The two searches are deliberately unequal partners. The exact pass is the one that can be
 * *right* — a string on screen that also exists in a file is evidence, not a similarity score.
 * The semantic pass exists for the case with no literal to find ("the sidebar is too narrow"),
 * and on its own it can only ever produce a plausible-looking file. So the exact pass runs
 * first, and a semantic-only hit is labelled as the weak thing it is rather than being averaged
 * into a number that hides the difference.
 *
 * Degrading is expected here and is not an error. The memory index is opt-in per project and
 * needs a local embedding model; most projects will not have one when a user first drags a
 * screenshot in. That case must return exact-only results, not fail.
 */
import type { WebContents } from "electron";
import { searchInFiles, NoProjectError } from "../build/search.js";
import { searchMemory } from "../memory/index.js";
import { currentProjectRoot } from "../workspace.js";
import { describeScreenshot, hasFacts } from "./describe.js";
import {
  rankCandidates,
  searchableStrings,
  type ExactHit,
  type LocatedCandidate,
  type ScreenshotFacts,
  type SemanticHit,
} from "./crossref.js";
import type { ProviderId } from "../inference/types.js";

/**
 * Matches kept per search string.
 *
 * `searchInFiles` will return up to 500. A string like `"const"` that slipped past the stop
 * list would then contribute 500 hits and bury the specific ones under sheer count — and the
 * ranking sorts on exact-hit count, so that is not a cosmetic problem. The first few
 * occurrences carry the information.
 */
const MAX_MATCHES_PER_QUERY = 20;

export interface LocateResult {
  candidates: LocatedCandidate[];
  /** What the model read off the image, so the UI can show what was actually searched for. */
  facts: ScreenshotFacts;
  /** The strings that got a search, in order. Shown when nothing matched. */
  searched: string[];
  /** True when the semantic pass could not run — no index, or no embedding model. */
  semanticUnavailable: boolean;
}

/** Nothing matched, and the caller must be able to say which strings were tried. */
function empty(facts: ScreenshotFacts, searched: string[], semanticUnavailable: boolean): LocateResult {
  return { candidates: [], facts, searched, semanticUnavailable };
}

/**
 * Stand in for the vision model, so the searches can be exercised without one.
 *
 * Everything downstream of the model — string selection, N project walks, the merge, the
 * ranking — is the part that can be wrong about a real repository, and it is unreachable in a
 * test otherwise: a vision model is a multi-gigabyte download that most machines running the
 * smoke will not have. Pinning the facts turns "does this find things in an actual project"
 * into a question that can be answered every run.
 *
 * MAIN-ONLY, and deliberately not a channel. `__setProjectRoot` is the precedent — a seam that
 * main calls directly, with nothing in `contract.ts` that would let a renderer reach it.
 */
let scriptedFacts: ScreenshotFacts | undefined;

export function __scriptFacts(facts: ScreenshotFacts | undefined): void {
  scriptedFacts = facts;
}

/**
 * The whole cross-reference.
 *
 * Sequential rather than parallel, and that is a choice about the machine rather than about
 * latency: each `searchInFiles` walks the project, and eight concurrent walks on a cold cache
 * is a lot of disk for a feature the user is watching a spinner for. Eight bounded walks in
 * series is the cheaper way to be slow.
 */
export async function locateScreenshot(
  sender: WebContents,
  options: {
    providerId: ProviderId;
    model: string;
    image: { data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };
    signal?: AbortSignal;
  }
): Promise<LocateResult> {
  /**
   * No project is a *different* answer from no match, and saying so is the point.
   *
   * Returning an empty result here made the panel say "I couldn't read any text from that
   * screenshot" when the truth was that nothing was open to search — a confidently wrong
   * explanation, which is the failure mode this feature exists to avoid, aimed at the user
   * instead of at the code. Throwing keeps the two apart.
   */
  const root = currentProjectRoot(sender);
  if (root === undefined) throw new NoProjectError();

  const facts =
    scriptedFacts ??
    (await describeScreenshot(options.providerId, options.model, options.image, options.signal));

  // The model read nothing usable off the image. Searching for its description of a blank
  // screen would return whatever the embedding index feels like, which is the guess this
  // feature must not make.
  if (!hasFacts(facts)) return empty(facts, [], true);

  const queries = searchableStrings(facts);

  const exact: ExactHit[] = [];
  for (const query of queries) {
    options.signal?.throwIfAborted();
    let result;
    try {
      result = await searchInFiles(sender, query);
    } catch {
      // One unsearchable string must not lose the other seven.
      continue;
    }
    for (const match of result.matches.slice(0, MAX_MATCHES_PER_QUERY)) {
      exact.push({ path: match.path, line: match.line, query, preview: match.preview });
    }
  }

  /**
   * The semantic query is the layout description, not the strings.
   *
   * The strings already had their exact pass; embedding them too would mostly re-find the same
   * files and inflate them to "high" confidence on the strength of one piece of evidence
   * counted twice.
   */
  const semanticQuery = [facts.appearance, ...facts.uiElements].join(" ").trim();

  let semantic: SemanticHit[] = [];
  let semanticUnavailable = false;
  if (semanticQuery === "") {
    semanticUnavailable = true;
  } else {
    try {
      const hits = await searchMemory(root, semanticQuery, 8);
      semantic = hits.map((hit) => ({
        path: hit.chunk.path,
        line: hit.chunk.startLine,
        symbol: hit.chunk.symbol,
        score: hit.score,
      }));
      // No index for this project yet. Not a failure — the primary pass already ran.
      semanticUnavailable = hits.length === 0;
    } catch {
      semanticUnavailable = true;
    }
  }

  return {
    candidates: rankCandidates(exact, semantic),
    facts,
    searched: queries,
    semanticUnavailable,
  };
}
