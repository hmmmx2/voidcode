"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionMatch } from "@/lib/api/chat";
import { formatRelativeTime } from "@/lib/format-time";

interface ChatHistoryDropdownProps {
  sessions: SessionMatch[];
  /** Runs in main over every message. Called as the box changes, debounced below. */
  onSearch: (query: string) => void;
  activeSessionId: string | null;
  isLoading: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
  timezone?: string | null;
  /** A delete that failed, shown here rather than only in a console. */
  deleteError?: string | null;
}

export default function ChatHistoryDropdown({
  sessions,
  onSearch,
  activeSessionId,
  isLoading,
  onSelectSession,
  onDeleteSession,
  onClose,
  timezone,
  deleteError = null,
}: ChatHistoryDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Which row is asking "are you sure", if any.
   *
   * Deleting cascades to every message and there is no undo, so a single mis-hover on a
   * 14px target should not be able to destroy a conversation. Confirming in place rather
   * than in a modal: the row is the thing being deleted, so it is the right place to ask,
   * and a dialog over a dropdown that closes on outside-click fights itself.
   *
   * This mattered less while the button was dead. It is exactly what wiring it up creates.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  /**
   * Debounced, because each keystroke is a LIKE scan over every stored message.
   *
   * 180ms is below where a search box starts to feel laggy and above the gap between
   * keystrokes, so a word typed at speed is one query rather than five.
   */
  useEffect(() => {
    const timer = setTimeout(() => onSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={dropdownRef}
      className="absolute top-full right-0 mt-1 w-72 bg-ide-bar border border-line rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <div className="border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-ink">Chat History</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="mt-1.5 w-full rounded border border-line bg-ide-code px-2 py-1 text-[11px] text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-line-strong"
        />
      </div>

      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-center">
            <span className="text-xs text-ink-3">Loading...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <span className="text-xs text-ink-3">
              {query.trim() === ""
                ? "No chat history yet"
                : `Nothing matches “${query.trim()}”`}
            </span>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors group ${
                session.id === activeSessionId
                  ? "bg-ide-raised"
                  : "hover:bg-void-3"
              }`}
            >
              <button
                className="flex-1 text-left min-w-0"
                onClick={() => onSelectSession(session.id)}
              >
                <div className="truncate text-xs text-ink">
                  {session.title || "Untitled Chat"}
                </div>
                {session.snippet != null && (
                  // Why this row matched, when it was not the title. A result list that does
                  // not say why makes you open each one to find out.
                  <div className="truncate text-[10px] text-ink-3">{session.snippet}</div>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-ink-3">
                    {formatRelativeTime(session.updatedAt, timezone)}
                  </span>
                  <span className="text-[10px] text-ink-3">
                    {session.messageCount} messages
                  </span>
                </div>
              </button>
              {confirming === session.id ? (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirming(null);
                      onDeleteSession(session.id);
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-diff-remove-ink hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                    aria-label={`Confirm deleting ${session.title || "this chat"}`}
                  >
                    Delete
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirming(null);
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] text-ink-3 hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                    aria-label="Keep this chat"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirming(session.id);
                }}
                className="flex-shrink-0 rounded p-1 text-ink-3 opacity-0 transition-all hover:bg-ide-raised hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                title="Delete chat"
                aria-label="Delete chat"
              >
                {/* Inline, not `/icons/ic-x-circle.svg` — that file bakes
                    #BE280E, so it could never follow the button's hover state
                    and put a red nothing else here uses on a delete affordance
                    that is already unambiguous. */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
              )}
            </div>
          ))
        )}
      </div>

      {deleteError !== null && (
        <div className="border-t border-line px-3 py-2">
          <span className="text-[10px] text-diff-remove-ink">{deleteError}</span>
        </div>
      )}
    </div>
  );
}
