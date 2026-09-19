"use client";

import { useRef } from "react";
import { IconChat, IconClose } from "@/components/icons";
import { FileIcon } from "./FileIcon";
import { tabLabels, type CentreTab } from "@/lib/build/editor-tabs";

/**
 * The centre pane's strip: Chat, then one tab per open file.
 *
 * Hand-rolled rather than Radix, for the reason `TerminalTabs` states and which applies here
 * with a second edge: Radix `TabsContent` unmounts its inactive children, and the two children
 * behind this strip are both expensive to unmount. Unmounting `AssistantPanel` drops the
 * transcript, the streaming cancel handle and the session id; unmounting the editor disposes
 * every buffer's undo stack. So the panes below are a `hidden` stack and the roving tabindex here
 * is explicit — which is the behaviour Radix would have provided.
 *
 * CHAT IS FIRST AND HAS NO CLOSE BUTTON. It is the one surface this pane always has: the grid
 * never collapses the centre (`workspace-layout.ts`'s `applyVisibility`), and
 * `BuildWorkspace`'s `renderPane` deliberately passes no `onClose` for the same reason. A cross
 * on it would advertise an action that cannot happen.
 *
 * The metrics — `h-9`, `text-[12px]`, a bottom hairline — are the dock's and the workspace
 * strip's, unchanged. Three tab strips in one window that each pick their own height read as
 * three different applications.
 */

export default function EditorTabs({
  paths,
  tab,
  dirtyPaths,
  onSelect,
  onClose,
}: {
  /** Open files, in strip order. Chat is not in here — see `lib/build/editor-tabs.ts`. */
  paths: readonly string[];
  tab: CentreTab;
  /** Paths whose buffer differs from disk. Empty until the editor can edit. */
  dirtyPaths?: ReadonlySet<string>;
  onSelect: (tab: CentreTab) => void;
  onClose: (path: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const labels = tabLabels(paths);
  /** Chat occupies index 0, so a file at `paths[i]` is at `i + 1` in the strip. */
  const activeIndex = tab.kind === "chat" ? 0 : paths.indexOf(tab.path) + 1;

  /** Arrows move focus and selection together, which is what a tablist does by default. */
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();

    // Clamped, not wrapped — the same choice `TerminalTabs` makes: Left from the first landing on
    // the last reads as the focus having been lost.
    const next = Math.min(Math.max(index + delta, 0), paths.length);
    if (next === index) return;
    const path = next === 0 ? null : paths[next - 1];
    onSelect(path === undefined || path === null ? { kind: "chat" } : { kind: "file", path });
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-index="${next}"] button`)?.focus();
  }

  return (
    <div ref={stripRef} className="flex min-w-0 items-stretch overflow-x-auto">
      <div role="tablist" aria-label="Editors" className="flex min-w-0 items-stretch">
        <div
          role="tab"
          aria-selected={tab.kind === "chat"}
          data-tab-index={0}
          className={`group flex shrink-0 items-center gap-1.5 border-r border-line px-3 transition-colors duration-150 ease-void ${
            tab.kind === "chat"
              ? "bg-ide-panel text-ink"
              : "text-ink-3 hover:bg-ide-raised hover:text-ink-2"
          }`}
        >
          <button
            type="button"
            tabIndex={activeIndex === 0 ? 0 : -1}
            onClick={() => onSelect({ kind: "chat" })}
            onKeyDown={(event) => onKeyDown(event, 0)}
            className="flex items-center gap-1.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
          >
            <IconChat size={12} />
            Chat
          </button>
        </div>

        {paths.map((path, index) => {
          const active = tab.kind === "file" && tab.path === path;
          const dirty = dirtyPaths?.has(path) === true;
          const label = labels.get(path) ?? path;

          return (
            <div
              key={path}
              role="tab"
              aria-selected={active}
              data-tab-index={index + 1}
              // Middle-click closes, the convention every editor shares — on the container so it
              // works anywhere on the tab, the same placement as `TerminalTabs`.
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(path);
                }
              }}
              className={`group flex shrink-0 items-center gap-1.5 border-r border-line pl-2.5 pr-1.5 transition-colors duration-150 ease-void ${
                active
                  ? "bg-ide-panel text-ink"
                  : "text-ink-3 hover:bg-ide-raised hover:text-ink-2"
              }`}
            >
              <button
                type="button"
                tabIndex={activeIndex === index + 1 ? 0 : -1}
                onClick={() => onSelect({ kind: "file", path })}
                onKeyDown={(event) => onKeyDown(event, index + 1)}
                title={path}
                className="flex min-w-0 items-center gap-1.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
              >
                <FileIcon name={path} />
                <span className="max-w-[16ch] truncate">{label}</span>
                {/*
                  The dirty dot goes AFTER the name, not in place of the close button.

                  Editors that swap the cross for a dot make the close target disappear exactly
                  when closing is the consequential action, and the user clicks the dot expecting
                  it to close. Both are shown; the cross still closes and still asks.
                */}
                {dirty && (
                  <span
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                    className="size-1.5 shrink-0 rounded-full bg-ink-2"
                  />
                )}
              </button>

              <button
                type="button"
                onClick={() => onClose(path)}
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                // Visible on the active tab and on hover only — a row of crosses on every tab is
                // noise, and middle-click covers the rest.
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
    </div>
  );
}
