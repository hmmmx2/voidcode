/**
 * Which of the centre pane's tabs is showing, and what happens when one closes.
 *
 * Its own module, and pure, so the transitions can be tested without mounting a workspace — the
 * same reason `dock.ts`, `workspace-tabs.ts` and `assistant-view.ts` sit beside it. `TerminalTabs`
 * and `Breadcrumbs` have both cited an `editor-tabs` module in their comments since the old Build
 * editor was removed; those citations resolve again.
 *
 * TWO VALUES RATHER THAN ONE, which is the only structural decision here. `activePath` in
 * `BuildWorkspace` stays "the file the viewer is showing"; `CentreTab` says whether the viewer is
 * what you are *looking at*. Collapsing them into a single `CentreTab | undefined` would mean the
 * tab strip loses its file tabs the moment you switch to Chat, and the file tree's own highlight —
 * which reads `activePath` — would flicker off with them.
 *
 * CHAT IS NOT IN THE PATH LIST. It is always present and never closable, which is the same fact
 * `applyVisibility` already states one level up as "the chat pane is never collapsible". Keeping
 * it out of `paths` means every function here is about files, and the invariant cannot be violated
 * by a transition that empties a list.
 */

/** The centre pane is showing the conversation, or one open file. */
export type CentreTab = { kind: "chat" } | { kind: "file"; path: string };

export const CHAT_TAB: CentreTab = { kind: "chat" };

/**
 * How many files can be open at once.
 *
 * A cap with a reason, the way `useTerminals` caps shells rather than letting a list grow until
 * the window is unusable. Each tab costs a full copy of the file in JS *and* a Monaco text model
 * with its own undo stack, neither of which is freed until the tab closes. Sixteen is past what
 * anyone navigates by clicking and well short of where either cost is noticeable.
 *
 * The seventeenth open is refused rather than silently evicting the oldest. Evicting would throw
 * away a buffer the user had edited, which is precisely the bug tabs exist to prevent.
 */
export const MAX_OPEN_TABS = 16;

/** Whether another file can be opened. */
export function atCapacity(paths: readonly string[]): boolean {
  return paths.length >= MAX_OPEN_TABS;
}

/**
 * Add a path to the strip, or return the strip unchanged if it is already there.
 *
 * Appends. Inserting beside the active tab is what some editors do and it means the strip
 * reorders itself under the pointer, so a second click lands on a different file than the one you
 * were aiming at.
 */
export function openTab(paths: readonly string[], path: string): string[] {
  if (paths.includes(path)) return [...paths];
  if (atCapacity(paths)) return [...paths];
  return [...paths, path];
}

/**
 * Close one tab, and say which file the viewer should show afterwards.
 *
 * RIGHT, THEN LEFT, THEN NOTHING. Closing the tab you are looking at moves you to its right
 * neighbour, falling back to the left when it was the last one, and to `null` — which the caller
 * reads as "show Chat" — when it was the only one. That is every editor's behaviour and the reason
 * is that the tab to the right is where a newly opened file went, so it is the one you were most
 * likely working through.
 *
 * Closing a tab you are *not* looking at leaves the active file alone. A close that also
 * navigated would move the user for pressing a button that said "close".
 */
export function closeTab(
  paths: readonly string[],
  active: string | null,
  path: string
): { paths: string[]; active: string | null } {
  const index = paths.indexOf(path);
  if (index === -1) return { paths: [...paths], active };

  const next = paths.filter((p) => p !== path);
  if (active !== path) return { paths: next, active };

  // `index` still points at the closed tab's slot, which is now the right neighbour.
  return { paths: next, active: next[index] ?? next[index - 1] ?? null };
}

/** Follow a rename, keeping the tab in place and the selection on it. */
export function renameTab(
  paths: readonly string[],
  active: string | null,
  from: string,
  to: string
): { paths: string[]; active: string | null } {
  if (!paths.includes(from)) return { paths: [...paths], active };
  return {
    paths: paths.map((p) => (p === from ? to : p)),
    active: active === from ? to : active,
  };
}

/**
 * A persisted value, narrowed to something this build can show.
 *
 * Total, like `parseDockTab` and `parseWorkspaceTab` and for the same reason: the string comes off
 * a document this window wrote, and "this window wrote it" is no guarantee about its contents — it
 * survives downgrades, hand-editing, and a newer build that knows more.
 *
 * `active` is checked against `openPaths` rather than trusted, because a file can be deleted
 * between sessions. Restoring a file tab whose file is gone would open the window onto an error.
 */
export function parseCentreTab(
  value: unknown,
  openPaths: readonly string[],
  active: string | null
): CentreTab {
  if (value !== "file") return CHAT_TAB;
  if (active === null || !openPaths.includes(active)) return CHAT_TAB;
  return { kind: "file", path: active };
}

/** What to write for the tab, given the shape `parseCentreTab` reads back. */
export function serializeCentreTab(tab: CentreTab): "chat" | "file" {
  return tab.kind;
}

/**
 * What each tab is called.
 *
 * The basename, until two tabs share one — then each gets its parent directory as well, which is
 * the rule every editor uses. `src/index.ts` and `main/index.ts` both showing "index.ts" is not a
 * cosmetic problem: it makes the strip unreadable at exactly the moment you have two similar files
 * open, which is when you are most likely to be comparing them.
 *
 * Only the ambiguous ones are expanded. Expanding all of them would widen every tab in a project
 * that happens to contain one collision.
 */
export function tabLabels(paths: readonly string[]): Map<string, string> {
  const basenames = new Map<string, number>();
  for (const path of paths) {
    const name = basename(path);
    basenames.set(name, (basenames.get(name) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const path of paths) {
    const name = basename(path);
    if ((basenames.get(name) ?? 0) < 2) {
      labels.set(path, name);
      continue;
    }
    const parent = parentName(path);
    labels.set(path, parent === "" ? name : `${parent}/${name}`);
  }
  return labels;
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function parentName(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "";
  const parent = path.slice(0, cut);
  const previous = parent.lastIndexOf("/");
  return previous === -1 ? parent : parent.slice(previous + 1);
}
