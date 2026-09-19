"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { IconClose, IconOutput, IconTerminal, IconWarning } from "@/components/icons";
import TerminalTabs from "@/components/Build/TerminalTabs";
import OutputPanel from "@/components/Build/OutputPanel";
import ProblemsPanel from "@/components/Build/ProblemsPanel";
import { DOCK_TABS, type DockTab } from "@/lib/build/dock";
import type { UseTerminals } from "@/lib/build/useTerminals";
import type { OutputChannel, OutputState } from "@/lib/build/output";
import { countsFor } from "@/lib/build/problems";
import type { LintResult } from "@shared/diagnostics";

/**
 * The bottom dock: a tab strip over a stack of panes.
 *
 * Two tabs — Terminal and Output. `DOCK_TABS` drives the strip, so a fourth would be a
 * list entry and a pane; Ports and Debug Console are absent for reasons recorded there.
 *
 * **THE PANES ARE A HIDDEN STACK, NOT SWAPPED CHILDREN.** Every `TerminalPanel` stays mounted for
 * as long as its tab exists; the inactive ones are `hidden`. This is the whole architectural
 * constraint of the dock: unmounting a `TerminalPanel` runs its cleanup, which closes the
 * MessagePort, which is what main watches to kill the child process. A tab control that renders
 * only the active child — Radix `TabsContent`, and most hand-rolled ones — would kill every shell
 * you were not looking at, silently, on every tab click.
 *
 * **Collapsing the dock no longer ends its terminals.** It used to: the panel was rendered behind
 * `panels.bottom &&`, so hiding it unmounted this component and every pane in it. Under the
 * workspace grid a hidden pane keeps its subtree mounted — the same rule that makes the tabs above
 * a hidden stack rather than swapped children — so reopening returns you to the shells you left.
 * `killTerminalsFor` in main still ends them with the window, which is the lifetime a pty actually
 * has. Clicking the active tab still does not collapse, but that is now a preference about
 * pointer targets rather than a guard on a destructive action.
 */

// Same reason Monaco is dynamic: xterm touches `document` at import time and this tree is
// prerendered in Node by the static export.
const TerminalPanel = dynamic(() => import("@/components/Build/TerminalPanel"), { ssr: false });

const TAB_LABELS: Record<DockTab, string> = {
  problems: "Problems",
  terminal: "Terminal",
  output: "Output",
};

const TAB_ICONS: Record<DockTab, (props: { size?: number }) => React.ReactElement> = {
  problems: IconWarning,
  terminal: IconTerminal,
  output: IconOutput,
};

export default function BottomDock({
  visible,
  tab,
  onTabChange,
  terminals,
  output,
  outputChannel,
  onOutputChannelChange,
  onClearOutput,
  problems,
  dirtyPaths,
  linting,
  onOpenLocation,
  onFlush,
  onTerminalExit,
  onClose,
}: {
  /**
   * Whether the dock is actually on screen.
   *
   * The grid never unmounts a pane — it gives a hidden one a zero rectangle — so this component
   * is mounted from launch whether or not the dock is open, and cannot infer that from anything
   * it can see.
   */
  visible: boolean;
  tab: DockTab;
  onTabChange: (tab: DockTab) => void;
  terminals: UseTerminals;
  output: OutputState;
  outputChannel: OutputChannel;
  onOutputChannelChange: (channel: OutputChannel) => void;
  onClearOutput: () => void;
  /** What the linters said about the open files, for the Problems tab. */
  problems: readonly LintResult[];
  /** Buffers that differ from disk, so a row can say its diagnostics are from the last save. */
  dirtyPaths: ReadonlySet<string>;
  /** Files with a lint run in flight, so a slow `tsc` does not read as a hang. */
  linting: ReadonlySet<string>;
  onOpenLocation: (path: string, line: number, column: number) => void;
  /** Write unsaved buffers before a terminal sees input. Threaded through to each pane. */
  onFlush?: () => void;
  /** A shell ended. Threaded per pane so the tab number can be named in Output. */
  onTerminalExit?: (id: number, code: number, signal: number | null) => void;
  onClose: () => void;
}) {
  const { open } = terminals;
  const count = terminals.terminals.length;
  const problemCounts = countsFor(problems);


  /**
   * Opening the dock gives you a shell, which is what it did before it had tabs.
   *
   * Once, and only once the dock is actually visible. It used to fire on mount, which was the
   * same thing while the dock defaulted open. It stopped being the same thing when the terminal
   * became hidden by default: the grid keeps every pane mounted and merely gives a hidden one a
   * zero rectangle, so this component mounts at launch either way and the effect was spawning a
   * real shell in the project root that nobody had asked for and nobody could see.
   *
   * Still not reactive to `count` reaching zero — that would make the last close button
   * un-pressable, since you would close a terminal and watch another appear.
   */
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !visible) return;
    opened.current = true;
    if (count === 0) open();
  }, [visible, count, open]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-ide-code">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-ide-bar/60">
        <div role="tablist" aria-label="Panel" className="flex items-stretch">
          {DOCK_TABS.map((id) => {
            const active = id === tab;
            const Icon = TAB_ICONS[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(id)}
                className={`flex items-center gap-1.5 border-r border-line px-3 text-[11px] uppercase tracking-wide transition-colors duration-150 ease-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink ${
                  active ? "bg-ide-panel text-ink" : "text-ink-3 hover:bg-ide-raised hover:text-ink-2"
                }`}
              >
                <Icon size={13} />
                {TAB_LABELS[id]}
                {/*
                  A count, only when there is one — the rule `WorkspaceSurface` already follows
                  for its own badges. A "0" beside Problems is a number that says nothing and
                  draws the eye every time you look at the dock.

                  This is the ONLY thing that announces a new diagnostic. The dock never opens
                  itself: stealing the layout to show a warning is worse than a badge, and a
                  linter that ran because you saved is not an event that should move the window.
                */}
                {id === "problems" && problemCounts.errors + problemCounts.warnings > 0 && (
                  <span
                    className={`rounded px-1 font-mono text-[10px] tabular-nums ${
                      problemCounts.errors > 0 ? "text-problem-error" : "text-problem-warn"
                    }`}
                  >
                    {problemCounts.errors + problemCounts.warnings}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {tab === "terminal" && (
          <TerminalTabs
            terminals={terminals.terminals}
            activeId={terminals.activeId}
            atCapacity={terminals.atCapacity}
            onFocus={terminals.focus}
            onClose={terminals.close}
            onOpen={terminals.open}
          />
        )}

        <div className="ml-auto flex items-stretch">
          <button
            type="button"
            onClick={onClose}
            // No longer says what it costs, because it no longer costs anything: the panes stay
            // mounted while hidden and the shells keep running — see the header.
            title={
              count > 0
                ? `Hide panel — ${count === 1 ? "the terminal keeps" : `${count} terminals keep`} running`
                : "Hide panel"
            }
            aria-label="Hide panel"
            className="flex items-center px-2.5 text-ink-3 transition-colors duration-150 ease-void hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
          >
            <IconClose size={13} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {/*
          EVERY PANE IS RENDERED, ALWAYS. `hidden` switches which one you see.

          Gating these on `tab === …` would unmount the terminal stack the moment you clicked
          another tab, and unmounting a `TerminalPanel` kills its shell — the same trap Radix
          `TabsContent` sets, reintroduced by hand one tab level up. Switching to Output to read
          a line and back to find your build gone would be the worst version of it.
        */}

        <div hidden={tab !== "problems"} className="h-full">
          <ProblemsPanel
            results={problems}
            dirtyPaths={dirtyPaths}
            running={linting}
            onOpenLocation={onOpenLocation}
          />
        </div>

        <div hidden={tab !== "output"} className="h-full">
          <OutputPanel
            output={output}
            channel={outputChannel}
            onChannelChange={onOutputChannelChange}
            onClear={onClearOutput}
          />
        </div>

        <div hidden={tab !== "terminal"} className="h-full">
          {count === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-[13px] text-ink-3">No terminal open.</p>
              <button
                type="button"
                onClick={terminals.open}
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                New terminal
              </button>
            </div>
          ) : (
            terminals.terminals.map((terminal) => {
              const active = terminal.id === terminals.activeId;
              return (
                <div key={terminal.id} hidden={!active} className="h-full">
                  <TerminalPanel
                    active={active && tab === "terminal"}
                    clearNonce={terminals.clearNonce}
                    onFlush={onFlush}
                    onExit={(code, signal) => onTerminalExit?.(terminal.id, code, signal)}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
