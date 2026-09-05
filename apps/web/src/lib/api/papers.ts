import { API_BASE, makeHeaders } from "./client";

/**
 * Research papers API.
 *
 * Unlike interviews, nothing is withheld — a paper breakdown exists to be read,
 * so the detail response carries all four section bodies. The list response
 * omits them, because sending four thousand words per paper to render a card
 * is the difference between a fast index and a slow one.
 */

export interface PaperSummary {
  slug: string;
  title: string;
  authors: string;
  year: number;
  venue: string | null;
  arxivId: string | null;
  abstract: string;
  difficulty: "easy" | "medium" | "hard";
  categories: string[];
  orderIndex: number;
  relatedProblemSlugs: string[];
  sectionsRead: string[];
  sectionCount: number;
  completedAt: string | null;
}

export interface PaperSection {
  key: string;
  label: string;
  body: string;
}

export interface KeyEquation {
  label: string;
  latex: string;
  note?: string;
}

export interface PaperDetail extends PaperSummary {
  pdfUrl: string;
  keyEquations: KeyEquation[];
  sections: PaperSection[];
}

export interface PaperLibrary {
  papers: PaperSummary[];
  sections: { key: string; label: string }[];
  progress: {
    papers: number;
    finished: number;
    sectionsRead: number;
    sectionsTotal: number;
  };
}

async function request<T>(
  path: string,
  userId?: string,
  init?: { method: string; body: unknown }
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: makeHeaders(userId),
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchPapers(userId?: string): Promise<PaperLibrary> {
  return request<PaperLibrary>("/v1/papers", userId);
}

export async function fetchPaper(
  slug: string,
  userId?: string
): Promise<PaperDetail> {
  return request<PaperDetail>(`/v1/papers/${encodeURIComponent(slug)}`, userId);
}

export async function markSectionRead(
  slug: string,
  section: string,
  userId?: string
): Promise<{ sectionsRead: string[]; completedAt: string | null }> {
  return request(`/v1/papers/${encodeURIComponent(slug)}/read`, userId, {
    method: "POST",
    body: { section },
  });
}
