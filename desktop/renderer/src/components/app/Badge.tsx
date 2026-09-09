import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The small status chip: course state, lesson type, module counts, filters.
 *
 * There were about fourteen hand-rolled versions of this, and between them they
 * carried most of the app's stray colour — `#2E7D32` for complete, amber for
 * in-progress, blue for a lesson type, and a `statusColor` ternary in
 * `CourseCatalogueClient` that mapped four states onto four hues.
 *
 * TWO TONES, NO COLOUR. A badge is a label, not a signal. Where a chip needs to
 * say something urgent it can say it in words — "3 remaining" reads faster than
 * amber does, and it survives being printed, screenshotted in greyscale, or
 * looked at by the ~8% of men with a colour vision deficiency. The one place in
 * this product where colour genuinely carries meaning is test pass/fail, and
 * that has its own component with an icon bolted to it. See `Verdict.tsx`.
 */
export function Badge({
  tone = "quiet",
  className,
  children,
}: {
  /** `strong` for the one chip in a group that should be read first. */
  tone?: "quiet" | "strong";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border",
        "px-2.5 py-0.5 text-[11px] font-medium leading-5",
        tone === "strong"
          ? "border-line-strong bg-void-3 text-ink-2"
          : "border-line bg-void-2 text-ink-3",
        className
      )}
    >
      {children}
    </span>
  );
}
