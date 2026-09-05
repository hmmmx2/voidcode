import type { Metadata } from "next";
import PaperReaderClient from "@/components/Research/PaperReaderClient";

export const metadata: Metadata = {
  title: "Paper — VoidCode AI",
};

/**
 * `/research/[slug]` — the reading workspace.
 *
 * In `(workspace)` rather than `(homepage)` because the split view needs the
 * full-height shell with no footer, exactly like the IDE. A footer under a
 * pane that is itself scrolling is the wrong shape.
 */
export default async function PaperPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <PaperReaderClient slug={slug} />;
}
