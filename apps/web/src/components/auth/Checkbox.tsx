"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A checkbox with a real label association.
 *
 * The native input is kept and visually hidden rather than replaced with a
 * `<div role="checkbox">`. Keeping it means space-to-toggle, form
 * participation, `:checked`, and screen-reader semantics all work without
 * being reimplemented — the custom box is drawn by a sibling that reacts to
 * `peer-checked`.
 *
 * `sr-only` rather than `hidden` or `opacity-0` with `pointer-events-none`:
 * `display:none` removes it from the accessibility tree AND from keyboard
 * focus order, which is exactly the bug this pattern usually ships with.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  error,
  disabled,
  id: providedId,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | null;
  disabled?: boolean;
  id?: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="peer sr-only"
        />
        <label
          htmlFor={id}
          aria-hidden
          className={cn(
            "mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 cursor-pointer items-center justify-center",
            "rounded-[5px] border transition-colors duration-150",
            "peer-checked:border-ink peer-checked:bg-ink",
            // The focus ring goes on this box, driven by the hidden input's
            // focus — otherwise keyboard users get no visible focus at all.
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ink",
            "peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-void-0",
            error ? "border-ink-3" : "border-line-strong hover:border-ink-3",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            className={cn("transition-opacity", checked ? "opacity-100" : "opacity-0")}
          >
            <path
              d="M2.5 6.2 4.8 8.5 9.5 3.5"
              stroke="var(--color-void-0)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </label>

        <label htmlFor={id} className="cursor-pointer text-xs leading-relaxed text-ink-2">
          {label}
        </label>
      </div>

      {error && (
        <p id={errorId} role="alert" className="text-xs text-ink">
          {error}
        </p>
      )}
    </div>
  );
}
