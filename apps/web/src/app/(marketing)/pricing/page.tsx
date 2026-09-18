import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/sections/MarketingNav";
import { PricingPlans } from "@/components/marketing/sections/PricingPlans";
import { CtaBlock } from "@/components/marketing/sections/CtaBlock";
import { MarketingFooter } from "@/components/marketing/sections/MarketingFooter";

export const metadata: Metadata = {
  title: "Pricing — VoidCode AI",
  description:
    "VoidCode is free and open source. The optional hosted VoidCode model is metered by the second and paid for with credits — RM20, RM50 and RM100 packs.",
};

/**
 * `/pricing`.
 *
 * A server component with one client leaf (the nav), like the overview page: there is nothing here
 * that depends on the visitor, so there is nothing to defer to the browser. The prices are static
 * text checked against the API's pack rows by `tests/test_marketing_pages.py`.
 */
export default function PricingPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <PricingPlans />
        <CtaBlock />
      </main>
      <MarketingFooter />
    </>
  );
}
