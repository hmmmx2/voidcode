/**
 * The one hex literal in the app that cannot be a token.
 *
 * xterm paints into its own DOM subtree with colours it is handed as strings; it never resolves
 * a CSS variable, so this has to restate a colour `globals.css` already owns.
 *
 * That is exactly how the previous value went wrong. It was `#1a1a1a`, under a comment saying it
 * matched the editor's surface — but that is `--gray-800`, the panel-body grey, while the
 * terminal sits inside a `bg-ide-code` container resolving to `--gray-990`, three steps darker.
 * The canvas was a visibly different black from the panel around it, on every fresh terminal,
 * and nothing in the codebase could notice because one side was a comment.
 *
 * **Its own module, not a constant inside `TerminalPanel`.** The test that keeps it honest reads
 * `globals.css` and compares, and importing it from the component would pull a `"use client"`
 * React file — and with it `window.host` — into the main tsconfig, which does not have the
 * renderer's ambient types. A pure constant has no such reach.
 *
 * **Still no ANSI palette, and now for a stronger reason than "half a palette is worse than none".**
 * A full sixteen-colour ramp in this app's greys was written and then rejected. The app permits two
 * chromatic values — `--green-400` and `--red-500` — so red and green survive a mapping, but yellow,
 * blue, magenta and cyan have nothing to map to and collapse into the same two or three greys.
 *
 * That trade is wrong here in a way it is not wrong for the rest of the chrome. Every other surface
 * renders *our* content, where monochrome is a design choice we are entitled to make. A terminal
 * renders *other programs'* output, and those programs encode meaning in exactly the hues that would
 * collapse: yellow for warnings, blue for paths, cyan for links. Flattening them destroys
 * information the author deliberately put there, which is closer to recolouring a user's screenshot
 * than to styling a panel. xterm's own sixteen stay.
 *
 * What is here is the terminal's *chrome* — the surface, the text it defaults to, the caret, and the
 * selection. Those are ours.
 */
export const TERMINAL_THEME = {
  background: "#050506",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  /**
   * `--gray-600`, the same value the editor selects with.
   *
   * Previously unset, so xterm fell back to its own translucent default — a different selection
   * colour from everything else in the app, which is the seam this module exists to prevent.
   */
  selectionBackground: "#333333",
} as const;
