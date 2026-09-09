"use client";

import type { PlanDoc } from "@shared/plan";
import { planProgress } from "@shared/plan";

/**
 * A plan, drawn as a plan.
 *
 * Before this, a plan was a paragraph. `plan` mode has always been a tool-restriction profile
 * that asked, in prose, for "what you would change, in which files, in what order" — and what
 * came back arrived as an `AgentStep` of kind `thought`, indistinguishable in the transcript
 * from any other paragraph the model wrote. You could read it; nothing could count it, check it
 * off, or show you where the run had got to.
 *
 * So the value of this component is not decoration. It is that the steps are *addressable* —
 * the same document the right pane will render, and the same one that survives a reload,
 * because it came out of a tool call validated against a schema rather than out of prose that
 * happened to be formatted as a list.
 *
 * Deliberately not interactive. Nothing here toggles a step: status is written by the run, and
 * a checkbox a person can tick would make this a to-do list that disagrees with what the agent
 * actually did. It reports.
 */
export default function PlanCard({ plan }: { plan: PlanDoc }) {
  const { done, total } = planProgress(plan);

  return (
    <section className="max-w-[80ch] rounded-md border border-line bg-ide-raised/40 p-3">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-ink">{plan.title}</h3>
        {/*
          The count is `aria-label`led as a sentence because "2/5" read aloud is "two slash
          five". The digits stay visible — they are scannable in a way the sentence is not.
        */}
        <span
          className="shrink-0 font-mono text-[10px] tracking-wide text-ink-3"
          aria-label={`${String(done)} of ${String(total)} steps done`}
        >
          {done}/{total}
        </span>
      </header>

      <ol className="flex flex-col gap-1.5">
        {plan.steps.map((step, index) => (
          // Index as key: a plan is replaced wholesale by a new `write_plan` call, never
          // reordered in place, so there is no identity here for React to preserve.
          <li key={index} className="flex gap-2">
            <StepMark status={step.status} />
            <div className="min-w-0 flex-1">
              <p
                className={
                  step.status === "done"
                    ? "text-xs text-ink-3 line-through decoration-ink-3/40"
                    : step.status === "active"
                      ? "text-xs text-ink"
                      : "text-xs text-ink-2"
                }
              >
                {step.title}
              </p>
              {step.detail !== undefined && (
                <p className="mt-0.5 text-xs text-ink-3">{step.detail}</p>
              )}
              {step.files !== undefined && step.files.length > 0 && (
                /*
                  Paths are what a reader checks first — "is it going to touch the thing I care
                  about?" — so they are listed rather than summarised as a count. Monospace
                  because they are paths, and wrapping because a deep path in a narrow pane
                  would otherwise force the whole transcript to scroll sideways.
                */
                <p className="mt-0.5 break-all font-mono text-[10px] text-ink-3">
                  {step.files.join("  ")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The status glyph, which is the only thing carrying state here — so it is not colour alone.
 *
 * A filled dot, a ring and an empty circle differ in shape as well as in tone, and each carries
 * its own text for a screen reader. Three shades of the same dot would be invisible to anyone
 * who cannot tell them apart, which for a progress indicator is the whole message.
 */
function StepMark({ status }: { status: PlanDoc["steps"][number]["status"] }) {
  const label = status === "done" ? "done" : status === "active" ? "in progress" : "not started";

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center"
    >
      {status === "done" ? (
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-diff-add-ink" aria-hidden>
          <path
            d="M2.5 6.5 L5 9 L9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : status === "active" ? (
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-ink" aria-hidden>
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="6" cy="6" r="1.8" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-ink-3" aria-hidden>
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </span>
  );
}
