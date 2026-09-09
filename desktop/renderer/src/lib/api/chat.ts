/**
 * Chat History API Client
 *
 * Every call goes to `/v1/chat/sessions` through the transport seam in `client.ts`, which answers
 * it over IPC from main's `chat_sessions` and `chat_messages` tables. Nothing leaves the machine.
 *
 * The path shape is the one the retired web API used, and it is kept deliberately — the seam matches
 * on it, so the two SSE readers keep working against a real `Response`. What this header used to say
 * was that the calls "go through the FastAPI backend", which stopped being true when the router
 * moved into main and stayed in the file as an instruction to look for a server that is not there.
 */

import type { ChatMessage } from "@/lib/mock-data";
import { API_BASE, makeHeaders } from "./client";

// ── Types ──────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  title: string | null;
  problemId: string | null;
  isActive: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A session that matched a search, and why it did. */
export interface SessionMatch extends SessionSummary {
  matchedIn: "title" | "message";
  /** Text around the hit, when a message body matched rather than the title. */
  snippet: string | null;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  detectedMode: string | null;
  thinkingContent: string | null;
  thinkingTokenCount: number | null;
  thinkingBudgetUsed: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface SessionDetail {
  id: string;
  title: string | null;
  problemId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

// ── Converters ────────────────────────────────────────────────

/**
 * The denominator for the thinking-budget bar on a replayed message.
 *
 * It said "this must match SGLANG_THINKING_BUDGET in apps/api/src/main.py" — a cross-repo
 * invariant against a repo D0 retired, enforceable by nothing, naming a server this app does not
 * use. There is no SGLang provider in `inference/registry.ts`; the backends are Ollama, llama.cpp
 * and OpenRouter.
 *
 * Kept because a stored message records how much of a budget it used, and the bar needs a total to
 * divide by. What it is *not* is authoritative: no provider is ever told this number, so a model
 * with a different budget renders against the wrong denominator. Storing the total beside
 * `thinkingBudgetUsed` is the real fix and needs a migration.
 */
const DISPLAY_THINKING_BUDGET = 8192;

/** Map a DB message to the frontend ChatMessage type. */
export function sessionMessageToChatMessage(msg: SessionMessage): ChatMessage {
  const thinkingMeta =
    msg.thinkingContent != null
      ? {
          content: msg.thinkingContent,
          tokenCount: msg.thinkingTokenCount ?? 0,
          budgetUsed: msg.thinkingBudgetUsed ?? 0,
          budgetTotal: DISPLAY_THINKING_BUDGET,
        }
      : undefined;

  const usage =
    msg.promptTokens != null || msg.completionTokens != null
      ? {
          promptTokens: msg.promptTokens ?? 0,
          completionTokens: msg.completionTokens ?? 0,
          totalTokens: (msg.promptTokens ?? 0) + (msg.completionTokens ?? 0),
        }
      : undefined;

  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    thinking: msg.thinkingContent ?? undefined,
    tokenCount: msg.thinkingTokenCount ?? undefined,
    thinkingMeta,
    usage,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function parseSessionSummary(data: Record<string, unknown>): SessionSummary {
  return {
    id: data.id as string,
    title: data.title as string | null,
    problemId: data.problem_id as string | null,
    isActive: data.is_active as boolean,
    messageCount: data.message_count as number,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

function parseSessionMessage(data: Record<string, unknown>): SessionMessage {
  return {
    id: data.id as string,
    role: data.role as "user" | "assistant",
    content: data.content as string,
    detectedMode: data.detected_mode as string | null,
    thinkingContent: data.thinking_content as string | null,
    thinkingTokenCount: data.thinking_token_count as number | null,
    thinkingBudgetUsed: data.thinking_budget_used as number | null,
    promptTokens: data.prompt_tokens as number | null,
    completionTokens: data.completion_tokens as number | null,
    createdAt: data.created_at as string,
  };
}

function parseSessionDetail(data: Record<string, unknown>): SessionDetail {
  const messages = (data.messages as Record<string, unknown>[]).map(
    parseSessionMessage
  );
  return {
    id: data.id as string,
    title: data.title as string | null,
    problemId: data.problem_id as string | null,
    isActive: data.is_active as boolean,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
    messages,
  };
}

async function handleResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      (error as { detail?: string }).detail ||
        `API error (${response.status})`
    );
  }
  return response.json();
}

// ── API Functions ─────────────────────────────────────────────

/**
 * Which assistant owns a conversation.
 *
 * Both share the same tables, which is right — a saved conversation is a saved conversation.
 * This is the one thing that differs, and every call below carries it so neither surface shows
 * the other's history.
 */
export type ChatSurface = "tutor" | "assistant";

export async function createSession(
  payload?: { problemId?: string; title?: string; surface?: ChatSurface },
  userId?: string
): Promise<SessionDetail> {
  const response = await fetch(`${API_BASE}/v1/chat/sessions`, {
    method: "POST",
    headers: makeHeaders(userId),
    body: JSON.stringify({
      problem_id: payload?.problemId ?? null,
      title: payload?.title ?? null,
      surface: payload?.surface ?? "tutor",
    }),
  });
  const data = (await handleResponse(response)) as Record<string, unknown>;
  return parseSessionDetail(data);
}

export async function listSessions(
  limit = 20,
  offset = 0,
  userId?: string
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const response = await fetch(
    `${API_BASE}/v1/chat/sessions?limit=${limit}&offset=${offset}`,
    { headers: makeHeaders(userId) }
  );
  const data = (await handleResponse(response)) as Record<string, unknown>;
  const sessions = (data.sessions as Record<string, unknown>[]).map(
    parseSessionSummary
  );
  return { sessions, total: data.total as number };
}

/**
 * Sessions whose title or any message matches, newest first.
 *
 * Search runs in main over every stored message, not over an already-fetched page. The
 * distinction matters: `listSessions` is capped, so filtering client-side would search the
 * newest twenty conversations and quietly report nothing for the twenty-first — which is
 * indistinguishable from having no match.
 *
 * A blank query lists everything up to `limit`, so a caller can use this alone and does not
 * have to switch between two functions as the box empties.
 */
export async function searchSessions(
  query: string,
  limit = 50,
  userId?: string,
  surface?: ChatSurface
): Promise<{ sessions: SessionMatch[]; total: number }> {
  const response = await fetch(
    `${API_BASE}/v1/chat/search?q=${encodeURIComponent(query)}&limit=${String(limit)}` +
      (surface === undefined ? "" : `&surface=${surface}`),
    { headers: makeHeaders(userId) }
  );
  const data = (await handleResponse(response)) as Record<string, unknown>;
  const sessions = (data.sessions as Record<string, unknown>[]).map((row) => ({
    ...parseSessionSummary(row),
    matchedIn: (row.matched_in as "title" | "message" | undefined) ?? "title",
    snippet: (row.snippet as string | null | undefined) ?? null,
  }));
  return { sessions, total: data.total as number };
}

export async function getSession(
  sessionId: string,
  userId?: string
): Promise<SessionDetail> {
  const response = await fetch(
    `${API_BASE}/v1/chat/sessions/${sessionId}`,
    { headers: makeHeaders(userId) }
  );
  const data = (await handleResponse(response)) as Record<string, unknown>;
  return parseSessionDetail(data);
}

export async function saveMessage(
  sessionId: string,
  payload: {
    role: "user" | "assistant";
    content: string;
    detectedMode?: string;
    thinkingContent?: string;
    thinkingTokenCount?: number;
    thinkingBudgetUsed?: number;
    promptTokens?: number;
    completionTokens?: number;
  },
  userId?: string
): Promise<SessionMessage> {
  const response = await fetch(
    `${API_BASE}/v1/chat/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: makeHeaders(userId),
      body: JSON.stringify({
        role: payload.role,
        content: payload.content,
        detected_mode: payload.detectedMode ?? null,
        thinking_content: payload.thinkingContent ?? null,
        thinking_token_count: payload.thinkingTokenCount ?? null,
        thinking_budget_used: payload.thinkingBudgetUsed ?? null,
        prompt_tokens: payload.promptTokens ?? null,
        completion_tokens: payload.completionTokens ?? null,
      }),
    }
  );
  const data = (await handleResponse(response)) as Record<string, unknown>;
  return parseSessionMessage(data);
}

export async function deleteSession(sessionId: string, userId?: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/v1/chat/sessions/${sessionId}`,
    { method: "DELETE", headers: makeHeaders(userId) }
  );
  if (!response.ok && response.status !== 204) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(
      (error as { detail?: string }).detail ||
        `Delete failed (${response.status})`
    );
  }
}
