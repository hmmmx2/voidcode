import { AppBackdrop } from "@/components/app";

/**
 * Shell for the Interview Prep browse surfaces — Dashboard, Problems, Interviews.
 *
 * `TopNavigation` and `AppFooter` used to live here. Both are gone: the workbench supplies
 * navigation now (menu bar, activity rail, section sidebar), so keeping the top nav drew a
 * second row of destinations inside the first — and a marketing footer at the bottom of a
 * pane inside an IDE frame is costume.
 *
 * `relative isolate overflow-hidden` IS NOT COSMETIC — `AppBackdrop` renders at `-z-20`, and
 * without a stacking context here those layers paint behind the root layout's black
 * background and disappear entirely. That failure is particularly nasty because nothing
 * errors: the page renders, and every glass surface in it quietly becomes a flat grey
 * rectangle with no blur, because a `backdrop-filter` with nothing behind it has nothing to
 * sample.
 *
 * THE SCROLL CONTAINER STAYS ON `<main>`, DELIBERATELY.
 *
 * `overflow-y-auto` makes `<main>` a nested scroller rather than the document, which rules
 * out `animation-timeline: view()` anywhere in the app — that binds to the nearest ancestor
 * scroll container and would freeze. `Reveal` is unaffected: IntersectionObserver's default
 * root is the viewport and it reports correctly for elements inside a nested scroller.
 *
 * `h-full`, not `h-screen`: this is a pane inside the workbench's flex column now, and
 * `h-screen` would make it overflow by exactly the height of the menu bar.
 */
export default function HomepageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      {/* `.reveal` starts at opacity 0 and is only un-hidden by an IntersectionObserver.
          Without this a visitor with JavaScript disabled gets a page of invisible sections —
          the content is all in the HTML, so it would be a purely self-inflicted failure.
          Any route group that uses `Reveal` must carry this. */}
      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      {/* `z-10` puts content above `.grain`, which sits at z-0. */}
      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
      </main>
    </div>
  );
}
