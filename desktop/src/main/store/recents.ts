/**
 * Recently opened projects, for File ▸ Open Recent.
 *
 * In SQLite beside everything else the user owns, rather than a JSON file next to it: the
 * database is already the answer to "where does this app keep my things", and a second
 * mechanism would be a second thing to back up, migrate and explain.
 *
 * Paths only. No contents, no tree, nothing derived — the tree is re-read on open, because a
 * cached one would be wrong the moment anything changed on disk, and a file list that lies is
 * worse than a slower open.
 */
import { openDatabase } from "./db.js";

export interface RecentProject {
  path: string;
  /** Basename, for a menu that would otherwise be a column of long absolute paths. */
  name: string;
  openedAt: string;
}

/**
 * Enough to be useful, few enough to stay a menu.
 *
 * A submenu is scanned, not searched, so a list past about ten stops being faster than the
 * folder picker it is meant to save you from.
 */
const MAX_RECENTS = 10;

export function rememberProject(absolutePath: string): void {
  const db = openDatabase();

  // Upsert on the path so reopening moves it to the top rather than adding a duplicate. The
  // path is the identity — the same folder opened twice is one entry.
  db.prepare(
    `INSERT INTO recent_projects (path, opened_at, opened_seq)
     VALUES (?, datetime('now'), (SELECT COALESCE(MAX(opened_seq), 0) + 1 FROM recent_projects))
     ON CONFLICT (path) DO UPDATE SET
       opened_at  = datetime('now'),
       opened_seq = (SELECT COALESCE(MAX(opened_seq), 0) + 1 FROM recent_projects)`
  ).run(absolutePath);

  // Trimmed on write rather than on read: the list is small, writes are rare, and doing it
  // here means the stored data never grows past what the menu shows.
  db.prepare(
    `DELETE FROM recent_projects
      WHERE path NOT IN (
        SELECT path FROM recent_projects ORDER BY opened_seq DESC LIMIT ?
      )`
  ).run(MAX_RECENTS);
}

export function recentProjects(): RecentProject[] {
  const rows = openDatabase()
    .prepare(
      `SELECT path, opened_at FROM recent_projects
        ORDER BY opened_seq DESC
        LIMIT ?`
    )
    .all(MAX_RECENTS) as Record<string, unknown>[];

  return rows.map((row) => {
    const value = row.path as string;
    return {
      path: value,
      // Split on both separators: a database written on Windows and read on a machine with a
      // different `path.sep` would otherwise show the whole string as the name.
      name: value.split(/[\\/]/).filter(Boolean).pop() ?? value,
      openedAt: row.opened_at as string,
    };
  });
}

/** Drops one entry — used when a remembered folder has been moved or deleted. */
export function forgetProject(absolutePath: string): void {
  openDatabase().prepare("DELETE FROM recent_projects WHERE path = ?").run(absolutePath);
}
