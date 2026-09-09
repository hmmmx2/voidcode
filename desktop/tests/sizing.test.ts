/**
 * Dividing a row, and dragging the dividers.
 *
 * Two properties matter more than any individual case, because every real bug here is one of
 * them failing: **the total is preserved**, and **constraints hold**. A drag that quietly loses
 * three pixels leaves a gap that grows with every drag; one that ignores a minimum produces a
 * pane too narrow to grab, which the user cannot undo because the handle is gone.
 */
import { describe, it, expect } from "vitest";
import { resizeAt, toPixels, toShares, type SizeConstraint } from "../renderer/src/lib/layout/sizing.js";

const free = (n: number): SizeConstraint[] =>
  Array.from({ length: n }, () => ({ min: 0, max: Number.POSITIVE_INFINITY }));

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe("shares to pixels", () => {
  it("divides the space in proportion", () => {
    expect(toPixels([0.25, 0.75], free(2), 1000)).toEqual([250, 750]);
  });

  it("normalises shares that do not sum to one", () => {
    // Every add and remove leaves them summing to something else. Normalising at the point of
    // use is the only place it cannot be forgotten.
    expect(toPixels([1, 3], free(2), 1000)).toEqual([250, 750]);
    expect(toPixels([2, 2, 4], free(3), 800)).toEqual([200, 200, 400]);
  });

  it("honours a minimum, and takes the space from the panes that can spare it", () => {
    const sizes = toPixels([0.1, 0.9], [{ min: 300, max: Infinity }, { min: 0, max: Infinity }], 1000);
    expect(sizes[0]).toBe(300);
    expect(sum(sizes)).toBeCloseTo(1000, 6);
  });

  it("honours a maximum the same way", () => {
    const sizes = toPixels([0.9, 0.1], [{ min: 0, max: 200 }, { min: 0, max: Infinity }], 1000);
    expect(sizes[0]).toBe(200);
    expect(sum(sizes)).toBeCloseTo(1000, 6);
  });

  it("preserves the total under every constraint mix", () => {
    // The property, asserted over cases rather than argued.
    const cases: Array<[number[], SizeConstraint[], number]> = [
      [[1, 1, 1], free(3), 999],
      [[0.5, 0.5], [{ min: 400, max: Infinity }, { min: 400, max: Infinity }], 1000],
      [[0.2, 0.3, 0.5], [{ min: 100, max: 150 }, { min: 0, max: Infinity }, { min: 50, max: 400 }], 900],
      [[1, 0, 0], free(3), 300],
    ];
    for (const [shares, constraints, total] of cases) {
      expect(sum(toPixels(shares, constraints, total)), JSON.stringify(shares)).toBeCloseTo(total, 6);
    }
  });

  it("falls back to equal shares when every share is zero or negative", () => {
    // A corrupt layout, not a request for zero-width panes.
    expect(toPixels([0, 0, 0], free(3), 900)).toEqual([300, 300, 300]);
    expect(toPixels([-1, -1], free(2), 800)).toEqual([400, 400]);
  });

  it("gives up rather than looping when the constraints cannot be satisfied", () => {
    // Three panes needing 400 each in 600px is unsatisfiable. It must terminate and stay at the
    // minimums, not spin trying to place the remainder.
    const sizes = toPixels([1, 1, 1], Array.from({ length: 3 }, () => ({ min: 400, max: 500 })), 600);
    expect(sizes).toEqual([400, 400, 400]);
  });

  it("handles the empty row", () => {
    expect(toPixels([], [], 1000)).toEqual([]);
  });
});

describe("pixels back to shares", () => {
  it("inverts toPixels", () => {
    expect(toShares([250, 750])).toEqual([0.25, 0.75]);
  });

  it("sums to one", () => {
    expect(sum(toShares([13, 71, 5]))).toBeCloseTo(1, 10);
  });
});

describe("dragging a divider", () => {
  const three = [300, 300, 300];

  it("moves space from one side to the other", () => {
    const after = resizeAt(three, free(3), 0, 50);
    expect(after[0]).toBe(350);
    expect(after[1]).toBe(250);
    expect(after[2]).toBe(300);
  });

  it("takes from the nearest neighbour first", () => {
    // What makes dragging feel local rather than shuffling the whole row.
    const after = resizeAt(three, free(3), 0, 50);
    expect(after[2]).toBe(300);
  });

  it("spills to the next neighbour once the nearest is exhausted", () => {
    const constraints: SizeConstraint[] = [
      { min: 0, max: Infinity },
      { min: 280, max: Infinity },
      { min: 0, max: Infinity },
    ];
    const after = resizeAt(three, constraints, 0, 100);
    expect(after[1]).toBe(280);
    expect(after[2]).toBe(220);
    expect(sum(after)).toBe(900);
  });

  it("drags the other way too", () => {
    const after = resizeAt(three, free(3), 1, -50);
    expect(after[1]).toBe(250);
    expect(after[2]).toBe(350);
  });

  it("clamps at a minimum instead of refusing the drag", () => {
    // A divider that snaps back to where it started reads as broken. It should travel as far as
    // it can and stop.
    const constraints: SizeConstraint[] = [
      { min: 0, max: Infinity },
      { min: 250, max: Infinity },
      { min: 250, max: Infinity },
    ];
    const after = resizeAt(three, constraints, 0, 1000);
    expect(after[0]).toBe(400);
    expect(after[1]).toBe(250);
    expect(after[2]).toBe(250);
    expect(sum(after)).toBe(900);
  });

  it("preserves the total on every drag", () => {
    // The property that makes this safe to call on every pointermove.
    for (const delta of [-1000, -137, -1, 0, 1, 137, 1000]) {
      for (const index of [0, 1]) {
        const after = resizeAt(three, [
          { min: 100, max: 500 },
          { min: 100, max: 500 },
          { min: 100, max: 500 },
        ], index, delta);
        expect(sum(after), `index ${index} delta ${delta}`).toBeCloseTo(900, 6);
      }
    }
  });

  it("does nothing at the ends, where there is no divider", () => {
    expect(resizeAt(three, free(3), -1, 50)).toEqual(three);
    expect(resizeAt(three, free(3), 2, 50)).toEqual(three);
    expect(resizeAt(three, free(3), 99, 50)).toEqual(three);
  });

  it("does nothing when neither side can move", () => {
    const pinned = Array.from({ length: 3 }, () => ({ min: 300, max: 300 }));
    expect(resizeAt(three, pinned, 0, 100)).toEqual(three);
  });
});
