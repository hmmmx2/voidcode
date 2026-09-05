import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Test-case pass/fail — the ONE place in this product that keeps colour.
 *
 * Everything else went monochrome. This survived because a failing test is the
 * one state a learner scans for dozens of times an hour, under time pressure,
 * in a dense console where position alone does not distinguish it. That is
 * information, not decoration.
 *
 * THE COMPONENT IS BUILT SO THE COLOUR CANNOT LEAK.
 *
 * `--color-verdict-pass` / `-fail` are named for this one consumer rather than
 * `success`/`error`, because a role name that broad is an open invitation to a
 * second caller and then a third — which is exactly how the app acquired five
 * competing accents. Any file other than `Editor/TestConsole.tsx` matching
 * `verdict-` is a regression, and that is greppable.
 *
 * COLOUR IS NEVER THE SOLE CARRIER.
 *
 * `Verdict` always renders an icon *and* a word. Where the visible label is only
 * a case number, it emits a visually-hidden "Passed"/"Failed" so the state is
 * still in the accessible name. Red and green are the single worst pair to
 * distinguish for the ~8% of men with a colour vision deficiency, and this is
 * also the state most worth getting right.
 */

/**
 * The tick / cross.
 *
 * COLOURLESS BY CONSTRUCTION — `stroke="currentColor"`, inheriting whatever
 * text colour its parent sets. That is the whole design of this file, and it is
 * a fix rather than a preference: these were `<Image src="/icons/ic-check-circle.svg">`
 * with `#657B3C` and `#BE280E` baked into the file — a fourth green/red pair
 * that no token, utility or cascade could reach, because an `<img>` is opaque
 * to CSS. Inline SVG is the only way the token controls the icon.
 *
 * `aria-hidden` because the sibling text is the accessible name; announcing
 * both would read "tick passed".
 */
export function VerdictIcon({
  passed,
  className,
}: {
  passed: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-4 w-4 flex-shrink-0", className)}
    >
      <circle cx="8" cy="8" r="6.25" />
      {passed ? (
        <path d="M5.4 8.2 7.2 10l3.4-3.6" />
      ) : (
        <path d="M6 6l4 4M10 6l-4 4" />
      )}
    </svg>
  );
}

/**
 * Icon plus label. `children` is the visible text; when omitted — or when the
 * visible text is only a case number — the state still reaches assistive tech
 * through the `sr-only` word.
 */
export function Verdict({
  passed,
  children,
  className,
}: {
  passed: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        passed ? "text-verdict-pass" : "text-verdict-fail",
        className
      )}
    >
      <VerdictIcon passed={passed} />
      {children ?? null}
      <span className="sr-only">{passed ? "Passed" : "Failed"}</span>
    </span>
  );
}
