import type { Metadata } from "next";
import QuestionRouter from "@/components/Interviews/QuestionRouter";

export const metadata: Metadata = {
  title: "Interview question — VoidCode AI",
};

/**
 * `/interviews/[slug]` — an interview question, in the IDE.
 *
 * Lives in `(workspace)` rather than `(homepage)` because the IDE needs the
 * full-height shell with no footer, exactly like `/problems/[id]`. Route groups
 * do not affect URLs, so this sits on the same path prefix as the catalogue at
 * `(homepage)/interviews/page.tsx` while getting a different layout.
 *
 * `QuestionRouter` then chooses between the IDE and the two-column written
 * workspace, because which one a question needs is a property of the question
 * rather than of the URL.
 *
 * Params are a Promise in Next 16 and must be awaited.
 */
export default async function InterviewQuestionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <QuestionRouter slug={slug} />;
}
