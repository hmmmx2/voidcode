/**
 * The accelerator parser and matcher.
 *
 * Every failure here is silent in the product: a shortcut that does nothing, or — worse — one
 * that fires when it should not and swallows a key Monaco needed. So the tests are about the
 * edges rather than the happy path: exact modifier matching, `CmdOrCtrl` meaning different
 * things on different platforms, and the punctuation keys the table actually uses.
 *
 * Pure functions over a plain object, so no DOM and no Electron.
 */
import { describe, it, expect } from "vitest";
import type { CommandId } from "../src/shared/commands.js";
import {
  parseAccelerator,
  parseAllAccelerators,
  matches,
  allowsRepeat,
  UnknownAcceleratorError,
  type Binding,
} from "../renderer/src/lib/shell/keybindings.js";
import { COMMAND_ACCELERATORS, COMMAND_IDS } from "../src/shared/commands.js";

/** A `KeyboardEvent` as far as `matches` is concerned. */
function event(
  code: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}
): KeyboardEvent {
  return {
    code,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  } as KeyboardEvent;
}

const parse = (accelerator: string): Binding =>
  parseAccelerator("run.execute" as CommandId, accelerator);

describe("parsing", () => {
  it("maps letters, digits and function keys to physical codes", () => {
    expect(parse("CmdOrCtrl+B").code).toBe("KeyB");
    expect(parse("CmdOrCtrl+1").code).toBe("Digit1");
    expect(parse("F12").code).toBe("F12");
    expect(parse("F2").code).toBe("F2");
  });

  it("maps the punctuation the table actually uses", () => {
    // These are the ones that would silently never fire if the map missed them.
    expect(parse("CmdOrCtrl+,").code).toBe("Comma");
    expect(parse("CmdOrCtrl+/").code).toBe("Slash");
    expect(parse("CmdOrCtrl+.").code).toBe("Period");
    expect(parse("CmdOrCtrl+Shift+`").code).toBe("Backquote");
  });

  it("maps named keys", () => {
    expect(parse("CmdOrCtrl+Enter").code).toBe("Enter");
    expect(parse("Alt+Left").code).toBe("ArrowLeft");
    expect(parse("Shift+Alt+Right").code).toBe("ArrowRight");
    expect(parse("Alt+Up").code).toBe("ArrowUp");
  });

  it("collects every modifier", () => {
    const binding = parse("CmdOrCtrl+Shift+Alt+K");
    expect(binding).toMatchObject({ cmdOrCtrl: true, shift: true, alt: true, code: "KeyK" });
  });

  it("distinguishes CmdOrCtrl from a literal Ctrl", () => {
    expect(parse("Ctrl+K")).toMatchObject({ ctrl: true, cmdOrCtrl: false });
    expect(parse("CmdOrCtrl+K")).toMatchObject({ ctrl: false, cmdOrCtrl: true });
  });

  it("throws on a key it cannot map rather than returning a dead binding", () => {
    // The whole point of this phase is removing shortcuts that do nothing. A parser that
    // silently produced an unmatchable binding would put one straight back.
    expect(() => parse("CmdOrCtrl+Nonsense")).toThrow(UnknownAcceleratorError);
    expect(() => parse("Meh+K")).toThrow(UnknownAcceleratorError);
    expect(() => parse("")).toThrow(UnknownAcceleratorError);
  });

  it("parses every accelerator in the shipped table", () => {
    // Runs at module load in the app too, so a malformed entry fails loudly everywhere —
    // but this is where it gets caught before anyone launches.
    const bindings = parseAllAccelerators();
    const withAccelerators = COMMAND_IDS.filter((id) => COMMAND_ACCELERATORS[id] !== null);
    expect(bindings).toHaveLength(withAccelerators.length);
  });

  it("gives no two commands the same chord", () => {
    // A duplicate would mean the first match wins and the second is dead — exactly the class
    // of silently-broken shortcut this phase exists to remove.
    const chords = parseAllAccelerators().map(
      (b) => `${String(b.cmdOrCtrl)}${String(b.ctrl)}${String(b.meta)}${String(b.alt)}${String(b.shift)}${b.code}`
    );
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe("matching", () => {
  it("fires on the right chord", () => {
    const binding = parse("CmdOrCtrl+B");
    expect(matches(binding, event("KeyB", { ctrl: true }), false)).toBe(true);
  });

  it("requires modifiers to match EXACTLY", () => {
    const binding = parse("CmdOrCtrl+K");

    // Without this, Ctrl+K would also fire on Ctrl+Shift+K, and every unshifted binding
    // would swallow its shifted neighbour.
    expect(matches(binding, event("KeyK", { ctrl: true, shift: true }), false)).toBe(false);
    expect(matches(binding, event("KeyK", { ctrl: true, alt: true }), false)).toBe(false);
    expect(matches(binding, event("KeyK"), false)).toBe(false);
  });

  it("reads CmdOrCtrl as Command on macOS and Control elsewhere", () => {
    const binding = parse("CmdOrCtrl+S");

    expect(matches(binding, event("KeyS", { meta: true }), true)).toBe(true);
    expect(matches(binding, event("KeyS", { ctrl: true }), true)).toBe(false);

    expect(matches(binding, event("KeyS", { ctrl: true }), false)).toBe(true);
    expect(matches(binding, event("KeyS", { meta: true }), false)).toBe(false);
  });

  it("separates the shifted and unshifted forms of one key", () => {
    const run = parse("CmdOrCtrl+Enter");
    const submit = parse("CmdOrCtrl+Shift+Enter");
    const shifted = event("Enter", { ctrl: true, shift: true });

    expect(matches(run, shifted, false)).toBe(false);
    expect(matches(submit, shifted, false)).toBe(true);
  });

  it("matches on the physical key, not the produced character", () => {
    // `Alt+Up` and `Shift+Alt+Right` are in the table, and on macOS Alt+letter produces an
    // entirely different `event.key`. Matching on `code` is what keeps those alive.
    const binding = parse("Shift+Alt+Right");
    expect(matches(binding, event("ArrowRight", { shift: true, alt: true }), true)).toBe(true);
  });

  it("does not confuse two bindings that share a key", () => {
    const toggleRight = parse("CmdOrCtrl+Alt+B");
    const toggleLeft = parse("CmdOrCtrl+B");
    const withAlt = event("KeyB", { ctrl: true, alt: true });

    expect(matches(toggleRight, withAlt, false)).toBe(true);
    expect(matches(toggleLeft, withAlt, false)).toBe(false);
  });
});

describe("auto-repeat", () => {
  it("repeats editing operations and not actions", () => {
    // Holding Alt+Down should keep moving the line; holding Ctrl+Enter must not submit
    // eleven times.
    expect(allowsRepeat("selection.moveLineDown")).toBe(true);
    expect(allowsRepeat("selection.expand")).toBe(true);

    expect(allowsRepeat("run.submit")).toBe(false);
    expect(allowsRepeat("run.execute")).toBe(false);
    expect(allowsRepeat("file.openFolder")).toBe(false);
    expect(allowsRepeat("view.commandPalette")).toBe(false);
  });
});
