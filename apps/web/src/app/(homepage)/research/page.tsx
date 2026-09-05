import type { Metadata } from "next";
import PaperLibraryClient from "@/components/Research/PaperLibraryClient";

export const metadata: Metadata = {
  title: "Research — VoidCode AI",
  description:
    "Papers with architecture, implementation, system-design and mathematical breakdowns, linked to the problems that implement them.",
};

/** `/research` — the library. Sits in `(homepage)` for nav, footer and backdrop. */
export default function ResearchPage() {
  return <PaperLibraryClient />;
}
