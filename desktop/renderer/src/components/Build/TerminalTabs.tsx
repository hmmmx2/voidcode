"use client";

import { useRef } from "react";
import { IconClose, IconPlus } from "@/components/icons";
import type { TerminalTab } from "@/lib/build/useTerminals";

/**
 * One tab per running shell.
 *
 * Hand-rolled rather than Radix, and not for want of trying. Radix `Tabs` gives roving tabindex
 * and correct ARIA for free, but its `TabsTrigger` sets `aria-controls` pointing at a
 * `TabsContent` id — and this dock deliberately has no `TabsContent`, because that component
 * unmounts its inactive children and unmounting a `TerminalPanel` kills the shell inside it.
 * Radix triggers over a hand-rolled `hidden` stack would leave every tab announcing a
 * relationship to an element that does not exist, which is worse for a screen reader than the
 * `role="tablist"` below. `EditorTabs` is the same shape for the same kind of reason.
 *
 * The roving tabindex is therefore explicit: one tab in the sequence, arrows move within the
 * strip. That is the behaviour Radix would have provided.
 */

export default function TerminalTabs({
  terminals,
  activeId,
  atCapacity,
  onFocus,
  onClose,
  onOpen,
}: {
  terminals: readonly TerminalTab[];
  activeId: number | null;
  atCapacity: boolean;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onOpen: () => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  /** Arrows move focus and selection together, which is what a tablist does by default. */
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();

    // Clamped, not wrapped. Wrapping a five-tab strip means Left from the first lands on the
    // last, which reads as the focus having been lost.
    const next = terminals[Math.min(Math.max(index + delta, 0), terminals.length - 1)];
    if (next === undefined || next.id === activeId) return;
    onFocus(next.id);
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-terminal-id="${next.id}"] button`)
      ?.focus();
  }

  return (
    <div ref={stripRef} className="flex min-w-0 items-stretch">
      <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-stretch">
        {terminals.map((terminal, index) => {
          const active = terminal.id === activeId;

          return (
            <div
              key={terminal.id}
              role="tab"
              aria-selected={active}
              data-terminal-id={terminal.id}
              // Middle-click closes, the convention every editor shares — and the same
              // placement as `EditorTabs`, on the container so it works anywhere on the tab.
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(terminal.id);
                }
              }}
              className={`group flex shrink-0 items-center gap-1.5 border-r border-line pl-3 pr-1.5 transition-colors duration-150 ease-void ${
                active ? "bg-ide-panel text-ink" : "text-ink-3 hover:bg-ide-raised hover:text-ink-2"
              }`}
            >
              <button
                type="button"
                tabIndex={active ? 0 : -1}
                onClick={() => onFocus(terminal.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="text-[12px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
              >
                {terminal.ordinal}
              </button>

              <button
                type="button"
                onClick={() => onClose(terminal.id)}
                aria-label={`Close terminal ${terminal.ordinal}`}
                title={`Close terminal ${terminal.ordinal}`}
                // Visible on the active tab and on hover only — a row of crosses on every tab
                // is noise, and the middle-click path covers the rest.
                className={`rounded p-0.5 text-ink-3 transition-opacity duration-150 ease-void hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <IconClose size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onOpen}
        disabled={atCapacity}
        // The cap is mirrored from main so this can be a disabled button with a reason, rather
        // than a spawn that throws after the user has already committed to it.
        title={
          atCapacity
            ? "Eight terminals is the limit for one window"
            : "New terminal (Ctrl+Shift+`)"
        }
        aria-label="New terminal"
        className="flex shrink-0 items-center px-2 text-ink-3 transition-colors duration-150 ease-void hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3"
      >
        <IconPlus size={13} />
      </button>
    </div>
  );
}
