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
 * Public landing page.
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
 */
export default function LandingPage() {
  return (
    <>
      <a
        href="#why"
        className="sr-only focus:not-sr-only focus:fixed focus:left-6 focus:top-6 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-void-0"
      >
        Skip the demo
      </a>

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
