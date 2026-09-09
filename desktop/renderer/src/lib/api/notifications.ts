/**
 * Notifications API client — fetch and manage user notifications.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ──────────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  referenceId: string | null;
  createdAt: string;
}

export interface NotificationList {
  notifications: Notification[];
  unreadCount: number;
  total: number;
}

// ── Parsers ────────────────────────────────────────────────────

function parseNotification(data: Record<string, unknown>): Notification {
  return {
    id: data.id as string,
    type: data.type as string,
    title: data.title as string,
    message: data.message as string,
    isRead: data.is_read as boolean,
    referenceId: (data.reference_id as string) ?? null,
    createdAt: data.created_at as string,
  };
}

// ── API Functions ─────────────────────────────────────────────

export async function fetchNotifications(
  userId?: string,
  unreadOnly = false,
  limit = 50
): Promise<NotificationList> {
  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread_only", "true");
  params.set("limit", String(limit));

  const res = await fetch(
    `${API_BASE}/v1/notifications?${params.toString()}`,
    { headers: makeHeaders(userId) }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch notifications: ${res.status}`);
  }

  const data = await res.json();
  return {
    notifications: (data.notifications as Record<string, unknown>[]).map(
      parseNotification
    ),
    unreadCount: data.unread_count as number,
    total: data.total as number,
  };
}

export async function fetchUnreadCount(userId?: string): Promise<number> {
  const res = await fetch(`${API_BASE}/v1/notifications/count`, {
    headers: makeHeaders(userId),
  });

  if (!res.ok) return 0;

  const data = await res.json();
  return (data.unread_count as number) ?? 0;
}

export async function markNotificationsRead(
  notificationIds: string[],
  userId?: string
): Promise<number> {
  const res = await fetch(`${API_BASE}/v1/notifications/read`, {
    method: "PATCH",
    headers: makeHeaders(userId),
    body: JSON.stringify({ notification_ids: notificationIds }),
  });

  if (!res.ok) {
    throw new Error(`Failed to mark notifications: ${res.status}`);
  }

  const data = await res.json();
  return (data.updated as number) ?? 0;
}

// ── SSE stream ─────────────────────────────────────────────────

/**
 * Opens a persistent SSE connection to GET /v1/notifications/stream.
 *
 * Uses fetch + ReadableStream (not native EventSource) because EventSource cannot be given custom
 * request headers, and because the transport seam in `client.ts` intercepts `fetch` — an EventSource
 * would go looking for a network origin that does not exist.
 *
 * It said the headers were needed "for X-User-Id for authentication". Nothing authenticates: there is
 * one local user and no server to present a credential to, and no handler in main reads that header.
 * Calling it authentication implied a check that was not happening, which is the kind of claim worth
 * removing even when the code around it is correct.
 *
 * Auto-reconnects every 3 s if the connection drops.
 *
 * @returns a cleanup function — call it to permanently close the stream
 *          (e.g. from a useEffect cleanup or on unmount).
 */
export function connectNotificationStream(
  userId: string | undefined,
  onNotification: (notification: Notification) => void,
  signal?: AbortSignal
): () => void {
  let active = true;

  async function connect() {
    while (active) {
      try {
        const res = await fetch(`${API_BASE}/v1/notifications/stream`, {
          headers: makeHeaders(userId),
          signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Stream responded with ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (active) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are delimited by \n\n
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.replace(/^data: /, "").trim();
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as {
                type: string;
                data?: Record<string, unknown>;
              };
              if (parsed.type === "notification" && parsed.data) {
                onNotification(parseNotification(parsed.data));
              }
              // "connected" and "heartbeat" events are intentionally ignored
            } catch {
              // Malformed JSON — skip
            }
          }
        }
      } catch {
        if (!active) break; // intentional close — don't reconnect
        // Network error / server restart — wait 3 s then reconnect
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  connect();

  // Return cleanup: sets active=false so the loop exits after the next read
  return () => {
    active = false;
  };
}
