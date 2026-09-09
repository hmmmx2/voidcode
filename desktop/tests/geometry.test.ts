/**
 * Rectangles, which is the part a screenshot would otherwise have to check.
 *
 * Two invariants carry most of the weight. **Panes tile their container** — every rectangle
 * inside the box, no gaps, no overlaps — and **constraints compose sum-along, max-across**. The
 * second is the one that looks right until a pane has a minimum, and then fails one level up
 * from wherever you happen to be looking.
 */
import { describe, it, expect } from "vitest";
import {
  computeLayout,
  childSizes,
  SASH_HIT_SIZE,
  UNCONSTRAINED,
  type ViewConstraints,
} from "../renderer/src/lib/layout/geometry.js";
import { addView, setVisible, singleRow, type GridLayout } from "../renderer/src/lib/layout/grid-model.js";

const three = (): GridLayout<string> => singleRow(["explorer", "editor", "assistant"], "horizontal");

const withMin = (mins: Record<string, Partial<ViewConstraints>>) => (data: string): ViewConstraints => ({
  ...UNCONSTRAINED,
  ...(mins[data] ?? {}),
});

describe("placing panes", () => {
  it("lays the root's children along the root orientation", () => {
    const { leaves } = computeLayout(three(), 900, 600);
    expect(leaves.map((l) => l.rect)).toEqual([
      { top: 0, left: 0, width: 300, height: 600 },
      { top: 0, left: 300, width: 300, height: 600 },
      { top: 0, left: 600, width: 300, height: 600 },
    ]);
  });

  it("stacks a split pane across the axis it was split on", () => {
    // The editor slot becomes a column: same x and width, halved height.
    const split = addView(three(), "terminal", [1], "down");
    const { leaves } = computeLayout(split, 900, 600);
    const byData = Object.fromEntries(leaves.map((l) => [l.data, l.rect]));

    expect(byData["editor"]).toEqual({ top: 0, left: 300, width: 300, height: 300 });
    expect(byData["terminal"]).toEqual({ top: 300, left: 300, width: 300, height: 300 });
    expect(byData["explorer"]).toEqual({ top: 0, left: 0, width: 300, height: 600 });
  });

  it("tiles the container exactly, at every depth", () => {
    // No gaps and no overlaps: the areas sum to the container's, on nested layouts too.
    for (const layout of [
      three(),
      addView(three(), "terminal", [1], "down"),
      addView(addView(three(), "terminal", [1], "down"), "problems", [1, 1], "right"),
    ]) {
      const { leaves } = computeLayout(layout, 900, 600);
      const area = leaves.reduce((acc, l) => acc + l.rect.width * l.rect.height, 0);
      expect(area).toBeCloseTo(900 * 600, 4);
      for (const l of leaves) {
        expect(l.rect.left).toBeGreaterThanOrEqual(-0.001);
        expect(l.rect.top).toBeGreaterThanOrEqual(-0.001);
        expect(l.rect.left + l.rect.width).toBeLessThanOrEqual(900.001);
        expect(l.rect.top + l.rect.height).toBeLessThanOrEqual(600.001);
      }
    }
  });
});

describe("constraints", () => {
  it("honours a pane's minimum width", () => {
    const { leaves } = computeLayout(three(), 900, 600, withMin({ explorer: { minWidth: 400 } }));
    expect(leaves[0]!.rect.width).toBe(400);
    expect(leaves.reduce((a, l) => a + l.rect.width, 0)).toBeCloseTo(900, 6);
  });

  it("sums minimums along the axis they lie on", () => {
    // Two 300-wide panes side by side need 600 between them, so the third gets 300.
    const constraints = withMin({ explorer: { minWidth: 300 }, editor: { minWidth: 300 } });
    const { leaves } = computeLayout(three(), 900, 600, constraints);
    expect(leaves.map((l) => l.rect.width)).toEqual([300, 300, 300]);
  });

  it("takes the largest minimum across the axis, not the sum", () => {
    // The editor column holds two stacked panes with 200px minimum *widths*. Stacked, they do
    // not add up — the column needs 200, not 400. Summing here is the classic error and it
    // would squeeze the neighbours for space nothing needs.
    const split = addView(three(), "terminal", [1], "down");
    const constraints = withMin({ editor: { minWidth: 200 }, terminal: { minWidth: 200 } });
    const { leaves } = computeLayout(split, 900, 600, constraints);
    const editorCol = leaves.find((l) => l.data === "editor")!;
    expect(editorCol.rect.width).toBe(300);
  });

  it("sums a nested row's minimums, which stacking alone would hide", () => {
    // Editor and problems sit side by side *inside* the editor column, so their 200px minimums
    // do add up — the column needs 400. Composing with max everywhere gives 200 and looks
    // plausible until exactly this shape appears.
    const column = addView(three(), "terminal", [1], "down");
    const nested = addView(column, "problems", [1, 0], "right");
    const constraints = withMin({ editor: { minWidth: 200 }, problems: { minWidth: 200 } });

    // Asserted on the *column's* width, not the row's. The row clamps to its own minimums
    // either way — if the column never made room it simply overflows, and two 200s still sum to
    // 400 inside a 300px box. `terminal` spans the column, so its width is what actually says
    // whether the minimum propagated up.
    const { leaves } = computeLayout(nested, 900, 600, constraints);
    expect(leaves.find((l) => l.data === "terminal")!.rect.width).toBe(400);
    const editor = leaves.find((l) => l.data === "editor")!;
    const problems = leaves.find((l) => l.data === "problems")!;
    expect(editor.rect.width + problems.rect.width).toBe(400);
  });

  it("takes the tightest ceiling across the axis, not the sum", () => {
    // Two stacked panes each capped at 200 wide cap their column at 200, not 400. Summing
    // maximums across the axis lets the column grow past what either child will accept.
    const split = addView(three(), "terminal", [1], "down");
    const capped = (data: string): ViewConstraints =>
      data === "editor" || data === "terminal" ? { ...UNCONSTRAINED, maxWidth: 200 } : UNCONSTRAINED;

    const { leaves } = computeLayout(split, 900, 600, capped);
    expect(leaves.find((l) => l.data === "editor")!.rect.width).toBe(200);
    expect(leaves.reduce((a, l) => a + (l.data === "terminal" ? 0 : l.rect.width), 0)).toBeCloseTo(900, 6);
  });

  it("sums a nested row's ceilings, so the column may exceed either child's", () => {
    // The mirror of the minimum case. Editor and problems sit side by side capped at 150 each,
    // so their row will accept 300 — and the column with it. Composing maximums with `min`
    // everywhere caps the column at 150 and starves a layout that had room.
    const column = addView(three(), "terminal", [1], "down");
    const nested = addView(column, "problems", [1, 0], "right");
    const capped = (data: string): ViewConstraints =>
      data === "editor" || data === "problems" ? { ...UNCONSTRAINED, maxWidth: 150 } : UNCONSTRAINED;

    const { leaves } = computeLayout(nested, 900, 600, capped);
    expect(leaves.find((l) => l.data === "terminal")!.rect.width).toBe(300);
  });

  it("pushes a column wider when its stacked children genuinely need it", () => {
    const split = addView(three(), "terminal", [1], "down");
    const constraints = withMin({ terminal: { minWidth: 500 } });
    const { leaves } = computeLayout(split, 900, 600, constraints);
    expect(leaves.find((l) => l.data === "terminal")!.rect.width).toBe(500);
    expect(leaves.find((l) => l.data === "editor")!.rect.width).toBe(500);
  });
});

describe("hidden panes", () => {
  it("takes no space and leaves the rest tiling the container", () => {
    const hidden = setVisible(three(), [0], false);
    const { leaves } = computeLayout(hidden, 900, 600);
    expect(leaves[0]!.rect.width).toBe(0);
    expect(leaves[0]!.visible).toBe(false);
    expect(leaves[1]!.rect.width + leaves[2]!.rect.width).toBeCloseTo(900, 6);
  });

  it("collapses a branch whose every leaf is hidden", () => {
    /**
     * The shape that produced the worst bug in this file. A hidden leaf reports a *maximum* of
     * 0, and maxima combine across the axis with `Math.min` — so a hidden pane capped its parent
     * branch at zero width and took its visible siblings down with it. Closing the bottom dock
     * collapsed the editor: still visible, still holding a share, rendered 0px wide.
     *
     * Both halves are asserted here. A branch with one hidden child must keep its space for the
     * other; a branch with none left must give its space up.
     */
    const split = addView(three(), "terminal", [1], "down");

    const dockClosed = setVisible(split, [1, 1], false);
    const open = computeLayout(dockClosed, 900, 600).leaves;
    expect(open.find((l) => l.data === "editor")!.rect.width).toBe(300);
    expect(open.find((l) => l.data === "editor")!.rect.height).toBe(600);

    const bothClosed = setVisible(dockClosed, [1, 0], false);
    const gone = computeLayout(bothClosed, 900, 600).leaves;
    expect(gone.find((l) => l.data === "editor")!.rect.width).toBe(0);
    expect(gone.find((l) => l.data === "explorer")!.rect.width).toBe(450);
    expect(gone.find((l) => l.data === "assistant")!.rect.width).toBe(450);

    // Heights, not just widths — and this is the assertion that bites. The root lays its
    // children out horizontally, so *widths* compose by summing, where a stray 0 is harmless.
    // Heights compose across the axis with `Math.min`, so a fully hidden branch that is not
    // excluded caps the whole row at zero height and the window renders empty.
    expect(gone.find((l) => l.data === "explorer")!.rect.height).toBe(600);
  });

  it("collapses a nested branch without taking its visible uncle with it", () => {
    /**
     * One level deeper than the case above, and the only shape where recursing into branches
     * matters. The editor column holds a row (editor beside problems) and a terminal. Close
     * both panes in the row and the row must vanish while the terminal keeps the column.
     *
     * If a fully hidden *branch* is merely counted rather than excluded, it reports a maximum of
     * 0, and its parent composes maxima across the axis with `Math.min` — so the column inherits
     * the zero and collapses even though the terminal in it is open. A leaf-only check does not
     * catch this: the row is a branch, not a leaf.
     */
    const column = addView(three(), "terminal", [1], "down");
    const nested = addView(column, "problems", [1, 0], "right");

    const rowClosed = setVisible(setVisible(nested, [1, 0, 0], false), [1, 0, 1], false);
    const placed = computeLayout(rowClosed, 900, 600).leaves;

    expect(placed.find((l) => l.data === "terminal")!.rect.width).toBe(300);
    expect(placed.find((l) => l.data === "terminal")!.rect.height).toBe(600);
    expect(placed.find((l) => l.data === "editor")!.rect.width).toBe(0);
    expect(placed.find((l) => l.data === "explorer")!.rect.width).toBe(300);
  });

  it("keeps its place in the list, so it comes back where it was", () => {
    const hidden = setVisible(three(), [0], false);
    expect(computeLayout(hidden, 900, 600).leaves.map((l) => l.data)).toEqual([
      "explorer",
      "editor",
      "assistant",
    ]);
  });
});

describe("dividers", () => {
  it("puts one between each adjacent pair, centred on the boundary", () => {
    const { sashes } = computeLayout(three(), 900, 600);
    expect(sashes).toHaveLength(2);
    expect(sashes[0]).toMatchObject({ branch: [], index: 0, orientation: "horizontal" });
    expect(sashes[0]!.rect.left).toBe(300 - SASH_HIT_SIZE / 2);
    expect(sashes[1]!.rect.left).toBe(600 - SASH_HIT_SIZE / 2);
    expect(sashes[0]!.rect.top).toBe(SASH_HIT_SIZE / 2);
  });

  it("is wider than the line it draws, so it can be grabbed", () => {
    // A 1px pointer target is unusable. The element is fatter than its appearance on purpose.
    const { sashes } = computeLayout(three(), 900, 600);
    expect(sashes[0]!.rect.width).toBe(SASH_HIT_SIZE);
    expect(SASH_HIT_SIZE).toBeGreaterThan(1);
  });

  it("runs the other way inside a split column", () => {
    const split = addView(three(), "terminal", [1], "down");
    const { sashes } = computeLayout(split, 900, 600);
    const vertical = sashes.filter((s) => s.orientation === "vertical");
    expect(vertical).toHaveLength(1);
    expect(vertical[0]).toMatchObject({ branch: [1], index: 0 });
    expect(vertical[0]!.rect.top).toBe(300 - SASH_HIT_SIZE / 2);
  });

  it("emits none against a hidden neighbour", () => {
    // A divider there would sit on top of the next one and drag nothing.
    const hidden = setVisible(three(), [0], false);
    const { sashes } = computeLayout(hidden, 900, 600);
    expect(sashes).toHaveLength(1);
    expect(sashes[0]).toMatchObject({ index: 1 });
  });

  it("never overlaps another divider", () => {
    /**
     * The bug this exists for, found by driving the real app rather than by reading the DOM.
     * A row divider and a column divider meet at a T-junction, and two 8px hit bands crossing
     * there share 64 square pixels. Whichever renders later wins, so grabbing the column
     * divider near the junction dragged the row one instead — and because that drag resized a
     * different branch along a different axis, nothing visibly moved at all.
     */
    const nested = addView(addView(three(), "terminal", [1], "down"), "problems", [1, 0], "right");
    const { sashes } = computeLayout(nested, 900, 600);
    expect(sashes.length).toBeGreaterThan(2);

    for (let a = 0; a < sashes.length; a += 1) {
      for (let b = a + 1; b < sashes.length; b += 1) {
        const x = sashes[a]!.rect;
        const y = sashes[b]!.rect;
        const overlaps =
          x.left < y.left + y.width &&
          y.left < x.left + x.width &&
          x.top < y.top + y.height &&
          y.top < x.top + x.height;
        expect(overlaps, `sash ${a} overlaps sash ${b}`).toBe(false);
      }
    }
  });

  it("still spans almost the whole edge it divides", () => {
    // The inset must not turn a divider into a stub — it gives up half a hit-width at each end
    // and nothing more.
    const { sashes } = computeLayout(three(), 900, 600);
    expect(sashes[0]!.rect.height).toBe(600 - SASH_HIT_SIZE);
  });

  it("emits none at all for a single pane", () => {
    expect(computeLayout(singleRow(["only"]), 900, 600).sashes).toEqual([]);
  });
});

describe("feeding a drag back", () => {
  it("reports the same sizes the layout drew", () => {
    const { sizes, extent } = childSizes(three(), [], 900, 600);
    expect(sizes).toEqual([300, 300, 300]);
    expect(extent).toBe(900);
  });

  it("reports the nested branch's sizes on its own axis", () => {
    const split = addView(three(), "terminal", [1], "down");
    const { sizes, extent } = childSizes(split, [1], 900, 600);
    expect(sizes).toEqual([300, 300]);
    expect(extent).toBe(600);
  });

  it("carries the constraints, so a drag cannot violate them", () => {
    const { constraints } = childSizes(three(), [], 900, 600, withMin({ explorer: { minWidth: 250 } }));
    expect(constraints[0]!.min).toBe(250);
    expect(constraints[1]!.min).toBe(0);
  });
});

describe("degenerate containers", () => {
  it("survives zero width without producing NaN", () => {
    // Fires on first paint, before the ResizeObserver has measured anything.
    const { leaves } = computeLayout(three(), 0, 0);
    for (const l of leaves) {
      expect(Number.isFinite(l.rect.width)).toBe(true);
      expect(Number.isFinite(l.rect.height)).toBe(true);
      expect(l.rect.width).toBeGreaterThanOrEqual(0);
    }
  });
});
