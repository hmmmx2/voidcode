"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/markdown/Markdown";
import Link from "next/link";
import { Badge, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import {
  assessAnswer,
  revealStage,
  saveAttempt,
  type AnswerReveal,
  type InterviewQuestionDetail,
} from "@/lib/api/interviews";
import { Mark } from "@/components/brand/Mark";
import { CompanyMark } from "./CompanyMark";

/**
 * A question answered in prose rather than code, in two columns.
 *
 * WHY THIS EXISTS AT ALL. Not every interview question is a program. "Which
 * direction of the KL divergence, and why" is answered by explaining, and
 * forcing it into an editor with test cases would either trivialise it or
 * distort it. Previously these questions simply could not be opened, which was
 * the worst of both — a card that refused to respond and never said why.
 *
 * TWO COLUMNS, AND THE SPLIT IS THE DESIGN.
 *
 *   Left  — the question, and the box you answer in. Everything you need to
 *           form an answer, and nothing that gives it away.
 *   Right — the marking. Empty until you submit, then the tutor's verdict.
 *           Reveal panels live below it, still gated.
 *
 * The reason they are side by side rather than stacked: you re-read the
 * question while reading the feedback. Stacked, that is a scroll each way.
 *
 * THE MODEL ANSWER IS NEVER IN THIS COMPONENT. Marking happens server-side —
 * `assessAnswer` sends your text up and gets a verdict back. If the comparison
 * happened here, the reference would have to be in the page, and the staged
 * reveal below would be decoration.
 */

/**
 * The tutor is fine-tuned for Socratic teaching, not grading.
 *
 * Measured: asked for a strict `VERDICT: correct|partial|incorrect` line, it
 * ignores the format and coaches instead -- the feedback correctly identifies
 * the flaw, but there is no verdict token to parse. So `unknown` is the common
 * case, not the error case, and the label must not imply a grade was withheld.
 *
 * Fighting this with stricter prompting would be unreliable against a model
 * trained to behave this way. The feedback is the value; the badge is a bonus
 * when the model happens to volunteer one.
 */
const VERDICT_COPY: Record<string, { label: string; tone: "quiet" | "strong" }> = {
  correct: { label: "Reads as correct", tone: "strong" },
  partial: { label: "Partially there", tone: "quiet" },
  incorrect: { label: "Something is off", tone: "quiet" },
  unknown: { label: "The tutor's read", tone: "quiet" },
  too_short: { label: "Needs more", tone: "quiet" },
};

type Assessment = { verdict: string; feedback: string };

export default function WrittenWorkspace({
  question,
  userId,
}: {
  question: InterviewQuestionDetail;
  userId?: string;
}) {
  const [answer, setAnswer] = useState(question.notes ?? "");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saving" | "saved" | null>(null);

  const [approach, setApproach] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<AnswerReveal | null>(null);
  const [busy, setBusy] = useState<"approach" | "answer" | null>(null);

  // ── Autosave, debounced ──────────────────────────────────────
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(answer);
  latest.current = answer;

  const flush = useCallback(async () => {
    setSaved("saving");
    try {
      await saveAttempt(question.slug, { notes: latest.current }, userId);
      setSaved("saved");
    } catch {
      setSaved(null);
    }
  }, [question.slug, userId]);

  const onChange = (value: string) => {
    setAnswer(value);
    setSaved(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 900);
  };

  // Save whatever is pending if the page goes away mid-debounce.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    };
  }, [flush]);

  const mark = async () => {
    if (!answer.trim()) return;
    setMarking(true);
    setError(null);
    try {
      setAssessment(await assessAnswer(question.slug, answer, userId));
      void flush();
    } catch (err) {
      console.error("Assessment failed:", err);
      setError(
        "The tutor could not mark this right now. Your answer is saved — try again in a moment."
      );
    } finally {
      setMarking(false);
    }
  };

  const reveal = async (stage: "approach" | "answer") => {
    setBusy(stage);
    try {
      if (stage === "approach") {
        setApproach((await revealStage(question.slug, "approach", userId)).approach);
      } else {
        setRevealed(await revealStage(question.slug, "answer", userId));
      }
    } catch (err) {
      console.error("Reveal failed:", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-workspace px-6 py-8 lg:px-10">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="mb-7">
        <Link
          href="/interviews"
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
        >
          <span aria-hidden>&larr;</span> All questions
        </Link>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone="quiet">{question.domainLabel}</Badge>
          <Badge tone={question.difficulty === "hard" ? "strong" : "quiet"}>
            {question.difficulty}
          </Badge>
          <span className="ml-1 flex items-center gap-2 text-ink-3">
            {question.companies.map((c) => (
              <CompanyMark key={c} company={c} className="h-[15px] w-[15px]" />
            ))}
          </span>
        </div>

        <h1 className="mt-3 max-w-[30ch] text-[clamp(1.4rem,2.4vw,1.95rem)] font-light leading-[1.15] tracking-tight text-ink">
          {question.title}
        </h1>
      </header>

      {/* ── Two columns ──────────────────────────────────────────
          Stacks below `lg`. A 50/50 split rather than a sidebar: the
          feedback is prose of comparable length to the answer, so a narrow
          right rail would be a column of six-word lines. */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — question and your answer */}
        <div className="space-y-6">
          <Surface radius="panel" className="p-6">
            <SectionLabel n={1} label="The question" />
            <p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-ink">
              {question.prompt}
            </p>
          </Surface>

          <Surface radius="panel" className="p-6">
            <div className="flex items-baseline justify-between gap-4">
              <SectionLabel n={2} label="Your answer" />
              <span
                aria-live="polite"
                className="font-mono text-[10px] tabular-nums text-ink-3"
              >
                {saved === "saving" && "Saving…"}
                {saved === "saved" && "Saved"}
              </span>
            </div>
            <p className="mt-3 max-w-[56ch] text-xs leading-relaxed text-ink-3">
              Write it as you would say it out loud. Saved to your account.
            </p>
            <textarea
              value={answer}
              onChange={(e) => onChange(e.target.value)}
              onBlur={flush}
              rows={14}
              placeholder="Talk through it…"
              className={cn(
                "mt-4 w-full resize-y rounded-xl border border-line bg-void-2 p-4",
                "text-sm leading-relaxed text-ink placeholder:text-ink-3/60",
                "transition-colors duration-150 ease-void",
                "focus:border-line-strong focus:outline-none"
              )}
            />
            <div className="mt-4 flex items-center gap-3">
              <Pill
                variant="solid"
                size="md"
                onClick={mark}
                disabled={marking || !answer.trim()}
              >
                {marking ? "Marking…" : "Check my answer"}
              </Pill>
              <span className="text-[11px] text-ink-3">
                Read against the reference, which stays hidden.
              </span>
            </div>
          </Surface>
        </div>

        {/* Right — the marking, then the gated reveals */}
        <div className="space-y-6">
          <Surface
            radius="panel"
            className={cn(
              "overflow-hidden p-0",
              // A hairline in the accent of the tutor's own mark, so the panel
              // reads as "something answered you" rather than as another
              // section of the page. Everything else here is a plain Surface.
              assessment && "ring-1 ring-inset ring-white/[0.07]"
            )}
          >
            {/* Tutor identity bar. Without it the feedback was an unattributed
                wall of text — the single biggest reason the panel did not read
                as an AI response. Mirrors the IDE's tutor panel header so the
                same thing looks the same in both places. */}
            <div className="flex items-center gap-2.5 border-b border-line bg-ide-bar px-5 py-3">
              <Mark className="h-4 w-4 text-ink-2" />
              <span className="text-xs font-medium text-ink">VoidCode AI</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
                Review
              </span>
            </div>

            <div className="p-6">
              {!assessment && !marking && !error && (
                <p className="max-w-[46ch] text-sm leading-relaxed text-ink-3">
                  Write an answer on the left and press{" "}
                  <span className="text-ink-2">Check my answer</span>. The tutor
                  reads it against the reference and tells you what is missing
                  or wrong &mdash; without showing you the reference itself.
                </p>
              )}

              {marking && (
                <div aria-live="polite" className="space-y-2.5">
                  <p className="text-sm text-ink-2">Reading your answer…</p>
                  <div className="space-y-2 motion-reduce:animate-none">
                    <div className="h-2 w-4/5 animate-pulse rounded bg-void-3" />
                    <div className="h-2 w-full animate-pulse rounded bg-void-3" />
                    <div className="h-2 w-2/3 animate-pulse rounded bg-void-3" />
                  </div>
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm leading-relaxed text-ink-2">
                  {error}
                </p>
              )}

              {assessment && (
                <div className="space-y-4">
                  <Badge tone={VERDICT_COPY[assessment.verdict]?.tone ?? "quiet"}>
                    {VERDICT_COPY[assessment.verdict]?.label ?? "Reviewed"}
                  </Badge>
                  <Feedback text={assessment.feedback} />
                  <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-ink-3/80">
                    A model wrote this, so read it as a second opinion rather
                    than a mark. Reveal the reference below and judge for
                    yourself &mdash; that is still the honest signal.
                  </p>
                </div>
              )}
            </div>
          </Surface>

          <RevealPanel
            n={4}
            label="How to approach it"
            hint="The shape of a good answer, without the answer."
            cta="Reveal approach"
            busy={busy === "approach"}
            revealed={approach !== null}
            onReveal={() => reveal("approach")}
          >
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-2">
              {approach}
            </p>
          </RevealPanel>

          <RevealPanel
            n={5}
            label="Reference answer"
            hint="What a strong candidate says, and the red flags that sink it."
            cta="Reveal reference answer"
            busy={busy === "answer"}
            revealed={revealed !== null}
            onReveal={() => reveal("answer")}
          >
            <div className="space-y-5">
              <div className="space-y-3 text-sm leading-relaxed text-ink-2">
                {revealed?.modelAnswer.split("\n\n").map((para, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {para}
                  </p>
                ))}
              </div>
              <Bullets title="Follow-ups" items={revealed?.followUps ?? []} />
              <Bullets title="Red flags" items={revealed?.redFlags ?? []} />
            </div>
          </RevealPanel>
        </div>
      </div>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/**
 * The tutor's reply.
 *
 * Was a hand-rolled subset of markdown -- bold, inline code, fenced blocks -- whose docstring
 * said plainly: *"If the tutor ever emits tables or images, replace this."* It emits tables. The
 * shared renderer covers them, plus headings, lists, links and syntax-highlighted code, and it
 * still pulls in no markdown dependency, which was the other half of that reasoning.
 *
 * This copy was never the unsafe one -- it built React elements. `ChatMessage`'s copy of the
 * same idea did not, which is the argument for having one of these rather than four.
 */
function Feedback({ text }: { text: string }) {
  return <Markdown source={text} className="text-sm text-ink-2" />;
}


function SectionLabel({ n, label }: { n: number; label: string }) {
  return (
    <p className="flex items-baseline gap-2.5">
      <span className="font-mono text-[10px] tabular-nums text-ink-3">
        {String(n).padStart(2, "0")}
      </span>
      <span className="text-xs font-medium uppercase tracking-[0.16em] text-ink-3">
        {label}
      </span>
    </p>
  );
}

function RevealPanel({
  n,
  label,
  hint,
  cta,
  busy,
  revealed,
  onReveal,
  children,
}: {
  n: number;
  label: string;
  hint: string;
  cta: string;
  busy: boolean;
  revealed: boolean;
  onReveal: () => void;
  children: React.ReactNode;
}) {
  return (
    <Surface radius="panel" className="p-6">
      <SectionLabel n={n} label={label} />
      {!revealed ? (
        <>
          <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-ink-3">
            {hint}
          </p>
          <Pill
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={onReveal}
            disabled={busy}
          >
            {busy ? "Loading…" : cta}
          </Pill>
        </>
      ) : (
        <div className="mt-4">{children}</div>
      )}
    </Surface>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
        {title}
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-xs leading-relaxed text-ink-2">
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
