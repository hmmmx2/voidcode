import type { Metadata } from "next";
import { Suspense } from "react";
import InterviewCatalogueClient from "@/components/Interviews/InterviewCatalogueClient";

export const metadata: Metadata = {
  title: "Elite Interview — VoidCode AI",
  description:
    "The ML, DL, CUDA, maths, LLM and VLM questions asked out loud, with the approach, the model answer and the red flags.",
};

/**
 * `/interviews` — the question bank.
 *
 * `Suspense` is required, not stylistic: the catalogue reads `useSearchParams()`
 * to keep filter state in the URL, and Next throws at build time if that is not
 * suspended.
 */
export default function InterviewsPage() {
  return (
    <Suspense
      fallback={<div className="mx-auto h-[600px] max-w-4xl" aria-hidden />}
    >
      <InterviewCatalogueClient />
    </Suspense>
  );
}
