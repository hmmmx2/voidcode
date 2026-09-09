/**
 * The Build workspace as a grid, and what to do with the layouts written before there was one.
 *
 * Four panes: the sidebar, the chat, the bottom dock beneath it, and the workspace. They were three
 * nested `SplitContainer`s with two separate size arrays — `paneSizes` keyed by pane and
 * `centreSizes` as a bare pair — plus `pane-sizes.ts` to stop a collapsed pane's width being
 * redistributed. One tree replaces all of it: nesting is the only structure, and a hidden leaf
 * keeps its own share, so the special case stops being special.
 *
 * **The centre pane is chat, and the dock nests inside it.** That is not a special case in the
 * model — orientation alternates with depth, so "terminal below the chat" is just a branch. The
 * pane ids say nothing about what renders in them.
 *
 * Pure, so the migration below can be tested against real stored documents rather than by
 * opening a window and hoping.
 */
import {
  addView,
  deserialize,
  findLeaf,
  serialize,
  setVisible,
  singleRow,
  type GridLayout,
  type GridNode,
} from "@/lib/layout/grid-model";
import { UNCONSTRAINED, type ViewConstraints } from "@/lib/layout/geometry";

/** The four slots. Ids, not roles — the grid does not care which is which. */
export const WORKSPACE_PANES = ["left", "chat", "dock", "right"] as const;
export type WorkspacePane = (typeof WORKSPACE_PANES)[number];

export function isWorkspacePane(value: unknown): value is WorkspacePane {
  return typeof value === "string" && (WORKSPACE_PANES as readonly string[]).includes(value);
}

/**
 * What each pane will accept, in pixels.
 *
 * The minimums are what stop a drag producing a pane too narrow to grab back — the failure that
 * has no undo, because the handle goes with it. The sidebar's is larger than the others because
 * a file tree below ~180px truncates every name to an ellipsis and stops being a file tree.
 */
export function workspaceConstraints(pane: WorkspacePane): ViewConstraints {
  switch (pane) {
    case "left":
      return { ...UNCONSTRAINED, minWidth: 180 };
    case "right":
      return { ...UNCONSTRAINED, minWidth: 240 };
    case "dock":
      return { ...UNCONSTRAINED, minHeight: 80 };
    case "chat":
      // Wider than the editor it replaced. An editor at 240px still shows code; a conversation
      // that narrow wraps prose every few words and stops being readable.
      return { ...UNCONSTRAINED, minWidth: 320, minHeight: 120 };
  }
}

/**
 * The shape every workspace has: three columns, with the middle split above the dock.
 *
 * Built by splitting rather than written as a literal, so the tree can only be a shape `addView`
 * can produce. A hand-written tree can encode a branch with one child or an orientation that
 * disagrees with its depth; this cannot.
 */
function shape(leftShare: number, chatShare: number, rightShare: number, dockShare: number): GridLayout<WorkspacePane> {
  const columns = singleRow<WorkspacePane>(["left", "chat", "right"], "horizontal");
  const withDock = addView(columns, "dock", [1], "down");

  const total = leftShare + chatShare + rightShare;
  const norm = total > 0 ? total : 1;
  const chatTotal = chatShare / norm;
  const dockOf = Math.min(Math.max(dockShare, 0), 0.9);

  return {
    ...withDock,
    root: {
      ...withDock.root,
      children: [
        { ...withDock.root.children[0]!, size: leftShare / norm },
        {
          ...withDock.root.children[1]!,
          size: chatTotal,
          ...(withDock.root.children[1]!.kind === "branch"
            ? {
                children: [
                  { ...withDock.root.children[1]!.children[0]!, size: 1 - dockOf },
                  { ...withDock.root.children[1]!.children[1]!, size: dockOf },
                ],
              }
            : {}),
        },
        { ...withDock.root.children[2]!, size: rightShare / norm },
      ],
    },
  };
}

/** First run: the widths the fixed grid had, so nothing moves for someone who never dragged. */
export function defaultWorkspaceLayout(): GridLayout<WorkspacePane> {
  return shape(0.18, 0.54, 0.28, 0.32);
}

/**
 * A layout written by versions 1 to 3, read as a grid.
 *
 * Those documents stored `panes: {left, centre, right}` and `centre: [editor, dock]`, which is
 * exactly this tree flattened — so the conversion is total and lossless, and a window that was
 * closed with a dragged layout reopens on it rather than snapping back to the defaults. That is
 * the whole reason this function exists instead of a version gate that discards.
 */
export function fromLegacy(panes: unknown, centre: unknown): GridLayout<WorkspacePane> {
  const share = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  const p = (typeof panes === "object" && panes !== null ? panes : {}) as Record<string, unknown>;
  const c = Array.isArray(centre) ? centre : [];

  return shape(
    share(p["left"], 0.18),
    share(p["centre"], 0.54),
    share(p["right"], 0.28),
    share(c[1], 0.32)
  );
}

/**
 * Show or hide panes to match the panel toggles.
 *
 * The toggles remain the source of truth for *whether* a pane is open — they are per-destination
 * and read before first paint, and the grid is not. The grid owns where a pane is and how wide;
 * this reconciles the two on every render, which is cheap because `setVisible` returns the same
 * tree when nothing changed.
 */
export function applyVisibility(
  layout: GridLayout<WorkspacePane>,
  open: { left: boolean; right: boolean; bottom: boolean }
): GridLayout<WorkspacePane> {
  const wanted: Record<WorkspacePane, boolean> = {
    left: open.left,
    right: open.right,
    dock: open.bottom,
    // The chat is never collapsible. It is the workspace; the panes around it are the optional part.
    chat: true,
  };

  let next = layout;
  for (const pane of WORKSPACE_PANES) {
    const at = findLeaf(next, (data) => data === pane);
    if (at !== null) next = setVisible(next, at, wanted[pane]);
  }
  return next;
}

/** The persisted form. Versions 4 and 5 store a grid; 1–3 stored two size arrays. */
export const WORKSPACE_LAYOUT_VERSION = 5;

/**
 * The first version whose document holds a serialised grid.
 *
 * Exported because the caller has to decide "grid or legacy size arrays" and had that answer
 * written as a bare `4`. Every later bump would have to remember to widen a literal that reads
 * like it means "the current version" — and the one time it did not, a v4 document sailed past
 * the range check, failed an equality test against the new version, and fell through to the
 * legacy reader, which looked for `panes` and `centre` that a v4 document has never had. The
 * layout reset and nothing reported it.
 */
export const GRID_SINCE_VERSION = 4;

/**
 * Is this the arrangement the app ships with?
 *
 * Read by the View menu, which greys "Reset Panel Layout" when there is nothing to reset. It
 * compares structure *and* sizes, because dragging a divider is a rearrangement too — someone who
 * has only resized still has something to put back.
 *
 * Visibility is deliberately not compared. `dockLayout` holds where panes sit; whether a panel is
 * open is separate state that `applyVisibility` layers on at render. Folding it in here would mean
 * a closed bottom panel counted as "not default", and Reset would then reopen a panel the user
 * closed on purpose — resetting something they never asked about.
 */
export function isDefaultWorkspaceLayout(layout: GridLayout<WorkspacePane>): boolean {
  const fallback = defaultWorkspaceLayout();
  // A branch carries no orientation of its own — depth decides it, alternating from the root — so
  // the root's is the only one there is to compare, and matching structure settles the rest.
  return layout.orientation === fallback.orientation && sameShape(layout.root, fallback.root);
}

function sameShape(a: GridNode<WorkspacePane>, b: GridNode<WorkspacePane>): boolean {
  // Sizes are shares, and a share that survived a serialize/deserialize round trip is arithmetic
  // rather than the literal it started as. Four places is far finer than a pixel at any window
  // size and far coarser than the error.
  if (Math.round(a.size * 1e4) !== Math.round(b.size * 1e4)) return false;
  if (a.kind === "leaf" || b.kind === "leaf") {
    return a.kind === "leaf" && b.kind === "leaf" && a.data === b.data;
  }
  /**
   * No test kills this line, and that is the honest state of it rather than an oversight.
   *
   * `every` walks `a`'s children, so a shorter `a` would compare as a prefix of `b` and the extras
   * would go unnoticed. Reaching that needs a root with two children sized 0.18 and 0.54 — and
   * sibling shares always sum to one, because every producer normalises: `addView` and
   * `removeView` by construction, `setSizes` by contract, `deserialize` by dividing through. So
   * the input exists in the type and not in the program.
   *
   * Kept because `sameShape` is a comparison of two trees, and one that is only correct for the
   * trees this module happens to build is a trap for the next caller.
   */
  if (a.children.length !== b.children.length) return false;
  return a.children.every((child, i) => sameShape(child, b.children[i]!));
}

export function serializeWorkspace(
  layout: GridLayout<WorkspacePane>,
  width: number,
  height: number
): unknown {
  return serialize(layout, Math.max(width, 1), Math.max(height, 1));
}

/**
 * Read a stored grid, or fall back.
 *
 * Total: anything unrecognised returns null and the caller uses the default. The value comes off
 * a document this window wrote, which is not a statement about its contents — it survives
 * downgrades and a future build that knows panes this one does not. A pane that no longer exists
 * is dropped and the branch collapses around it, which is `deserialize`'s job, not this one's.
 */
export function deserializeWorkspace(value: unknown): GridLayout<WorkspacePane> | null {
  const parsed = deserialize<WorkspacePane>(value, migratePane);
  if (parsed === null) return null;
  // A layout with no chat pane cannot be rendered — refuse it rather than showing a window with a
  // sidebar either side of nothing.
  return findLeaf(parsed, (d) => d === "chat") === null ? null : parsed;
}

/**
 * A stored pane id, as this version names it.
 *
 * Version 4 called the centre pane `editor`; version 5 calls it `chat`, because that is what
 * renders there now. The rename has to happen *here*, at the leaf, rather than as a pass over the
 * parsed tree — `deserialize` drops any leaf its validator rejects and collapses the branch around
 * it, so simply not recognising `editor` would not produce a layout missing one pane. It would
 * produce a two-column layout with the centre gone and the dock promoted into its place, which is
 * a valid-looking tree and therefore passes every structural check downstream.
 */
function migratePane(data: unknown): WorkspacePane | null {
  if (data === "editor") return "chat";
  return isWorkspacePane(data) ? data : null;
}
