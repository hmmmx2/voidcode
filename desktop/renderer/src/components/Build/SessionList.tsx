"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Conversations in the Build assistant: new, search, open, delete.
 *
 * Built on `chat_sessions`/`chat_messages` rather than a new table. Those exist, work, and
 * already back the tutor's history — and a second pair meaning the same thing would have to be
 * kept in step with the first forever. What is *not* stored there is the agent's tool activity:
 * `chat_messages.role` has a CHECK admitting only `user` and `assistant`, SQLite cannot alter a
 * CHECK, and widening it means rebuilding the table. Steps stay in `agent_steps`, joined to a
 * conversation through `agent_runs.session_id`.
 *
 * Search runs in main over titles and message bodies. It is deliberately not filtering an
 * already-fetched page: the panel only ever holds the newest N sessions, so filtering here
 * would search the last 30 conversations and quietly report nothing for the 31st.
 */

export interface SessionRow {
  id: string;
  title: string | null;
  messageCount: number;
  updatedAt: string;
  /** Present on search results: the text around the hit, when a message matched. */
  snippet?: string | null;
}

export default function SessionList({
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onDelete,
  onNew,
  onSearch,
  error,
}: {
  sessions: readonly SessionRow[];
  activeSessionId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onSearch: (query: string) => void;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  /**
   * Debounced, because every keystroke is a SQLite `LIKE` scan over every message.
   *
   * 180ms is below the threshold where a search box feels laggy and well above the interval
   * between keystrokes, so a word typed at speed is one query rather than five.
   */
  useEffect(() => {
    const timer = setTimeout(() => onSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  const startNew = useCallback(() => {
    setQuery("");
    setConfirming(null);
    onNew();
  }, [onNew]);

  return (
    <div className="flex flex-col gap-2 border-b border-line bg-ide-bar px-2 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={startNew}
          className="rounded border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          New session
        </button>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="min-w-0 flex-1 rounded border border-line bg-ide-code px-2 py-1 text-[11px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-line-strong"
        />
      </div>

      <div className="max-h-48 overflow-y-auto">
        {loading ? (
          <p className="px-1 py-2 text-[11px] text-ink-3">Searching…</p>
        ) : sessions.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-ink-3">
            {query.trim() === "" ? "No conversations yet." : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-start gap-2 rounded px-1 py-1 transition-colors ${
                session.id === activeSessionId ? "bg-ide-raised" : "hover:bg-void-3"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                <span className="block truncate text-[11px] text-ink">
                  {session.title ?? "Untitled"}
                </span>
                {session.snippet != null && (
                  // Why this row matched, when it was not the title. A result list that does
                  // not say why it matched makes the user open each one to find out.
                  <span className="block truncate text-[10px] text-ink-3">{session.snippet}</span>
                )}
                <span className="block text-[10px] text-ink-3">
                  {session.messageCount} message{session.messageCount === 1 ? "" : "s"}
                </span>
              </button>

              {confirming === session.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(session.id);
                    }}
                    className="rounded px-1 text-[10px] font-medium text-diff-remove-ink hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-1 text-[10px] text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  // Two steps, because deleting cascades to every message and there is no undo.
                  onClick={() => setConfirming(session.id)}
                  aria-label={`Delete ${session.title ?? "this conversation"}`}
                  className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition-all hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
                    <path
                      d="M6 6l4 4M10 6l-4 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {error !== null && <p className="px-1 text-[10px] text-diff-remove-ink">{error}</p>}
    </div>
  );
}
