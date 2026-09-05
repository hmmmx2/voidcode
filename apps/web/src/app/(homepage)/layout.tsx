import TopNavigation from "@/components/Layout/TopNavigation";
import AppFooter from "@/components/Layout/AppFooter";
import { AppBackdrop } from "@/components/app";

/**
 * Shell for `/homepage`.
 *
 * `relative isolate overflow-hidden` IS NOT COSMETIC — `AppBackdrop` renders at
 * `-z-20`, and without a stacking context here those layers paint behind the
 * root layout's black background and disappear entirely. That failure is
 * particularly nasty because nothing errors: the page renders, and every glass
 * surface in it quietly becomes a flat grey rectangle with no blur, because a
 * `backdrop-filter` with nothing behind it has nothing to sample.
 *
 * THE SCROLL CONTAINER STAYS ON `<main>`, DELIBERATELY.
 *
 * `h-screen` + `overflow-y-auto` makes `<main>` a nested scroller rather than
 * the document, which rules out `animation-timeline: view()` anywhere in the
 * app — that binds to the nearest ancestor scroll container and would freeze.
 * `Reveal` is unaffected: IntersectionObserver's default root is the viewport
 * and it reports correctly for elements inside a nested scroller.
 *
 * Keeping it also keeps the footer out of the way until you reach it, and keeps
 * `TopNavigation` fixed without `position: sticky`. The cost is that the nav is
 * a sibling *above* the scroller rather than over it — which is exactly why the
 * backdrop lives up here on the root instead of inside `<main>`, so the nav
 * still has something to refract.
 */
export default function HomepageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      {/* `.reveal` starts at opacity 0 and is only un-hidden by an
          IntersectionObserver. Without this a visitor with JavaScript disabled
          gets a page of invisible sections — the content is all in the HTML, so
          it would be a purely self-inflicted failure. Any route group that uses
          `Reveal` must carry this. */}
      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      <TopNavigation variant="homepage" />

      {/* `z-10` puts content above `.grain`, which sits at z-0.
          Footer lives inside main so it scrolls naturally with page content. */}
      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
        <AppFooter />
      </main>
    </div>
  );
}
