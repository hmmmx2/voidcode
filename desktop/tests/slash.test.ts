/**
 * Slash commands, and the two ways they could quietly become dangerous.
 *
 * The first is scope: a slash command may only rewrite outgoing text or change local UI state
 * the user could change with a click. Typing must never be a way to do something clicking
 * cannot — no tool granted, no provider the `<select>` would not offer, nothing reaching main.
 * `/mode auto` in particular must produce an *intent* and not a mode change, so the native
 * arming window still stands between the user and a shell.
 *
 * The second is the trigger. `http://`, regexes, paths and code blocks contain slashes
 * constantly, and a picker that opens mid-sentence steals the next keystroke. Position 0 only.
 */
import { describe, it, expect } from "vitest";
import {
  COMMANDS,
  complete,
  parseSlash,
  resolve,
  suggest,
} from "../renderer/src/lib/build/slash.js";
import { SELECTABLE_MODES } from "../src/shared/agent-modes.js";

describe("when a slash is a command", () => {
  it("triggers at the very start and nowhere else", () => {
    expect(parseSlash("/file")).not.toBeNull();

    // The cases that made "anywhere" untenable.
    for (const text of [
      "see http://example.com",
      "run ls /usr/bin",
      "the regex /^a.*z$/ matches",
      "a sentence, then /file",
      " /file",
      "```\n/file\n```",
    ]) {
      expect(parseSlash(text), text).toBeNull();
    }
  });

  it("does not trigger on a slash after a newline", () => {
    // A paragraph whose second line starts with a path is prose, not an invocation.
    expect(parseSlash("here is the thing\n/src/index.ts")).toBeNull();
  });

  it("splits the name from its argument at the first space", () => {
    expect(parseSlash("/mode auto")).toEqual({ name: "mode", argument: "auto", hasArgument: true });
    expect(parseSlash("/mode")).toEqual({ name: "mode", argument: "", hasArgument: false });

    // The *first* space, not the last: a name is one word and everything after it belongs to the
    // argument. Splitting at the last space makes the name "mode auto" here and matches nothing,
    // which a single-space example cannot show because both rules agree on it.
    expect(parseSlash("/mode auto extra")).toEqual({
      name: "mode",
      argument: "auto extra",
      hasArgument: true,
    });
  });

  it("treats a bare slash as an empty name, so the list can show everything", () => {
    expect(parseSlash("/")).toEqual({ name: "", argument: "", hasArgument: false });
    expect(suggest(parseSlash("/"))).toHaveLength(COMMANDS.length);
  });
});

describe("what gets suggested", () => {
  it("narrows by prefix as you type", () => {
    expect(suggest(parseSlash("/f")).map((c) => c.name)).toEqual(["file", "folder"]);
    expect(suggest(parseSlash("/fo")).map((c) => c.name)).toEqual(["folder"]);
  });

  it("offers nothing for a name that matches none", () => {
    expect(suggest(parseSlash("/zzz"))).toEqual([]);
  });

  it("stops competing for keys once an argument is being typed", () => {
    // Otherwise the picker eats the arrow keys while you are choosing a mode.
    const showing = suggest(parseSlash("/mode a"));
    expect(showing.map((c) => c.name)).toEqual(["mode"]);
  });

  it("shows nothing at all for ordinary text", () => {
    expect(suggest(parseSlash("hello"))).toEqual([]);
  });
});

describe("the scope boundary", () => {
  it("produces an intent for auto rather than a mode change", () => {
    /**
     * THE ONE THAT MATTERS. `/mode auto` must not arm anything. It yields the same intent as
     * every other mode, and the panel routes it through `armAuto()`, which is a window main
     * owns. If this ever returned something that skipped that, typing would grant a capability
     * clicking does not.
     */
    const intent = resolve("/mode auto");
    expect(intent).toEqual({ kind: "mode", mode: "auto" });
  });

  it("has an intent kind for every command, and no command without one", () => {
    // Total mapping: adding a command without deciding what it does fails here.
    for (const command of COMMANDS) {
      const argument = command.argument === undefined ? "" : SELECTABLE_MODES[0]!;
      expect(command.intent(argument), command.name).not.toBeNull();
    }
  });

  it("names only intents the panel can satisfy locally", () => {
    // The enumerable list of everything typing can cause. Widening it should be a visible diff.
    const kinds = new Set(
      COMMANDS.map((c) => c.intent(c.argument === undefined ? "" : SELECTABLE_MODES[0]!)!.kind)
    );
    expect([...kinds].sort()).toEqual(["clear", "history", "mode", "models", "pick"]);
  });

  it("reads the mode list from the shared module rather than restating it", () => {
    // A fifth mode should be typeable the moment it is selectable anywhere.
    for (const mode of SELECTABLE_MODES) {
      expect(resolve(`/mode ${mode}`), mode).toEqual({ kind: "mode", mode });
    }
  });

  it("refuses a mode that is not selectable", () => {
    // Including one that exists internally but is not offered by the select.
    expect(resolve("/mode godmode")).toBeNull();
    expect(resolve("/mode ")).toBeNull();
  });
});

describe("unknown commands", () => {
  it("are sent as literal text, not swallowed", () => {
    /**
     * A typo must not discard what someone wrote. `resolve` returning null is the panel's signal
     * to send the text unchanged, so `/flie notes.md` arrives as a message rather than vanishing.
     */
    expect(resolve("/flie")).toBeNull();
    expect(resolve("/nonsense with arguments")).toBeNull();
  });

  it("leave ordinary messages alone", () => {
    expect(resolve("what does this file do?")).toBeNull();
    expect(resolve("see http://example.com/file")).toBeNull();
  });
});

describe("completion", () => {
  it("leaves the cursor ready for an argument when one is wanted", () => {
    const mode = COMMANDS.find((c) => c.name === "mode")!;
    expect(complete(mode)).toBe("/mode ");
  });

  it("does not add a trailing space to a command that takes none", () => {
    const clear = COMMANDS.find((c) => c.name === "clear")!;
    expect(complete(clear)).toBe("/clear");
  });
});

describe("the command table", () => {
  it("has unique names", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every command a hint, because the list is the only documentation", () => {
    for (const command of COMMANDS) {
      expect(command.hint.length, command.name).toBeGreaterThan(0);
    }
  });

  it("uses no name with a space in it, which the parser could not address", () => {
    for (const command of COMMANDS) expect(command.name).not.toContain(" ");
  });
});
