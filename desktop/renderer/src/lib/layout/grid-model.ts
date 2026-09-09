/**
 * The layout, as a value.
 *
 * A dock that can be rearranged needs somewhere for "how it is arranged" to live, and the whole
 * design turns on that place being a plain immutable tree rather than a widget. Every operation
 * here returns a new layout; React renders it; nothing in this file touches the DOM or imports
 * React. That means a split, a drag and a restore are all testable without a browser, which is
 * where the bugs in this kind of code actually are.
 *
 * Ported from VS Code's grid (`src/vs/base/browser/ui/grid/`, commit d8b1606) — specifically
 * `getRelativeLocation` (grid.ts:141-157), `getLocationOrientation` / `getDirectionOrientation`
 * (133-139), the split primitive in `GridView.addView` (gridview.ts:1209-1258), and the
 * serialisation walk in `SerializableGrid.serializeNode` (grid.ts:781-802). The wire format
 * itself is vendored verbatim in `vendor/vscode/grid-contract.ts` rather than reinvented.
 *
 * **Why port rather than take the engine.** VS Code's `Grid` finds a view's position by walking
 * exactly four `parentElement`s per level (grid.ts:183-197), under a comment conceding it "will
 * break as soon as DOM structures of the Splitview or Gridview change". React has to own that
 * markup, so the engine was never available to us. What was available is that *nothing in the
 * layout maths reads the DOM* — `getBoundingClientRect`, `offsetWidth` and `clientWidth` do not
 * appear anywhere in grid.ts, gridview.ts, splitview.ts or sash.ts. Layout is arithmetic driven
 * by an explicit `layout(width, height)`. That is the seam this file sits on.
 *
 * **Orientation alternates with depth, and that is the whole trick.** A branch at an even depth
 * lays its children out along one axis, its children's children along the other. So there is no
 * "row" or "column" type — nesting is the only structure, and `locationOrientation` recovers
 * which axis you are on from the length of the path. Getting this wrong produces a layout that
 * looks right until the second split.
 */
import type {
  ISerializedGrid,
  ISerializedNode,
  SerializedOrientation,
} from "@/vendor/vscode/grid-contract";

/**
 * The two values upstream's `const enum Orientation` compiles to.
 *
 * Declared here rather than in the vendored file so that file can stay type-only and emit
 * nothing — see the deviation note in its header. The numbers are the persisted format's, not
 * ours to choose.
 */
const SERIALIZED_VERTICAL = 0 satisfies SerializedOrientation;
const SERIALIZED_HORIZONTAL = 1 satisfies SerializedOrientation;

/**
 * Which way a branch lays its children out.
 *
 * Strings rather than VS Code's numeric enum: these end up in a persisted document, and a
 * layout file reading `"orientation": "horizontal"` can be diagnosed by eye where `0` cannot.
 * `toSerialized`/`fromSerialized` convert at the boundary so the stored format stays theirs.
 */
export type Orientation = "horizontal" | "vertical";

/** Where a new pane goes, relative to an existing one. */
export type Direction = "up" | "down" | "left" | "right";

/**
 * A path from the root: one child index per level.
 *
 * `[]` is the root branch, `[1]` its second child, `[1, 0]` that child's first. Length is depth,
 * which is why `locationOrientation` can derive the axis from it alone.
 */
export type GridLocation = readonly number[];

export interface LeafNode<T> {
  readonly kind: "leaf";
  readonly data: T;
  /** Share of the parent's extent. Normalised among siblings at the point of use. */
  readonly size: number;
  /**
   * Hidden panes keep their share.
   *
   * There is deliberately no `cachedVisibleSize` beside this, though VS Code's node has one.
   * Theirs is needed because their sizes are pixels that get zeroed on hide; ours are shares,
   * and a hidden leaf is pinned to zero pixels by its *constraint* at render time instead.
   *
   * That only holds because `setSizes` skips invisible children. It did not always: this comment
   * used to justify the absent cache by saying the share was "a value nothing overwrites", while
   * `setSizes` a few lines below overwrote it for every child. Dragging any sash in a branch
   * containing a hidden pane wrote that pane's live pixel width — zero — into its share, and the
   * pane came back collapsed. So the invariant is real, but it is maintained, not free.
   */
  readonly visible: boolean;
}

export interface BranchNode<T> {
  readonly kind: "branch";
  readonly children: readonly GridNode<T>[];
  readonly size: number;
}

export type GridNode<T> = LeafNode<T> | BranchNode<T>;

export interface GridLayout<T> {
  readonly root: BranchNode<T>;
  readonly orientation: Orientation;
}

export function orthogonal(orientation: Orientation): Orientation {
  return orientation === "horizontal" ? "vertical" : "horizontal";
}

/**
 * The axis a node at this depth is laid out along.
 *
 * Ported from `getLocationOrientation` (grid.ts:133-135). The parity looks arbitrary and is not:
 * children of the root sit along the root orientation, their children along its opposite, and so
 * on down. An empty path is the root itself, which is why even lengths give the orthogonal.
 */
export function locationOrientation(root: Orientation, location: GridLocation): Orientation {
  return location.length % 2 === 0 ? orthogonal(root) : root;
}

/** `getDirectionOrientation`, grid.ts:137-139. Up/down stack vertically; left/right, horizontally. */
export function directionOrientation(direction: Direction): Orientation {
  return direction === "up" || direction === "down" ? "vertical" : "horizontal";
}

/**
 * Where a pane added in `direction` from the pane at `location` ends up.
 *
 * Ported from `getRelativeLocation` (grid.ts:141-157). Two cases, and the second is the one that
 * makes a grid a grid:
 *
 *   - **Same axis** — the new pane is a sibling. Take the last index, add one if the direction
 *     is rightward or downward, and it slots in beside the reference.
 *   - **Across the axis** — the reference pane must *become* a branch containing itself and the
 *     newcomer. The returned path descends one level further, and `addView` does the surgery.
 */
export function relativeLocation(
  root: Orientation,
  location: GridLocation,
  direction: Direction
): GridLocation {
  const here = locationOrientation(root, location);
  const wanted = directionOrientation(direction);
  const after = direction === "right" || direction === "down";

  if (here === wanted) {
    const rest = location.slice(0, -1);
    const index = (location[location.length - 1] ?? 0) + (after ? 1 : 0);
    return [...rest, index];
  }
  return [...location, after ? 1 : 0];
}

/** The node at `location`, or null if the path does not resolve. Total by construction. */
export function nodeAt<T>(layout: GridLayout<T>, location: GridLocation): GridNode<T> | null {
  let node: GridNode<T> = layout.root;
  for (const index of location) {
    if (node.kind !== "branch") return null;
    // Annotated: without it the reassignment below makes `child`'s inference circular.
    const child: GridNode<T> | undefined = node.children[index];
    if (child === undefined) return null;
    node = child;
  }
  return node;
}

/** The path to the first leaf whose data matches, depth-first. */
export function findLeaf<T>(
  layout: GridLayout<T>,
  predicate: (data: T) => boolean
): GridLocation | null {
  const walk = (node: GridNode<T>, path: number[]): GridLocation | null => {
    if (node.kind === "leaf") return predicate(node.data) ? path : null;
    for (let i = 0; i < node.children.length; i += 1) {
      const hit = walk(node.children[i]!, [...path, i]);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(layout.root, []);
}

/** Every leaf, in visual order, with its path. */
export function leaves<T>(layout: GridLayout<T>): Array<{ location: GridLocation; node: LeafNode<T> }> {
  const out: Array<{ location: GridLocation; node: LeafNode<T> }> = [];
  const walk = (node: GridNode<T>, path: number[]): void => {
    if (node.kind === "leaf") {
      out.push({ location: path, node });
      return;
    }
    node.children.forEach((child, i) => walk(child, [...path, i]));
  };
  walk(layout.root, []);
  return out;
}

function leaf<T>(data: T, size: number): LeafNode<T> {
  return { kind: "leaf", data, size, visible: true };
}

/** Replace the node at `location`, rebuilding the spine above it. Returns null on a bad path. */
function replaceAt<T>(
  node: GridNode<T>,
  location: GridLocation,
  replace: (existing: GridNode<T>) => GridNode<T> | null
): GridNode<T> | null {
  if (location.length === 0) return replace(node);
  if (node.kind !== "branch") return null;

  const [index, ...rest] = location;
  const child = node.children[index!];
  if (child === undefined) return null;

  const updated = replaceAt(child, rest, replace);
  // Nothing below changed, so neither did this. Returning the same object lets callers reconcile
  // on every render without React seeing a new tree each time — `applyVisibility` does exactly
  // that, and without this it would remount nothing but re-render everything, every frame.
  if (updated === child) return node;
  const children = [...node.children];
  if (updated === null) children.splice(index!, 1);
  else children[index!] = updated;

  // A branch with one child is the same layout with an extra level in it, and left in place it
  // would flip the orientation of everything below — `locationOrientation` reads depth. So it
  // collapses. Upstream does the same in `GridView.removeView`.
  if (children.length === 1 && location.length === 1) {
    const only = children[0]!;
    return { ...only, size: node.size };
  }
  if (children.length === 0) return null;
  return { ...node, children };
}

/**
 * Insert a pane beside an existing one.
 *
 * The across-the-axis case is the interesting one, and it is the same surgery as
 * `GridView.addView` (gridview.ts:1209-1258): the reference leaf is lifted out and replaced by a
 * branch holding it and the newcomer. The two split the reference's share, so the rest of the
 * layout does not move — splitting a pane should disturb its neighbours no more than closing a
 * tab does.
 */
export function addView<T>(
  layout: GridLayout<T>,
  data: T,
  reference: GridLocation,
  direction: Direction
): GridLayout<T> {
  const target = nodeAt(layout, reference);
  if (target === null) return layout;

  const here = locationOrientation(layout.orientation, reference);
  const wanted = directionOrientation(direction);
  const after = direction === "right" || direction === "down";

  if (here !== wanted) {
    const half = target.size / 2;
    const incoming = leaf(data, half);
    const existing = { ...target, size: half };
    const branch: BranchNode<T> = {
      kind: "branch",
      size: target.size,
      children: after ? [existing, incoming] : [incoming, existing],
    };
    const root = replaceAt(layout.root, reference, () => branch);
    return root === null || root.kind !== "branch" ? layout : { ...layout, root };
  }

  // Same axis: a sibling. It takes half of the reference's share for the same reason.
  const parentPath = reference.slice(0, -1);
  const index = (reference[reference.length - 1] ?? 0) + (after ? 1 : 0);
  const root = replaceAt(layout.root, parentPath, (parent) => {
    if (parent.kind !== "branch") return parent;
    const children = [...parent.children];
    const refIndex = reference[reference.length - 1] ?? 0;
    const ref = children[refIndex];
    if (ref === undefined) return parent;
    const half = ref.size / 2;
    children[refIndex] = { ...ref, size: half };
    children.splice(index, 0, leaf(data, half));
    return { ...parent, children };
  });
  if (root === null || root.kind !== "branch") return layout;
  return root === layout.root ? layout : { ...layout, root };
}

/** Remove the pane at `location`, collapsing any branch it leaves with a single child. */
export function removeView<T>(layout: GridLayout<T>, location: GridLocation): GridLayout<T> {
  if (location.length === 0) return layout;
  const root = replaceAt(layout.root, location, () => null);
  if (root === null) return { ...layout, root: { kind: "branch", size: 1, children: [] } };
  return root.kind === "branch" ? { ...layout, root } : { ...layout, root: { kind: "branch", size: 1, children: [root] } };
}

/**
 * Hide or show a pane without forgetting how wide it was.
 *
 * The share is left exactly as it was — `computeLayout` gives a hidden leaf a `{min: 0, max: 0}`
 * constraint, so the siblings expand to fill and the stored share is untouched underneath.
 * Showing it again needs no restore step for that reason. Dropping the pane from the tree
 * instead would lose its position as well as its width, and reopening would have to guess both.
 */
export function setVisible<T>(
  layout: GridLayout<T>,
  location: GridLocation,
  visible: boolean
): GridLayout<T> {
  const root = replaceAt(layout.root, location, (node) => {
    if (node.kind !== "leaf" || node.visible === visible) return node;
    return { ...node, visible };
  });
  if (root === null || root.kind !== "branch") return layout;
  return root === layout.root ? layout : { ...layout, root };
}

/** Write new shares into the children of the branch at `location`. */
export function setSizes<T>(
  layout: GridLayout<T>,
  location: GridLocation,
  sizes: readonly number[]
): GridLayout<T> {
  const root = replaceAt(layout.root, location, (node) => {
    if (node.kind !== "branch") return node;
    return {
      ...node,
      children: node.children.map((c, i) => {
        /**
         * An invisible child keeps the share it had.
         *
         * The sizes handed in come from `computeLayout`, which gives a hidden leaf a zero-pixel
         * rectangle — so writing them all back stores zero as that pane's remembered share and it
         * reopens collapsed. Hiding is supposed to cost nothing: `setVisible` leaves the share
         * alone precisely so the pane returns at the width it left at.
         *
         * `c.kind === "branch"` is included deliberately — a branch has no `visible` of its own,
         * and a fully-hidden subtree is already excluded from the pixel pass by `hasVisibleLeaf`
         * in geometry.ts, so its incoming size would be zero for the same reason.
         */
        if (c.kind === "leaf" && !c.visible) return c;
        return { ...c, size: sizes[i] ?? c.size };
      }),
    };
  });
  return root === null || root.kind !== "branch" ? layout : { ...layout, root };
}

// ── Persistence ─────────────────────────────────────────────────────────────────────────────
//
// The stored shape is VS Code's `ISerializedGrid`, byte-for-byte, deliberately. Keeping their
// format costs nothing — it is the same information — and buys a wire format that is already
// documented, already has a reference implementation to compare against, and is legible to
// anyone who has debugged a VS Code layout.

function toSerializedNode<T>(node: GridNode<T>): ISerializedNode {
  if (node.kind === "leaf") {
    const serialised: ISerializedNode = { type: "leaf", data: node.data, size: node.size };
    return node.visible ? serialised : { ...serialised, visible: false };
  }
  return { type: "branch", data: node.children.map(toSerializedNode), size: node.size };
}

export function serialize<T>(layout: GridLayout<T>, width: number, height: number): ISerializedGrid {
  return {
    root: toSerializedNode(layout.root),
    orientation: layout.orientation === "vertical" ? SERIALIZED_VERTICAL : SERIALIZED_HORIZONTAL,
    width,
    height,
  };
}

/**
 * A persisted layout, narrowed to one this build can render.
 *
 * **Total, and hostile to its input.** The value arrives off `host.session.load()`; that this
 * window wrote it is not a statement about its contents, which survive downgrades, hand-editing
 * and a future build that knows node kinds this one does not. Anything unrecognised returns
 * null and the caller falls back to a default layout — the same rule `parseDockTab` follows, and
 * for the same reason.
 *
 * `validate` decides whether a leaf's payload is still meaningful. A layout naming a pane this
 * build no longer has must not restore an empty hole, so the leaf is dropped and the branch
 * collapses around it.
 */
export function deserialize<T>(
  value: unknown,
  validate: (data: unknown) => T | null
): GridLayout<T> | null {
  if (typeof value !== "object" || value === null) return null;
  const grid = value as Partial<ISerializedGrid>;
  if (grid.orientation !== SERIALIZED_VERTICAL && grid.orientation !== SERIALIZED_HORIZONTAL) {
    return null;
  }

  const parse = (node: unknown): GridNode<T> | null => {
    if (typeof node !== "object" || node === null) return null;
    const n = node as Partial<ISerializedNode>;
    const size = typeof n.size === "number" && Number.isFinite(n.size) && n.size > 0 ? n.size : 1;

    if (n.type === "leaf") {
      const data = validate((n as { data?: unknown }).data);
      if (data === null) return null;
      return { kind: "leaf", data, size, visible: n.visible !== false };
    }
    if (n.type === "branch") {
      const raw = (n as { data?: unknown }).data;
      if (!Array.isArray(raw)) return null;
      const children = raw.map(parse).filter((c): c is GridNode<T> => c !== null);
      if (children.length === 0) return null;
      // Same collapse as `replaceAt`: a lone child must not keep a level, or every orientation
      // below it flips.
      if (children.length === 1) return { ...children[0]!, size };
      return { kind: "branch", size, children };
    }
    return null;
  };

  const root = parse(grid.root);
  if (root === null) return null;
  const orientation: Orientation =
    grid.orientation === SERIALIZED_VERTICAL ? "vertical" : "horizontal";
  return {
    orientation,
    root: root.kind === "branch" ? root : { kind: "branch", size: 1, children: [root] },
  };
}

/** A layout of one pane per entry, side by side. The fallback when nothing was restored. */
export function singleRow<T>(data: readonly T[], orientation: Orientation = "horizontal"): GridLayout<T> {
  return {
    orientation,
    root: {
      kind: "branch",
      size: 1,
      children: data.map((d) => leaf(d, 1 / Math.max(data.length, 1))),
    },
  };
}

/**
 * Move a pane next to another one.
 *
 * Remove then add, in that order, and the order is the whole difficulty: removing collapses any
 * branch left holding one child, which **renumbers every location after it**. A naive
 * implementation captures the target path first, removes the source, and then inserts at a path
 * that now points somewhere else — which looks correct in a flat three-pane layout and puts the
 * pane in the wrong place the moment anything is nested.
 *
 * So the target is re-found by identity after the removal rather than carried across it. That
 * needs a way to recognise the same pane again, which is what `sameData` is for: the caller knows
 * whether its payload is a string, an id, or an object worth comparing by field.
 */
export function moveView<T>(
  layout: GridLayout<T>,
  from: GridLocation,
  to: GridLocation,
  direction: Direction,
  sameData: (a: T, b: T) => boolean = (a, b) => a === b
): GridLayout<T> {
  const moving = nodeAt(layout, from);
  const target = nodeAt(layout, to);
  if (moving === null || moving.kind !== "leaf") return layout;
  /**
   * Both ends must be leaves.
   *
   * The `kind` check on the target is enforced by the compiler rather than by a test: a
   * `BranchNode` has no `data`, so removing it makes the two reads below type errors — `tsc`
   * reports TS2339 twice. A mutation test cannot show that, because vitest transpiles without
   * typechecking, which is worth knowing before concluding this line is dead.
   */
  if (target === null || target.kind !== "leaf") return layout;

  // Dropping a pane onto itself: an early return, and only that. Falling through would remove
  // it, fail to find it again, and return the original layout by the route below — the same
  // answer for more work. Said plainly because the obvious claim, that this prevents losing the
  // pane's size, is not true and a mutation removing it changes nothing observable.
  if (sameData(moving.data, target.data)) return layout;

  const without = removeView(layout, from);
  const landing = findLeaf(without, (data) => sameData(data, target.data));
  // The target went with the source: it was the branch's other child and the removal collapsed
  // them together. Nothing to move relative to, so leave the layout alone rather than guessing.
  if (landing === null) return layout;

  // No guard on the result: `addView` only refuses when its reference does not resolve, and
  // `landing` was just found in this very tree. A check here would be unreachable, and an
  // unreachable check reads as a hazard someone has thought about.
  return addView(without, moving.data, landing, direction);
}
