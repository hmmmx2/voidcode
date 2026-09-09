/**
 * The mode names both processes need to agree on.
 *
 * Names and labels only. The *policy* — which tools each mode binds, whether it writes without
 * a dialog, how many turns it may take, and what the model is told — lives in
 * `main/agent/modes.ts` and stays there. Main decides what a mode means; the renderer only
 * needs to know which ones exist so it can offer them.
 *
 * Shared rather than duplicated because the alternative in this codebase is a hand-maintained
 * copy either side of the process boundary guarded by a parity test — the arrangement
 * `agent-event-parity.test.ts` exists to police, and which has already let streaming break
 * once. A list of four strings does not need that ceremony when one file can serve both.
 */

/** Every mode the policy table defines, including ones not yet offered. */
export type AgentMode = "plan" | "manual" | "acceptEdits" | "auto";

/**
 * The modes a user can pick.
 *
 * `auto` is here now. It was deliberately absent while the two things that bound it did not
 * exist — arming, which is a human consenting through a window main owns, and the run
 * checkpoint, which makes its writes one click back. Both are built, so the list is complete.
 *
 * Selectable is not the same as available. Choosing Auto binds the shell and lets proposals
 * reach disk without a dialog, but an *unarmed* window writes nothing and says so: arming is
 * a separate act, and nothing the renderer sends can perform it.
 */
export const SELECTABLE_MODES = ["plan", "manual", "acceptEdits", "auto"] as const;

export type SelectableMode = (typeof SELECTABLE_MODES)[number];

/** Ships asking before it writes. A default that did not would be a decision nobody made. */
export const DEFAULT_MODE: SelectableMode = "acceptEdits";

export function isSelectableMode(value: string): value is SelectableMode {
  return (SELECTABLE_MODES as readonly string[]).includes(value);
}

export const MODE_LABELS: Record<SelectableMode, string> = {
  plan: "Plan",
  manual: "Manual",
  acceptEdits: "Accept Edits",
  auto: "Auto",
};

/**
 * What each mode does, in the words a user would use.
 *
 * Says what the agent *can* do rather than which tools are bound: "reads the project" is the
 * fact someone picking a mode needs, and the tool names are main's business.
 */
export const MODE_HELP: Record<SelectableMode, string> = {
  plan: "Reads the project and proposes an approach. Changes nothing.",
  manual: "No tools. Answers from the conversation and what you show it.",
  acceptEdits: "Reads, searches, and proposes edits you review before anything is written.",
  // Says what it costs, not just what it does. Someone choosing this needs the second sentence
  // more than the first, and "undo covers files, not commands" is the part that surprises.
  auto: "Writes edits straight to disk and can run commands. Needs arming; a run's file changes can be undone, its commands cannot.",
};
