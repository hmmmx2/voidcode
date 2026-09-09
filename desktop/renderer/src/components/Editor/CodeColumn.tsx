"use client";

import { COMMAND_ACCELERATORS } from "@shared/commands";
import { formatAccelerator } from "@/lib/shell/keybindings";
import { Pill } from "@/components/ui/Pill";
import MonacoWrapper from "./MonacoWrapper";
import { LANGUAGE_MAP } from "@/lib/constants";
import type { SaveStatus } from "@/lib/hooks/useAutosave";

interface CodeColumnProps {
  code: string;
  language: string;
  onCodeChange: (value: string) => void;
  onLanguageChange: (language: string) => void;
  onRun: () => void;
  onSubmit: () => void;
  onReset: () => void;
  onExpand: () => void;
  isRunning: boolean;
  isSubmitting: boolean;
  isExpanded: boolean;
  saveStatus?: SaveStatus;
  /**
   * Languages this problem actually ships a template and driver for.
   *
   * THE DROPDOWN USED TO BE `Object.keys(LANGUAGE_MAP)` — Python, JavaScript,
   * C++ and Java on every problem regardless of what existed. Choosing one
   * without a template loaded an empty editor and a submission that could not
   * be graded, because the driver that wraps the solution simply was not there.
   * Offering fewer, working options beats offering four where three are broken.
   */
  availableLanguages?: string[];
}

export default function CodeColumn({
  code,
  language,
  onCodeChange,
  onLanguageChange,
  onRun,
  onSubmit,
  onReset,
  onExpand,
  isRunning,
  isSubmitting,
  isExpanded,
  saveStatus = "idle",
  availableLanguages,
}: CodeColumnProps) {
  // Keep only what `LANGUAGE_MAP` can actually map to a Judge0 id and a Monaco
  // mode; fall back to the currently selected language so the select is never
  // empty while a problem is still loading.
  const languages = (availableLanguages ?? []).filter((l) => l in LANGUAGE_MAP);
  const options = languages.length > 0 ? languages : [language];
  const isExecuting = isRunning || isSubmitting;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-ide-panel">
      {/* Row 1 — Tab navbar: "Code" label (left) + Bug/Run/Submit (right) — bg #262626 */}
      <div className="h-9 flex-shrink-0 flex items-center justify-between px-3 bg-ide-bar border-b border-line">
        <span className="text-xs font-medium text-ink">Code</span>
        <div className="flex items-center gap-2">
          {/* THESE ARE REAL BUTTONS NOW, NOT PICTURES OF BUTTONS.

              `ic-run-code.svg` and `ic-submit-code.svg` were pre-rendered
              pill graphics with the words "Run" and "Submit" as vector paths
              and `#3C7B46` baked into the Submit fill — so the primary action
              in the workspace was an image with an `alt` attribute. It could
              not change on hover, could not show a disabled state beyond a
              blanket opacity fade, did not scale with text size, and put a
              green nothing else on the page had at the busiest point of the
              interface. `Pill` gives all of that back for free. */}
          <Pill
            variant="ghost"
            size="sm"
            onClick={onRun}
            disabled={isExecuting}
            title={`Run code (${shortcut("run.execute")})`}
          >
            Run
          </Pill>

          <Pill
            variant="solid"
            size="sm"
            onClick={onSubmit}
            disabled={isExecuting}
            title={`Submit code (${shortcut("run.submit")})`}
          >
            Submit
          </Pill>
        </div>
      </div>

      {/* Row 2 — Toolkit: Language dropdown (left) + Reset/Expand (right) — bg #262626 */}
      <div className="h-8 flex-shrink-0 flex items-center justify-between px-3 bg-ide-bar border-b border-line">
        {/* Language dropdown — transparent bg, #FFFFFF text */}
        <div className="relative">
          <select
            value={language}
            onChange={(e) => onLanguageChange(e.target.value)}
            disabled={options.length < 2}
            title={options.length < 2 ? `${language} is the only language for this problem` : "Select language"}
            className="appearance-none rounded bg-transparent py-1 pl-2 pr-5 text-xs text-ink outline-none transition-colors hover:bg-ide-raised focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-default disabled:hover:bg-transparent"
            aria-label="Select language"
          >
            {options.map((lang) => (
              <option key={lang} value={lang} className="bg-ide-bar text-ink">
                {lang}
              </option>
            ))}
          </select>
          {/* Custom chevron overlay */}
          <svg
            width="8"
            height="5"
            viewBox="0 0 10 7"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none"
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div className="flex items-center gap-2">
          {/* Save status indicator */}
          {saveStatus === "saving" && (
            <span className="text-[10px] text-ink-3 animate-pulse">Saving...</span>
          )}
          {saveStatus === "saved" && (
            <span className="text-[10px] text-ink-3">Saved</span>
          )}
          {saveStatus === "error" && (
            <span className="text-[10px] text-ink-2">Save failed</span>
          )}

          {/* Reset */}
          <button
            onClick={onReset}
            className="p-1.5 rounded hover:bg-ide-raised transition-colors"
            title="Reset code to template"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M-0.000124323 6.03797L1.33318 6.02953C1.34946 8.60215 3.456 10.6829 6.02928 10.6666C8.60256 10.6503 10.6826 8.5431 10.6663 5.97048C10.6501 3.39786 8.54351 1.31715 5.97023 1.33343C4.73892 1.34122 3.58271 1.83854 2.72406 2.68733L4.31203 2.67728L4.32047 4.01059L0.653877 4.03379L0.630678 0.367193L1.96398 0.358757L1.97154 1.55273C3.05336 0.572537 4.46782 0.00957676 5.96179 0.000124323C9.26973 -0.0208052 11.9787 2.65344 11.9996 5.96204C12.0206 9.27065 9.34565 11.979 6.03772 11.9999C2.72978 12.0208 0.0208094 9.34657 -0.000124323 6.03797Z"
                fill="currentColor"
              />
            </svg>
          </button>

          {/* Expand / Collapse */}
          <button
            onClick={onExpand}
            className="p-1.5 rounded hover:bg-ide-raised transition-colors"
            title={isExpanded ? "Exit fullscreen" : "Fullscreen"}
          >
            {isExpanded ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M5.08333 8.41667L0.75 12.75M5.08333 8.41667V12.4167M5.08333 8.41667H1.08333M8.41667 5.08333L12.75 0.75M8.41667 5.08333V1.08333M8.41667 5.08333H12.4167"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M8.41667 5.08333L12.75 0.75M12.75 0.75H8.75M12.75 0.75V4.75M0.75 12.75L5.08333 8.41667M0.75 12.75V8.75M0.75 12.75H4.75"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Monaco Editor — bg #212121 */}
      <div className="flex-1 min-h-0">
        <MonacoWrapper
          language={LANGUAGE_MAP[language]?.monacoId ?? "python"}
          value={code}
          onChange={(val) => onCodeChange(val ?? "")}
        />
      </div>
    </div>
  );
}

/**
 * The shortcut as the user's platform spells it.
 *
 * Read from the command table rather than written here. These two tooltips said "Ctrl+Enter"
 * and "Ctrl+Shift+Enter" for months while neither key did anything — the menu registered no
 * accelerators on Windows and nothing else was listening. A label copied from a table cannot
 * drift from it.
 */
function shortcut(id: "run.execute" | "run.submit"): string {
  const accelerator = COMMAND_ACCELERATORS[id];
  if (accelerator === null) return "";
  const isMac = typeof window !== "undefined" && /Mac/i.test(window.navigator.userAgent);
  return formatAccelerator(accelerator, isMac);
}
