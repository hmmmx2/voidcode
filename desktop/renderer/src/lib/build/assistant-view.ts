/**
 * Which of the assistant's three surfaces is showing.
 *
 * This replaced two independent booleans, `showSessions` and `showHistory`, either of which
 * could be true. Both drawers were `max-h-48`, stacked above the transcript, so opening both
 * cost 24rem of the panel and left the conversation in a slot. Nothing prevented it and
 * nothing in the UI suggested it was a state worth being in.
 *
 * The code already knew. `openSession` and `openRun` both called `setShowHistory(false)` on
 * their way out — hand-written exclusivity at two of the several places that needed it, which
 * is the shape a missing state machine leaves behind.
 *
 * Pure and separate from the panel so it can be tested without mounting 1200 lines of
 * streaming, attachments and diff review — the same reasoning as `lib/build/editor-tabs.ts`.
 */

export type AssistantView = "chat" | "sessions" | "history";

/**
 * Clicking a view selects it; clicking the one you are on returns to the conversation.
 *
 * The toggle-back matters: it is what the old labels promised. "Hide chats" was the second
 * half of a button that said "Chats", and losing it would mean the only way out of a drawer
 * was to open a different one.
 */
export function selectView(current: AssistantView, clicked: AssistantView): AssistantView {
  return current === clicked ? "chat" : clicked;
}

/**
 * History is a list of agent runs, so a panel with no agent has none to list.
 *
 * The panel already hid the button behind `host.agent !== undefined`. Encoding it here as
 * well means the *state* cannot reach `history` either — otherwise a session restore or a
 * keyboard path could select a view whose trigger is not on screen, and the drawer would open
 * with no way to close it.
 */
export function canShow(view: AssistantView, hasAgent: boolean): boolean {
  return view !== "history" || hasAgent;
}

/** Selection that respects `canShow`, falling back to the conversation. */
export function selectViewSafely(
  current: AssistantView,
  clicked: AssistantView,
  hasAgent: boolean
): AssistantView {
  const next = selectView(current, clicked);
  return canShow(next, hasAgent) ? next : "chat";
}
