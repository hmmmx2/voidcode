/**
 * Chat History API Client
 *
 * All calls go through the FastAPI backend at /v1/chat/sessions.
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

// Qwen3.5-9B via SGLang uses an 8192-token thinking budget.
// This must match SGLANG_THINKING_BUDGET in apps/api/src/main.py.
const SGLANG_THINKING_BUDGET = 8192;

/** Map a DB message to the frontend ChatMessage type. */
export function sessionMessageToChatMessage(msg: SessionMessage): ChatMessage {
  const thinkingMeta =
    msg.thinkingContent != null
      ? {
          content: msg.thinkingContent,
          tokenCount: msg.thinkingTokenCount ?? 0,
          budgetUsed: msg.thinkingBudgetUsed ?? 0,
          budgetTotal: SGLANG_THINKING_BUDGET,
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

export async function createSession(
  payload?: { problemId?: string; title?: string },
  userId?: string
): Promise<SessionDetail> {
  const response = await fetch(`${API_BASE}/v1/chat/sessions`, {
    method: "POST",
    headers: makeHeaders(userId),
    body: JSON.stringify({
      problem_id: payload?.problemId ?? null,
      title: payload?.title ?? null,
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
