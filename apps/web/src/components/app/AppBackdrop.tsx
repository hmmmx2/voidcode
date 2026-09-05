/**
 * The backdrop every glass surface in the logged-in app refracts.
 *
 * THIS IS A PREREQUISITE, NOT A DECORATION.
 *
 * `backdrop-filter` over flat black is invisible — there is nothing to sample,
 * and a glass panel degenerates into a slightly lighter rectangle. The auth
 * pages learned this the hard way; see the docblock in `auth/GlassPanel.tsx`.
 * If a glass surface in this app ever stops looking like glass, check that this
 * component is mounted on its route group's root before touching the fill.
 *
 * The gradient and bloom are the landing hero's, verbatim, which is the point:
 * crossing from `/` into `/homepage` should not feel like changing product.
 *
 * WHY THE APP NEEDED THIS AT ALL, WHEN THE NAV ALREADY HAD `backdrop-blur`
 *
 * It had the utility and no effect. `TopNavigation` is a `flex-shrink-0`
 * sibling *above* `<main>` in a `flex flex-col h-screen`, so nothing ever
 * scrolls beneath it and the blur had nothing to act on. Rather than make the
 * nav sticky — which would turn `<main>`'s scroll container into a second
 * scroller and break more than it fixes — the backdrop moves up to the route
 * group root. Every glass surface in the app is then a descendant of one
 * isolated stacking context with a live, drifting backdrop behind it.
 *
 * THREE THINGS THAT WILL BREAK IT
 *
 * 1. The host must carry `relative isolate overflow-hidden`. `isolate` is
 *    load-bearing: these layers sit at negative z so content can occlude them,
 *    and without a stacking context here they paint *behind* the root layout's
 *    black background and vanish completely.
 * 2. Content must sit at `relative z-10`, or `.grain` (at `z-0`) paints over it.
 * 3. This renders only `<div>`s, deliberately. `TopNavigation`'s scroll
 *    listener does `document.querySelector("main")` and takes the first match,
 *    so a stray `<main>` or `<section>` here would silently steal it.
 */
export function AppBackdrop({
  tone = "page",
}: {
  /**
   * `workspace` shortens the gradient and narrows the bloom. The IDE fills the
   * viewport with panels rather than scrolling a document past a masthead, so
   * the page-height gradient would lift the whole editor region into grey
   * instead of falling off behind content.
   */
  tone?: "page" | "workspace";
}) {
  const workspace = tone === "workspace";

  return (
    <>
      <div
        aria-hidden
        className={
          "pointer-events-none absolute inset-x-0 top-0 -z-20 " +
          (workspace
            ? "h-[420px] bg-[linear-gradient(to_bottom,#0d0d0f_0%,#050506_50%,#000000_100%)]"
            : "h-[900px] bg-[linear-gradient(to_bottom,#111114_0%,#050506_45%,#000000_100%)]")
        }
      />
      <div
        aria-hidden
        className={
          "pointer-events-none absolute left-1/2 -z-20 -translate-x-1/2 " +
          "animate-drift rounded-full " +
          "bg-[radial-gradient(closest-side,rgba(255,255,255,0.045),transparent)] " +
          (workspace
            ? "top-[-14%] h-[420px] w-[760px]"
            : "top-[-10%] h-[720px] w-[1100px]")
        }
      />
      {/* Monochrome gradients band visibly on 8-bit displays; 3% noise removes
          it. One decoded tile repeated, not a live filter — see `.grain`. */}
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-0" />
    </>
  );
}
