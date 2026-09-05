import type { Metadata } from "next";
import { Suspense } from "react";
import ProblemCatalogueClient from "@/components/Problems/ProblemCatalogueClient";

export const metadata: Metadata = {
  title: "Problems — VoidCode AI",
  description:
    "Implement the ML, DL, LLM, VLM and CUDA primitives interviews ask for, from scratch.",
};

/**
 * `/problems` — the catalogue.
 *
 * Lives in `(homepage)` for its chrome (nav, footer, backdrop), while
 * `/problems/[id]` lives in `(workspace)` because the IDE needs a full-height
 * shell with no footer. Route groups do not affect URLs, so the two coexist on
 * the same path prefix with different layouts — which is exactly what they need.
 *
 * `Suspense` is required, not stylistic: the catalogue reads `useSearchParams()`
 * to keep filter state in the URL, and Next throws at build time if that is not
 * suspended.
 */
export default function ProblemsPage() {
  return (
    <Suspense
      fallback={<div className="mx-auto h-[600px] max-w-4xl" aria-hidden />}
    >
      <ProblemCatalogueClient />
    </Suspense>
  );
}
