/**
 * The one hex literal in the app that cannot be a token, held to the token anyway.
 *
 * xterm's theme takes hex strings — it paints into its own DOM subtree and never sees a CSS
 * variable — so `TERMINAL_THEME` has to restate a colour that `globals.css` already owns. That
 * is exactly how the previous value went wrong: the background was `#1a1a1a` under a comment
 * saying it matched the editor's surface, when the editor's surface is `#050506` and `#1a1a1a`
 * is the panel-body grey three steps lighter. The canvas was a visibly different black from the
 * panel it sat inside, and nothing could notice.
 *
 * Reading the stylesheet is the only thing that keeps the two in step.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_THEME } from "../renderer/src/lib/build/terminal-theme.js";

const CSS = readFileSync(join(__dirname, "../renderer/src/app/globals.css"), "utf8");

/**
 * Resolve a custom property to a literal, following one level of `var()`.
 *
 * `--color-ide-code: var(--gray-990)` is the shape in the file, so a parser that only read the
 * declaration would compare a hex against the string "var(--gray-990)" and pass on both sides
 * being wrong. Comments are stripped first: `globals.css` annotates these lines with the very
 * hex codes being looked for, and a naive match finds the comment rather than the value.
 */
function resolve(name: string): string {
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const declaration = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(withoutComments);
  expect(declaration, `--${name} is not declared in globals.css`).not.toBeNull();

  const value = declaration![1]!.trim();
  const indirect = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  return indirect === null ? value : resolve(indirect[1]!);
}

describe("the terminal's colours", () => {
  it("paints on the same surface as the panel around it", () => {
    // `TerminalPanel`'s container is `bg-ide-code`. If the canvas is any other colour there is a
    // visible seam wherever the shell has not written yet — most of a fresh terminal.
    expect(TERMINAL_THEME.background.toLowerCase()).toBe(resolve("color-ide-code").toLowerCase());
  });

  it("is not the panel grey it used to claim to be", () => {
    // The specific regression. `--gray-800` is a real token and a plausible-looking value; it is
    // simply the wrong one, and was wrong for as long as nobody put the two side by side.
    expect(TERMINAL_THEME.background.toLowerCase()).not.toBe(resolve("gray-800").toLowerCase());
  });

  it("selects with the same grey the editor selects with", () => {
    // Previously unset, so xterm used its own translucent default — a different selection colour
    // from every other surface, which is the exact class of seam this module exists to prevent.
    expect(TERMINAL_THEME.selectionBackground.toLowerCase()).toBe(resolve("gray-600").toLowerCase());
  });

  it("declares exactly the four colours xterm is given, and no ANSI palette", () => {
    /**
     * The list is the point, not the count.
     *
     * A sixteen-colour ANSI ramp in this app's greys was written and rejected: only two chromatic
     * values exist, so red and green map but yellow, blue, magenta and cyan collapse together. The
     * terminal renders other programs' output, and those programs encode meaning in exactly the
     * hues that would collapse — so xterm's own sixteen stay and only the chrome is ours.
     *
     * If an `ansi*` key ever appears here, that decision has been reversed by accident.
     */
    expect(Object.keys(TERMINAL_THEME).sort()).toEqual([
      "background",
      "cursor",
      "foreground",
      "selectionBackground",
    ]);
    expect(Object.keys(TERMINAL_THEME).filter((k) => k.toLowerCase().includes("ansi"))).toEqual([]);
  });

  it("uses six-digit hex, which is all xterm accepts here", () => {
    for (const [key, value] of Object.entries(TERMINAL_THEME)) {
      expect(value, `${key} is not a plain hex colour`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
