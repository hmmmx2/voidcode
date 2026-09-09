"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  childSizes,
  computeLayout,
  UNCONSTRAINED,
  type PlacedSash,
  type Rect,
  type ViewConstraints,
} from "@/lib/layout/geometry";
import { moveView, setSizes, type Direction, type GridLayout, type GridLocation } from "@/lib/layout/grid-model";
import { resizeAt, toShares } from "@/lib/layout/sizing";
import { PANE_MIME, decodePaneDrag, encodePaneDrag } from "@/lib/layout/pane-drag";

/**
 * The docking system's one component.
 *
 * It measures its own box and renders rectangles. Everything else — where a pane goes when it is
 * split, how minimums compose, what a drag does to the tree — is pure logic in `lib/layout/`,
 * tested without a DOM. This file is deliberately the thin part.
 *
 * **One measurement, at the top.** `ResizeObserver` reads this container and nothing below it
 * touches the DOM for geometry. That mirrors how VS Code's engine works — it is driven entirely
 * by an explicit `layout(width, height)` and never calls `getBoundingClientRect` — and it is the
 * property that let the arithmetic be lifted at all while React keeps the markup.
 *
 * **Panes are positioned, never reordered or unmounted.** Every leaf keeps its React identity for
 * the life of the layout, and hiding sets a zero rectangle rather than removing the element. The
 * dock learnt this the expensive way: Radix's `TabsContent` unmounts inactive children, and
 * `TerminalPanel`'s cleanup calls `handle.close()`, so switching tabs killed every running shell.
 * A pane here can hold a terminal, so the same rule applies — the tree decides position, never
 * existence.
 */

/** How much of a pane's edge counts as "drop beside it" rather than "drop onto it". */
const EDGE_FRACTION = 0.28;

/** Which edge a pointer is nearest, or null for the middle. */
function edgeAt(rect: Rect, x: number, y: number): Direction | null {
  const dx = (x - rect.left) / Math.max(rect.width, 1);
  const dy = (y - rect.top) / Math.max(rect.height, 1);
  // Nearest edge wins, so a corner picks one rather than flickering between two.
  const distances: Array<[Direction, number]> = [
    ["left", dx],
    ["right", 1 - dx],
    ["up", dy],
    ["down", 1 - dy],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [direction, distance] = distances[0]!;
  return distance <= EDGE_FRACTION ? direction : null;
}

interface DockGridProps<T> {
  layout: GridLayout<T>;
  onLayoutChange: (next: GridLayout<T>) => void;
  /** Stable identity per pane. Reordering must not remount, so this cannot be an index. */
  keyFor: (data: T) => string;
  renderPane: (data: T, rect: Rect) => React.ReactNode;
  constraintsFor?: (data: T) => ViewConstraints;
  /**
   * Let panes be dragged to new slots.
   *
   * Off by default: a grid that rearranges itself is a feature, and a grip appearing over content
   * that cannot usefully move would be chrome pretending to be an affordance.
   */
  movable?: boolean;
  className?: string;
}

/** What the pointer is doing, and the sizes it started from. */
interface Drag {
  readonly sash: PlacedSash;
  readonly origin: number;
  readonly startSizes: readonly number[];
}

export default function DockGrid<T>({
  layout,
  onLayoutChange,
  keyFor,
  renderPane,
  constraintsFor = () => UNCONSTRAINED,
  movable = false,
  className,
}: DockGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The pane being dragged and the edge currently under the pointer. */
  const [paneDrag, setPaneDrag] = useState<{ from: GridLocation } | null>(null);
  const [dropAt, setDropAt] = useState<{ to: GridLocation; direction: Direction } | null>(null);

  // `useLayoutEffect` rather than `useEffect`: the first paint would otherwise place every pane
  // at zero and then jump, which reads as a flash on every window open.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    const measure = (): void => {
      setBox((current) =>
        current.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight }
      );
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { leaves, sashes } = computeLayout(layout, box.width, box.height, constraintsFor);

  // Read inside handlers bound for the life of a drag, which must not close over a stale tree.
  const latest = useRef({ layout, box, constraintsFor, onLayoutChange });
  latest.current = { layout, box, constraintsFor, onLayoutChange };

  const applyDrag = useCallback((current: Drag, position: number) => {
    const { layout: tree, box: size, constraintsFor: constraints, onLayoutChange: emit } = latest.current;
    const { constraints: bounds } = childSizes(
      tree,
      current.sash.branch,
      size.width,
      size.height,
      constraints
    );

    // Measured from where the drag started, not from the previous frame. Accumulating deltas
    // drifts as soon as a pane hits a bound: the pointer keeps moving, the sizes cannot, and the
    // divider ends up lagging the cursor by however far it was pushed past the limit.
    const next = resizeAt(current.startSizes, bounds, current.sash.index, position - current.origin);
    emit(setSizes(tree, current.sash.branch, toShares(next)));
  }, []);

  useEffect(() => {
    if (drag === null) return;

    const move = (event: PointerEvent): void => {
      applyDrag(drag, drag.sash.orientation === "horizontal" ? event.clientX : event.clientY);
    };
    const stop = (): void => setDrag(null);

    // On `window`, not the sash: the pointer routinely leaves an 8px target mid-drag, and a
    // listener on the element alone stops receiving moves the moment it does.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, applyDrag]);

  const beginDrag = useCallback(
    (sash: PlacedSash, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const { sizes } = childSizes(
        latest.current.layout,
        sash.branch,
        latest.current.box.width,
        latest.current.box.height,
        latest.current.constraintsFor
      );
      setDrag({
        sash,
        origin: sash.orientation === "horizontal" ? event.clientX : event.clientY,
        startSizes: sizes,
      });
    },
    []
  );

  const nudge = useCallback(
    (sash: PlacedSash, step: number) => {
      const { sizes, constraints } = childSizes(
        latest.current.layout,
        sash.branch,
        latest.current.box.width,
        latest.current.box.height,
        latest.current.constraintsFor
      );
      const next = resizeAt(sizes, constraints, sash.index, step);
      latest.current.onLayoutChange(setSizes(latest.current.layout, sash.branch, toShares(next)));
    },
    []
  );

  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className ?? ""}`}>
      {leaves.map((leaf) => {
        const isTarget =
          dropAt !== null && dropAt.to.join(".") === leaf.location.join(".");
        return (
        <div
          key={keyFor(leaf.data)}
          // `hidden` rather than conditional rendering — see the note at the top about panes
          // that own a pty.
          hidden={!leaf.visible}
          // Named group, so the grip reveals on this pane's hover and not on any ancestor's.
          className="group/pane"
          onDragOver={(event) => {
            // `types` is readable during a drag; `getData` is not, by spec — the payload stays
            // protected until the drop. So the gate here is the type, and `paneDrag` is used only
            // to suppress the preview on the pane the drag started from.
            if (!event.dataTransfer.types.includes(PANE_MIME)) return;
            // Dropping a pane on itself is a no-op in `moveView`; showing no target says so
            // before the user commits rather than after.
            if (paneDrag !== null && paneDrag.from.join(".") === leaf.location.join(".")) return;
            const direction = edgeAt(leaf.rect, event.clientX - containerLeft(containerRef), event.clientY - containerTop(containerRef));
            if (direction === null) {
              setDropAt(null);
              return;
            }
            event.preventDefault();
            setDropAt({ to: leaf.location, direction });
          }}
          onDrop={(event) => {
            /**
             * Everything this needs comes out of the event.
             *
             * `from` is in the payload and the direction is under the pointer, so neither is read
             * from React state. State set in `dragstart` has not necessarily committed by the time
             * `drop` fires — a pointer drag fires dozens of `dragover` events in between and hides
             * it, but a drop arriving in the same tick sees `null` and silently does nothing. That
             * is a race, not a rare case, and the fix is to stop depending on the timing.
             */
            const from = decodePaneDrag(event.dataTransfer.getData(PANE_MIME));
            if (from === null) return;

            const direction = edgeAt(
              leaf.rect,
              event.clientX - containerLeft(containerRef),
              event.clientY - containerTop(containerRef)
            );
            if (direction === null) return;

            event.preventDefault();
            setPaneDrag(null);
            setDropAt(null);
            onLayoutChange(moveView(latest.current.layout, from, leaf.location, direction, sameLeaf));
          }}
          style={{
            position: "absolute",
            top: leaf.rect.top,
            left: leaf.rect.left,
            width: leaf.rect.width,
            height: leaf.rect.height,
          }}
        >
          {renderPane(leaf.data, leaf.rect)}

          {/*
            The grip.

            A pane has no title bar of its own — its contents own their headers — so the handle is
            the grid's rather than the pane's. Hidden until the pointer is over the pane, because
            a permanent dot in the corner of every panel is chrome that says "you could move this"
            in a place where you almost never want to.
          */}
          {movable && leaf.visible && (
            <div
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PANE_MIME, encodePaneDrag(leaf.location));
                event.dataTransfer.effectAllowed = "move";
                setPaneDrag({ from: leaf.location });
              }}
              onDragEnd={() => {
                setPaneDrag(null);
                setDropAt(null);
              }}
              role="button"
              aria-label={`Move ${keyFor(leaf.data)} pane`}
              title="Drag to move this pane"
              className="absolute right-1 top-1 z-20 h-4 w-4 cursor-grab rounded opacity-0 transition-opacity duration-150 ease-void hover:bg-ide-raised focus-visible:opacity-100 group-hover/pane:opacity-100 active:cursor-grabbing"
            >
              <span aria-hidden className="flex h-full w-full items-center justify-center text-[10px] leading-none text-ink-3">
                ⠿
              </span>
            </div>
          )}

          {/*
            Where it would land.

            Drawn as the actual rectangle the pane would occupy rather than a glowing edge: the
            question a drop preview has to answer is "how big will it be", and half a pane is a
            very different answer from a thin strip.
          */}
          {isTarget && dropAt !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-30 border border-ink-3 bg-ink/10"
              style={landingStyle(dropAt.direction)}
            />
          )}
        </div>
      );})}

      {sashes.map((sash) => (
        <Sash
          key={`${sash.branch.join(".")}:${sash.index}`}
          sash={sash}
          active={
            drag !== null &&
            drag.sash.index === sash.index &&
            drag.sash.branch.join(".") === sash.branch.join(".")
          }
          onBegin={beginDrag}
          onNudge={nudge}
        />
      ))}

      {/*
        Held only while dragging.

        Two jobs, both learnt from `SplitContainer`. It keeps the resize cursor steady when the
        pointer crosses a pane that sets its own, and it stops text selecting across the editor —
        without it a drag over Monaco selects code the whole way.
      */}
      {drag !== null && (
        <div
          aria-hidden
          className="absolute inset-0 z-50"
          style={{
            cursor: drag.sash.orientation === "horizontal" ? "col-resize" : "row-resize",
            userSelect: "none",
          }}
        />
      )}
    </div>
  );
}

/** One divider. Drawn as a hairline, grabbed by a target several times wider. */
function Sash({
  sash,
  active,
  onBegin,
  onNudge,
}: {
  sash: PlacedSash;
  active: boolean;
  onBegin: (sash: PlacedSash, event: React.PointerEvent<HTMLDivElement>) => void;
  onNudge: (sash: PlacedSash, step: number) => void;
}) {
  const horizontal = sash.orientation === "horizontal";

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={(event) => onBegin(sash, event)}
      onKeyDown={(event) => {
        // Reachable without a pointer. A layout you can only change by dragging is a layout
        // somebody cannot change at all.
        const back = horizontal ? "ArrowLeft" : "ArrowUp";
        const forward = horizontal ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        onNudge(sash, event.key === forward ? KEYBOARD_STEP : -KEYBOARD_STEP);
      }}
      style={{
        position: "absolute",
        top: sash.rect.top,
        left: sash.rect.left,
        width: sash.rect.width,
        height: sash.rect.height,
        cursor: horizontal ? "col-resize" : "row-resize",
        zIndex: 40,
      }}
      className="group flex items-stretch justify-center focus-visible:outline-none"
    >
      {/*
        The hairline. Its parent carries the hit area, so this stays 1px — the design system has
        two chromatic values and no chrome ridges, and a dock that draws its own bevels would be
        the loudest thing on screen.
      */}
      <span
        aria-hidden
        className={`${horizontal ? "h-full w-px" : "w-full h-px"} transition-colors duration-150 ease-void ${
          active ? "bg-ink-3" : "bg-line group-hover:bg-line-strong group-focus-visible:bg-ink-3"
        }`}
      />
    </div>
  );
}

/** One arrow press, in pixels. Small enough to be precise, large enough to be worth pressing. */
const KEYBOARD_STEP = 16;

/** The container's page offset, so pointer coordinates can be compared with pane rectangles. */
function containerLeft(ref: React.RefObject<HTMLDivElement | null>): number {
  return ref.current?.getBoundingClientRect().left ?? 0;
}
function containerTop(ref: React.RefObject<HTMLDivElement | null>): number {
  return ref.current?.getBoundingClientRect().top ?? 0;
}

/** Panes are compared by identity of their data, which is what `keyFor` already assumes. */
function sameLeaf<T>(a: T, b: T): boolean {
  return a === b;
}

/** Half the pane, on the side the pointer is nearest. */
function landingStyle(direction: Direction): React.CSSProperties {
  switch (direction) {
    case "left":
      return { left: 0, top: 0, bottom: 0, width: "50%" };
    case "right":
      return { right: 0, top: 0, bottom: 0, width: "50%" };
    case "up":
      return { left: 0, right: 0, top: 0, height: "50%" };
    case "down":
      return { left: 0, right: 0, bottom: 0, height: "50%" };
  }
}
