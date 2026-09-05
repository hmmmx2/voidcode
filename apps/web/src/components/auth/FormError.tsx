import type { ReactNode } from "react";

/**
 * An inline error banner for the auth forms.
 *
 * `role="alert"` so a screen reader announces it when it appears. That matters
 * more than usual here: the error arrives via a full page navigation from
 * NextAuth's `?error=` redirect, so a sighted user sees the page change and a
 * non-sighted one gets no signal at all unless the message announces itself.
 *
 * Monochrome, not red. The page has no colour vocabulary to spend and a red
 * band would be the loudest thing on it — louder than the sign-in buttons,
 * which is the wrong emphasis. A left rule, a raised surface and white text
 * carry "something went wrong" perfectly well at this size. Meaning is not
 * carried by colour alone, which is the accessibility requirement anyway.
 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mb-6 flex gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3.5"
    >
      <span aria-hidden className="mt-[3px] h-4 w-[2px] flex-shrink-0 rounded-full bg-ink" />
      <p className="text-sm leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}
