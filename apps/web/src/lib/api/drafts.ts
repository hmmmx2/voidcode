/**
 * Drafts API client — autosave code drafts to backend.
 */

import { API_BASE, makeHeaders } from "./client";

export interface DraftResponse {
  id: string;
  problem_id: string;
  language: string;
  source_code: string;
  updated_at: string;
}

export async function saveDraft(
  problemId: string,
  language: string,
  sourceCode: string,
  userId?: string
): Promise<DraftResponse> {
  const res = await fetch(`${API_BASE}/v1/drafts`, {
    method: "PUT",
    headers: makeHeaders(userId),
    body: JSON.stringify({
      problem_id: problemId,
      language,
      source_code: sourceCode,
    }),
  });
  if (!res.ok) throw new Error(`Draft save failed: ${res.status}`);
  return res.json();
}

export async function loadDraft(
  problemId: string,
  language: string,
  userId?: string
): Promise<DraftResponse | null> {
  const res = await fetch(
    `${API_BASE}/v1/drafts?problem_id=${encodeURIComponent(problemId)}&language=${encodeURIComponent(language)}`,
    { headers: makeHeaders(userId) }
  );
  if (!res.ok) throw new Error(`Draft load failed: ${res.status}`);
  const data = await res.json();
  return data.draft ?? null;
}
