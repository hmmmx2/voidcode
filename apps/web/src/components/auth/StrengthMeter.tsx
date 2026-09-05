"use client";

import { estimateStrength } from "@/lib/validation/auth";
import { cn } from "@/lib/utils";

/**
 * Four segments that fill as the password gets stronger.
 *
 * MONOCHROME, so strength is carried by how many segments are lit and by the
 * word beside them — never by colour alone. The usual red/amber/green meter
 * fails for the ~8% of men with a colour vision deficiency, and it would be the
 * loudest thing on an otherwise black-and-white page.
 *
 * `aria-hidden` on the bars with the label in a live region: a screen reader
 * gets "Password strength: Good" rather than four anonymous divs. `polite`
 * rather than `assertive` so it does not interrupt typing.
 */
export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = estimateStrength(password);

  return (
    <div className="mt-3">
      <div aria-hidden className="flex gap-1.5">
        {[1, 2, 3, 4].map((segment) => (
          <div
            key={segment}
            className={cn(
              "h-[3px] flex-1 rounded-full transition-colors duration-300 ease-void",
              segment <= score ? "bg-ink" : "bg-line-strong"
            )}
          />
        ))}
      </div>
      <p aria-live="polite" className="mt-2 h-4 text-xs text-ink-3">
        {label && <>Password strength: {label}</>}
      </p>
    </div>
  );
}
