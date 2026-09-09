"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";
import { reportError } from "@/lib/shell/report-error";

/**
 * The last thing between a render error and a white window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it. In a browser that
 * leaves a blank tab and a console message; here the window is frameless, so it leaves a blank
 * rectangle with no title bar, no menu, and no way to close it except the task manager. The
 * user's report is "the app broke" and there is nothing on disk to say why.
 *
 * So this does two jobs, and the second is the one that gets forgotten: it records the error
 * *with its component stack*, which is the artefact that says where in the tree it threw.
 *
 * How useful that stack is depends on the build, and it is worth being honest about. In
 * development it names components — `at ProblemPanel`, `at Workbench` — and is exactly what
 * you want. In a production build every component name is minified to a single letter, so the
 * same stack reads `at t`, `at u`, `at E` for sixty-nine frames. Measured on the real bundle:
 * 4.5KB of a 5.6KB entry, which at the log's 2MB cap is 374 entries — a component throwing in
 * a re-render loop would rotate the original cause out of the file in seconds.
 *
 * Hence `TOP_FRAMES`. The frames nearest the throw are the ones that localise it; the sixty
 * below are React's own plumbing and the layout chain, identical for every error in the app.
 * `route` in the report is what actually narrows a production error down to a file.
 *
 * Deliberately a class. Error boundaries have no hook equivalent — `componentDidCatch` is the
 * only API React offers for this, and every "useErrorBoundary" is a wrapper around a class.
 */

/**
 * How much of the component stack is kept.
 *
 * Enough to cross a page's own components and reach the layout, which is where the useful
 * signal stops. Trimming is marked rather than silent, so a truncated stack cannot be
 * mistaken for a shallow tree.
 */
const TOP_FRAMES = 20;

export function trimComponentStack(stack: string | null | undefined): string | null {
  if (stack === null || stack === undefined || stack === "") return null;
  const frames = stack.split("\n");
  if (frames.length <= TOP_FRAMES) return stack;
  return [...frames.slice(0, TOP_FRAMES), `    … ${frames.length - TOP_FRAMES} more frames`].join(
    "\n"
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Names the region in the log, so nested boundaries stay distinguishable. */
  region: string;
}

interface ErrorBoundaryState {
  message: string | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return { message: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    reportError(err, {
      kind: "react",
      region: this.props.region,
      // The whole reason to implement `componentDidCatch` alongside
      // `getDerivedStateFromError`: this is where the component stack is available.
      componentStack: trimComponentStack(info.componentStack),
    });
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;

    return (
      <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium text-ink">This panel stopped working.</p>
        {/*
          The message, shown rather than hidden behind "an error occurred".

          It is the difference between a user who can tell you what happened and one who
          cannot. The stack stays in the log — that is for whoever fixes it — but the message
          is usually a sentence, and a sentence is worth reading aloud over a support call.
        */}
        <p className="max-w-md break-words font-mono text-xs text-ink-3">{this.state.message}</p>
        <p className="text-xs text-ink-3">
          It has been written to the log — Help → Open Logs Folder.
        </p>
        <button
          type="button"
          onClick={() => this.setState({ message: null })}
          className="rounded border border-line px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          Try again
        </button>
      </div>
    );
  }
}
