"use client";

import { useEffect, useRef } from "react";
import type { SessionSummary } from "@/lib/api/chat";
import { formatRelativeTime } from "@/lib/format-time";

interface ChatHistoryDropdownProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  isLoading: boolean;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
  timezone?: string | null;
}

export default function ChatHistoryDropdown({
  sessions,
  activeSessionId,
  isLoading,
  onSelectSession,
  onDeleteSession,
  onClose,
  timezone,
}: ChatHistoryDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

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
      <div className="px-3 py-2 border-b border-line">
        <span className="text-xs font-medium text-ink">
          Chat History
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-center">
            <span className="text-xs text-ink-3">Loading...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <span className="text-xs text-ink-3">
              No chat history yet
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
                <div className="text-xs text-ink truncate">
                  {session.title || "Untitled Chat"}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-ink-3">
                    {formatRelativeTime(session.updatedAt, timezone)}
                  </span>
                  <span className="text-[10px] text-ink-3">
                    {session.messageCount} messages
                  </span>
                </div>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(session.id);
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}
