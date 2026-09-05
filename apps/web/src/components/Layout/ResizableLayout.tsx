"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { layout } from "@/lib/tokens";

interface ResizableLayoutProps {
  leftPanel: React.ReactNode;
  topMiddle: React.ReactNode;
  bottomMiddle: React.ReactNode;
  rightPanel: React.ReactNode;
  isRightPanelOpen?: boolean;
  isEditorExpanded?: boolean;
}

type DragTarget = "left-divider" | "right-divider" | "middle-split" | null;

export default function ResizableLayout({
  leftPanel,
  topMiddle,
  bottomMiddle,
  rightPanel,
  isRightPanelOpen = true,
  isEditorExpanded = false,
}: ResizableLayoutProps) {
  const [leftWidth, setLeftWidth] = useState<number>(layout.leftDefault);
  const [rightWidth, setRightWidth] = useState<number>(layout.rightDefault);
  const [topHeight, setTopHeight] = useState<number>(layout.middleSplitDefault);
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const dragTarget = useRef<DragTarget>(null);

  const middleWidth = isRightPanelOpen
    ? 100 - leftWidth - rightWidth
    : 100 - leftWidth;

  const handleDividerMouseDown = useCallback(
    (target: DragTarget) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragTarget.current = target;
      setIsDragging(true);
      document.body.style.cursor =
        target === "middle-split" ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragTarget.current) return;

      if (dragTarget.current === "left-divider" && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        const maxLeft = isRightPanelOpen
          ? 100 - rightWidth - layout.columnMinWidth
          : 100 - layout.columnMinWidth;
        const clamped = Math.max(
          layout.columnMinWidth,
          Math.min(pct, maxLeft)
        );
        setLeftWidth(clamped);
      } else if (
        dragTarget.current === "right-divider" &&
        containerRef.current &&
        isRightPanelOpen
      ) {
        const rect = containerRef.current.getBoundingClientRect();
        const pctFromRight =
          ((rect.right - e.clientX) / rect.width) * 100;
        const clamped = Math.max(
          layout.columnMinWidth,
          Math.min(pctFromRight, 100 - leftWidth - layout.columnMinWidth)
        );
        setRightWidth(clamped);
      } else if (
        dragTarget.current === "middle-split" &&
        middleRef.current
      ) {
        const rect = middleRef.current.getBoundingClientRect();
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        const clamped = Math.max(20, Math.min(pct, 80));
        setTopHeight(clamped);
      }
    },
    [leftWidth, rightWidth, isRightPanelOpen]
  );

  const handleMouseUp = useCallback(() => {
    dragTarget.current = null;
    setIsDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const gap = layout.gapSize;

  // Expanded mode: only show the code editor fullscreen.
  // The right panel is hidden via CSS (not unmounted) so that any in-progress
  // AI streaming is preserved — unmounting VoidCodeAIPanel would kill the fetch stream.
  if (isEditorExpanded) {
    return (
      <div
        className="flex flex-1 overflow-hidden relative"
        style={{ padding: `${gap}px` }}
      >
        <div className="flex-1 flex flex-col rounded-lg overflow-hidden">
          {topMiddle}
        </div>
        {isRightPanelOpen && (
          <div style={{ display: "none" }} aria-hidden="true">
            {rightPanel}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-1 overflow-hidden relative"
      style={{ padding: `${gap}px`, gap: `${gap}px` }}
    >
      {/* Drag overlay to prevent iframe/editor stealing events */}
      {isDragging && <div className="absolute inset-0 z-50" />}

      {/* Column 1: Description (left) */}
      <div
        style={{ flex: `${leftWidth} 1 0%` }}
        className="flex flex-col rounded-lg overflow-hidden min-w-0"
      >
        {leftPanel}
      </div>

      {/* Left divider */}
      <div
        onMouseDown={handleDividerMouseDown("left-divider")}
        className="w-1 flex-shrink-0 cursor-col-resize rounded-full hover:bg-line-strong transition-colors bg-ide-gutter"
      />

      {/* Column 2: Middle (Code top + TestCase bottom) */}
      <div
        ref={middleRef}
        style={{ flex: `${middleWidth} 1 0%` }}
        className="flex flex-col overflow-hidden min-w-0"
      >
        {/* Top: Code editor */}
        <div
          style={{ flex: `${topHeight} 1 0%` }}
          className="flex flex-col rounded-lg overflow-hidden min-h-0"
        >
          {topMiddle}
        </div>

        {/* Vertical divider (between Code and TestCase) */}
        <div
          onMouseDown={handleDividerMouseDown("middle-split")}
          className="flex-shrink-0 cursor-row-resize rounded-full hover:bg-line-strong transition-colors bg-ide-gutter"
          style={{ height: `${gap}px` }}
        />

        {/* Bottom: Test Case / Execution / Slide */}
        <div
          style={{ flex: `${100 - topHeight} 1 0%` }}
          className="flex flex-col rounded-lg overflow-hidden min-h-0"
        >
          {bottomMiddle}
        </div>
      </div>

      {/* Right divider + Column 3: VoidCode AI (right) — hidden when panel closed */}
      {isRightPanelOpen && (
        <>
          <div
            onMouseDown={handleDividerMouseDown("right-divider")}
            className="w-1 flex-shrink-0 cursor-col-resize rounded-full hover:bg-line-strong transition-colors bg-ide-gutter"
          />

          <div
            style={{ flex: `${rightWidth} 1 0%` }}
            className="flex flex-col rounded-lg overflow-hidden min-w-0"
          >
            {rightPanel}
          </div>
        </>
      )}
    </div>
  );
}
