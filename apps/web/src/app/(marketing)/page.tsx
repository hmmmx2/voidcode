import { MarketingNav } from "@/components/marketing/sections/MarketingNav";
import { Hero } from "@/components/marketing/sections/Hero";
import { StackStrip } from "@/components/marketing/sections/StackStrip";
import { ProblemStatement } from "@/components/marketing/sections/ProblemStatement";
import { TwoTracks } from "@/components/marketing/sections/TwoTracks";
import { FeatureRows } from "@/components/marketing/sections/FeatureRows";
import { ConceptGraph } from "@/components/marketing/sections/ConceptGraph";
import { ObjectionFaq } from "@/components/marketing/sections/ObjectionFaq";
import { CtaBlock } from "@/components/marketing/sections/CtaBlock";
import { MarketingFooter } from "@/components/marketing/sections/MarketingFooter";

/**
 * `/` — the overview.
 *
 * ONE OF THREE PAGES. The site is overview, `/pricing` and `/download`. The download section used
 * to sit at the bottom of this page; it moved because a download is a destination people link to
 * directly, and because a page that argues a case should not end in a file list. Every "Download"
 * on this page now points at that page, which is also the only page with a client component on it.
 *
 *
 * A server component, and it must stay one. The <h1> inside <Hero> is the
 * intended LCP element and it is plain server-rendered text with nothing in
 * front of it — no client boundary, no suspense, no font swap it has to wait on.
 * Client components are pushed to the leaves (the nav's scroll state, the demo
 * runner, the 3D canvas) so none of them can delay that paint.
 *
 * Unauthenticated visitors reach this page because `middleware.ts` lists `/` in
 * PUBLIC_PATHS; signed-in visitors are redirected to `/homepage` there, which is
 * what the deleted `app/page.tsx` used to do unconditionally.
 *
 * THERE IS NO "SKIP THE DEMO" LINK. It was a skip link to `#why`, hidden until focused — so the
 * first thing a keyboard visitor met was an offer to leave, and it showed up unbidden whenever the
 * browser restored focus to the top of the document. The nav above is reachable by the same Tab
 * press and goes to the same places.
 */
export default function LandingPage() {
  return (
    <>
      <MarketingNav />

      <main>
        <Hero />
        <StackStrip />
        <ProblemStatement />
        <TwoTracks />
        <FeatureRows />
        <ConceptGraph />
        <ObjectionFaq />
        <CtaBlock />
      </main>

      <MarketingFooter />
    </>
  );
}
