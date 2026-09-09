/**
 * Which windows were open, where, and what they had in them.
 *
 * The app restored nothing. Every launch created exactly one window, at a hard-coded size, at
 * whatever position the OS chose, with no project and no tabs — so quitting with three
 * projects open cost three folder-pickers and a dozen file clicks to get back to work.
 *
 * Two rules the rest of this file follows:
 *
 *   - **Bounds come from main, never from the renderer.** They are read off the window's own
 *     move and resize events. A channel that accepted a rectangle would let a renderer lie
 *     about where its window is, and there is nothing to gain by allowing it.
 *   - **Paths, never contents.** See the `window_workspace` comment in `db.ts`: persisting
 *     dirty buffers would make this database a second, silently diverging copy of the user's
 *     source.
 */
import { openDatabase } from "./db.js";
import type { WindowMode } from "../modes.js";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionWindow {
  id: string;
  mode: WindowMode;
  projectRoot: string | null;
  route: string;
  bounds: WindowBounds;
  maximised: boolean;
  fullScreen: boolean;
}

/** Upsert everything main knows about a window. */
export function rememberWindow(window: SessionWindow): void {
  openDatabase()
    .prepare(
      `INSERT INTO windows (id, mode, project_root, route, bounds, maximised, full_screen,
                            restorable, updated_at, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'),
               (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM windows))
       ON CONFLICT (id) DO UPDATE SET
         mode         = excluded.mode,
         project_root = excluded.project_root,
         route        = excluded.route,
         bounds       = excluded.bounds,
         maximised    = excluded.maximised,
         full_screen  = excluded.full_screen,
         -- Back to restorable. Remembering a window means it is live right now, and a row
         -- that stayed at 0 would be a window on screen that silently will not come back.
         -- Ids are uuids so reuse should not happen, but the invariant is cheaper to hold
         -- than to reason about.
         restorable   = 1,
         updated_at   = datetime('now'),
         updated_seq  = (SELECT COALESCE(MAX(updated_seq), 0) + 1 FROM windows)`
    )
    .run(
      window.id,
      window.mode,
      window.projectRoot,
      window.route,
      JSON.stringify(window.bounds),
      window.maximised ? 1 : 0,
      window.fullScreen ? 1 : 0
    );
}

/**
 * The user closed this window on purpose, so it should not come back.
 *
 * Distinct from deleting the row: keeping it means a later launch can still read what it had,
 * and it makes the difference between "closed" and "never existed" inspectable.
 */
export function forgetWindow(id: string): void {
  openDatabase().prepare("UPDATE windows SET restorable = 0 WHERE id = ?").run(id);
}

/** Windows to reopen, oldest first so they stack in the order they were created. */
export function restorableWindows(): SessionWindow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, mode, project_root, route, bounds, maximised, full_screen
         FROM windows
        WHERE restorable = 1
        ORDER BY updated_seq ASC`
    )
    .all() as Record<string, unknown>[];

  return rows.flatMap((row) => {
    let bounds: WindowBounds;
    try {
      bounds = JSON.parse(row.bounds as string) as WindowBounds;
    } catch {
      // A row we cannot read is dropped rather than allowed to abort the whole restore. One
      // corrupt window must not cost the user the other two.
      return [];
    }
    return [
      {
        id: row.id as string,
        mode: row.mode as WindowMode,
        projectRoot: (row.project_root as string | null) ?? null,
        route: row.route as string,
        bounds,
        maximised: row.maximised === 1,
        fullScreen: row.full_screen === 1,
      },
    ];
  });
}

/**
 * Everything else a window had open, as an opaque versioned document.
 *
 * This module deliberately does not know what is inside. The renderer owns the shape of its
 * own layout, and a `windows` table that had to be migrated every time a pane gained a
 * property would be the tail wagging the dog.
 */
export function saveWorkspaceState(windowId: string, state: unknown): void {
  openDatabase()
    .prepare(
      `INSERT INTO window_workspace (window_id, state, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (window_id) DO UPDATE SET
         state = excluded.state, updated_at = datetime('now')`
    )
    .run(windowId, JSON.stringify(state));
}

export function loadWorkspaceState(windowId: string): unknown {
  const row = openDatabase()
    .prepare("SELECT state FROM window_workspace WHERE window_id = ?")
    .get(windowId) as { state?: string } | undefined;

  if (row?.state === undefined) return undefined;
  try {
    return JSON.parse(row.state);
  } catch {
    return undefined;
  }
}

/** Drops a window and its workspace entirely. Used when a restored window fails to open. */
export function dropWindow(id: string): void {
  // `window_workspace` cascades, but only with `PRAGMA foreign_keys = ON` — which `db.ts`
  // sets. Naming the dependency here so a future change to that pragma has a comment to trip
  // over rather than a silent orphan.
  openDatabase().prepare("DELETE FROM windows WHERE id = ?").run(id);
}

export interface Display {
  bounds: WindowBounds;
}

/** Smallest window we will restore to, whatever the stored rectangle says. */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

/** How much of a window must be on a display for it to count as reachable. */
const VISIBLE_MARGIN = 80;

/**
 * Keep a restored window somewhere the user can actually reach it.
 *
 * THE MOST COMMON REAL BUG IN THIS FEATURE, by a distance: someone works on a laptop docked
 * to a second monitor, quits, undocks, and reopens the app to a window positioned at x=2400 —
 * off-screen, unreachable, and to all appearances a crash. It is worse than it sounds because
 * the window genuinely exists and has focus, so keyboard input goes somewhere invisible.
 *
 * Pure, and takes the display list as an argument, so the arithmetic can be tested without a
 * screen. Returns a rectangle that is guaranteed to overlap some display by at least
 * `VISIBLE_MARGIN` in both axes, falling back to centring on the primary display.
 */
export function clampToDisplays(
  bounds: WindowBounds,
  displays: readonly Display[]
): WindowBounds {
  const width = Math.max(bounds.width, MIN_WIDTH);
  const height = Math.max(bounds.height, MIN_HEIGHT);

  const reachable = displays.some((display) => {
    const d = display.bounds;
    // Enough of the title bar on screen to grab. Full containment is the wrong test — a
    // window deliberately hanging off the right edge is a normal thing to have arranged.
    const overlapX = Math.min(bounds.x + width, d.x + d.width) - Math.max(bounds.x, d.x);
    const overlapY = Math.min(bounds.y + height, d.y + d.height) - Math.max(bounds.y, d.y);
    return overlapX >= VISIBLE_MARGIN && overlapY >= VISIBLE_MARGIN;
  });

  if (reachable) return { x: bounds.x, y: bounds.y, width, height };

  const primary = displays[0];
  if (primary === undefined) return { x: 0, y: 0, width, height };

  return {
    x: Math.round(primary.bounds.x + (primary.bounds.width - width) / 2),
    y: Math.round(primary.bounds.y + (primary.bounds.height - height) / 2),
    width: Math.min(width, primary.bounds.width),
    height: Math.min(height, primary.bounds.height),
  };
}
