/**
 * Turning the layout tree into rectangles.
 *
 * The one place that knows a pane's position on screen, and it is a pure function of the tree
 * and a width and a height. Nothing here reads the DOM — the container is measured once by
 * `DockGrid`, and every rectangle below it is arithmetic. That is the same division VS Code
 * draws: its whole engine is driven by an explicit `layout(width, height, top, left)` and
 * `getBoundingClientRect` appears nowhere in grid.ts, gridview.ts, splitview.ts or sash.ts.
 *
 * Keeping it here rather than inside the component is what makes "the assistant pane is 3px too
 * narrow after restoring a split layout" a unit test rather than a screenshot.
 *
 * **Constraints compose as sum-along, max-across.** A row's minimum width is the sum of its
 * children's; its minimum *height* is the largest of theirs. Ported from `BranchNode`'s
 * accessors (gridview.ts:290-328). Getting it backwards produces a layout that is correct until
 * a pane has a minimum, and then collapses one level up from wherever you are looking.
 */
import {
  locationOrientation,
  type GridLayout,
  type GridLocation,
  type GridNode,
  type Orientation,
} from "./grid-model";
import { toPixels, type SizeConstraint } from "./sizing";

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** What a pane will accept on both axes. Mirrors the vendored `IViewConstraints`. */
export interface ViewConstraints {
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

export const UNCONSTRAINED: ViewConstraints = {
  minWidth: 0,
  maxWidth: Number.POSITIVE_INFINITY,
  minHeight: 0,
  maxHeight: Number.POSITIVE_INFINITY,
};

export interface PlacedLeaf<T> {
  readonly location: GridLocation;
  readonly data: T;
  readonly rect: Rect;
  readonly visible: boolean;
}

export interface PlacedSash {
  /** The branch whose children this divider sits between. */
  readonly branch: GridLocation;
  /** Index of the child *before* the divider — what `resizeAt` takes. */
  readonly index: number;
  /** The axis the divider resizes along, so the caller knows which pointer delta to use. */
  readonly orientation: Orientation;
  readonly rect: Rect;
}

export interface PlacedLayout<T> {
  readonly leaves: readonly PlacedLeaf<T>[];
  readonly sashes: readonly PlacedSash[];
}

/**
 * How wide the divider's hit area is.
 *
 * Drawn as a 1px line — the design system has no chrome ridges — but a 1px pointer target is
 * unusable, so the element is wider than what it appears to be and centred on the boundary.
 * VS Code makes the same split for the same reason.
 */
export const SASH_HIT_SIZE = 8;

/** The axis a branch's children are laid out along. */
function childAxis<T>(layout: GridLayout<T>, branch: GridLocation): Orientation {
  return locationOrientation(layout.orientation, [...branch, 0]);
}

function isHidden<T>(node: GridNode<T>): boolean {
  return node.kind === "leaf" && !node.visible;
}

/**
 * Does anything under here still want space?
 *
 * A branch is only as hidden as its leaves. This exists because composing over a hidden child
 * is not the same as composing over a zero: maxima combine across the axis with `Math.min`, so
 * a hidden pane contributing a maximum of 0 caps its *parent* at zero and collapses every
 * visible sibling with it. Closing the bottom dock took the editor with it — the editor was
 * still visible, still had a share, and rendered 0px wide.
 *
 * A hidden child imposes no ceiling and needs no floor. It is left out of the composition
 * entirely rather than given a number that means something else.
 */
function hasVisibleLeaf<T>(node: GridNode<T>): boolean {
  return node.kind === "leaf" ? node.visible : node.children.some(hasVisibleLeaf);
}

/** Sum along the axis, max across it — `BranchNode.minimumSize`, gridview.ts:290-328. */
function minAlong<T>(
  layout: GridLayout<T>,
  node: GridNode<T>,
  location: GridLocation,
  axis: Orientation,
  constraintsFor: (data: T) => ViewConstraints
): number {
  if (node.kind === "leaf") {
    if (!node.visible) return 0;
    const c = constraintsFor(node.data);
    return axis === "horizontal" ? c.minWidth : c.minHeight;
  }
  const mins = node.children
    .map((child, i) => ({ child, i }))
    .filter(({ child }) => hasVisibleLeaf(child))
    .map(({ child, i }) => minAlong(layout, child, [...location, i], axis, constraintsFor));
  // Filtering here is for symmetry with `maxAlong`, not for correctness: a hidden child's
  // minimum is 0, and 0 changes neither a sum nor a maximum. The max side is the one that
  // matters — see the note on `hasVisibleLeaf`.
  //
  // Every leaf below is hidden, so the branch itself wants nothing and collapses.
  if (mins.length === 0) return 0;
  return childAxis(layout, location) === axis
    ? mins.reduce((a, b) => a + b, 0)
    : Math.max(...mins);
}

/** The mirror: sum along, *min* across — a row is only as wide as its tightest ceiling allows. */
function maxAlong<T>(
  layout: GridLayout<T>,
  node: GridNode<T>,
  location: GridLocation,
  axis: Orientation,
  constraintsFor: (data: T) => ViewConstraints
): number {
  if (node.kind === "leaf") {
    if (!node.visible) return 0;
    const c = constraintsFor(node.data);
    return axis === "horizontal" ? c.maxWidth : c.maxHeight;
  }
  const maxes = node.children
    .map((child, i) => ({ child, i }))
    .filter(({ child }) => hasVisibleLeaf(child))
    .map(({ child, i }) => maxAlong(layout, child, [...location, i], axis, constraintsFor));
  // Nothing visible below: a ceiling of zero, so the branch collapses like a hidden leaf.
  if (maxes.length === 0) return 0;
  return childAxis(layout, location) === axis
    ? maxes.reduce((a, b) => a + b, 0)
    : Math.min(...maxes);
}

/**
 * Every pane's rectangle, and every divider's, for a container this size.
 *
 * Hidden panes get a zero-width rectangle and no divider rather than being dropped: their
 * position in the tree is what lets them come back where they were, and `setVisible` keeps the
 * width they had. A divider is emitted only where there is a visible pane on both sides —
 * otherwise it would sit on top of another one and drag nothing.
 */
export function computeLayout<T>(
  layout: GridLayout<T>,
  width: number,
  height: number,
  constraintsFor: (data: T) => ViewConstraints = () => UNCONSTRAINED
): PlacedLayout<T> {
  const leaves: PlacedLeaf<T>[] = [];
  const sashes: PlacedSash[] = [];

  const place = (node: GridNode<T>, location: GridLocation, rect: Rect): void => {
    if (node.kind === "leaf") {
      leaves.push({ location, data: node.data, rect, visible: node.visible });
      return;
    }

    const axis = childAxis(layout, location);
    const horizontal = axis === "horizontal";
    const extent = horizontal ? rect.width : rect.height;
    const cross = horizontal ? rect.height : rect.width;

    // A hidden pane stays in the list rather than being filtered out, so indices still line up
    // with the tree — `resizeAt` and `setSizes` both address children by position. It is pinned
    // to zero by its constraint below, not by its share: `setVisible` deliberately leaves the
    // share alone so the pane can reclaim it, and zeroing it here as well would be a second
    // mechanism for the same thing with nothing able to tell them apart.
    const shares = node.children.map((child) => child.size);
    const constraints: SizeConstraint[] = node.children.map((child, i) =>
      isHidden(child)
        ? { min: 0, max: 0 }
        : {
            min: minAlong(layout, child, [...location, i], axis, constraintsFor),
            max: maxAlong(layout, child, [...location, i], axis, constraintsFor),
          }
    );
    const sizes = toPixels(shares, constraints, extent);

    let offset = 0;
    node.children.forEach((child, i) => {
      const size = sizes[i] ?? 0;
      place(
        child,
        [...location, i],
        horizontal
          ? { top: rect.top, left: rect.left + offset, width: size, height: cross }
          : { top: rect.top + offset, left: rect.left, width: cross, height: size }
      );
      offset += size;

      const hasVisibleAfter = node.children.slice(i + 1).some((c) => !isHidden(c));
      if (!isHidden(child) && hasVisibleAfter) {
        const centre = horizontal ? rect.left + offset : rect.top + offset;
        // Short of its own ends by half a hit-width.
        //
        // Dividers meet at T-junctions, and two 8px bands crossing there overlap for 8px. The
        // later one in the DOM wins the hit test, so grabbing a column divider anywhere near a
        // row divider silently dragged the wrong one — the pointer landed on a band belonging to
        // a different branch and the drag did nothing visible.
        //
        // Trimming both leaves the junction itself dead rather than wrong. VS Code spends a
        // whole corner-sash mechanism to make those few pixels live; that is a lot of machinery
        // for a 4px square, and "nothing happens" is a far better failure than "the wrong pane
        // moves".
        const inset = Math.min(SASH_HIT_SIZE / 2, cross / 2);
        const span = Math.max(cross - inset * 2, 0);
        sashes.push({
          branch: location,
          index: i,
          orientation: axis,
          rect: horizontal
            ? {
                top: rect.top + inset,
                left: centre - SASH_HIT_SIZE / 2,
                width: SASH_HIT_SIZE,
                height: span,
              }
            : {
                top: centre - SASH_HIT_SIZE / 2,
                left: rect.left + inset,
                width: span,
                height: SASH_HIT_SIZE,
              },
        });
      }
    });
  };

  place(layout.root, [], { top: 0, left: 0, width, height });
  return { leaves, sashes };
}

/**
 * The pixel sizes of one branch's children, for feeding a drag back through `resizeAt`.
 *
 * The drag handler needs the same numbers `computeLayout` produced, and recomputing them from
 * the tree is cheaper and less error-prone than threading them out through the render.
 */
export function childSizes<T>(
  layout: GridLayout<T>,
  branch: GridLocation,
  width: number,
  height: number,
  constraintsFor: (data: T) => ViewConstraints = () => UNCONSTRAINED
): { sizes: number[]; constraints: SizeConstraint[]; extent: number } {
  const placed = computeLayout(layout, width, height, constraintsFor);
  const axis = childAxis(layout, branch);
  const horizontal = axis === "horizontal";

  // Children of `branch` are the placed nodes exactly one level deeper on that path.
  const node = branch.reduce<GridNode<T> | null>(
    (acc, i) => (acc !== null && acc.kind === "branch" ? (acc.children[i] ?? null) : null),
    layout.root as GridNode<T>
  );
  if (node === null || node.kind !== "branch") return { sizes: [], constraints: [], extent: 0 };

  const sizes = node.children.map((_, i) => {
    const path = [...branch, i];
    const rect = rectOf(placed, path, layout);
    return rect === null ? 0 : horizontal ? rect.width : rect.height;
  });
  const constraints: SizeConstraint[] = node.children.map((child, i) =>
    isHidden(child)
      ? { min: 0, max: 0 }
      : {
          min: minAlong(layout, child, [...branch, i], axis, constraintsFor),
          max: maxAlong(layout, child, [...branch, i], axis, constraintsFor),
        }
  );
  return { sizes, constraints, extent: sizes.reduce((a, b) => a + b, 0) };
}

/** The rectangle covering a node, leaf or branch: the union of the leaves beneath it. */
function rectOf<T>(placed: PlacedLayout<T>, location: GridLocation, _layout: GridLayout<T>): Rect | null {
  const under = placed.leaves.filter(
    (l) => l.location.length >= location.length && location.every((v, i) => l.location[i] === v)
  );
  if (under.length === 0) return null;

  const top = Math.min(...under.map((l) => l.rect.top));
  const left = Math.min(...under.map((l) => l.rect.left));
  const right = Math.max(...under.map((l) => l.rect.left + l.rect.width));
  const bottom = Math.max(...under.map((l) => l.rect.top + l.rect.height));
  return { top, left, width: right - left, height: bottom - top };
}
