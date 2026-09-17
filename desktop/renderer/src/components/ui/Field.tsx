"use client";

// Ported from the website's `components/ui/Field.tsx` when sign-in moved into the desktop app. The website is
// being removed, so this is now the only copy.
import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled text input. The first real form primitive in this codebase.
 *
 * WHY THE FOCUS AFFORDANCE IS A BORDER, NOT A RING
 *
 * Every input in this codebase signals focus by changing its border colour, and
 * every *button* signals it with a ring. That split is worth keeping: an input
 * is a box you type into, so brightening its edge reads as "this box is live",
 * whereas a ring around a box that already has an edge reads as a double
 * outline. Buttons have no natural edge, so the ring is doing real work there.
 *
 * WHY `htmlFor` MATTERS HERE SPECIFICALLY
 *
 * Not one `<label>` in this codebase is associated with its input — they are all
 * visually adjacent and programmatically unrelated. That means a screen reader
 * announces "edit text, blank" with no indication of what the field is for, and
 * clicking the label does not focus the input. `useId()` fixes both for every
 * consumer at once, which is most of the reason this primitive exists rather
 * than each form hand-rolling its markup.
 */
export function Field({
  label,
  error,
  hint,
  className,
  id: providedId,
  trailing,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: ReactNode;
  /** Rendered inside the field box, right-aligned — e.g. a reveal toggle. */
  trailing?: ReactNode;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  // `aria-describedby` must point ONLY at nodes that exist. Naming an absent id
  // makes some screen readers announce nothing at all rather than skipping it.
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-xs font-medium tracking-wide text-ink-2">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            "h-11 w-full rounded-xl border bg-void-2 px-3.5 text-sm text-ink",
            "placeholder:text-ink-3 transition-colors duration-150",
            "focus:outline-none",
            // Autofill. Chrome paints its own pale-yellow background and near-black
            // text, which on this page looks like a rendering bug. There is no
            // property to disable it — the standard workaround is an inset shadow
            // large enough to cover the box, plus a text-fill colour, held through
            // the transition so it does not flash on focus.
            "[&:-webkit-autofill]:[-webkit-text-fill-color:var(--color-ink)]",
            "[&:-webkit-autofill]:[box-shadow:0_0_0_1000px_var(--color-void-2)_inset]",
            "[&:-webkit-autofill]:[transition:background-color_9999s_ease-in-out_0s]",
            trailing && "pr-11",
            error
              ? "border-ink-3 focus:border-ink"
              : "border-line-strong hover:border-ink-3/60 focus:border-ink-3",
            props.disabled && "cursor-not-allowed opacity-50"
          )}
          {...props}
        />
        {trailing && (
          <div className="absolute right-1 top-1/2 -translate-y-1/2">{trailing}</div>
        )}
      </div>

      {/*
        `role="alert"` so the message is announced when it appears. Without it a
        sighted user sees the error and a screen-reader user gets nothing — the
        field is simply marked invalid with no reason given.
      */}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-relaxed text-ink">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-ink-3">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A `Field` with a reveal toggle.
 *
 * The toggle is a real `<button type="button">`, not an icon with an onClick —
 * so it is reachable by keyboard and announces its state. `type="button"` is
 * load-bearing: the default inside a `<form>` is `submit`, so without it,
 * revealing your password submits the form.
 */
export function PasswordField({
  label,
  error,
  hint,
  autoComplete = "current-password",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  error?: string | null;
  hint?: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Field
      {...props}
      label={label}
      error={error}
      hint={hint}
      autoComplete={autoComplete}
      type={revealed ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          // The accessible name states the ACTION, not the state — "Show
          // password" tells the user what pressing it does. `aria-pressed`
          // carries the state.
          aria-label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          tabIndex={props.disabled ? -1 : 0}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg text-ink-3",
            "transition-colors hover:text-ink-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-void-2"
          )}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      }
    />
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M8.2 4.7A7.6 7.6 0 0 1 10 4.5c5.5 0 8.5 5.5 8.5 5.5a15.4 15.4 0 0 1-2.4 3.1M4.4 6A15.6 15.6 0 0 0 1.5 10S4.5 15.5 10 15.5c1.3 0 2.4-.3 3.4-.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="m3 3 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
