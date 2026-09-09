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
 * Code is deliberately absent, and that is a decision rather than an omission. Build has no
 * editor: code arrives in the conversation as diffs, which is where a change is legible — a
 * reviewed hunk says what is changing and why, and a file open in a pane says neither. Interview
 * Prep keeps a real editor, because writing a solution is authoring and this is not.
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
