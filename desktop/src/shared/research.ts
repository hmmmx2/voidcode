/**
 * The research library's wire format, declared once for both halves of the app.
 *
 * Same reasoning as `credits.ts`: main parses these shapes, the preload surface describes them and
 * the renderer draws them, and three copies of one format is three places for a field rename to be
 * half-applied with nothing objecting.
 *
 * THE FOUR SECTION KEYS ARE FIXED, and fixed in two languages: `SECTION_ORDER` here must equal
 * `SECTION_ORDER` in `apps/api/src/routers/papers.py`, which is also the pattern its `/read`
 * endpoint validates against. `research.test.ts` pins them together. A client that offered a fifth
 * tab would post a section the server refuses; one that dropped a tab would leave a paper
 * permanently unfinishable, because completion is "all four read".
 */

/** What it is, what you would type, what it costs to run, why the maths works. In that order. */
export const SECTION_ORDER = ["architecture", "implementation", "systems", "mathematics"] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_ORDER as readonly string[]).includes(value);
}

/** A row in the library. No section bodies — those are megabytes and the list does not need them. */
export interface PaperSummary {
  slug: string;
  title: string;
  /** One string as the API stores it, not a list: "Vaswani et al." is one field there. */
  authors: string;
  year: number;
  venue: string | null;
  arxivId: string | null;
  abstract: string;
  difficulty: string;
  categories: string[];
  orderIndex: number;
  relatedProblemSlugs: string[];
  /**
   * Which sections this reader has opened. EMPTY FOR A SIGNED-OUT READER, by the server's
   * choice rather than this client's — see `_progress_by_paper` in the API: every signed-out
   * caller is one anonymous user, so their progress was once a single shared row.
   */
  sectionsRead: string[];
  sectionCount: number;
  completedAt: string | null;
}

export interface PaperSection {
  key: string;
  label: string;
  /** Markdown. Rendered by the desktop's own `Markdown`, never as HTML. */
  body: string;
}

export interface KeyEquation {
  label: string;
  latex: string;
  note?: string;
}

export interface PaperDetail extends PaperSummary {
  /** Hotlinked from arXiv. Never handed to the renderer — see `research/papers.ts::openPdf`. */
  pdfUrl: string;
  keyEquations: KeyEquation[];
  sections: PaperSection[];
}

/** How far through the library a reader is. Zeroed for a signed-out reader, by the same rule. */
export interface LibraryProgress {
  papers: number;
  finished: number;
  sectionsRead: number;
  sectionsTotal: number;
}

export interface PaperLibrary {
  papers: PaperSummary[];
  sections: { key: string; label: string }[];
  progress: LibraryProgress;
}
