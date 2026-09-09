/**
 * The payload a pane drag carries.
 *
 * This is a codec for a tree index, and it is decoded from `dataTransfer` — which is filled by
 * whatever was dragged, including another window or another application. The decoded value is then
 * used to walk a tree, so "not a location" has to come back as null rather than as `[NaN]`.
 */
import { describe, it, expect } from "vitest";
import { decodePaneDrag, encodePaneDrag } from "../renderer/src/lib/layout/pane-drag.js";

describe("a pane drag payload", () => {
  it("round-trips a location", () => {
    for (const location of [[0], [1, 0], [0, 2, 1]]) {
      expect(decodePaneDrag(encodePaneDrag(location))).toEqual(location);
    }
  });

  it("round-trips the root", () => {
    // `[]` is a legal location — the whole grid — and `join` makes it "", which the decoder must
    // not confuse with an empty payload. It cannot, and this is why the two are not the same:
    // an absent payload means "not our drag", and returning `[]` for it would target the root.
    expect(encodePaneDrag([])).toBe("");
    expect(decodePaneDrag("")).toBeNull();
  });

  it("refuses anything that is not a location", () => {
    for (const raw of [
      "a",
      "1.a",
      "1..2",
      "-1",
      // Spellings `Number` accepts and `String(value)` does not produce. A location that arrived
      // as "1e3" would index child 1000 of a two-child branch.
      "1e3",
      "0x2",
      " 1",
      "Infinity",
      "NaN",
    ]) {
      expect(decodePaneDrag(raw), raw).toBeNull();
    }
  });
});
