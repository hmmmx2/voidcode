/**
 * Which surface the right pane is showing.
 *
 * Its own module, and pure, so the parser can be tested without mounting a workspace — the same
 * reason `dock.ts` sits beside it, and this follows that file deliberately rather than inventing
 * a second shape for the same problem.
 *
 * **The value arrives off a persisted document.** `host.session.load()` returns a string this
 * window wrote, but "this window wrote it" is not a guarantee about its contents: it survives
 * downgrades, hand-editing, and a future version that knows surfaces this one does not. So the
 * parser is total — anything unrecognised becomes the default rather than propagating.
 */

/**
 * Every surface the right pane can show.
 *
 * **Three, because three have something to show.** The rule this list follows is that a tab must
 * open onto something real: a tab that opens onto "coming soon" is worse than no tab, because it
 * costs a click to learn nothing. Plan and Steps arrived when the agent could write a plan;
 * Preview arrives now that a dev server can actually be run and displayed.
 *
 * All four now have something to show. Design was the last to arrive, and adding it was exactly
 * what the note here predicted: one name in this list plus a surface — because the parser is
 * written against the list rather than against a literal union, a persisted `"design"` written
 * by a newer build started being honoured the moment the surface existed.
 *
 * Code is still deliberately absent, for a reason that has changed. This said "Build has no
 * editor", and Build now does: the centre pane carries editor tabs beside Chat, because clicking a
 * file in the explorer is the one gesture a file tree promises and it used to produce a sentence
 * in another pane. What survives is the narrower claim — a Code tab *here* would be a second
 * place showing the same file, which is exactly the objection `WorkspaceSurface` makes about a
 * second place to act on a run: two surfaces for one thing is two surfaces that can disagree.
 *
 * The reviewed-diff argument also survives, and is about a different job. A model's change is
 * legible as a hunk and not as a file, which is why the assistant still proposes rather than
 * writes. Reading your own code was never what that argument was about.
 */
export const WORKSPACE_TABS = ["plan", "steps", "design", "preview"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = "plan";

/** What the tab is called on screen. Separate from the id, which is persisted and must not move. */
export const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, string> = {
  plan: "Plan",
  steps: "Steps",
  design: "Design",
  preview: "Preview",
};

/**
 * A persisted value, narrowed to a surface this build actually has.
 *
 * A version that knows more surfaces than this one will have written a name that is not in
 * `WORKSPACE_TABS`, and falling back is the correct answer to that — not an error, just an older
 * build opening where it can.
 *
 * Membership is tested against the array rather than an object, deliberately. `"__proto__" in obj`
 * and `obj["toString"]` are both truthy for a plain object literal, so a lookup-table version
 * would accept `__proto__` as a valid tab name and then fail somewhere far away.
 */
export function parseWorkspaceTab(value: unknown): WorkspaceTab {
  if (typeof value !== "string") return DEFAULT_WORKSPACE_TAB;
  return (WORKSPACE_TABS as readonly string[]).includes(value)
    ? (value as WorkspaceTab)
    : DEFAULT_WORKSPACE_TAB;
}
