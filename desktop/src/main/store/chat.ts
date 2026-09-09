/**
 * Tutor conversations, in local SQLite.
 *
 * The tutor streams but forgot everything on reload, which makes it a worse teacher than it
 * needs to be: the thread *is* the context. Someone who explained what they tried two messages
 * ago should not have to explain it again.
 *
 * Shapes here are named for the store; the wire translation lives at the seam in
 * `renderer/src/lib/api/client.ts`, the same way submissions and drafts work. Emitting
 * store-shaped rows straight onto the wire is what broke submission history.
 */
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";

/** Which assistant a conversation belongs to. Both share these tables; only this differs. */
export type ChatSurface = "tutor" | "assistant";

export interface ChatSessionRow {
  id: string;
  problemId: string | null;
  title: string | null;
  surface: ChatSurface;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummaryRow extends ChatSessionRow {
  messageCount: number;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
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

export function createSession(
  problemId: string | null,
  title: string | null,
  /**
   * Defaults to the tutor, which is what a caller that has not been taught about surfaces is.
   *
   * Not a required argument, deliberately: every existing caller predates the column and means
   * the tutor, so a default keeps them correct rather than merely compiling. The Build
   * assistant is the one that has to say so, and it does.
   */
  surface: ChatSurface = "tutor"
): ChatSessionRow {
  const id = randomUUID();

  openDatabase()
    .prepare(
      `INSERT INTO chat_sessions (id, problem_id, title, surface, created_at, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'),
                           strftime('%Y-%m-%d %H:%M:%f', 'now'),
                           (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM chat_sessions))`
    )
    .run(id, problemId, title, surface);

  // Read back rather than constructing the row here: `created_at` comes from SQLite's clock
  // via a column default, and a value invented in JavaScript would differ from the one every
  // subsequent read returns.
  return getSession(id)!;
}

export function getSession(id: string): ChatSessionRow | undefined {
  const row = openDatabase()
    .prepare(
      `SELECT id, problem_id, title, surface, created_at, updated_at
         FROM chat_sessions WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;

  return row === undefined ? undefined : toSessionRow(row);
}

/**
 * Sessions, newest activity first, with their message counts.
 *
 * The count is a join rather than a stored column, so it cannot drift from the rows it
 * describes — the same reasoning as `progress.first_solved_at` being derived from
 * submissions rather than tracked alongside them.
 */
export function listSessions(
  limit = 20,
  offset = 0,
  /**
   * Which surface's conversations. Omitted means both, which only a debugging caller wants.
   *
   * The tutor and the Build assistant share these tables, so an unfiltered list showed each of
   * them the other's history — every row a conversation the user had somewhere else, in a
   * window with a different purpose.
   */
  surface?: ChatSurface
): {
  sessions: ChatSessionSummaryRow[];
  total: number;
} {
  const db = openDatabase();
  const where = surface === undefined ? "" : "WHERE s.surface = :surface";

  const rows = db
    .prepare(
      `SELECT s.id, s.problem_id, s.title, s.surface, s.created_at, s.updated_at,
              COUNT(m.id) AS message_count
         FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.session_id = s.id
         ${where}
        GROUP BY s.id
        ORDER BY s.updated_seq DESC
        LIMIT :limit OFFSET :offset`
    )
    .all({ limit, offset, ...(surface === undefined ? {} : { surface }) }) as Record<
    string,
    unknown
  >[];

  // Counted with the same filter. A total that counted both surfaces would tell the tutor it
  // had conversations it cannot show.
  const total = (
    db
      .prepare(
        surface === undefined
          ? "SELECT COUNT(*) AS n FROM chat_sessions"
          : "SELECT COUNT(*) AS n FROM chat_sessions WHERE surface = :surface"
      )
      .get(surface === undefined ? {} : { surface }) as { n: number }
  ).n;

  return {
    sessions: rows.map((r) => ({ ...toSessionRow(r), messageCount: r.message_count as number })),
    total,
  };
}

/** A session that matched a search, and the reason it did. */
export interface ChatSessionMatchRow extends ChatSessionSummaryRow {
  /** Which field matched. Title wins when both do, since it is what the list already shows. */
  matchedIn: "title" | "message";
  /** Text around the first match in a message body, or null when the title matched. */
  snippet: string | null;
}

/**
 * Escape the wildcards SQLite's LIKE gives to the *pattern*, so a search box is a search box.
 *
 * Without this, `_` matches any character and `%` matches everything, so typing either one
 * returns every session in the database. That is not a hypothetical in a coding tool: the
 * things a user searches for are identifiers, and `read_file` without escaping matches
 * `readXfile` while a lone `_` matches all rows.
 *
 * The escape character has to be declared by the query too — see `ESCAPE` in the SQL below.
 * Backslash is not special to LIKE by default; it becomes special only because we say so.
 */
function escapeLike(value: string): string {
  // The backslash is in the class as well as `%` and `_`: it is the escape character, so a
  // query containing one would otherwise produce a dangling escape and match nothing at all.
  // Windows paths are the obvious way a user types one without thinking about it.
  return value.replace(/[\\%_]/g, "\\$&");
}

/** How much of a matching message to show either side of the hit. */
const SNIPPET_RADIUS = 60;

function snippetAround(content: string, needle: string): string {
  const at = content.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return content.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

/**
 * Sessions whose title or any message matches.
 *
 * LIKE rather than FTS5. An FTS index is a migration, a second copy of every message, and a
 * set of triggers to keep them agreeing — worth it over a corpus that does not fit in memory,
 * and not worth it over one local user's chat history. If that stops being true the query
 * shape here is the thing to replace, not the callers.
 *
 * A blank query lists everything, so the panel can call this unconditionally as the search box
 * empties rather than switching between two functions and getting the transition wrong.
 */
export function searchSessions(
  query: string,
  limit = 30,
  /** Which surface's conversations, for the same reason `listSessions` takes one. */
  surface?: ChatSurface
): {
  sessions: ChatSessionMatchRow[];
  total: number;
} {
  const trimmed = query.trim();
  if (trimmed === "") {
    const all = listSessions(limit, 0, surface);
    return {
      sessions: all.sessions.map((session) => ({ ...session, matchedIn: "title", snippet: null })),
      total: all.total,
    };
  }

  const pattern = `%${escapeLike(trimmed)}%`;

  /**
   * One row per session, not one per matching message.
   *
   * `MIN(m.created_at)` picks a deterministic message to quote from — without an aggregate
   * SQLite is free to hand back any row from the group, which makes the snippet change
   * between identical searches. `MAX` over the title match turns "did any row match" into a
   * per-session flag.
   */
  const rows = openDatabase()
    .prepare(
      `SELECT s.id, s.problem_id, s.title, s.surface, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM chat_messages c WHERE c.session_id = s.id) AS message_count,
              (s.title LIKE :pattern ESCAPE '\\') AS title_hit,
              (SELECT m.content
                 FROM chat_messages m
                WHERE m.session_id = s.id AND m.content LIKE :pattern ESCAPE '\\'
                ORDER BY m.created_at ASC, m.rowid ASC
                LIMIT 1) AS hit_content
         FROM chat_sessions s
        WHERE (:surface IS NULL OR s.surface = :surface)
          AND (s.title LIKE :pattern ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM chat_messages m
                           WHERE m.session_id = s.id AND m.content LIKE :pattern ESCAPE '\\'))
        ORDER BY s.updated_seq DESC
        LIMIT :limit`
    )
    .all({ pattern, limit, surface: surface ?? null }) as Record<string, unknown>[];

  return {
    sessions: rows.map((row) => {
      const titleHit = Number(row.title_hit ?? 0) === 1;
      const content = (row.hit_content as string | null) ?? null;
      return {
        ...toSessionRow(row),
        messageCount: row.message_count as number,
        matchedIn: titleHit ? ("title" as const) : ("message" as const),
        snippet: titleHit || content === null ? null : snippetAround(content, trimmed),
      };
    }),
    total: rows.length,
  };
}

export function messagesFor(sessionId: string): ChatMessageRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, session_id, role, content, detected_mode, thinking_content,
              thinking_token_count, thinking_budget_used, prompt_tokens,
              completion_tokens, created_at
         FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC, rowid ASC`
    )
    .all(sessionId) as Record<string, unknown>[];

  return rows.map(toMessageRow);
}

/**
 * Optional fields carry an explicit `| undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `detectedMode?: string | null` means "may be absent,
 * but if present must not be undefined" — and the zod schema behind `chat:saveMessage` infers
 * exactly `string | null | undefined`. Spreading the validated input straight in is the
 * natural thing for the handler to do, so the type has to admit it.
 */
export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  detectedMode?: string | null | undefined;
  thinkingContent?: string | null | undefined;
  thinkingTokenCount?: number | null | undefined;
  thinkingBudgetUsed?: number | null | undefined;
  promptTokens?: number | null | undefined;
  completionTokens?: number | null | undefined;
}

export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`No chat session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export function appendMessage(sessionId: string, message: NewMessage): ChatMessageRow {
  const db = openDatabase();

  // Checked rather than left to the foreign key, so the caller gets a named error instead of
  // a SQLite constraint message with a session id buried in it.
  if (getSession(sessionId) === undefined) throw new UnknownSessionError(sessionId);

  const id = randomUUID();

  db.prepare(
    `INSERT INTO chat_messages
       (id, session_id, role, content, detected_mode, thinking_content,
        thinking_token_count, thinking_budget_used, prompt_tokens,
        completion_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`
  ).run(
    id,
    sessionId,
    message.role,
    message.content,
    message.detectedMode ?? null,
    message.thinkingContent ?? null,
    message.thinkingTokenCount ?? null,
    message.thinkingBudgetUsed ?? null,
    message.promptTokens ?? null,
    message.completionTokens ?? null
  );

  // A session's position in the list is "when did I last speak to it", so writing a message
  // is what makes it recent. Without this the list ordering would freeze at creation time.
  db.prepare(
    `UPDATE chat_sessions
        SET updated_at  = strftime('%Y-%m-%d %H:%M:%f', 'now'),
            updated_seq = (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM chat_sessions)
      WHERE id = ?`
  ).run(sessionId);

  const row = db
    .prepare(
      `SELECT id, session_id, role, content, detected_mode, thinking_content,
              thinking_token_count, thinking_budget_used, prompt_tokens,
              completion_tokens, created_at
         FROM chat_messages WHERE id = ?`
    )
    .get(id) as Record<string, unknown>;

  return toMessageRow(row);
}

/** Messages go with it — `ON DELETE CASCADE`, with `PRAGMA foreign_keys` on. */
export function deleteSession(id: string): void {
  openDatabase().prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}

function toSessionRow(row: Record<string, unknown>): ChatSessionRow {
  return {
    id: row.id as string,
    problemId: (row.problem_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    // The CHECK constrains what can be stored, so anything else means a hand-edited file.
    surface: (row.surface as ChatSurface | undefined) ?? "tutor",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toMessageRow(row: Record<string, unknown>): ChatMessageRow {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    detectedMode: (row.detected_mode as string | null) ?? null,
    thinkingContent: (row.thinking_content as string | null) ?? null,
    thinkingTokenCount: (row.thinking_token_count as number | null) ?? null,
    thinkingBudgetUsed: (row.thinking_budget_used as number | null) ?? null,
    promptTokens: (row.prompt_tokens as number | null) ?? null,
    completionTokens: (row.completion_tokens as number | null) ?? null,
    createdAt: row.created_at as string,
  };
}
