/**
 * The layout tree, which is where a docking system's bugs live.
 *
 * These are written against the behaviour rather than copied from upstream. VS Code's own
 * grid.test.ts is 1311 lines and looked like a free conformance suite; it is not. Exactly three
 * of its ~35 tests are engine-independent — `getRelativeLocation`, `sanitizeGridNodeDescriptor`
 * and `createSerializedGrid`, about 63 lines. Every other test constructs the real `Grid`, whose
 * transitive closure is 74 files and 33,626 lines. Adopting the suite would have meant adopting
 * the engine, which is the thing we deliberately did not adopt.
 *
 * The one property worth stating up front, because almost every bug here is a violation of it:
 * **orientation alternates with depth**. A layout that looks correct after one split and wrong
 * after two has got `locationOrientation` wrong, and nothing else will tell you.
 */
import { describe, it, expect } from "vitest";
import {
  addView,
  deserialize,
  directionOrientation,
  findLeaf,
  leaves,
  locationOrientation,
  nodeAt,
  orthogonal,
  relativeLocation,
  moveView,
  removeView,
  serialize,
  setSizes,
  setVisible,
  singleRow,
  type GridLayout,
} from "../renderer/src/lib/layout/grid-model.js";

/** Three panes side by side — what BuildWorkspace shows today. */
function threePane(): GridLayout<string> {
  return singleRow(["explorer", "editor", "assistant"], "horizontal");
}

const ids = (layout: GridLayout<string>): string[] => leaves(layout).map((l) => l.node.data);

describe("the axis a node sits on", () => {
  it("alternates with depth", () => {
    // The load-bearing property. Children of the root lie along the root orientation; theirs lie
    // across it; and so on down. A grid needs no row or column type because of this.
    expect(locationOrientation("horizontal", [])).toBe("vertical");
    expect(locationOrientation("horizontal", [0])).toBe("horizontal");
    expect(locationOrientation("horizontal", [0, 1])).toBe("vertical");
    expect(locationOrientation("horizontal", [0, 1, 0])).toBe("horizontal");
  });

  it("reads a direction as the axis it implies", () => {
    expect(directionOrientation("up")).toBe("vertical");
    expect(directionOrientation("down")).toBe("vertical");
    expect(directionOrientation("left")).toBe("horizontal");
    expect(directionOrientation("right")).toBe("horizontal");
  });

  it("has exactly two axes and they are each other's opposite", () => {
    expect(orthogonal("horizontal")).toBe("vertical");
    expect(orthogonal(orthogonal("horizontal"))).toBe("horizontal");
  });
});

describe("where a new pane lands", () => {
  it("becomes a sibling when the direction runs along the current axis", () => {
    // Root is horizontal, so its children are too: adding to the right of child 1 is index 2.
    expect(relativeLocation("horizontal", [1], "right")).toEqual([2]);
    expect(relativeLocation("horizontal", [1], "left")).toEqual([1]);
  });

  it("descends a level when the direction runs across it", () => {
    // Splitting a horizontal row downward cannot produce a sibling — the reference has to become
    // a branch. The path gains a level, and `addView` does the surgery that path describes.
    expect(relativeLocation("horizontal", [1], "down")).toEqual([1, 1]);
    expect(relativeLocation("horizontal", [1], "up")).toEqual([1, 0]);
  });
});

describe("adding panes", () => {
  it("puts a pane beside its reference on the same axis", () => {
    const after = addView(threePane(), "terminal", [1], "right");
    expect(ids(after)).toEqual(["explorer", "editor", "terminal", "assistant"]);
  });

  it("puts it before, going left", () => {
    const after = addView(threePane(), "terminal", [1], "left");
    expect(ids(after)).toEqual(["explorer", "terminal", "editor", "assistant"]);
  });

  it("turns the reference into a branch when splitting across the axis", () => {
    const after = addView(threePane(), "terminal", [1], "down");

    // Still three children at the root: the editor slot now holds a branch, not a leaf.
    expect(after.root.children).toHaveLength(3);
    const split = nodeAt(after, [1]);
    expect(split?.kind).toBe("branch");
    expect(ids(after)).toEqual(["explorer", "editor", "terminal", "assistant"]);
    expect(nodeAt(after, [1, 0])).toMatchObject({ kind: "leaf", data: "editor" });
    expect(nodeAt(after, [1, 1])).toMatchObject({ kind: "leaf", data: "terminal" });
  });

  it("splits only the reference's share, leaving its neighbours alone", () => {
    // Splitting a pane should disturb the rest of the layout no more than opening a tab does.
    const before = threePane();
    const explorerBefore = nodeAt(before, [0])!.size;

    const after = addView(before, "terminal", [1], "down");
    expect(nodeAt(after, [0])!.size).toBe(explorerBefore);
    expect(nodeAt(after, [1])!.size).toBeCloseTo(explorerBefore, 10);
    expect(nodeAt(after, [1, 0])!.size + nodeAt(after, [1, 1])!.size).toBeCloseTo(
      explorerBefore,
      10
    );
  });

  it("survives a second split, which is where the axis maths shows up", () => {
    // One split can be right by accident. The second cannot: the inner branch is on the opposite
    // axis, so splitting *it* downward must produce a sibling, not another level.
    const once = addView(threePane(), "terminal", [1], "down");
    const twice = addView(once, "problems", [1, 1], "down");

    expect(nodeAt(twice, [1])?.kind).toBe("branch");
    expect(nodeAt(twice, [1, 2])).toMatchObject({ kind: "leaf", data: "problems" });
    expect(ids(twice)).toEqual(["explorer", "editor", "terminal", "problems", "assistant"]);
  });

  it("leaves the layout alone when the reference does not exist", () => {
    const before = threePane();
    expect(addView(before, "terminal", [9], "right")).toEqual(before);
  });
});

describe("removing panes", () => {
  it("drops the leaf", () => {
    expect(ids(removeView(threePane(), [1]))).toEqual(["explorer", "assistant"]);
  });

  it("collapses a branch left holding one child", () => {
    // Otherwise the survivor keeps a level it does not need, and every orientation below it
    // flips — the layout would look correct until the next split.
    const split = addView(threePane(), "terminal", [1], "down");
    expect(nodeAt(split, [1])?.kind).toBe("branch");

    const closed = removeView(split, [1, 1]);
    expect(nodeAt(closed, [1])).toMatchObject({ kind: "leaf", data: "editor" });
    expect(ids(closed)).toEqual(["explorer", "editor", "assistant"]);
  });

  it("gives the collapsed branch's share to the survivor", () => {
    const split = addView(threePane(), "terminal", [1], "down");
    const branchSize = nodeAt(split, [1])!.size;
    const closed = removeView(split, [1, 1]);
    expect(nodeAt(closed, [1])!.size).toBe(branchSize);
  });
});

describe("hiding a pane", () => {
  it("remembers the width it had", () => {
    const hidden = setVisible(threePane(), [0], false);
    const node = nodeAt(hidden, [0]);
    expect(node).toMatchObject({ kind: "leaf", visible: false });
    // The share is left alone rather than cached and zeroed — see the note on `setVisible`.
    expect(node!.size).toBeCloseTo(1 / 3, 10);

    const shown = setVisible(hidden, [0], true);
    expect(nodeAt(shown, [0])).toMatchObject({ visible: true });
    expect(nodeAt(shown, [0])!.size).toBeCloseTo(1 / 3, 10);
  });

  it("keeps the pane in the tree, so its position survives too", () => {
    // Dropping it and re-adding on show would lose where it sat, not just how wide it was.
    const hidden = setVisible(threePane(), [0], false);
    expect(ids(hidden)).toEqual(["explorer", "editor", "assistant"]);
  });
});

describe("persistence", () => {
  it("round-trips a split layout", () => {
    const before = addView(threePane(), "terminal", [1], "down");
    const restored = deserialize(
      JSON.parse(JSON.stringify(serialize(before, 1600, 900))),
      (d) => (typeof d === "string" ? d : null)
    );

    expect(restored).not.toBeNull();
    expect(ids(restored!)).toEqual(ids(before));
    expect(restored!.orientation).toBe(before.orientation);
    expect(nodeAt(restored!, [1])?.kind).toBe("branch");
  });

  it("writes the format VS Code writes", () => {
    // Deliberately theirs: same information, and a layout that can be read by anyone who has
    // debugged a VS Code one. `orientation` is the numeric enum value, not our string.
    const doc = serialize(threePane(), 1600, 900);
    expect(doc).toMatchObject({ orientation: 1, width: 1600, height: 900 });
    expect(doc.root.type).toBe("branch");
    expect(doc.root).toHaveProperty("data");
  });

  it("keeps a hidden pane's real width, not its collapsed one", () => {
    const doc = serialize(setVisible(threePane(), [0], false), 1600, 900);
    const first = (doc.root as { data: Array<{ size: number; visible?: boolean }> }).data[0]!;
    expect(first.visible).toBe(false);
    expect(first.size).toBeCloseTo(1 / 3, 10);
  });

  it("refuses anything it does not recognise, rather than half-restoring it", () => {
    // The value comes off a persisted document. That this window wrote it is not a statement
    // about its contents — it survives downgrades, hand-editing, and a build that knew more.
    for (const junk of [
      null,
      undefined,
      42,
      "layout",
      {},
      { orientation: 7, root: { type: "leaf", data: "a", size: 1 } },
      { orientation: 1, root: { type: "sideways", data: "a", size: 1 } },
      // An unknown kind carrying otherwise-valid branch data. Rejecting the first case only
      // proves `data` must be an array; this one proves the *kind* is checked, which is what a
      // future build writing a node type we do not have will actually send.
      {
        orientation: 1,
        root: {
          type: "sideways",
          size: 1,
          data: [
            { type: "leaf", data: "explorer", size: 1 },
            { type: "leaf", data: "editor", size: 1 },
          ],
        },
      },
      { orientation: 1, root: { type: "branch", data: "not-an-array", size: 1 } },
      { orientation: 1 },
    ]) {
      expect(deserialize(junk, (d) => (typeof d === "string" ? d : null)), String(JSON.stringify(junk))).toBeNull();
    }
  });

  it("drops a pane this build no longer has, and collapses around it", () => {
    // A layout naming a view we removed must not restore an empty hole.
    const before = addView(threePane(), "ghost", [1], "down");
    const restored = deserialize(serialize(before, 1600, 900), (d) =>
      typeof d === "string" && d !== "ghost" ? d : null
    );
    expect(ids(restored!)).toEqual(["explorer", "editor", "assistant"]);
    expect(nodeAt(restored!, [1])).toMatchObject({ kind: "leaf", data: "editor" });
  });

  it("does not let a prototype key through as pane data", () => {
    // House rule, same as `parseDockTab`: membership is decided by the validator, and a plain
    // object's inherited keys are not data.
    const doc = { orientation: 1, root: { type: "leaf", data: "__proto__", size: 1 } };
    const allowed = ["explorer", "editor"];
    expect(deserialize(doc, (d) => (typeof d === "string" && allowed.includes(d) ? d : null))).toBeNull();
  });
});

describe("finding things", () => {
  it("locates a leaf by its data", () => {
    const split = addView(threePane(), "terminal", [1], "down");
    expect(findLeaf(split, (d) => d === "terminal")).toEqual([1, 1]);
    expect(findLeaf(split, (d) => d === "nope")).toBeNull();
  });

  it("returns leaves in visual order", () => {
    expect(ids(threePane())).toEqual(["explorer", "editor", "assistant"]);
  });

  it("resolves a path, and refuses one that runs off the tree", () => {
    const layout = threePane();
    expect(nodeAt(layout, [])).toBe(layout.root);
    expect(nodeAt(layout, [0, 0])).toBeNull();
    expect(nodeAt(layout, [3])).toBeNull();
  });
});

describe("resizing", () => {
  it("writes shares into a branch's children", () => {
    const sized = setSizes(threePane(), [], [0.5, 0.3, 0.2]);
    expect(leaves(sized).map((l) => l.node.size)).toEqual([0.5, 0.3, 0.2]);
  });

  it("leaves a hidden pane's share alone", () => {
    /**
     * THE PROPERTY, and the one combination the suite never tried.
     *
     * `setSizes` is fed the pixel widths `computeLayout` produced, and a hidden leaf's rectangle
     * is zero wide — so writing every child back stores zero as that pane's remembered share.
     * Hiding is supposed to be free: `setVisible` deliberately does not touch the share so the
     * pane returns at the width it left at. Dragging *any* sash in the same branch used to undo
     * that, and nothing noticed because hiding and resizing were only ever tested apart.
     */
    const hidden = setVisible(threePane(), [2], false);
    const shareBefore = leaves(hidden)[2]!.node.size;

    // What a real drag looks like: the visible panes have pixel widths, the hidden one has none.
    const afterDrag = setSizes(hidden, [], [0.7, 0.3, 0]);

    expect(leaves(afterDrag)[2]!.node.size).toBe(shareBefore);
    expect(leaves(afterDrag)[2]!.node.size).not.toBe(0);
    // The visible panes still take the sizes they were given.
    expect(leaves(afterDrag).slice(0, 2).map((l) => l.node.size)).toEqual([0.7, 0.3]);
  });

  it("carries a hidden pane's share through save and reload", () => {
    /**
     * The full symptom was: hide, drag, save, reload, show — and the pane came back at half the
     * window. Two steps caused that together. `setSizes` wrote zero into the share, and then
     * `deserialize` rejected the zero as not-a-positive-size and substituted 1, which normalises
     * to a far larger slice than the pane ever had.
     *
     * `toSerializedNode` writes the share verbatim, so with the first step fixed the second is
     * unreachable: a hidden pane now persists a real number and reads back as itself. That is
     * why `deserialize`'s `> 0` guard is deliberately left alone — a zero share genuinely is
     * invalid, and accepting it would trade a pane that reopens too wide for one that can never
     * reopen at all.
     */
    const hidden = setVisible(threePane(), [2], false);
    const dragged = setSizes(hidden, [], [0.7, 0.3, 0]);
    const kept = leaves(dragged)[2]!.node.size;

    const restored = deserialize(
      JSON.parse(JSON.stringify(serialize(dragged, 1600, 900))),
      (d) => (typeof d === "string" ? d : null)
    );
    expect(restored).not.toBeNull();

    const shares = leaves(restored!).map((l) => l.node.size);
    expect(shares[2]).toBe(kept);
    expect(shares[2]).not.toBe(1); // the promoted value that produced the half-window pane
    expect(leaves(restored!)[2]!.node.visible).toBe(false);
  });
});

/**
 * Moving a pane, and the renumbering that makes it hard.
 *
 * Removing a pane can collapse the branch it leaves behind, and that renumbers every location
 * after it. A move that captures the destination path *before* the removal is correct in a flat
 * layout and wrong in a nested one — which is the shape a docking system spends all its time in.
 */
describe("moving a pane", () => {
  it("puts it beside its new neighbour", () => {
    const after = moveView(threePane(), [0], [2], "right");
    expect(ids(after)).toEqual(["editor", "assistant", "explorer"]);
  });

  it("puts it before, going left", () => {
    const after = moveView(threePane(), [2], [0], "left");
    expect(ids(after)).toEqual(["assistant", "explorer", "editor"]);
  });

  it("splits the destination when moving across the axis", () => {
    const after = moveView(threePane(), [0], [2], "down");
    expect(ids(after)).toEqual(["editor", "assistant", "explorer"]);
    expect(nodeAt(after, [1])?.kind).toBe("branch");
    expect(nodeAt(after, [1, 1])).toMatchObject({ kind: "leaf", data: "explorer" });
  });

  it("survives a removal that renumbers the destination", () => {
    /**
     * THE CASE. Split the editor, then move the pane *above* the split out to the far side. The
     * removal collapses the editor column back to a leaf, so every index after it shifts — a move
     * that carried the old path would land against the wrong pane entirely.
     */
    const split = addView(threePane(), "terminal", [1], "down");
    const moved = moveView(split, [1, 0], [2], "right");

    expect(ids(moved)).toEqual(["explorer", "terminal", "assistant", "editor"]);
    // And the collapsed column is a leaf again, not a branch with one child.
    expect(nodeAt(moved, [1])).toMatchObject({ kind: "leaf", data: "terminal" });
  });

  it("does nothing when a pane is dropped on itself", () => {
    // Remove-then-add would lose its size, and collapse a level if it were an only child.
    const before = threePane();
    expect(moveView(before, [1], [1], "right")).toBe(before);
  });

  it("does nothing when either end of the move does not exist", () => {
    const before = threePane();
    expect(moveView(before, [9], [0], "right")).toBe(before);
    expect(moveView(before, [0], [9], "right")).toBe(before);
  });

  it("refuses to drop onto a branch", () => {
    // The drop zones are drawn on panes, not on containers — a branch has no identity to re-find
    // after the removal, so landing "next to" one is not a thing that can be expressed.
    const split = addView(threePane(), "terminal", [1], "down");
    expect(moveView(split, [0], [1], "right")).toBe(split);
  });

  it("refuses to move a branch, only a leaf", () => {
    // A branch has no single identity to re-find after the removal, and dragging a container is
    // not a gesture the UI offers.
    const split = addView(threePane(), "terminal", [1], "down");
    expect(moveView(split, [1], [0], "left")).toBe(split);
  });

  it("follows the destination when the removal promotes it", () => {
    /**
     * The clearest case for re-finding by identity rather than carrying a path.
     *
     * Editor and terminal are the two children of one branch. Removing editor leaves that branch
     * with a single child, so it collapses and terminal is *promoted* from `[1,1]` to `[1]`. The
     * destination path the caller passed is now stale — it points at the assistant's old slot —
     * and a move that used it would drop the editor beside the wrong pane entirely.
     *
     * Re-finding terminal by its data lands it correctly, which is the behaviour asserted here.
     */
    const split = addView(threePane(), "terminal", [1], "down");
    const result = moveView(split, [1, 0], [1, 1], "right");

    expect(ids(result)).toEqual(["explorer", "terminal", "editor", "assistant"]);
    expect(nodeAt(result, [1])).toMatchObject({ kind: "leaf", data: "terminal" });
    expect(nodeAt(result, [2])).toMatchObject({ kind: "leaf", data: "editor" });
  });

  it("keeps every pane exactly once, however it is moved", () => {
    // The invariant a move must never break: nothing duplicated, nothing lost.
    const split = addView(threePane(), "terminal", [1], "down");
    for (const direction of ["up", "down", "left", "right"] as const) {
      const moved = moveView(split, [0], [1, 1], direction);
      expect([...ids(moved)].sort(), direction).toEqual(
        ["assistant", "editor", "explorer", "terminal"].sort()
      );
    }
  });
});
