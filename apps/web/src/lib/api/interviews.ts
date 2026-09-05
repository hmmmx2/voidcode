import { API_BASE, makeHeaders } from "./client";
import type { Problem, TestCase } from "@/lib/mock-data";
import type { APICodeTemplate, ProblemDetail } from "./problems";

/**
 * Elite Interview API.
 *
 * Note what is missing from `InterviewQuestionDetail`: there is no `approach`
 * and no `modelAnswer`. That is not an oversight in the type — the server does
 * not send them until they are asked for, so the page physically cannot leak
 * an answer the user has not requested. `revealStage` is the only way to get
 * them, and asking for the answer is recorded.
 */

export type Difficulty = "easy" | "medium" | "hard";

export interface InterviewSummary {
  slug: string;
  title: string;
  /** First ~150 chars of the prompt, for the catalogue cards. */
  promptPreview: string;
  domain: string;
  domainLabel: string;
  /** What you physically do: derive, compute, or write code. */
  kind: "derivation" | "computation" | "code";
  kindLabel: string;
  difficulty: Difficulty;
  companies: string[];
  categories: string[];
  orderIndex: number;
  /** 1 = could not answer, 2 = shaky, 3 = solid. Null until self-rated. */
  selfRating: number | null;
  revealedAnswer: boolean;
  attempted: boolean;
  /** An executable form exists. False while Phase 2 authoring is in progress. */
  hasWorkspace: boolean;
  /** Has submitted at least once. */
  solved: boolean;
}

export interface InterviewFacet {
  key: string;
  label: string;
  total: number;
}

export interface InterviewListData {
  questions: InterviewSummary[];
  facets: {
    domains: InterviewFacet[];
    companies: InterviewFacet[];
    difficulties: InterviewFacet[];
    kinds: InterviewFacet[];
  };
  progress: { total: number; attempted: number; solid: number };
}

export interface InterviewQuestionDetail extends InterviewSummary {
  prompt: string;
  notes: string | null;
}

export interface ApproachReveal {
  stage: "approach";
  approach: string;
}

export interface AnswerReveal {
  stage: "answer";
  modelAnswer: string;
  followUps: string[];
  redFlags: string[];
}

/** One place that turns a non-2xx into a thrown Error, so callers can `.catch`. */
async function request<T>(
  path: string,
  userId: string | undefined,
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

export async function fetchInterviews(
  userId?: string
): Promise<InterviewListData> {
  return request<InterviewListData>("/v1/interviews", userId);
}

export async function fetchInterviewQuestion(
  slug: string,
  userId?: string
): Promise<InterviewQuestionDetail> {
  return request<InterviewQuestionDetail>(
    `/v1/interviews/${encodeURIComponent(slug)}`,
    userId
  );
}

export async function revealStage(
  slug: string,
  stage: "approach",
  userId?: string
): Promise<ApproachReveal>;
export async function revealStage(
  slug: string,
  stage: "answer",
  userId?: string
): Promise<AnswerReveal>;
export async function revealStage(
  slug: string,
  stage: "approach" | "answer",
  userId?: string
): Promise<ApproachReveal | AnswerReveal> {
  return request<ApproachReveal | AnswerReveal>(
    `/v1/interviews/${encodeURIComponent(slug)}/reveal`,
    userId,
    { method: "POST", body: { stage } }
  );
}

export async function saveAttempt(
  slug: string,
  body: {
    selfRating?: number | null;
    notes?: string | null;
    elapsedSeconds?: number;
  },
  userId?: string
): Promise<{ slug: string; selfRating: number | null; notes: string | null }> {
  // snake_case on the wire — the API speaks Python and only its responses are
  // camelCased. Sending `selfRating` here would silently save nothing, because
  // FastAPI's `exclude_unset` treats an unknown key as absent rather than
  // rejecting the request.
  const payload: Record<string, unknown> = {};
  if (body.selfRating !== undefined) payload.self_rating = body.selfRating;
  if (body.notes !== undefined) payload.notes = body.notes;
  if (body.elapsedSeconds !== undefined)
    payload.elapsed_seconds = body.elapsedSeconds;

  return request(`/v1/interviews/${encodeURIComponent(slug)}/attempt`, userId, {
    method: "PUT",
    body: payload,
  });
}

/** Records the first submit server-side; that is what unlocks the tutor. */
export async function markSubmitted(
  slug: string,
  userId?: string
): Promise<{ submittedAt: string }> {
  return request(`/v1/interviews/${encodeURIComponent(slug)}/submitted`, userId, {
    method: "POST",
    body: {},
  });
}

/**
 * Have the tutor mark a written answer.
 *
 * Only the verdict and feedback come back. The model answer stays on the
 * server — see the endpoint's docstring for why that matters.
 */
export async function assessAnswer(
  slug: string,
  answer: string,
  userId?: string
): Promise<{ verdict: "correct" | "partial" | "incorrect" | "unknown"; feedback: string }> {
  return request(`/v1/interviews/${encodeURIComponent(slug)}/assess`, userId, {
    method: "POST",
    body: { answer },
  });
}

// ── Workspace ───────────────────────────────────────────────────────────────

/**
 * The IDE payload for a question that has an executable form.
 *
 * Shaped as `ProblemDetail` plus the interview state, so `WorkspaceClient` takes
 * it through the same `loadQuestion` prop the curriculum route uses.
 *
 * `expectedOutput` on every case is `null` and that is the server's doing, not
 * the client's — see `GET /v1/interviews/{slug}/workspace`. Anything here that
 * tried to display it would find nothing to display.
 */
export interface InterviewWorkspace {
  detail: ProblemDetail;
  elapsedSeconds: number;
  submittedAt: string | null;
  notes: string | null;
  companies: string[];
  domainLabel: string;
  difficulty: Difficulty;
  title: string;
}

export async function fetchInterviewWorkspace(
  slug: string,
  userId?: string
): Promise<InterviewWorkspace> {
  const data = await request<Record<string, unknown>>(
    `/v1/interviews/${encodeURIComponent(slug)}/workspace`,
    userId
  );

  const p = data.problem as Record<string, unknown>;
  const problem: Problem = {
    id: p.id as string,
    orderIndex: p.order_index as number,
    title: p.title as string,
    difficulty: capitalise(p.difficulty as string) as "Easy" | "Medium" | "Hard",
    description: p.description as string,
    examples: p.examples as Problem["examples"],
    constraints: p.constraints as string[],
    hints: p.hints as string[],
  };

  const testCases: TestCase[] = (
    data.testCases as Record<string, unknown>[]
  ).map((tc) => ({
    id: tc.id as string,
    label: tc.label as string,
    inputs: tc.inputs as Array<{ name: string; value: string }>,
    stdin: tc.stdin as string | undefined,
    // Always null here. Kept in the shape so TestConsole needs no branch.
    expectedOutput: (tc.expected_output as string | null) ?? "",
  }));

  const codeTemplates: APICodeTemplate[] = (
    data.codeTemplates as Record<string, unknown>[]
  ).map((ct) => ({
    id: ct.id as string,
    language: ct.language as string,
    judge0LanguageId: ct.judge0_language_id as number,
    templateCode: ct.template_code as string,
    driverCode: ct.driver_code as string | null,
  }));

  return {
    detail: { problem, testCases, codeTemplates },
    elapsedSeconds: (data.elapsedSeconds as number) ?? 0,
    submittedAt: (data.submittedAt as string | null) ?? null,
    notes: (data.notes as string | null) ?? null,
    companies: (data.companies as string[]) ?? [],
    domainLabel: (data.domainLabel as string) ?? "",
    difficulty: data.difficulty as Difficulty,
    title: data.title as string,
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
