"use client";

import type { SlashCommand } from "@/lib/build/slash";

/**
 * The list that appears when a message starts with a slash.
 *
 * **Not a popover, and deliberately not Radix.** Every popover primitive worth using moves focus
 * into itself when it opens — that is what makes them accessible as dialogs, and it is exactly
 * wrong here. The user is mid-sentence in a textarea; taking focus means the next keystroke goes
 * somewhere else and the command they were typing is interrupted by the thing meant to help them
 * type it.
 *
 * So this is an absolutely positioned `<ul>` that never takes focus. The textarea keeps it,
 * handles the arrow keys, and passes down which row is active. The list is a rendering of state
 * that lives above it, which is also why it needs no tests of its own: `suggest` decides what
 * appears and `tests/slash.test.ts` covers that.
 *
 * `aria-activedescendant` on the textarea is how a screen reader is told which row is current
 * without focus ever moving — the same pattern a combobox uses, and the reason each row carries a
 * stable id.
 */

export const SLASH_OPTION_ID = (name: string): string => `slash-option-${name}`;

interface SlashAutocompleteProps {
  commands: readonly SlashCommand[];
  /** Index into `commands`. The textarea owns it, because the textarea owns the arrow keys. */
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
}

export default function SlashAutocomplete({
  commands,
  activeIndex,
  onPick,
}: SlashAutocompleteProps) {
  if (commands.length === 0) return null;

  return (
    <ul
      id="slash-autocomplete"
      role="listbox"
      aria-label="Slash commands"
      // Above the composer rather than below it: the composer sits at the bottom of a 300px
      // panel, and a list below would be off-screen or would push the textarea up as you type.
      className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-56 overflow-y-auto rounded-md border border-line bg-ide-panel py-1 shadow-[var(--shadow-panel)]"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          id={SLASH_OPTION_ID(command.name)}
          role="option"
          aria-selected={index === activeIndex}
          // `onMouseDown` rather than `onClick`: click fires after blur, and blurring the
          // textarea closes this list, so by the time click arrives there is nothing to pick.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command);
          }}
          className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px] ${
            index === activeIndex ? "bg-ide-raised text-ink" : "text-ink-2"
          }`}
        >
          <span className="font-mono text-ink">/{command.name}</span>
          {command.argument !== undefined && (
            <span className="font-mono text-[11px] text-ink-3">{command.argument}</span>
          )}
          <span className="ml-auto truncate text-[11px] text-ink-3">{command.hint}</span>
        </li>
      ))}
    </ul>
  );
}
