"use client";

import { useState } from "react";
import type { Problem } from "@/lib/mock-data";

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
      <div className="text-sm text-ink-2 leading-relaxed space-y-3">
        {problem.description.split("\n\n").map((paragraph, i) => (
          <p key={i} dangerouslySetInnerHTML={{
            __html: paragraph
              .replace(/\*\*(.*?)\*\*/g, '<strong class="text-ink font-semibold">$1</strong>')
          }} />
        ))}
      </div>

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
