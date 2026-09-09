"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// One declaration, shared with main — see `src/shared/preview.ts`.
import type { PreviewState } from "@shared/preview";

/**
 * The live preview, which is a hole in the page rather than content in it.
 *
 * The dev server is shown in a `WebContentsView` — a separate web contents with its own process
 * and session, owned by main. See `preview/view.ts` for why that rather than an iframe: an
 * iframe would put whatever the project serves inside the app's own document, and the project
 * serves whatever an agent just wrote and whatever an npm dependency injected.
 *
 * **So this component draws nothing where the page goes.** Its job is to measure the rectangle
 * and tell main where to put the native view, then get out of the way. Everything visible here
 * — the start button, the log, the failure — is what shows when there is *no* page to cover it.
 *
 * The measuring is the fiddly part, and all of it comes from the view being native: it does not
 * reflow when the DOM does, does not clip to a scroll container, and does not disappear when
 * this component unmounts. Every one of those has to be driven explicitly, which is what the
 * effects below are.
 */

interface PreviewCommandInfo {
  label: string;
  script: string;
}

const IDLE: PreviewState = {
  status: "idle",
  url: null,
  label: null,
  log: "",
  exitCode: null,
  error: null,
};

export default function PreviewPanel({
  host,
  visible,
  projectRoot,
}: {
  host: NonNullable<Window["host"]>;
  /**
   * The open project, as a value that changes when it does.
   *
   * Every question this panel asks main is about a specific project, and main answers from the
   * sender's *current* root — so the answers go stale the moment someone opens a different
   * folder. Threading the root through as a dependency is what makes the effects re-ask.
   *
   * The first version had no such prop and asked once on mount. On a launch where no folder was
   * open yet, `detect` failed, `command` stayed null, the button rendered its "dev server"
   * fallback and was disabled — and opening a project changed none of that. Clicking it did
   * nothing at all, which is how this was found: by clicking it.
   */
  projectRoot: string | undefined;
  /**
   * Whether the Preview tab is the one on screen.
   *
   * The native view is not clipped by anything in the DOM, so a tab switch has to actively take
   * it away — otherwise it stays floating over whatever tab you moved to. This is the same class
   * of problem `DockGrid` documents for terminals, arriving from the opposite direction: there
   * the danger is unmounting something that must stay alive, here it is leaving something
   * visible that has no idea the page moved on.
   */
  visible: boolean;
}) {
  const [state, setState] = useState<PreviewState>(IDLE);
  const [command, setCommand] = useState<PreviewCommandInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  /** Push the slot's current rectangle to main. Cheap, and called on every layout change. */
  const place = useCallback(() => {
    const element = slot.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    // A pane collapsed to nothing still has a rectangle; showing a zero-sized view is harmless
    // and keeps the contents alive, which is what makes reopening instant.
    void host.preview?.show({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [host]);

  // What this project would run, so the button can say it before it does it. Re-asked whenever
  // the project changes: the answer is about that project and nothing else.
  useEffect(() => {
    let alive = true;
    setCommand(undefined);
    void host.preview
      ?.detect()
      .then((result) => {
        if (alive) setCommand((result as { command: PreviewCommandInfo | null }).command);
      })
      .catch(() => {
        // No project open, most likely. `null` and "failed to ask" are the same answer to the
        // only question this drives: whether there is a button to offer.
        if (alive) setCommand(null);
      });
    return () => {
      alive = false;
    };
  }, [host, projectRoot]);

  // The current state on mount: a preview survives a reload of this window, because the server
  // is main's rather than the panel's.
  useEffect(() => {
    void host.preview
      ?.state()
      .then((next) => setState(next as PreviewState))
      .catch(() => setState(IDLE));
  }, [host, projectRoot]);

  useEffect(() => host.onPreviewChanged?.((next) => setState(next as PreviewState)), [host]);

  /**
   * Show it, move it, and take it away — the whole lifecycle of a surface the DOM cannot see.
   *
   * A `ResizeObserver` on the slot catches sash drags and window resizes. The scroll and the
   * `visible` dependency catch the two things it does not: the pane moving without changing
   * size, and the tab changing underneath it.
   */
  useEffect(() => {
    if (!visible || state.status !== "ready") {
      void host.preview?.hide();
      return;
    }

    place();
    const element = slot.current;
    const observer = new ResizeObserver(place);
    if (element !== null) observer.observe(element);
    window.addEventListener("resize", place);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      // Hidden on unmount, not destroyed. The server keeps running and the page keeps its
      // scroll position, so coming back is instant rather than a reload.
      void host.preview?.hide();
    };
  }, [visible, state.status, place, host]);

  const start = useCallback(() => {
    setBusy(true);
    void host.preview
      ?.start()
      .then((next) => setState(next as PreviewState))
      .catch((err: unknown) => {
        setState({
          ...IDLE,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setBusy(false));
  }, [host]);

  const stop = useCallback(() => {
    void host.preview
      ?.stop()
      .then((next) => setState(next as PreviewState))
      .catch(() => {});
  }, [host]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        {state.status === "ready" ? (
          <>
            <button
              type="button"
              onClick={stop}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              Stop
            </button>
            {/* The address, shown because a dev server's port is the thing you need when you
                want to open it in a real browser — which is where you go the moment you need
                devtools, since this view has none. */}
            <span className="truncate font-mono text-[10px] text-ink-3">{state.url}</span>
          </>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={busy || command === undefined || command === null || state.status === "starting"}
            className="rounded bg-ink px-2.5 py-1 text-[11px] text-void-0 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
          >
            {/*
              The button says what it will run.

              Starting a dev server executes the project's own code, and opening a folder was not
              consent to that. A button labelled "Start" hides the one fact worth knowing; one
              labelled `pnpm run dev` does not.
            */}
            {state.status === "starting" ? "Starting…" : `Run ${command?.label ?? "dev server"}`}
          </button>
        )}
      </div>

      {/*
        The hole.

        Deliberately empty and deliberately `flex-1`: main draws the page over this rectangle,
        and anything rendered inside would be underneath it — visible only in the moments the
        view is away, which is the worst kind of flicker to debug.
      */}
      <div ref={slot} className="min-h-0 flex-1 rounded border border-line bg-ide-code">
        {state.status !== "ready" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 overflow-hidden px-4 text-center">
            {command === null ? (
              <p className="text-[13px] text-ink-3">
                This project has no dev, start or serve script to run.
              </p>
            ) : state.status === "starting" ? (
              <p className="text-[13px] text-ink-3">Waiting for the dev server to answer…</p>
            ) : state.status === "failed" ? (
              <p className="text-[13px] text-diff-remove-ink">{state.error}</p>
            ) : (
              <p className="text-[13px] text-ink-3">
                Run the dev server to see the project here.
              </p>
            )}

            {/* The server's own output, which is the only thing that says why it will not
                start. Shown for both `starting` and `failed`: a build that is taking a long
                time and one that has died look identical without it. */}
            {state.log !== "" && state.status !== "idle" && (
              <pre className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded bg-ide-panel p-2 text-left font-mono text-[10px] leading-relaxed text-ink-3">
                {state.log}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
