/**
 * Slash commands, and the boundary that makes them cheap.
 *
 * **A slash command may only rewrite outgoing text or change local UI state the user could
 * change with a click.** It must never grant a tool, choose a provider the `<select>` would not
 * offer, or reach main. That constraint is the whole reason this is a hundred lines and not a
 * capability surface: `/mode auto` produces an *intent* that the panel hands to the same
 * `armAuto()` path the dropdown uses, so the native consent window still appears and nothing
 * here can skip it. Typing a command must never be a way to do something clicking cannot.
 *
 * It lives at the top of this file because it is the property that must survive every future
 * addition to `COMMANDS`.
 *
 * **Triggering is `/` at position 0 only.** `http://`, a regex, a path and a code block all
 * contain slashes, and a picker that opens mid-sentence is worse than no picker — it steals the
 * next keystroke. So the parser looks at the start of the message and nowhere else.
 */
import { SELECTABLE_MODES, isSelectableMode, type SelectableMode } from "@shared/agent-modes";

/**
 * What running a command asks the panel to do.
 *
 * Data, not a callback: the parser stays pure and testable, and every effect a command can have
 * is enumerable by reading this union. A new member is a visible widening of what typing can do.
 */
export type SlashIntent =
  /** Attach a file or folder — Phase 6's context refs. Opens the picker when no path is given. */
  | { kind: "pick"; target: "file" | "folder" }
  /** Start a new session, exactly as the New button does. */
  | { kind: "clear" }
  /** Change the mode selector. `auto` still routes through arming; this only moves the select. */
  | { kind: "mode"; mode: SelectableMode }
  /** Navigate to the model manager. */
  | { kind: "models" }
  /** Show the History view. */
  | { kind: "history" };

export interface SlashCommand {
  name: string;
  /** Shown beside the name in the list. */
  hint: string;
  /** `null` when the entered argument is not one this command accepts. */
  intent: (argument: string) => SlashIntent | null;
  /** True when the command wants an argument, so the list can show it. */
  argument?: string;
}

/**
 * Every command, and what it maps to.
 *
 * Each one is something that already exists and is already reachable by clicking. That is the
 * test for adding another: if it cannot be done with the mouse, it does not belong here.
 */
export const COMMANDS: readonly SlashCommand[] = [
  { name: "file", hint: "Attach a file from this project", intent: () => ({ kind: "pick", target: "file" }) },
  { name: "folder", hint: "Attach a folder from this project", intent: () => ({ kind: "pick", target: "folder" }) },
  { name: "clear", hint: "Start a new session", intent: () => ({ kind: "clear" }) },
  {
    name: "mode",
    hint: "Change how the assistant works",
    argument: SELECTABLE_MODES.join(" | "),
    // Read from `agent-modes.ts` rather than restating four strings, so a fifth mode is
    // selectable here the moment it is selectable anywhere.
    intent: (argument) => (isSelectableMode(argument) ? { kind: "mode", mode: argument } : null),
  },
  { name: "model", hint: "Open the model manager", intent: () => ({ kind: "models" }) },
  { name: "history", hint: "Show past sessions", intent: () => ({ kind: "history" }) },
];

/** What the autocomplete is showing, if anything. */
export interface SlashQuery {
  /** The characters after the slash and before the first space. */
  name: string;
  /** Everything after the first space, trimmed. Empty when there is none. */
  argument: string;
  /** True once a space has been typed, so the list can stop offering names. */
  hasArgument: boolean;
}

/**
 * Read the composer's text as a command, or null if it is a message.
 *
 * Only a leading slash counts, and only when it is the very first character — not after a
 * newline, not after a space. Someone who has typed a paragraph and starts a line with `/` is
 * writing a path, not invoking anything.
 */
export function parseSlash(text: string): SlashQuery | null {
  if (!text.startsWith("/")) return null;

  const body = text.slice(1);
  const space = body.indexOf(" ");
  if (space === -1) return { name: body, argument: "", hasArgument: false };

  return {
    name: body.slice(0, space),
    argument: body.slice(space + 1).trim(),
    hasArgument: true,
  };
}

/**
 * The commands to offer for what has been typed so far.
 *
 * Prefix matching, not fuzzy: there are six of them and they are all short, so a prefix is
 * unambiguous and predictable — and predictability matters more than cleverness for something
 * that reacts to every keystroke while you are mid-sentence.
 */
export function suggest(query: SlashQuery | null): readonly SlashCommand[] {
  if (query === null) return [];
  // Once a space has been typed the name is settled; the list should be the one exact match, so
  // an argument can be typed without the picker fighting for the same keys.
  if (query.hasArgument) {
    const exact = COMMANDS.find((command) => command.name === query.name);
    return exact === undefined ? [] : [exact];
  }
  const needle = query.name.toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * What sending this text should do.
 *
 * `null` means "this is an ordinary message" — including for `/nonsense`, which is sent as
 * literal text rather than swallowed. Eating an unrecognised command would mean a typo silently
 * discards what someone wrote, which is the worst possible response to a typo.
 */
export function resolve(text: string): SlashIntent | null {
  const query = parseSlash(text);
  if (query === null) return null;

  const command = COMMANDS.find((entry) => entry.name === query.name);
  if (command === undefined) return null;
  return command.intent(query.argument);
}

/** The text to leave in the composer after a command runs. Always empty — commands are not messages. */
export const CONSUMED = "";

/** Complete a partially-typed name, for Tab and for clicking a suggestion. */
export function complete(command: SlashCommand): string {
  return command.argument === undefined ? `/${command.name}` : `/${command.name} `;
}
