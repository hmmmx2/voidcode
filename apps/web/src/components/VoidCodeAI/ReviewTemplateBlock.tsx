"use client";

import { useState } from "react";
import type { ReviewTemplate } from "./VoidCodeAIPanel";

interface ReviewTemplateBlockProps {
  template: ReviewTemplate;
}

export default function ReviewTemplateBlock({
  template,
}: ReviewTemplateBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const modeLabel =
    template.allPassed
      ? "CONGRATULATION"
      : template.mode;

  const modeColor = template.allPassed
    ? "text-ink"
    : template.mode === "DEBUG"
      ? "text-ink-2"
      : template.mode === "TEACHING"
        ? "text-ink-2"
        : template.mode === "EXPLAIN"
          ? "text-ink-2"
          : "text-ink-2";

  const statusColor = template.allPassed
    ? "border-line-strong bg-void-3"
    : "border-line bg-void-2";

  return (
    <div
      className={`rounded-lg border ${statusColor} overflow-hidden text-xs`}
    >
      {/* Header — always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="flex-shrink-0"
          >
            <rect
              x="1"
              y="1"
              width="10"
              height="10"
              rx="2"
              stroke="currentColor"
              strokeWidth="1"
            />
            <path d="M3 4H9M3 6H9M3 8H7" stroke="currentColor" strokeWidth="0.8" />
          </svg>
          <span className="text-ink-2 font-medium">
            Code Review Context
          </span>
          <span className={`font-mono ${modeColor}`}>
            [{modeLabel}]
          </span>
          <span className="text-ink-3">
            {template.passFail}
          </span>
        </div>
        <svg
          width="10"
          height="7"
          viewBox="0 0 10 7"
          fill="none"
          className={`transition-transform duration-200 ${
            isExpanded ? "rotate-180" : ""
          }`}
        >
          <path
            d="M1 1L5 5L9 1"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-line/50 px-3 py-2 space-y-3">
          {/* Problem */}
          <div>
            <p className="text-ink-3 font-medium mb-0.5">
              Problem Description
            </p>
            <p className="text-ink-2 whitespace-pre-wrap leading-relaxed">
              {template.problemDescription}
            </p>
          </div>

          {/* Source code */}
          <div>
            <p className="text-ink-3 font-medium mb-0.5">
              Source Code ({template.language})
            </p>
            <pre className="bg-ide-code/80 rounded p-2 text-ink-2 font-mono overflow-x-auto text-[10px] leading-4">
              {template.sourceCodeWithLines}
            </pre>
          </div>

          {/* Test case details */}
          <div>
            <p className="text-ink-3 font-medium mb-0.5">
              Test Case Results
            </p>
            <pre className="bg-ide-code/80 rounded p-2 text-ink-2 font-mono overflow-x-auto text-[10px] leading-4 whitespace-pre-wrap">
              {template.testCaseDetails}
            </pre>
          </div>

          {/* Execution output */}
          {template.executionOutput !== "No errors" && (
            <div>
              <p className="text-ink-3 font-medium mb-0.5">
                Execution Output
              </p>
              <pre className="bg-ide-code/80 rounded p-2 text-ink-2 font-mono overflow-x-auto text-[10px] leading-4 whitespace-pre-wrap">
                {template.executionOutput}
              </pre>
            </div>
          )}

          {/* Mode reasoning */}
          <div>
            <p className="text-ink-3 font-medium mb-0.5">
              Mode Detection
            </p>
            <p className="text-ink-2 italic">
              {template.modeReasoning}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
