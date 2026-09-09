"use client";

import { usePathname } from "next/navigation";
import WorkspaceClient from "@/components/Layout/WorkspaceClient";
import { TOTAL_PROBLEMS, problemPosition, resolveProblemSlug } from "@/lib/curriculum";

export default function ProblemPageClient() {
  // `id` may be a 1-based position (the dashboard links this way) or a slug (the course
  // pages do). `resolveProblemSlug` handles both — see `lib/curriculum.ts`.
  const id = usePathname().split("/").filter(Boolean).pop() ?? "1";

  return (
    <WorkspaceClient
      problemSlug={resolveProblemSlug(id)}
      currentProblem={problemPosition(id)}
      totalProblems={TOTAL_PROBLEMS}
    />
  );
}
