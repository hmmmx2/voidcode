/**
 * How a row of panes divides the space it is given.
 *
 * One dimension only. A grid is a tree of these — a column of rows of columns — so everything
 * two-dimensional is handled by nesting, and this file never needs to know which axis it is on.
 *
 * Ported from VS Code's `SplitView` (`src/vs/base/browser/ui/splitview/splitview.ts`), commit
 * d8b1606: `resize` (1235-1321), `distributeEmptySpace`, `saveProportions` (622-634) and the
 * proportional branch of `layout` (846-874). Reimplemented rather than vendored — the upstream
 * method writes `container.style.top/height` and calls `sash.layout()` on its way out, so the
 * arithmetic and the DOM writing are the same function there and cannot be here, where React
 * owns the markup. What survives is the arithmetic, which is the part with the bugs in it.
 *
 * **Sizes are shares, not pixels.** The upstream trick worth keeping is `saveProportions`: on
 * load, stored pixel sizes become ratios of the space they were measured in, and the first real
 * layout rescales them to whatever the window is now. Storing pixels alone means a layout
 * serialised on a 34" ultrawide restores as a sliver on a laptop. Storing ratios means it
 * restores as itself. `pane-sizes.ts` already reinvented half of this for hidden panes; this is
 * the other half.
 */

/** What a pane will accept, in pixels. `Infinity` for "no maximum" is deliberate — see clamp. */
export interface SizeConstraint {
  readonly min: number;
  readonly max: number;
}

/**
 * Bounded, and total: a `NaN` size would otherwise propagate silently through a whole layout.
 *
 * The `Infinity` case has to be handled explicitly rather than by letting `Math.min` deal with
 * it. Writing this as `Math.min(Math.max(value, min), isFinite(max) ? max : value)` looks
 * equivalent and silently drops the *minimum* whenever there is no maximum — `Math.max(v, min)`
 * raises it and `Math.min(…, v)` immediately puts it back.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const atLeastMin = Math.max(value, min);
  return Number.isFinite(max) ? Math.min(atLeastMin, max) : atLeastMin;
}

const EPSILON = 0.01;

/**
 * Turn shares into pixels for a container this wide.
 *
 * Shares need not sum to 1 — they are normalised here, because every operation that adds or
 * removes a pane leaves them summing to something else, and normalising at the point of use is
 * the only place that cannot be forgotten.
 *
 * Constraints are honoured, which means the result may not be proportional: a pane with a 200px
 * minimum in a 300px container takes two thirds of it whatever its share says. The remainder is
 * redistributed across panes that still have room, which is why this is a loop rather than a
 * map — one pass can push another pane past its own bound.
 */
export function toPixels(
  shares: readonly number[],
  constraints: readonly SizeConstraint[],
  total: number
): number[] {
  if (shares.length === 0) return [];

  const sum = shares.reduce((acc, share) => acc + Math.max(share, 0), 0);
  // Every share zero or negative is a corrupt layout, not a request for zero-width panes.
  const normalised = sum > 0 ? shares.map((s) => Math.max(s, 0) / sum) : shares.map(() => 1 / shares.length);

  const sizes = normalised.map((share, i) => clamp(share * total, constraints[i]!.min, constraints[i]!.max));

  // Redistribute whatever the clamping left over, among panes that can still move. Bounded by
  // the pane count: each pass either places the remainder or pins at least one more pane.
  for (let pass = 0; pass <= shares.length; pass += 1) {
    const placed = sizes.reduce((acc, size) => acc + size, 0);
    const remainder = total - placed;
    if (Math.abs(remainder) < EPSILON) break;

    const growing = remainder > 0;
    const movable = sizes
      .map((size, i) => ({ i, room: growing ? constraints[i]!.max - size : size - constraints[i]!.min }))
      .filter((entry) => entry.room > EPSILON);
    // Nothing left that can legally move. The layout is over- or under-constrained and staying
    // at the bounds is the honest answer; looping would not find one.
    if (movable.length === 0) break;

    // A pane with no maximum has infinite room, and weighting by `room / totalRoom` would be
    // `Infinity / Infinity` — NaN, which clamp then turns into the minimum, collapsing the pane
    // to nothing. Unbounded panes simply share the remainder between them. Only reachable while
    // growing: room to shrink is `size - min`, always finite.
    const unbounded = movable.filter((entry) => !Number.isFinite(entry.room));
    if (unbounded.length > 0) {
      const each = remainder / unbounded.length;
      for (const entry of unbounded) sizes[entry.i] = sizes[entry.i]! + each;
      continue;
    }

    const room = movable.reduce((acc, entry) => acc + entry.room, 0);
    for (const entry of movable) {
      const give = remainder * (entry.room / room);
      sizes[entry.i] = clamp(sizes[entry.i]! + give, constraints[entry.i]!.min, constraints[entry.i]!.max);
    }
  }

  return sizes;
}

/** Pixels back to shares, for storing. The inverse of `toPixels` up to clamping. */
export function toShares(sizes: readonly number[]): number[] {
  const total = sizes.reduce((acc, size) => acc + Math.max(size, 0), 0);
  if (total <= 0) return sizes.map(() => (sizes.length === 0 ? 0 : 1 / sizes.length));
  return sizes.map((size) => Math.max(size, 0) / total);
}

/**
 * Drag the divider that sits after `index` by `delta` pixels.
 *
 * The pane before the divider grows by `delta` and the panes after it give that space back, so
 * the total is unchanged — which is the property that makes this safe to call on every
 * pointermove. A drag that would violate a constraint is *clamped, not refused*: pushing a
 * divider into a pane that has hit its minimum moves it as far as it can go and stops, rather
 * than snapping back to where it started, because a divider that ignores you feels broken.
 *
 * Capacity is computed on both sides before anything moves. Applying greedily and repairing
 * afterwards is the obvious implementation and it is wrong: the repair pass has to undo work in
 * the reverse order it was done, and gets the total wrong whenever both sides run out at once.
 */
export function resizeAt(
  sizes: readonly number[],
  constraints: readonly SizeConstraint[],
  index: number,
  delta: number
): number[] {
  const result = [...sizes];
  if (index < 0 || index >= sizes.length - 1 || delta === 0) return result;

  // Nearest-first: the pane against the divider absorbs the drag before its neighbours do,
  // which is what makes dragging feel local rather than shuffling the whole row.
  const growing: number[] = [];
  const shrinking: number[] = [];
  if (delta > 0) {
    for (let i = index; i >= 0; i -= 1) growing.push(i);
    for (let i = index + 1; i < sizes.length; i += 1) shrinking.push(i);
  } else {
    for (let i = index + 1; i < sizes.length; i += 1) growing.push(i);
    for (let i = index; i >= 0; i -= 1) shrinking.push(i);
  }

  const wanted = Math.abs(delta);
  const roomToGrow = growing.reduce((acc, i) => acc + (constraints[i]!.max - result[i]!), 0);
  const roomToShrink = shrinking.reduce((acc, i) => acc + (result[i]! - constraints[i]!.min), 0);
  // Whichever side runs out first decides how far the divider actually moves.
  const movable = Math.min(wanted, roomToGrow, roomToShrink);
  if (movable <= 0) return result;

  let toGive = movable;
  for (const i of growing) {
    if (toGive <= EPSILON) break;
    const room = constraints[i]!.max - result[i]!;
    const take = Math.min(room, toGive);
    result[i] = result[i]! + take;
    toGive -= take;
  }

  let toTake = movable;
  for (const i of shrinking) {
    if (toTake <= EPSILON) break;
    const room = result[i]! - constraints[i]!.min;
    const give = Math.min(room, toTake);
    result[i] = result[i]! - give;
    toTake -= give;
  }

  return result;
}
