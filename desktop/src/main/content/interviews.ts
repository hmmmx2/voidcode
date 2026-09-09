/**
 * The interviews surface, owned by main.
 *
 * The bank itself is generated into `interview-bank.ts`. This is the part that was
 * written rather than transcribed: the display vocabularies, the facet counts, and —
 * the reason the module exists — the two projections that decide what may leave this
 * process.
 *
 * THE ANSWER IS NOT IN THE DETAIL PAYLOAD, AND THAT IS THE WHOLE DESIGN.
 *
 * The page reveals the approach, then the model answer, then the follow-ups. If the
 * detail projection returned all of it, that sequence would be theatre — one devtools
 * tab and the exercise is over. The web API enforced this at the network boundary; on
 * the desktop the boundary is between main and the renderer, which is the same
 * guarantee for the same reason. `toSummary` and `toDetail` are the only ways out of
 * the bank, and `reveal` is the only thing that returns an answer.
 *
 * It also makes `revealedAnswer` mean something. A self-rating of "solid" from someone
 * who never asked for the answer is a different signal from the same rating after
 * reading it, and that distinction only survives if the reveal is a request rather
 * than a CSS class.
 */

import { QUESTIONS, type Question, type Difficulty, type Kind } from "./interview-bank.js";
import type { InterviewAttempt } from "../store/interviews.js";

export type { Question, Difficulty, Kind };
export { QUESTIONS };

/**
 * `hasWorkspace` is passed in rather than asked here, and the answer lives in
 * `interview-detail.ts` — see `hasInterviewWorkspace`.
 *
 * It is derived from the executable catalogue rather than stored on the question, because
 * a boolean written into the bank would be a second place for the truth to live and it
 * would be the one that goes stale.
 */

/**
 * Display order, not alphabetical: foundations first, then modality, then systems.
 * Declared so the UI never has to derive an order from whatever the rows happen to
 * contain.
 */
export const DOMAIN_ORDER = ["ml", "dl", "maths", "llm", "vlm", "cuda"] as const;
export const DOMAIN_LABELS: Record<string, string> = {
  ml: "Machine Learning",
  dl: "Deep Learning",
  maths: "Mathematics",
  llm: "LLM",
  vlm: "VLM",
  cuda: "CUDA & Systems",
};

export const COMPANY_ORDER = ["Meta", "OpenAI", "Anthropic", "Google DeepMind", "NVIDIA"] as const;
export const DIFFICULTY_ORDER = ["easy", "medium", "hard"] as const;

/**
 * What the candidate physically does. Ordered by how most people revise: the maths,
 * then the sizing, then the whiteboard code.
 */
export const KIND_ORDER = ["derivation", "computation", "code"] as const;
export const KIND_LABELS: Record<string, string> = {
  derivation: "Derivation",
  computation: "Computation",
  code: "Code",
};

const BY_SLUG = new Map(QUESTIONS.map((q) => [q.slug, q]));

export class UnknownQuestionError extends Error {
  constructor(slug: string) {
    super(`unknown interview question: ${slug}`);
    this.name = "UnknownQuestionError";
  }
}

export function getQuestion(slug: string): Question {
  const question = BY_SLUG.get(slug);
  if (question === undefined) throw new UnknownQuestionError(slug);
  return question;
}

export interface Summary {
  slug: string;
  title: string;
  promptPreview: string;
  domain: string;
  domainLabel: string;
  kind: Kind;
  kindLabel: string;
  difficulty: Difficulty;
  companies: string[];
  categories: string[];
  orderIndex: number;
  selfRating: number | null;
  revealedAnswer: boolean;
  attempted: boolean;
  hasWorkspace: boolean;
  solved: boolean;
}

export interface Detail extends Summary {
  prompt: string;
  notes: string | null;
}

/**
 * A one-line taste of the prompt, for the catalogue cards.
 *
 * Safe to send with the list: the prompt is the *question*, which the detail view shows
 * unprompted anyway. What is withheld is the approach and the answer, and neither can be
 * reconstructed from this.
 *
 * Cut on a word boundary — a card ending "the interpol" reads as a rendering bug rather
 * than as truncation.
 */
export function preview(prompt: string, limit = 150): string {
  const flat = prompt.split(/\s+/).filter(Boolean).join(" ");
  if (flat.length <= limit) return flat;
  const cut = flat.lastIndexOf(" ", limit);
  return flat.slice(0, cut > 0 ? cut : limit).replace(/[,;:]+$/, "") + "…";
}

/**
 * `hasWorkspace` says whether an executable form exists.
 *
 * The catalogue uses it to decide where a card links — the IDE, or the read-only view —
 * so a question whose executable half has not landed degrades to reading instead of
 * opening an editor with nothing in it.
 */
export function toSummary(
  question: Question,
  attempt: InterviewAttempt | undefined,
  hasWorkspace: boolean
): Summary {
  return {
    slug: question.slug,
    title: question.title,
    promptPreview: preview(question.prompt),
    domain: question.domain,
    domainLabel: DOMAIN_LABELS[question.domain] ?? question.domain,
    kind: question.kind,
    kindLabel: KIND_LABELS[question.kind] ?? question.kind,
    difficulty: question.difficulty,
    companies: question.companies,
    categories: question.categories,
    orderIndex: question.orderIndex,
    selfRating: attempt?.selfRating ?? null,
    revealedAnswer: attempt?.revealedAnswer ?? false,
    // The existence of a row, not any field in it. Rating, revealing and submitting all
    // create one, so "attempted" covers every way of having engaged with the question.
    attempted: attempt !== undefined,
    hasWorkspace,
    solved: attempt?.submittedAt != null,
  };
}

export function toDetail(
  question: Question,
  attempt: InterviewAttempt | undefined,
  hasWorkspace: boolean
): Detail {
  return {
    ...toSummary(question, attempt, hasWorkspace),
    prompt: question.prompt,
    notes: attempt?.notes ?? null,
  };
}

export interface Facet {
  key: string;
  label: string;
  total: number;
}

/**
 * Counts over every question, not over the filtered result.
 *
 * Deliberate: a facet count that shrinks as you filter cannot tell you what selecting it
 * would give you, and a facet showing 0 that you can still click is worse than one that
 * never moves. These answer "how much CUDA exists", which is a fixed property of the bank.
 *
 * Built from the authored orders rather than from the rows, so a kind with no questions
 * still appears at 0. That is currently every question being `code`: `derivation` and
 * `computation` show zero, which is the truth about the bank rather than a missing filter.
 */
export function facets(questions: readonly Question[] = QUESTIONS): {
  domains: Facet[];
  companies: Facet[];
  difficulties: Facet[];
  kinds: Facet[];
} {
  const count = <T extends string>(pick: (q: Question) => T | T[]): Map<string, number> => {
    const tally = new Map<string, number>();
    for (const q of questions) {
      const value = pick(q);
      for (const key of Array.isArray(value) ? value : [value]) {
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    return tally;
  };

  const domains = count((q) => q.domain);
  const companies = count((q) => q.companies);
  const difficulties = count((q) => q.difficulty);
  const kinds = count((q) => q.kind);

  return {
    domains: DOMAIN_ORDER.map((d) => ({
      key: d,
      label: DOMAIN_LABELS[d] ?? d,
      total: domains.get(d) ?? 0,
    })),
    companies: COMPANY_ORDER.map((c) => ({ key: c, label: c, total: companies.get(c) ?? 0 })),
    difficulties: DIFFICULTY_ORDER.map((d) => ({
      key: d,
      label: d.charAt(0).toUpperCase() + d.slice(1),
      total: difficulties.get(d) ?? 0,
    })),
    kinds: KIND_ORDER.map((k) => ({ key: k, label: KIND_LABELS[k] ?? k, total: kinds.get(k) ?? 0 })),
  };
}

/**
 * `solid` counts 3s only.
 *
 * Counting shaky answers as progress would make the ring flattering and useless, which
 * defeats the point of an honest self-assessment.
 */
export function progress(attempts: ReadonlyMap<string, InterviewAttempt>): {
  total: number;
  attempted: number;
  solid: number;
} {
  const rated = [...attempts.values()].filter((a) => a.selfRating !== null);
  return {
    total: QUESTIONS.length,
    attempted: rated.length,
    solid: rated.filter((a) => a.selfRating === 3).length,
  };
}
