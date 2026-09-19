/**
 * The document a Build window writes when it closes, and reads when it opens.
 *
 * WHY THIS IS ITS OWN MODULE. The parsing used to live inline in a `useEffect` in
 * `BuildWorkspace`, where nothing could reach it — and every other persisted-document rule in
 * this workspace (`parseDockTab`, `parseWorkspaceTab`, `deserializeWorkspace`, `fromLegacy`) is a
 * pure function with a test beside it. Adding a new versioned field to the one branch that had no
 * test would have been the wrong place to start.
 *
 * TOTAL, LIKE EVERY OTHER PARSER HERE. `host.session.load()` returns a string this window wrote,
 * and "this window wrote it" guarantees nothing about its contents: it survives downgrades,
 * hand-editing, and a newer build that knows fields this one does not. Anything unrecognised
 * becomes the default rather than propagating.
 *
 * READING A FILE IS NOT THIS MODULE'S JOB. It returns the paths that *were* open; whether they
 * still exist is an `fs:read` per path and belongs to the caller. A document naming a file that
 * has since been deleted is ordinary, not an error.
 */
import { DEFAULT_DOCK_TAB, parseDockTab, type DockTab } from "./dock";
import {
  DEFAULT_WORKSPACE_TAB,
  parseWorkspaceTab,
  type WorkspaceTab,
} from "./workspace-tabs";
import {
  deserializeWorkspace,
  fromLegacy,
  GRID_SINCE_VERSION,
  WORKSPACE_LAYOUT_VERSION,
  type WorkspacePane,
} from "./workspace-layout";
import type { GridLayout } from "@/lib/layout/grid-model";

/** The version that first wrote a list of open files rather than a single active path. */
export const TABS_SINCE_VERSION = 6;

export interface RestoredWorkspace {
  dock: DockTab;
  workspace: WorkspaceTab;
  grid: GridLayout<WorkspacePane>;
  /**
   * Which files to try to reopen, in strip order.
   *
   * A document older than `TABS_SINCE_VERSION` carries only `active`, so this is that one path —
   * which is the behaviour those windows had, and is why they are converted rather than refused.
   */
  openPaths: string[];
  active: string | null;
  centre: "chat" | "file";
}

/**
 * Narrow a persisted document, or `null` if it cannot be used at all.
 *
 * `null` for unparseable JSON, for a version below 1, and for a version from the future. That
 * last one is the case worth naming: a document a newer build wrote may describe panes or tabs
 * this build has no surface for, and applying half of it is worse than opening fresh. The check
 * is against the constant rather than a literal, because an earlier version of this line
 * hard-coded the then-current number and the next bump made every existing document look like
 * one from the future.
 */
export function parseWorkspaceDocument(state: string): RestoredWorkspace | null {
  let parsed: {
    version?: number;
    active?: unknown;
    open?: unknown;
    centreTab?: unknown;
    panes?: unknown;
    centre?: unknown;
    dock?: unknown;
    workspace?: unknown;
    grid?: unknown;
  };
  try {
    parsed = JSON.parse(state) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const version = parsed.version;
  if (typeof version !== "number" || version < 1) return null;
  if (version > WORKSPACE_LAYOUT_VERSION) return null;

  /**
   * Versions 4 and up store a grid; 1 to 3 stored `panes` and `centre`, which is that grid
   * flattened. Converted rather than discarded: a gate that dropped them would look fine in a
   * fresh window and silently reset the layout of every existing one.
   *
   * `>=`, not equality. A v4 document holds a perfectly good grid whose centre pane is called
   * `editor`, and `deserializeWorkspace` renames it.
   */
  const grid =
    (version >= GRID_SINCE_VERSION ? deserializeWorkspace(parsed.grid) : null) ??
    fromLegacy(parsed.panes, parsed.centre);

  const active = typeof parsed.active === "string" ? parsed.active : null;

  /**
   * `open`, and NOT `centre`.
   *
   * `centre` is taken: versions 1 to 3 use it for the centre column's *sizes*, and `fromLegacy`
   * reads it as such two lines above. Naming the tab list `centre` would have made every v1
   * document restore a pair of pixel widths as file paths — which `filter` below would discard
   * silently, so the symptom would have been "my tabs never come back" with nothing to see.
   */
  const openPaths =
    version >= TABS_SINCE_VERSION && Array.isArray(parsed.open)
      ? parsed.open.filter((p): p is string => typeof p === "string")
      : active === null
        ? []
        : [active];

  return {
    // Absent on versions 1 and 2, which is why `parseDockTab` is total rather than a validator:
    // those documents restore to the default and open where they always did.
    dock: parseDockTab(parsed.dock),
    workspace: parseWorkspaceTab(parsed.workspace),
    grid,
    openPaths: [...new Set(openPaths)],
    active,
    /**
     * Older documents predate the centre pane having tabs at all, and they restore to Chat —
     * which is the surface those windows only ever had. A document naming `file` is honoured
     * only if a file actually comes back, which `parseCentreTab` decides once the caller knows.
     */
    centre: parsed.centreTab === "file" ? "file" : "chat",
  };
}

/** The document to write. Field names are the format above; changing one needs a version bump. */
export function serializeWorkspaceDocument(input: {
  grid: unknown;
  dock: DockTab;
  workspace: WorkspaceTab;
  openPaths: readonly string[];
  active: string | undefined;
  centre: "chat" | "file";
}): string {
  return JSON.stringify({
    version: WORKSPACE_LAYOUT_VERSION,
    active: input.active,
    open: [...input.openPaths],
    centreTab: input.centre,
    // The dimensions are metadata: our sizes are already shares, so restore never reads them.
    // Written anyway to keep the document byte-compatible with the format it is modelled on.
    grid: input.grid,
    dock: input.dock,
    workspace: input.workspace,
  });
}

/** Defaults, for a window with no document or an unusable one. */
export function defaultRestoredWorkspace(
  grid: GridLayout<WorkspacePane>
): RestoredWorkspace {
  return {
    dock: DEFAULT_DOCK_TAB,
    workspace: DEFAULT_WORKSPACE_TAB,
    grid,
    openPaths: [],
    active: null,
    centre: "chat",
  };
}
