/**
 * What a pane drag carries.
 *
 * A `GridLocation` is a path of child indices — `[1, 0]` is "first child of the second branch" —
 * and `dataTransfer` holds strings, so it travels as `"1.0"`.
 *
 * This lives apart from `DockGrid` for one reason, learnt from driving the real app: the drop
 * handler must not depend on React state. `dragstart` sets state, `drop` reads it, and the two can
 * land in the same tick — a real pointer drag hides that because dozens of `dragover` events fall
 * between them and the state settles, but nothing guarantees it. The payload is already in the
 * event. A handler that reads its own event cannot be raced.
 *
 * Decoding is defensive for the same reason `decodeRefDrag` is: `dataTransfer` is filled by
 * whatever was dragged, including another application, and a location is used to index a tree.
 */

import type { GridLocation } from "@/lib/layout/grid-model";

/** The type a pane drag carries. Its own, so a file drag cannot be mistaken for a pane drag. */
export const PANE_MIME = "application/x-voidcode-pane";

export function encodePaneDrag(location: GridLocation): string {
  return location.join(".");
}

/** A location, or null if the payload is not one this grid could have written. */
export function decodePaneDrag(raw: string): GridLocation | null {
  if (raw === "") return null;
  const parts = raw.split(".");
  const location: number[] = [];
  for (const part of parts) {
    // `Number` alone accepts "", " ", "0x2", "1e3" and "Infinity"; a child index is a plain
    // non-negative integer and nothing else. The round-trip through `String` rejects every
    // spelling that is not the canonical one.
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || String(value) !== part) return null;
    location.push(value);
  }
  return location;
}
