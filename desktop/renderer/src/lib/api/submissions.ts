/**
 * Submissions API client — fetch submission history from the backend.
 */

import type { Submission } from "@/lib/mock-data";
import { API_BASE, makeHeaders } from "./client";
import { formatRelativeTime } from "@/lib/format-time";

// ── Backend response types ────────────────────────────────────────

interface APISubmission {
  id: string;
  status: string;            // "accepted", "wrong_answer", etc.
  language: string;
  total_tests: number;
  passed_tests: number;
  overall_runtime_ms: number | null;
  overall_memory_kb: number | null;
  created_at: string;        // ISO 8601
  source_code: string | null;
}

interface APISubmissionListResponse {
  submissions: APISubmission[];
}

// ── Status mapping ────────────────────────────────────────────────

const STATUS_MAP: Record<string, Submission["status"]> = {
  accepted: "Accepted",
  wrong_answer: "Wrong Answer",
  time_limit_exceeded: "Time Limit Exceeded",
  runtime_error: "Runtime Error",
  compilation_error: "Runtime Error",
  internal_error: "Runtime Error",
};

// ── Runtime formatting ────────────────────────────────────────────

function formatRuntime(ms: number | null): string {
  if (ms === null || ms === undefined) return "N/A";
  if (ms < 1) return "<1ms";
  return `${Math.round(ms)}ms`;
}

// ── API function ──────────────────────────────────────────────────

export async function fetchSubmissions(
  problemId: string,
  userId?: string,
  timezone?: string | null,
): Promise<Submission[]> {
  const res = await fetch(
    `${API_BASE}/v1/submissions?problem_id=${encodeURIComponent(problemId)}`,
    { headers: makeHeaders(userId) }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch submissions: ${res.status}`);
  }

  const data: APISubmissionListResponse = await res.json();

  return data.submissions.map((s) => ({
    id: s.id,
    status: STATUS_MAP[s.status] ?? "Runtime Error",
    runtime: formatRuntime(s.overall_runtime_ms),
    language: s.language,
    timestamp: formatRelativeTime(s.created_at, timezone),
    passedTests: s.passed_tests,
    totalTests: s.total_tests,
    sourceCode: s.source_code ?? undefined,
  }));
}
