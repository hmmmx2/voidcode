"use client";

import { Pill } from "@/components/ui/Pill";
import { useEffect, useRef, useState } from "react";
import { DEMO_BEATS } from "./demo-script";
import { DEMO_LANGUAGE } from "./demo-content";
import { CodeStatic } from "./CodeStatic";
import { DemoConsole } from "./DemoConsole";
import { DemoEditor } from "./DemoEditor";
import { DemoProblemPanel } from "./DemoProblemPanel";
import { DemoTutorPanel } from "./DemoTutorPanel";
import { useDemoRunner } from "./useDemoRunner";
import { useShouldReduceMotion } from "@/lib/hooks/useShouldReduceMotion";
import { MonoLabel } from "@/components/marketing/primitives/SectionShell";

/**
 * The hero demo.
 *
 * Chrome mirrors `Editor/CodeColumn.tsx` rather than a macOS window with traffic
 * lights — the `h-9 bg-[#262626]` bar, the `Code` label, the real
 * `ic-run-code` / `ic-submit-code` assets. A demo that is a screenshot of the
 * product is more persuasive than one that is a mock of it, and it cannot drift
 * out of date.
 *
 * The editor is real and its buffer really is mutated by the tutor. Only the
 * model is canned, and only because the alternative is worse: see
 * `gradeBuffer` in `demo-content.ts` for why nothing is executed.
 */
export function DemoWindow() {
  const demo = useDemoRunner();
  const shouldReduceMotion = useShouldReduceMotion();

  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [isWide, setIsWide] = useState(false);
  const [input, setInput] = useState("");

  const sendRef = useRef(demo.send);
  sendRef.current = demo.send;
  const autoplayedRef = useRef(false);

  // Monaco and the script both wait for the demo to be near the viewport, so
  // neither competes with the hero's paint.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    setIsWide(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setIsWide(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Autoplay is gated on three things, and the third is the one usually missed:
  // a scripted animation that starts on its own is exactly what
  // `prefers-reduced-motion` exists to prevent. Those visitors get a Play button.
  useEffect(() => {
    if (autoplayedRef.current || !inView || shouldReduceMotion || document.hidden) return;
    autoplayedRef.current = true;
    const timer = setTimeout(
      () => sendRef.current(DEMO_BEATS[0].chip, { fromAutoplay: true }),
      700
    );
    return () => clearTimeout(timer);
  }, [inView, shouldReduceMotion]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (demo.busy) return;
    demo.send(input);
    setInput("");
  };

  const showMonaco = inView && isWide;

  return (
    <div ref={rootRef} className="relative mx-auto w-full max-w-[1120px]">
      <div className="overflow-hidden rounded-[1.25rem] border border-line-strong bg-void-1 shadow-panel">
        <div className="flex h-11 items-center gap-3 border-b border-line-strong bg-void-2 px-4">
          <MonoLabel className="hidden sm:inline">voidcode</MonoLabel>
          <span className="mx-auto truncate text-xs text-ink-2">
            Scaled Dot-Product Attention
          </span>
          {demo.hasPlayed ? (
            <button
              type="button"
              onClick={demo.replay}
              className="hidden shrink-0 rounded-full border border-line-strong px-2.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink sm:inline"
            >
              Replay
            </button>
          ) : (
            <span className="hidden shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-3 sm:inline">
              Preview
            </span>
          )}
        </div>

        <div className="grid lg:grid-cols-[248px_minmax(0,1fr)_336px]">
          <DemoProblemPanel />

          <div className="flex min-w-0 flex-col bg-editor-bg">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-line-strong bg-[#262626] px-3">
              <span className="text-xs font-medium text-ink">Code</span>
              {/* These mirror the real workspace toolbar, which now uses the
                  same `Pill` primitive. They used to be the workspace's
                  pre-rendered `ic-run-code.svg` / `ic-submit-code.svg` artwork
                  under a `grayscale` filter, because `ic-submit-code.svg` bakes
                  the app's green into the paths and that is the one colour this
                  page cannot show. The app no longer ships those images, so the
                  filter hack goes with them — and the demo is once again a
                  picture of the real thing rather than of its predecessor. */}
              <div className="flex items-center gap-2">
                <Pill variant="ghost" size="sm" onClick={demo.run} title="Run code">
                  Run
                </Pill>
                <Pill variant="outline" size="sm" disabled title="Submit — available after sign in">
                  Submit
                </Pill>
              </div>
            </div>

            <div className="flex h-8 shrink-0 items-center border-b border-line-strong bg-[#262626] px-3">
              <MonoLabel className="text-ink-2">{DEMO_LANGUAGE}</MonoLabel>
            </div>

            <div className="h-[19rem] min-w-0 shrink-0">
              {showMonaco ? (
                <DemoEditor value={demo.code} onChange={demo.setCode} />
              ) : (
                <div className="h-full overflow-auto">
                  <CodeStatic code={demo.code} />
                </div>
              )}
            </div>

            <DemoConsole state={demo.consoleState} />
          </div>

          <DemoTutorPanel
            mode={demo.mode}
            messages={demo.messages}
            streamingId={demo.streamingId}
            chips={demo.chips}
            onChip={(chip) => demo.send(chip)}
            disabled={demo.busy}
            footer={
              shouldReduceMotion && !demo.hasPlayed ? (
                <button
                  type="button"
                  onClick={() => demo.send(DEMO_BEATS[0].chip)}
                  className="h-9 w-full rounded-lg border border-line-strong bg-void-2 text-xs text-ink transition-colors hover:border-ink-3"
                >
                  Play the demo
                </button>
              ) : (
                <form onSubmit={submit} className="flex items-center gap-2">
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    disabled={demo.busy}
                    placeholder="Ask Anything..."
                    aria-label="Ask the tutor"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-void-2 px-3 text-xs text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={demo.busy || !input.trim()}
                    className="h-9 shrink-0 rounded-lg border border-line-strong px-3 text-xs text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-40"
                  >
                    Ask
                  </button>
                </form>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}
