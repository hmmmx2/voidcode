import WorkspaceClient from "@/components/Layout/WorkspaceClient";
import {
  TOTAL_PROBLEMS,
  problemPosition,
  resolveProblemSlug,
} from "@/lib/curriculum";

/**
 * `/problems/[id]` — the workspace.
 *
 * `id` may be a 1-based position (the dashboard links this way) or a slug (the
 * course pages do). `resolveProblemSlug` handles both; see `lib/curriculum.ts`
 * for why the mapping is a static list rather than a lookup.
 *
 * `totalProblems` used to be the literal `5` and is now derived. It is what the
 * prev/next chevrons clamp against, so a stale literal disables the arrow on the
 * last problem and quietly hides everything past it.
 */
export default async function ProblemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <WorkspaceClient
      problemSlug={resolveProblemSlug(id)}
      currentProblem={problemPosition(id)}
      totalProblems={TOTAL_PROBLEMS}
    />
  );
}
