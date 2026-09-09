/**
 * Finding the passages a tutor answer should rest on.
 *
 * ## Lexical, not embedded — and this is a departure worth stating
 *
 * The plan for this phase said to reuse `memory/`: its chunker, its `nomic-embed-text` client and
 * its brute-force vector scan. That is the right call for the Build index, which covers *the
 * user's whole project* — thousands of files, arbitrary prose, no shared vocabulary.
 *
 * It is the wrong call here, for two reasons that only became clear once the corpus existed.
 *
 * **The corpus is 25 passages.** Semantic search earns its complexity on recall problems — many
 * documents, many ways to phrase the same thing. At this size a term-overlap score with IDF
 * finds the right passage, and the failure mode of getting it wrong is one irrelevant citation
 * rather than a missed answer.
 *
 * **The dependency is the real objection.** `memory/embed.ts` is deliberately local-only, which
 * means Ollama running with `nomic-embed-text` pulled. Routing the tutor through it would make
 * every answer's grounding depend on a model the user may not have — and the failure would be
 * silent: no citations, an answer from weights, and nothing on screen to say the difference. A
 * tutor that cites only when an embedding model happens to be installed is worse than one that
 * always cites, because you cannot tell which mode you are in.
 *
 * If the corpus grows past a few hundred passages this trade flips, and `memory/store.ts` has the
 * machinery ready — `topMatches` is exported and pure for exactly that kind of reuse.
 *
 * ## The concept graph does the work embeddings would
 *
 * The app knows which problem the learner has open, and D2's taxonomy knows which concepts that
 * problem teaches. Passages tagged with those concepts are boosted, which is a stronger relevance
 * signal than sentence similarity and costs nothing — it comes from structure that already exists.
 */
import { REFERENCE, type ReferenceDoc } from "./reference.js";
import { taxonomy } from "./taxonomy.js";

export interface Passage {
  docId: string;
  sectionId: string;
  title: string;
  heading: string;
  body: string;
  source: string;
  asOf: string;
  score: number;
}

export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceError";
  }
}

/**
 * Words, keeping underscores inside them.
 *
 * `d_k`, `kv_heads` and `blockIdx` are the terms that actually discriminate between passages
 * here, and a tokenizer that split on underscore would turn `d_k` into `d` and `k` — two tokens
 * so common they carry no signal, from the one term that would have found the answer.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

interface Indexed {
  passage: Omit<Passage, "score">;
  concepts: string[];
  terms: Map<string, number>;
  length: number;
}

let indexed: Indexed[] | undefined;
let idf: Map<string, number> | undefined;
let frequency: Map<string, number> | undefined;

function build(): {
  rows: Indexed[];
  weights: Map<string, number>;
  docFrequency: Map<string, number>;
} {
  if (indexed !== undefined && idf !== undefined && frequency !== undefined) {
    return { rows: indexed, weights: idf, docFrequency: frequency };
  }

  const rows: Indexed[] = [];
  for (const doc of REFERENCE) {
    for (const section of doc.sections) {
      // Heading and body together: a heading is a dense restatement of what the section is
      // about, so a term appearing in both should count twice rather than once.
      const terms = new Map<string, number>();
      const tokens = tokenize(`${section.heading} ${section.body}`);
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);

      rows.push({
        passage: {
          docId: doc.id,
          sectionId: section.id,
          title: doc.title,
          heading: section.heading,
          body: section.body,
          source: doc.source,
          asOf: doc.asOf,
        },
        concepts: doc.concepts,
        terms,
        length: tokens.length,
      });
    }
  }

  /**
   * Document frequency counted over SECTIONS, not documents.
   *
   * With ten documents an IDF has three or four distinct values and cannot separate "attention"
   * — which appears in most of them — from "coalescing", which appears in one. Twenty-five
   * sections gives the weighting enough resolution to be worth computing at all.
   */
  const df = new Map<string, number>();
  for (const row of rows) {
    for (const term of row.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const weights = new Map<string, number>();
  for (const [term, count] of df) {
    // Smoothed, so a term in every section scores just above zero rather than exactly zero —
    // it should be nearly worthless, not disqualifying for a query made only of common words.
    weights.set(term, Math.log((rows.length + 1) / (count + 0.5)));
  }

  indexed = rows;
  idf = weights;
  frequency = df;
  return { rows, weights, docFrequency: df };
}

export interface SearchOptions {
  /**
   * Concepts the learner is currently working on.
   *
   * A boost rather than a filter. Someone reading about attention may still ask what float16
   * underflow is, and a hard filter would answer that from weights while sitting on a passage
   * about it.
   */
  concepts?: readonly string[];
  limit?: number;
}

/** How much a concept match is worth. Enough to reorder near-ties, not enough to beat a real hit. */
const CONCEPT_BOOST = 1.35;

/**
 * Words a question is made of, which say nothing about its topic.
 *
 * **IDF cannot catch these, and that is the point of having the list.** IDF measures rarity in
 * the *corpus*; these are rare there and ubiquitous in *queries*. `what` appears in only a few
 * headings — "What LayerNorm normalises over", "What the cache costs" — so it scores as highly
 * discriminating, and "what is the capital of France" duly cited a passage about LayerNorm. The
 * two frequencies are different measurements and only one of them is computable from the corpus.
 *
 * Kept short deliberately. Every word here is one a learner cannot search for, so it holds
 * question scaffolding and nothing domain-adjacent — `batch` and `layer` look like noise and are
 * exactly what someone might be asking about.
 */
/*
  A first version also required a matched term to be rarer than half the corpus, on the theory
  that common words should not qualify a passage. Mutation testing showed nothing could observe
  it once this list existed — the stopwords catch the same cases and catch them for the right
  reason — so it was removed rather than kept as a knob whose value nobody could justify.
*/
const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do", "does",
  "for", "from", "get", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "me", "my", "not", "of", "on", "or", "our", "should", "so", "some", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "up", "use", "using", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you",
  "your",
]);

/**
 * The passages most likely to answer this, best first.
 *
 * Returns nothing rather than the least-bad passage when no term matches. An irrelevant citation
 * is worse than none: it tells the learner the answer rests on a source that does not mention the
 * thing they asked about, and the tutor is instructed to say it does not know instead.
 */
export function searchReference(query: string, options: SearchOptions = {}): Passage[] {
  const { rows, weights } = build();
  const limit = options.limit ?? 3;
  const wanted = new Set(options.concepts ?? []);

  // Deduplicated, and stripped of question scaffolding: repeating a word should not multiply its
  // weight, and "what"/"how"/"why" should not be able to match anything at all.
  const queryTerms = new Set(tokenize(query).filter((t) => !QUERY_STOPWORDS.has(t)));
  if (queryTerms.size === 0) return [];

  const scored: Passage[] = [];
  for (const row of rows) {
    let score = 0;
    for (const term of queryTerms) {
      const count = row.terms.get(term);
      if (count === undefined) continue;
      // Sub-linear in term frequency: a section repeating a word six times is not six times as
      // relevant as one mentioning it once.
      score += (weights.get(term) ?? 0) * (1 + Math.log(count));
    }
    if (score <= 0) continue;

    // Divided by the square root of length so a long section does not win on breadth alone,
    // and a short precise one is not buried.
    score /= Math.sqrt(row.length);
    if (wanted.size > 0 && row.concepts.some((c) => wanted.has(c))) score *= CONCEPT_BOOST;

    scored.push({ ...row.passage, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * The concepts a piece of content teaches, for scoping a search to what the learner is doing.
 *
 * Lives here rather than at the call site so the tutor path has one function to call, and so the
 * taxonomy lookup cannot be forgotten — which would silently drop the boost and leave retrieval
 * looking merely mediocre rather than misconfigured.
 */
export function conceptsForItem(itemId: string): string[] {
  return taxonomy()
    .conceptsFor(itemId)
    .map((c) => c.id);
}

/**
 * Check the corpus, or throw naming what is wrong.
 *
 * Called by the test suite rather than at startup: a malformed reference file should fail CI, and
 * failing to launch the whole app over a citation typo is the wrong severity.
 */
export function validateReference(docs: readonly ReferenceDoc[] = REFERENCE): void {
  const conceptIds = taxonomy().concepts;
  const seenDocs = new Set<string>();
  const seenSections = new Set<string>();

  for (const doc of docs) {
    if (seenDocs.has(doc.id)) throw new ReferenceError(`duplicate document ${doc.id}`);
    seenDocs.add(doc.id);

    if (doc.sections.length === 0) throw new ReferenceError(`document ${doc.id} has no sections`);
    if (doc.source.trim() === "") throw new ReferenceError(`document ${doc.id} has no source`);
    // A date that is not a date cannot be compared, so staleness could never be found — which is
    // the one job this field has.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.asOf)) {
      throw new ReferenceError(`document ${doc.id} has a malformed asOf ${doc.asOf}`);
    }

    for (const concept of doc.concepts) {
      if (!conceptIds.has(concept)) {
        throw new ReferenceError(`document ${doc.id} names unknown concept ${concept}`);
      }
    }

    for (const section of doc.sections) {
      // Section ids reach the learner as citations, so a collision would make two different
      // passages indistinguishable in an answer.
      if (seenSections.has(section.id)) {
        throw new ReferenceError(`duplicate section id ${section.id}`);
      }
      seenSections.add(section.id);
      if (section.body.trim() === "") {
        throw new ReferenceError(`section ${section.id} has no body`);
      }
    }
  }
}
