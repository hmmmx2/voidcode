"use client";

import { useEffect, useRef, type RefObject } from "react";

export type Pointer = { x: number; y: number };

/**
 * Normalised cursor position, −1…1 on both axes, as a ref.
 *
 * WHY THIS EXISTS RATHER THAN r3f's `state.pointer`
 *
 * Every canvas in this system is decorative: its wrapper is
 * `pointer-events-none` and the `<Canvas>` itself carries
 * `pointerEvents: "none"`. r3f attaches its listeners to that subtree, so it
 * never receives a pointer event and `state.pointer` stays at (0, 0) forever.
 *
 * The hero's cursor lean was written against `state.pointer` and was therefore
 * dead from the day it shipped — it only became noticeable once the object
 * stopped spinning and nothing else was covering for it.
 *
 * Listening on `window` sidesteps r3f's event system entirely, which is what we
 * want: the object should respond to the cursor without becoming hit-testable
 * and stealing events from the page behind it.
 *
 * A ref, not state, because this updates on every pointer move and the consumer
 * is a `useFrame` callback. Storing it in state would re-render the component
 * tree at pointer frequency to produce an identical tree.
 */
export function useCursorLean(): RefObject<Pointer> {
  const pointer = useRef<Pointer>({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = -(event.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return pointer;
}
