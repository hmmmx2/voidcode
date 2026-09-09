/**
 * Notifications: what happened while you were not looking.
 *
 * The web raised these in `submission_service` and fanned them out through Redis pub/sub so
 * an event on one node reached a client connected to another. A desktop app has one process
 * and one window, so the fan-out is a function call — `onCreated` below — and the whole
 * Redis half of the router simply has no counterpart here.
 *
 * Creation lives in main and is never a channel. A renderer that could write its own
 * notifications could tell the user their submission passed when it did not, which is the
 * one thing this surface is for.
 */
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";

/**
 * `submission_failed` is no longer raised by anything — only a first solve produces a
 * notification now. It stays in the vocabulary because rows written under the old rule are
 * still in people's databases, and the bell still has an icon and copy for them. Removing it
 * would mean rebuilding the table to change a CHECK constraint, for no gain.
 */
export type NotificationType =
  | "submission_accepted"
  | "submission_failed"
  | "welcome"
  | "streak"
  | "system";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  /** The thing it is about, e.g. a problem id. Null for those about nothing. */
  referenceId: string | null;
  createdAt: string;
}

export interface NewNotification {
  type: NotificationType;
  title: string;
  message: string;
  referenceId?: string | undefined;
}

/**
 * Live listeners, for the SSE stream.
 *
 * In-process because there is one process. The web needed Redis to cross nodes; here the
 * only distance to travel is main to renderer, and that is one `webContents.send`.
 */
type Listener = (notification: Notification) => void;
const listeners = new Set<Listener>();

export function onNotificationCreated(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createNotification(input: NewNotification): Notification {
  const id = randomUUID();
  openDatabase()
    .prepare(
      `INSERT INTO notifications (id, type, title, message, reference_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, input.type, input.title, input.message, input.referenceId ?? null);

  // Read back rather than construct: `created_at` is a column default, so building the
  // object here would invent a timestamp a millisecond off from the stored one — and the
  // list is sorted by it.
  const notification = getNotification(id) as Notification;

  for (const listener of listeners) {
    try {
      listener(notification);
    } catch {
      // A dead window is not a reason to fail the write. The notification is already
      // stored; the listener is only how it arrives sooner than the next poll.
    }
  }

  return notification;
}

export function getNotification(id: string): Notification | undefined {
  const row = openDatabase()
    .prepare(`SELECT ${COLUMNS} FROM notifications WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toNotification(row);
}

export function listNotifications(
  options: { unreadOnly?: boolean; limit?: number } = {}
): { notifications: Notification[]; unreadCount: number; total: number } {
  const db = openDatabase();
  // Clamped the way the server clamped it: a limit is a bound on work, so accepting an
  // unbounded one from the caller would make the bound decorative.
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);

  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM notifications
        ${options.unreadOnly === true ? "WHERE is_read = 0" : ""}
        -- rowid, not id. The id is a random UUID, so it is not a tiebreak at all — it is
        -- a coin toss, and two notifications from one submission land in the same
        -- millisecond often enough that the test caught it on the first run. SQLite's
        -- implicit rowid increases with insertion, which is exactly "newest" when the
        -- timestamps tie. (chat_sessions needed a counter column instead because it orders
        -- by most recently *updated*, which insertion order cannot express.)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];

  return {
    notifications: rows.map(toNotification),
    unreadCount: unreadCount(),
    // Every notification, not the filtered or truncated count. The list says "showing 50 of
    // 120"; a total that shrank with the filter could not.
    total: (db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n,
  };
}

export function unreadCount(): number {
  const row = openDatabase()
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0")
    .get() as { n: number };
  return row.n;
}

/**
 * Mark as read. An empty or absent list means all of them.
 *
 * Only unread rows are touched, so the returned count is "how many changed" rather than
 * "how many matched" — marking an already-read notification read again is not a change and
 * reporting it as one would make the badge appear to update when nothing did.
 */
export function markRead(ids?: readonly string[]): number {
  const db = openDatabase();

  if (ids === undefined || ids.length === 0) {
    return db.prepare("UPDATE notifications SET is_read = 1 WHERE is_read = 0").run()
      .changes as number;
  }

  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `UPDATE notifications SET is_read = 1
        WHERE is_read = 0 AND id IN (${placeholders})`
    )
    .run(...ids).changes as number;
}

/**
 * The one notification nobody earned.
 *
 * The web created this when a user row was created; a desktop install has no such moment, so
 * the condition is "this database has never held a notification and has never held a
 * submission". Both halves matter: the first alone would re-fire for someone upgrading from
 * a build that predates this table, handing a welcome message to a user with fifty
 * submissions behind them.
 */
export function seedWelcomeNotification(): Notification | undefined {
  const db = openDatabase();
  const seen = db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
  if (seen.n > 0) return undefined;

  const submissions = db.prepare("SELECT COUNT(*) AS n FROM submissions").get() as { n: number };
  if (submissions.n > 0) return undefined;

  return createNotification({
    type: "welcome",
    title: "Welcome to VoidCode AI",
    /**
     * The only first-run artefact this app has, so it is the one place that can say the thing a new
     * user cannot otherwise find out: **Ollama is a separate download.**
     *
     * The order is deliberate. Start with what works immediately, because it is most of the product
     * and it needs nothing installed; mention the model second, as an addition rather than a
     * prerequisite. Reversed, this reads as a setup checklist standing between the reader and the
     * exercises — and it would be a false one, since grading is local (spec §4.4).
     *
     * The URL is spelled out rather than linked because a notification body is plain text here. That
     * is a feature for this particular sentence: it is short enough to read off the screen.
     */
    message:
      "The exercises, the grading and your progress all run on this machine, and need nothing " +
      "installed — start with a problem and submit when you are ready. " +
      "The tutor and the coding assistant need a language model, which is a separate free " +
      "download: install Ollama from ollama.com, then open the model manager to see what your " +
      "machine can run.",
  });
}

const COLUMNS = "id, type, title, message, is_read, reference_id, created_at";

function toNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as string,
    type: row.type as NotificationType,
    title: row.title as string,
    message: row.message as string,
    // SQLite has no boolean type; the column is a 0/1 INTEGER with a CHECK constraint.
    isRead: row.is_read === 1,
    referenceId: (row.reference_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}
