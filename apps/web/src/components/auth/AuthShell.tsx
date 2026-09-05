import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The two-column frame shared by `/login` and `/register`.
 *
 * Grid proportions are lifted from the landing hero (`lg:grid-cols-[1fr_0.95fr]`)
 * so the two pages share a rhythm rather than merely a palette.
 *
 * MOBILE IS A DELIBERATE DEVIATION FROM THE LANDING PAGE.
 *
 * The hero floats its object *behind* the headline below `lg`, with a radial
 * scrim sinking the midtones where type lands. That works for decorative
 * copy. It would be wrong here: this column contains a form, and a specular
 * streak crossing an input's focus ring or an error message is a legibility
 * problem, not an aesthetic one. So below `lg` the object is simply not
 * rendered — no canvas, no still, no WebGL context on a phone at all.
 *
 * That is also why the object lives in a `hidden lg:block` wrapper rather than
 * being hidden with opacity: `TieredObject`'s idle probe and dynamic import
 * are inside it, so an unmounted subtree fetches nothing.
 */
export function AuthShell({
  children,
  object,
  brand,
  reverse = false,
}: {
  children: ReactNode;
  object: ReactNode;
  brand: ReactNode;
  /** Mirror the columns — used by `/register` so the two pages are not identical. */
  reverse?: boolean;
}) {
  return (
    <div className="relative z-10 flex min-h-screen flex-col px-6 py-8 lg:px-12 lg:py-10">
      <header className="flex-shrink-0">{brand}</header>

      <main className="flex flex-1 items-center py-12 lg:py-16">
        {/*
          Three columns, not two: content, a 1px rule, and the object.

          The rule is a real grid track rather than a border on one of the
          columns, because a border would sit flush against whichever side owns
          it and the gap would be lopsided — 64px on one side, 0 on the other.
          Its own track gets symmetric `gap-x` on both sides for free, and the
          `reverse` mirror works without moving which element carries the border.
        */}
        {/*
          WIDTH SCALES PAST `2xl`, because Tailwind's largest default breakpoint
          is 1536px and the monitors this is actually used on start there.

          24" is 1920, 27" and 32" are 2560, and a 34" ultrawide is 3440. At a
          fixed `max-w-6xl` (1152px) the whole page occupies a third of a 34"
          screen with vast dead margins either side, which reads as a phone
          layout stretched onto a desktop rather than as a designed one.

          The steps are deliberately gentle and stop at 1760px. Beyond that the
          two columns are far enough apart that the eye stops reading them as
          one composition and the divider stops doing its job — on a very wide
          screen the correct answer is margin, not more spread.

          EVERY BREAKPOINT HERE IS ARBITRARY (`min-[1536px]:`) RATHER THAN NAMED
          (`2xl:`), including the one that has a name. Measured: mixing the two
          inverts the cascade — Tailwind v4 emits named variants *after*
          arbitrary ones, so `2xl:max-w-[88rem]` beat `min-[1920px]:max-w-[96rem]`
          at 2560px and the container stayed at 1408px when it should have been
          1536px. Arbitrary variants sort correctly among themselves by their
          own pixel value, so keeping the whole ladder in one form is what makes
          it predictable.
        */}
        <div
          className={cn(
            "mx-auto grid w-full items-center gap-y-12",
            "max-w-6xl min-[1536px]:max-w-[88rem] min-[1920px]:max-w-[96rem] min-[2400px]:max-w-[110rem]",
            "lg:grid-cols-[1fr_1px_0.95fr] lg:gap-x-14 min-[1536px]:gap-x-20 min-[1920px]:gap-x-24"
          )}
        >
          <div
            className={cn(
              "w-full max-w-xl min-[1536px]:max-w-[38rem]",
              reverse && "lg:order-3"
            )}
          >
            {children}
          </div>

          {/* Hidden below `lg` along with the object — a divider between two
              things that are no longer side by side is just a stray line. */}
          <div
            aria-hidden
            className="column-rule hidden h-[62%] max-h-[520px] w-px self-center lg:block lg:order-2 min-[1536px]:max-h-[620px]"
          />

          {/* `aspect-square` plus `relative` is what gives the absolutely
              positioned tiers a box to fill. Hidden below lg — see above.
              The cap grows with the container so the object keeps its share of
              the composition instead of stranding itself in a widening column. */}
          <div
            className={cn(
              "relative hidden aspect-square w-full lg:block",
              "max-w-[560px] min-[1536px]:max-w-[660px] min-[1920px]:max-w-[740px] min-[2400px]:max-w-[820px]",
              reverse ? "lg:order-1 lg:justify-self-start" : "lg:order-3 lg:justify-self-end"
            )}
          >
            {object}
          </div>
        </div>
      </main>

      <footer className="flex flex-shrink-0 flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-3">
        <span>© {new Date().getFullYear()} VoidCode AI</span>
        <a href="/terms" className="transition-colors hover:text-ink-2">
          Terms
        </a>
        <a href="/privacy" className="transition-colors hover:text-ink-2">
          Privacy
        </a>
      </footer>
    </div>
  );
}
