"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import WorkspaceClient from "@/components/Layout/WorkspaceClient";
import type { ExtraPanel } from "@/components/ProblemPanel/ProblemTabs";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import {
  fetchInterviewWorkspace,
  markSubmitted,
  revealStage,
  saveAttempt,
  type AnswerReveal,
} from "@/lib/api/interviews";
import type { ProblemDetail } from "@/lib/api/problems";

/**
 * An interview question, in the same IDE as the curriculum.
 *
 * This is a thin wrapper, deliberately. The editor, the console, the submit
 * pipeline, autosave and submission history are all `WorkspaceClient` doing
 * exactly what it does for Problems — the executable half of an interview
 * question *is* a problems row, so none of that needed a second implementation.
 *
 * What this adds is the three things that make it an interview rather than a
 * lesson:
 *
 *   1. A loader that fetches from `/v1/interviews/{slug}/workspace`, where the
 *      server withholds every expected output.
 *   2. Approach and Model answer as extra left-panel tabs, still gated behind
 *      `POST /reveal` so the disclosure is enforced server-side.
 *   3. The tutor locked until first submit, and a timer.
 */
export default function InterviewWorkspaceClient({ slug }: { slug: string }) {
  const { data: session } = useSession();
  const userId = (session?.user as { backendId?: string } | undefined)
    ?.backendId;

  const [approach, setApproach] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerReveal | null>(null);
  const [busy, setBusy] = useState<"approach" | "answer" | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Seconds accrued before this visit, so the timer resumes rather than
  // restarting. Read once from the workspace payload.
  const baseline = useRef(0);
  const startedAt = useRef<number | null>(null);

  /**
   * Stable across renders, because `WorkspaceClient` has it in an effect's
   * dependency array. An inline arrow would give a new identity every render
   * and refetch the question in a loop.
   */
  const loadQuestion = useCallback(
    async (s: string): Promise<ProblemDetail> => {
      const workspace = await fetchInterviewWorkspace(s, userId);
      baseline.current = workspace.elapsedSeconds;
      startedAt.current = Date.now();
      setElapsed(workspace.elapsedSeconds);
      setHasSubmitted(Boolean(workspace.submittedAt));
      return workspace.detail;
    },
    [userId]
  );

  // Tick the clock. Only while unsubmitted — once you have answered, the number
  // is a record of how long it took, not a stopwatch that keeps running.
  useEffect(() => {
    if (hasSubmitted || startedAt.current === null) return;
    const id = setInterval(() => {
      setElapsed(
        baseline.current + Math.floor((Date.now() - startedAt.current!) / 1000)
      );
    }, 1000);
    return () => clearInterval(id);
  }, [hasSubmitted]);

  // Persist on unmount. Without this, closing the tab loses the session's time
  // entirely — the server only knows what it was last told.
  const persist = useCallback(() => {
    if (startedAt.current === null) return;
    const total =
      baseline.current + Math.floor((Date.now() - startedAt.current) / 1000);
    void saveAttempt(slug, { elapsedSeconds: total }, userId).catch(() => {
      // Best-effort. A lost timer reading is not worth an error dialog.
    });
  }, [slug, userId]);

  useEffect(() => persist, [persist]);

  const onSubmitted = useCallback(() => {
    setHasSubmitted(true);
    persist();
    // Server-side record. It re-checks that a submission row actually exists,
    // so this is a notification rather than the source of truth.
    void markSubmitted(slug, userId).catch((err) =>
      console.error("Failed to record submission:", err)
    );
  }, [persist, slug, userId]);

  const reveal = async (stage: "approach" | "answer") => {
    setBusy(stage);
    try {
      if (stage === "approach") {
        setApproach((await revealStage(slug, "approach", userId)).approach);
      } else {
        setAnswer(await revealStage(slug, "answer", userId));
      }
    } catch (err) {
      console.error("Reveal failed:", err);
    } finally {
      setBusy(null);
    }
  };

  const extraPanels: ExtraPanel[] = useMemo(
    () => [
      {
        value: "approach",
        label: "Approach",
        content: (
          <RevealPane
            hint="The shape of a good answer, without the answer."
            cta="Reveal approach"
            busy={busy === "approach"}
            revealed={approach !== null}
            onReveal={() => reveal("approach")}
          >
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-2">
              {approach}
            </p>
          </RevealPane>
        ),
      },
      {
        value: "answer",
        label: "Model answer",
        content: (
          <RevealPane
            hint="What a strong candidate says, and the red flags that sink it."
            cta="Reveal model answer"
            busy={busy === "answer"}
            revealed={answer !== null}
            onReveal={() => reveal("answer")}
          >
            <div className="space-y-5">
              <div className="space-y-3 text-sm leading-relaxed text-ink-2">
                {answer?.modelAnswer.split("\n\n").map((para, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {para}
                  </p>
                ))}
              </div>
              <Section title="Follow-ups" items={answer?.followUps ?? []} />
              <Section title="Red flags" items={answer?.redFlags ?? []} />
            </div>
          </RevealPane>
        ),
      },
    ],
    // `reveal` is recreated each render but only reads state it already closes
    // over; including it would rebuild the panels every tick of the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approach, answer, busy]
  );

  return (
    <>
      <WorkspaceClient
        problemSlug={slug}
        currentProblem={1}
        totalProblems={1}
        basePath="/interviews"
        loadQuestion={loadQuestion}
        extraPanels={extraPanels}
        isTutorLocked={!hasSubmitted}
        onSubmitted={onSubmitted}
      />
      <Timer seconds={elapsed} stopped={hasSubmitted} />
    </>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/**
 * Fixed to the viewport rather than placed in the nav.
 *
 * The nav is shared with the curriculum, and adding a timer to it would mean a
 * conditional in a component that four other routes render. This costs one
 * element and touches nothing else.
 */
function Timer({ seconds, stopped }: { seconds: number; stopped: boolean }) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2",
        "rounded-full border border-line bg-void-0/90 px-3 py-1.5",
        "font-mono text-[11px] tabular-nums backdrop-blur",
        stopped ? "text-ink-3" : "text-ink-2"
      )}
    >
      <span className="sr-only">{stopped ? "Final time" : "Elapsed"}: </span>
      {mm}:{ss}
      {stopped && <span className="ml-2 text-ink-3">submitted</span>}
    </div>
  );
}

function RevealPane({
  hint,
  cta,
  busy,
  revealed,
  onReveal,
  children,
}: {
  hint: string;
  cta: string;
  busy: boolean;
  revealed: boolean;
  onReveal: () => void;
  children: React.ReactNode;
}) {
  if (!revealed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-[36ch] text-xs leading-relaxed text-ink-3">{hint}</p>
        <Pill variant="outline" size="sm" onClick={onReveal} disabled={busy}>
          {busy ? "Loading…" : cta}
        </Pill>
      </div>
    );
  }
  return <div className="p-4">{children}</div>;
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
        {title}
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2.5 text-xs leading-relaxed text-ink-2"
          >
            <span
              aria-hidden
              className="mt-[6px] h-1 w-1 flex-shrink-0 rounded-full bg-ink-3"
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
