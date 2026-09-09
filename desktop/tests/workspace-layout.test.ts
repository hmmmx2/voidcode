/**
 * The Build workspace's tree, and the layouts written before it was one.
 *
 * The migration is the part worth testing hardest. Versions 1 to 3 stored `panes` and `centre`
 * as two separate size arrays; a version gate that discarded them would silently reset the
 * layout of every existing window, which is the kind of regression nobody reports as a bug —
 * they just drag it back and assume they misremembered.
 */
import { describe, it, expect } from "vitest";
import {
  applyVisibility,
  defaultWorkspaceLayout,
  deserializeWorkspace,
  fromLegacy,
  GRID_SINCE_VERSION,
  isDefaultWorkspaceLayout,
  isWorkspacePane,
  serializeWorkspace,
  WORKSPACE_LAYOUT_VERSION,
  WORKSPACE_PANES,
  workspaceConstraints,
  type WorkspacePane,
} from "../renderer/src/lib/build/workspace-layout.js";
import { computeLayout } from "../renderer/src/lib/layout/geometry.js";
import { findLeaf, leaves, moveView, nodeAt, setSizes, setVisible } from "../renderer/src/lib/layout/grid-model.js";

const widths = (layout: ReturnType<typeof defaultWorkspaceLayout>, w = 1600, h = 1000) => {
  const placed = computeLayout(layout, w, h, workspaceConstraints);
  return Object.fromEntries(placed.leaves.map((l) => [l.data, Math.round(l.rect.width)]));
};
const heights = (layout: ReturnType<typeof defaultWorkspaceLayout>, w = 1600, h = 1000) => {
  const placed = computeLayout(layout, w, h, workspaceConstraints);
  return Object.fromEntries(placed.leaves.map((l) => [l.data, Math.round(l.rect.height)]));
};

describe("the shape", () => {
  it("has all four panes, once each", () => {
    const ids = leaves(defaultWorkspaceLayout()).map((l) => l.node.data);
    expect([...ids].sort()).toEqual([...WORKSPACE_PANES].sort());
  });

  it("puts the dock under the chat, not beside it", () => {
    const layout = defaultWorkspaceLayout();
    expect(nodeAt(layout, [1])?.kind).toBe("branch");
    expect(findLeaf(layout, (d) => d === "chat")).toEqual([1, 0]);
    expect(findLeaf(layout, (d) => d === "dock")).toEqual([1, 1]);

    const h = heights(layout);
    expect(h["chat"]! + h["dock"]!).toBeCloseTo(h["left"]!, 0);
    expect(widths(layout)["chat"]).toBe(widths(layout)["dock"]);
  });

  it("opens at the widths the fixed grid used, so nothing moves on upgrade", () => {
    // 0.18 / 0.54 / 0.28 of 1600 — the old `DEFAULT_PANE_SIZES`.
    const w = widths(defaultWorkspaceLayout());
    expect(w["left"]).toBe(288);
    expect(w["right"]).toBe(448);
    expect(w["chat"]).toBe(864);
  });
});

describe("reading a version 1-3 document", () => {
  it("restores a dragged layout rather than resetting it", () => {
    // The regression this exists for: a discarding version gate looks fine in a fresh window
    // and quietly throws away everyone's layout.
    const layout = fromLegacy({ left: 0.3, centre: 0.5, right: 0.2 }, [0.6, 0.4]);
    const w = widths(layout);
    expect(w["left"]).toBe(480);
    expect(w["chat"]).toBe(800);
    expect(w["right"]).toBe(320);

    const h = heights(layout);
    expect(h["dock"]! / (h["chat"]! + h["dock"]!)).toBeCloseTo(0.4, 2);
  });

  it("normalises shares that do not sum to one", () => {
    const w = widths(fromLegacy({ left: 1, centre: 2, right: 1 }, [0.5, 0.5]));
    expect(w["left"]).toBe(400);
    expect(w["chat"]).toBe(800);
    expect(w["right"]).toBe(400);
  });

  it("falls back per field, not all-or-nothing", () => {
    // A document missing `centre` should still honour the pane widths it does have.
    const w = widths(fromLegacy({ left: 0.3, centre: 0.5, right: 0.2 }, undefined));
    expect(w["left"]).toBe(480);
  });

  it("survives junk without producing NaN", () => {
    for (const [panes, centre] of [
      [null, null],
      ["nonsense", 42],
      [{ left: "wide", centre: -1, right: NaN }, ["a", "b"]],
      [{}, []],
    ] as Array<[unknown, unknown]>) {
      const w = widths(fromLegacy(panes, centre));
      for (const pane of WORKSPACE_PANES) {
        expect(Number.isFinite(w[pane]), `${pane} for ${JSON.stringify(panes)}`).toBe(true);
      }
      expect(w["left"]! + w["chat"]! + w["right"]!).toBeCloseTo(1600, 0);
    }
  });
});

describe("visibility", () => {
  it("collapses the panes whose toggles are off", () => {
    const layout = applyVisibility(defaultWorkspaceLayout(), {
      left: false,
      right: true,
      bottom: true,
    });
    expect(widths(layout)["left"]).toBe(0);
    expect(widths(layout)["chat"]! + widths(layout)["right"]!).toBeCloseTo(1600, 0);
  });

  it("never collapses the chat", () => {
    // The chat is the workspace; the panes around it are the optional part, and no toggle offers it.
    const layout = applyVisibility(defaultWorkspaceLayout(), {
      left: false,
      right: false,
      bottom: false,
    });
    expect(widths(layout)["chat"]).toBe(1600);
    expect(heights(layout)["chat"]).toBe(1000);
  });

  it("gives a reopened pane the width it had, not a default", () => {
    const dragged = fromLegacy({ left: 0.3, centre: 0.5, right: 0.2 }, [0.68, 0.32]);
    const hidden = applyVisibility(dragged, { left: false, right: true, bottom: true });
    const shown = applyVisibility(hidden, { left: true, right: true, bottom: true });
    expect(widths(shown)["left"]).toBe(480);
  });

  it("is idempotent, so reconciling on every render is free", () => {
    const open = { left: true, right: true, bottom: false };
    const once = applyVisibility(defaultWorkspaceLayout(), open);
    expect(applyVisibility(once, open)).toBe(once);
  });
});

describe("persistence", () => {
  it("round-trips a dragged, partly collapsed layout", () => {
    const dragged = applyVisibility(fromLegacy({ left: 0.3, centre: 0.5, right: 0.2 }, [0.6, 0.4]), {
      left: true,
      right: false,
      bottom: true,
    });
    const restored = deserializeWorkspace(
      JSON.parse(JSON.stringify(serializeWorkspace(dragged, 1600, 1000)))
    );
    expect(restored).not.toBeNull();
    // Same pixels as before the round trip, whatever they are — the point is that nothing
    // shifted, not that a collapsed neighbour left the widths untouched. It does not: the
    // assistant's 320px goes to the two panes that can still grow, so left reads 640 here and
    // 480 with everything open. Asserting the raw number either way would be asserting the
    // renormalisation rather than the round trip.
    expect(widths(restored!)).toEqual(widths(dragged));
    expect(widths(restored!)["right"]).toBe(0);

    // And with the assistant back, the dragged share is exactly what was stored.
    const reopened = applyVisibility(restored!, { left: true, right: true, bottom: true });
    expect(widths(reopened)["left"]).toBe(480);
  });

  it("refuses a document with no chat pane rather than rendering a window with nothing in the middle", () => {
    const noChat = {
      orientation: 1,
      width: 1600,
      height: 1000,
      root: {
        type: "branch",
        size: 1,
        data: [
          { type: "leaf", data: "left", size: 1 },
          { type: "leaf", data: "right", size: 1 },
        ],
      },
    };
    expect(deserializeWorkspace(noChat)).toBeNull();
  });

  it("refuses junk, so the caller falls back to the default", () => {
    for (const junk of [null, undefined, 7, "layout", {}, { orientation: 9 }]) {
      expect(deserializeWorkspace(junk)).toBeNull();
    }
  });

  it("drops a pane this build no longer has", () => {
    const withGhost = {
      orientation: 1,
      width: 1600,
      height: 1000,
      root: {
        type: "branch",
        size: 1,
        data: [
          { type: "leaf", data: "ghost", size: 1 },
          { type: "leaf", data: "chat", size: 1 },
        ],
      },
    };
    const restored = deserializeWorkspace(withGhost);
    expect(restored).not.toBeNull();
    expect(leaves(restored!).map((l) => l.node.data)).toEqual(["chat"]);
  });
});

/**
 * Version 4 called the centre pane `editor`. Version 5 calls it `chat`.
 *
 * The rename is the whole migration, and the way it could go wrong is specific: `deserialize`
 * drops any leaf its validator rejects and collapses the branch around it. So a build that simply
 * stopped recognising `editor` would not fail loudly — it would hand back a *valid* two-column
 * layout with the middle gone and the dock promoted into its place, which passes every structural
 * check downstream and looks to the user like their workspace was reset.
 */
describe("the v4 layout, read by a v5 build", () => {
  /** A real v4 document: three columns, the middle one split above the dock. */
  const v4 = () => ({
    orientation: 1,
    width: 1600,
    height: 1000,
    root: {
      type: "branch",
      size: 1,
      data: [
        { type: "leaf", data: "left", size: 0.2 },
        {
          type: "branch",
          size: 0.5,
          data: [
            { type: "leaf", data: "editor", size: 0.6 },
            { type: "leaf", data: "dock", size: 0.4 },
          ],
        },
        { type: "leaf", data: "right", size: 0.3 },
      ],
    },
  });

  it("renames the editor pane to chat", () => {
    const restored = deserializeWorkspace(v4());
    expect(restored).not.toBeNull();
    expect(leaves(restored!).map((l) => l.node.data).sort()).toEqual(["chat", "dock", "left", "right"]);
  });

  it("keeps every pane, rather than collapsing the branch the centre lived in", () => {
    // THE PROPERTY. Four panes in, four panes out — and the dock is still *under* the chat rather
    // than promoted beside it, which is what an unrecognised leaf would have produced.
    const restored = deserializeWorkspace(v4());
    expect(findLeaf(restored!, (d) => d === "chat")).toEqual([1, 0]);
    expect(findLeaf(restored!, (d) => d === "dock")).toEqual([1, 1]);
  });

  it("keeps the widths the user dragged to", () => {
    // The reason to migrate at all. Discarding the document would be safe and would silently undo
    // every drag the user ever made.
    const w = widths(deserializeWorkspace(v4())!);
    expect(w["left"]).toBeCloseTo(320, 0);
    expect(w["right"]).toBeCloseTo(480, 0);
    const h = heights(deserializeWorkspace(v4())!);
    expect(h["dock"]! / (h["chat"]! + h["dock"]!)).toBeCloseTo(0.4, 2);
  });

  it("still refuses a v4 document that never had a centre pane", () => {
    // The rename must not become a way for a structurally broken document to pass.
    const broken = { ...v4(), root: { type: "branch", size: 1, data: [{ type: "leaf", data: "left", size: 1 }] } };
    expect(deserializeWorkspace(broken)).toBeNull();
  });

  it("pins the version at which documents started carrying a grid", () => {
    /**
     * `GRID_SINCE_VERSION` is a historical fact, not a setting: version 4 is when the stored
     * document stopped being two size arrays and became a serialised tree. **It can never change**,
     * however high `WORKSPACE_LAYOUT_VERSION` climbs.
     *
     * Asserting `<= WORKSPACE_LAYOUT_VERSION` was too weak to be worth having — it is satisfied by
     * moving both together, which is exactly the mistake. Dragging it up to the current version
     * sends every older grid to the legacy reader, and that reader looks for `panes` and `centre`
     * which a v4 document has never contained, so the layout resets and nothing says so.
     */
    expect(GRID_SINCE_VERSION).toBe(4);

    /**
     * And the rename had to take the version with it — strictly past 4, not merely at it.
     *
     * The migration above covers reading an old document with a new build. This covers the other
     * direction, which is the one with no code to catch it: an old build reads
     * `version <= 4` documents happily, so writing `chat` under version 4 would hand an
     * editor-era build a pane id it does not know. It drops the unknown leaf and collapses the
     * branch, producing a plausible two-column layout with the middle missing. Version 5 is what
     * makes that build refuse the document instead.
     */
    expect(WORKSPACE_LAYOUT_VERSION).toBeGreaterThan(GRID_SINCE_VERSION);
  });
});

describe("constraints", () => {
  it("keeps the sidebar wide enough to be a file tree", () => {
    // Below about 180px every name truncates to an ellipsis and the panel stops being useful.
    expect(workspaceConstraints("left").minWidth).toBeGreaterThanOrEqual(180);
    expect(workspaceConstraints("right").minWidth).toBeGreaterThan(0);
    expect(workspaceConstraints("dock").minHeight).toBeGreaterThan(0);
  });

  it("stops a drag collapsing a pane past the point of grabbing it back", () => {
    // The failure with no undo: the handle goes with the pane.
    const layout = defaultWorkspaceLayout();
    const narrow = computeLayout(layout, 400, 600, workspaceConstraints);
    const left = narrow.leaves.find((l) => l.data === "left")!;
    expect(left.rect.width).toBeGreaterThanOrEqual(180);
  });

  it("names every pane, so a new one cannot be added without deciding", () => {
    for (const pane of WORKSPACE_PANES) {
      expect(workspaceConstraints(pane), pane).toBeDefined();
    }
  });
});

describe("the pane guard", () => {
  it("accepts the four and nothing else", () => {
    for (const pane of WORKSPACE_PANES) expect(isWorkspacePane(pane)).toBe(true);
    for (const junk of ["__proto__", "toString", "centre", "", null, 1, {}]) {
      expect(isWorkspacePane(junk), String(junk)).toBe(false);
    }
  });
});

/**
 * Knowing when there is something to put back.
 *
 * This drives whether "Reset Panel Layout" is offered or greyed, and both mistakes are bad in the
 * same quiet way: greyed when a pane has been moved leaves someone stuck with a layout they cannot
 * undo, and offered on a fresh window is a live menu item that does nothing.
 */
describe("recognising the default layout", () => {
  it("says yes to the layout the app ships with", () => {
    expect(isDefaultWorkspaceLayout(defaultWorkspaceLayout())).toBe(true);
  });

  it("survives a round trip through the persisted form", () => {
    // The stored document holds pixels; reading it back divides. A default layout that came off
    // disk must still count as default, or Reset lights up for everyone on their second launch.
    const stored = serializeWorkspace(defaultWorkspaceLayout(), 1600, 1000);
    const restored = deserializeWorkspace(JSON.parse(JSON.stringify(stored)));
    expect(restored).not.toBeNull();
    expect(isDefaultWorkspaceLayout(restored!)).toBe(true);
  });

  it("says no once a pane has been moved", () => {
    const at = findLeaf(defaultWorkspaceLayout(), (d) => d === "left")!;
    const moved = moveView(defaultWorkspaceLayout(), at, findLeaf(defaultWorkspaceLayout(), (d) => d === "right")!, "right");
    expect(isDefaultWorkspaceLayout(moved)).toBe(false);
  });

  it("notices a nudge, not just a shove", () => {
    /**
     * Shares, not pixels — so the comparison has to be fine enough that moving a divider a couple
     * of pixels still counts. 0.001 of a 1600px window is under two pixels, and a check that
     * rounded more coarsely would grey out Reset for someone who *did* move something and now
     * cannot get it back.
     */
    const nudged = setSizes(defaultWorkspaceLayout(), [], [0.181, 0.539, 0.28]);
    expect(isDefaultWorkspaceLayout(nudged)).toBe(false);
  });

  it("says no when the panes are swapped into a default-shaped tree", () => {
    /**
     * The adversarial case, built by hand because no sequence of drags lands on it by accident:
     * same nesting, same child counts, same sizes to the digit — and the sidebar and the assistant
     * exchanged. Structure alone cannot tell this from the default, so if identity were not
     * compared, Reset would be greyed for someone whose panes are on the wrong sides.
     */
    const d = defaultWorkspaceLayout();
    const [first, middle, last] = d.root.children;
    expect(first?.kind).toBe("leaf");
    expect(last?.kind).toBe("leaf");
    if (first?.kind !== "leaf" || last?.kind !== "leaf" || middle === undefined) throw new Error("shape changed");

    const swapped = {
      ...d,
      root: {
        ...d.root,
        // Sizes stay with the slots; only which pane sits in them changes.
        children: [{ ...first, data: last.data }, middle, { ...last, data: first.data }],
      },
    };
    expect(isDefaultWorkspaceLayout(swapped)).toBe(false);
  });

  it("says no once a divider has been dragged", () => {
    // Resizing is a rearrangement. Someone who widened the sidebar and wants it back has no other
    // way to get there, so a check that only compared structure would strand them.
    const resized = setSizes(defaultWorkspaceLayout(), [], [0.3, 0.42, 0.28]);
    expect(isDefaultWorkspaceLayout(resized)).toBe(false);
  });

  it("ignores whether panels are open", () => {
    /**
     * THE PROPERTY, and the reason this is not a deep-equal.
     *
     * Closing the bottom panel is not rearranging anything — it is a toggle with its own menu item
     * and its own undo. If it counted, Reset would light up for anyone working with the dock
     * closed, and using it would reopen a panel they closed on purpose.
     */
    const closed = applyVisibility(defaultWorkspaceLayout(), { left: false, right: false, bottom: false });
    expect(isDefaultWorkspaceLayout(closed)).toBe(true);
  });

  it("still says no when a moved layout also has a panel closed", () => {
    // The two are independent, so hiding must not mask a real rearrangement.
    const at = findLeaf(defaultWorkspaceLayout(), (d) => d === "left")!;
    const to = findLeaf(defaultWorkspaceLayout(), (d) => d === "right")!;
    const moved = moveView(defaultWorkspaceLayout(), at, to, "right");
    const hidden = setVisible(moved, findLeaf(moved, (d) => d === "dock")!, false);
    expect(isDefaultWorkspaceLayout(hidden)).toBe(false);
  });
});
