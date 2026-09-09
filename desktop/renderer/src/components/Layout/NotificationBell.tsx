"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Menu } from "@/components/app";
import { cn } from "@/lib/utils";
import { IconBell } from "@/components/icons";
import { useUserId } from "@/lib/hooks/useUserId";
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  connectNotificationStream,
  type Notification,
} from "@/lib/api/notifications";
import { formatRelativeTime } from "@/lib/format-time";
import { useUserProfile } from "@/lib/context/UserProfileContext";

// ── Inline SVG icons (from assets) ──────────────────────────

/** ic-check-circle.svg — green stroke #657B3C */
function IconCheckCircle({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="7.5" stroke="currentColor" />
      <path
        d="M4 8.22485L6.50511 10.6864L10.6978 4.57151"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** ic-x-circle.svg — red stroke #BE280E */
function IconXCircle({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="7.5" stroke="currentColor" />
      <path
        d="M7.8927 6.6814L9.91418 4.66089L11.1261 5.87378L9.10559 7.89331L11.0363 9.82495L9.82434 11.0369L7.89368 9.1062L5.87317 11.1267L4.66125 9.91382L6.68079 7.89331L4.57141 5.78394L5.7843 4.57202L7.8927 6.6814Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Generic bell/info circle for welcome, streak, and default types */
function IconInfoCircle({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="7.5" stroke="currentColor" />
      <path
        d="M8 7V11M8 5.5V5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Type icon mapping ────────────────────────────────────────
//
// ICON SHAPE, NOT COLOUR. This used to return a `color`/`iconColor` pair per
// type — green for accepted, red for failed, blue for welcome, yellow for
// streak — four hues in a 320px dropdown, and the largest single concentration
// of stray colour in the app's chrome.
//
// A tick, a cross and an info glyph already separate these four states, and the
// title text says which is which. Note that even the pass/fail pair goes
// monochrome here: `verdict-*` is reserved for the test console, where a
// learner scans results under time pressure. A notification is read once, in a
// list, at leisure — it does not need the same signal, and spending colour on
// it would devalue the place that does.

function typeStyles(type: string): {
  Icon: React.ComponentType<{ className?: string }>;
} {
  switch (type) {
    case "submission_accepted":
      return { Icon: IconCheckCircle };
    case "submission_failed":
      return { Icon: IconXCircle };
    default:
      return { Icon: IconInfoCircle };
  }
}

/**
 * Two sizes, because there are two bars.
 *
 * `md` (32px) is the marketing header in `TopNavigation`, where the bell sits among 40px
 * controls. `sm` (24px) is the workbench title bar, which is 36px tall and whose other icons
 * are 24px — at 32px the bell was visibly the largest thing up there and carried its own
 * hover colour into the bargain. Defaulting to `md` keeps the legal pages untouched.
 */
export interface NotificationBellProps {
  size?: "sm" | "md";
}

export default function NotificationBell({ size = "md" }: NotificationBellProps = {}) {
  const userId = useUserId();
  const { profile } = useUserProfile();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Seed the initial badge count from DB on mount ──────────
  // We do this once so the badge is correct before the SSE stream
  // delivers its first event. After that, SSE keeps it up to date.
  useEffect(() => {
    fetchUnreadCount(userId)
      .then(setUnreadCount)
      .catch(() => {}); // silently fail — badge stays at 0
  }, [userId]);

  // ── SSE stream — real-time notification push ────────────────
  // Replaces the old 60-second polling interval.
  // connectNotificationStream auto-reconnects if the connection drops.
  useEffect(() => {
    if (!userId) return;

    const abort = new AbortController();

    const disconnect = connectNotificationStream(
      userId,
      (incoming) => {
        // Increment badge immediately
        setUnreadCount((prev) => prev + 1);
        // Prepend to list so it appears at the top (list may be empty if
        // dropdown hasn't been opened yet — that's fine, it gets loaded on open)
        setNotifications((prev) => [incoming, ...prev]);
      },
      abort.signal
    );

    return () => {
      abort.abort();   // signals fetch to stop
      disconnect();    // sets active=false so the loop won't reconnect
    };
  }, [userId]);

  // ── Close dropdown on click-outside ────────────────────────
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (dropdownRef.current === null || target === null) return;
      // The panel is portalled into `document.body` to escape the workbench menu bar's
      // stacking context, so it is not a descendant of this wrapper. Without the second
      // test every click *inside* the menu counts as outside it and closes it — which
      // makes "Mark all as read" unclickable.
      if (dropdownRef.current.contains(target)) return;
      if (target.closest("[data-menu-portal]") !== null) return;
      setIsOpen(false);
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // ── Toggle dropdown + load notifications ───────────────────
  const handleToggle = async () => {
    const opening = !isOpen;
    setIsOpen(opening);

    if (opening) {
      setIsLoading(true);
      try {
        const data = await fetchNotifications(userId);
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      } catch {
        // show whatever we already have
      } finally {
        setIsLoading(false);
      }
    }
  };

  // ── Mark all as read ───────────────────────────────────────
  const handleMarkAllRead = async () => {
    try {
      await markNotificationsRead([], userId);
      setUnreadCount(0);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true }))
      );
    } catch {
      // silently fail
    }
  };

  // ── Click on a notification ────────────────────────────────
  const handleNotificationClick = async (n: Notification) => {
    // Mark as read
    if (!n.isRead) {
      try {
        await markNotificationsRead([n.id], userId);
        setNotifications((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch {
        // silently fail
      }
    }

    // Navigate to related problem if it's a submission notification
    if (n.referenceId && n.type.startsWith("submission_")) {
      setIsOpen(false);
      // referenceId is a problem UUID — we navigate to /problems/1 etc.
      // For now just close the dropdown
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell icon button */}
      <button
        type="button"
        onClick={handleToggle}
        title="Notifications"
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={isOpen}
        className={cn(
          "relative flex items-center justify-center",
          size === "sm" ? "h-6 w-6 rounded" : "h-8 w-8 rounded-lg",
          "transition-colors duration-200 ease-void",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
          // `sm` borrows the title bar's hover convention rather than the header's. Its
          // neighbours there use `bg-ide-raised`; `bg-white/10` beside them read as a
          // different control that happened to be adjacent.
          size === "sm"
            ? isOpen
              ? "bg-ide-raised text-ink"
              : "text-ink-3 hover:bg-ide-raised hover:text-ink"
            : isOpen
              ? "bg-white/10 text-ink"
              : "text-ink-3 hover:bg-white/5 hover:text-ink-2"
        )}
      >
        {/* Sized by prop, not by class: the glyph's own width/height attributes win over a
            className, which is how the old 20px bell survived every attempt to shrink it. */}
        <IconBell size={size === "sm" ? 16 : 20} />
        {/* The badge is white-on-black, not red. It is a count, not an alarm —
            and its position on the bell is what marks it as unread. The count
            is also in the button's accessible name above, so a screen reader
            does not depend on this at all. */}
        {unreadCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute flex items-center justify-center rounded-full bg-ink font-bold leading-none text-void-0",
              // The badge scales with the button, which it did not until the title bar asked
              // for 24px: a 16px badge on a 16px glyph covered most of the bell and read as an
              // icon in its own right rather than a count on one.
              size === "sm"
                ? "-right-1 -top-1 h-3 min-w-[12px] px-[3px] text-[8px]"
                : "-right-0.5 -top-0.5 h-4 min-w-[16px] px-1 text-[10px]"
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <Menu width="w-80" anchor={dropdownRef}>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-medium text-ink">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:outline-none focus-visible:text-ink focus-visible:underline"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-xs text-ink-3">Loading…</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-xs text-ink-3">No notifications yet</span>
              </div>
            ) : (
              notifications.map((n) => {
                const { Icon } = typeStyles(n.type);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleNotificationClick(n)}
                    className={cn(
                      "flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left last:border-b-0",
                      "transition-colors duration-150 ease-void hover:bg-white/5",
                      "focus-visible:outline-none focus-visible:bg-white/5",
                      // Unread reads as *brighter*, not as a different colour —
                      // the same axis the rest of the product uses for emphasis.
                      !n.isRead && "bg-white/[0.025]"
                    )}
                  >
                    <span className="mt-0.5 flex-shrink-0 text-ink-3">
                      <Icon />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "truncate text-xs font-medium",
                            n.isRead ? "text-ink-2" : "text-ink"
                          )}
                        >
                          {n.title}
                        </span>
                        {!n.isRead && (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-ink"
                          />
                        )}
                        {!n.isRead && <span className="sr-only">Unread</span>}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">
                        {n.message}
                      </p>
                      <span className="mt-1 block font-mono text-[10px] text-ink-3">
                        {formatRelativeTime(n.createdAt, profile?.timezone)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Menu>
      )}
    </div>
  );
}
