"use client";

import { useState } from "react";
import Markdown from "@/components/markdown/Markdown";
import type { Problem } from "@/lib/mock-data";
import ShapeRail from "./ShapeRail";
import { Math } from "@/components/app";

interface ProblemDescriptionProps {
  problem: Problem;
}

export default function ProblemDescription({ problem }: ProblemDescriptionProps) {
  const [hintsOpen, setHintsOpen] = useState(false);

  // NOTE: `problem.difficulty` is fetched and then discarded. There was a
  // `difficultyColor` here mapping Easy/Medium/Hard onto green/yellow/red, but
  // nothing ever rendered it — the variable was assigned and never read, which
  // is how its styling drifted outside the design system unnoticed. Removed
  // rather than restyled. Surfacing difficulty would be worth doing, but it is
  // a new feature rather than part of this restyle; `Badge` is ready for it.

  return (
    <div className="p-4 space-y-5">
      {/* Title */}
      <div>
        <h2 className="text-lg font-semibold text-ink">
          Question {problem.orderIndex}: {problem.title}
        </h2>
      </div>

      {/* Description */}
      {/*
        A fifth hand-rolled markdown renderer, replaced by the shared one.

        This copy was the least dangerous — problem descriptions are authored curriculum, not
        model output — but it is the same construction: build an HTML string, inject it, never
        escape `<`. Leaving one behind after removing the others keeps the pattern in the
        codebase for the next person to copy, which is how it reached `ChatMessage.tsx`.
      */}
      <Markdown source={problem.description} className="text-sm text-ink-2" />

      {/* The definition, above the shapes and the examples.
          The reading order is the order the ideas depend on each other: what this computes,
          then what it arrives and leaves as, then concrete values. */}
      {problem.math !== undefined && (
        <section aria-label="Definition" className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
            Definition
          </h3>
          {/* `overflow-x-auto` on its own container, not on the panel. This column is narrow
              and a real equation is wider than it — softmax's numerator and denominator both
              carry a subtracted max — so without this the right-hand side is simply cut off,
              which is worse than a scrollbar because nothing indicates there is more. */}
          <div className="overflow-x-auto rounded-lg border border-line bg-void-2 px-4 py-4">
            <Math latex={problem.math} />
          </div>
          {/* The thing the competitor gets wrong: their equations serialise MathML and HTML
              together, so copying one yields every symbol three times. */}
          <p className="text-[11px] text-ink-3">Copying this gives you the LaTeX source.</p>
        </section>
      )}

      {/* Shapes sit between the prose and the examples deliberately: the statement says what
          to compute, the rail says what it arrives and leaves as, and only then do concrete
          values make sense. */}
      {problem.shapes !== undefined && <ShapeRail shapes={problem.shapes} />}

      {/* Examples */}
      <div className="space-y-4">
        {problem.examples.map((example, i) => (
          <div key={i} className="space-y-1">
            <p className="text-sm font-semibold text-ink">Example {i + 1}:</p>
            <div className="text-sm text-ink-2 space-y-0.5">
              <p>
                <span className="font-semibold text-ink">Input:</span>{" "}
                {example.input}
              </p>
              <p>
                <span className="font-semibold text-ink">Output:</span>{" "}
                {example.output}
              </p>
              {example.explanation && (
                <p>
                  <span className="font-semibold text-ink">Explanation:</span>{" "}
                  {example.explanation}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Constraints */}
      <div>
        <p className="text-sm font-semibold text-ink mb-2">Constraints:</p>
        <ul className="list-disc list-inside text-sm text-ink-2 space-y-1">
          {problem.constraints.map((constraint, i) => (
            <li key={i}>{constraint}</li>
          ))}
        </ul>
      </div>

      {/* Hints Accordion */}
      <div className="rounded-lg overflow-hidden">
        <button
          onClick={() => setHintsOpen(!hintsOpen)}
          className="w-full flex items-center justify-between bg-ide-raised px-4 py-2.5 text-sm font-medium text-ink hover:bg-line-strong transition-colors rounded-lg"
        >
          <span>Hints</span>
          <svg
            width="10"
            height="7"
            viewBox="0 0 10 7"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={`transition-transform duration-200 ${hintsOpen ? "rotate-180" : ""}`}
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {hintsOpen && (
          <div className="px-4 py-3 space-y-2 bg-void-3 rounded-b-lg">
            {problem.hints.map((hint, i) => (
              <p key={i} className="text-sm text-ink-2">
                <span className="text-ink-2 font-medium">Hint {i + 1}:</span>{" "}
                {hint}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
