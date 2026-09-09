/**
 * A design token, as both sides see it.
 *
 * Lives here rather than in `main/design/tokens.ts` for the reason `plan.ts` and `preview.ts`
 * do: main parses these out of the project's CSS and the renderer draws them, and a second
 * declaration is how the two drift. The parser stays in main, because it is main that reads the
 * project's files.
 */

export type TokenKind = "color" | "font" | "radius" | "spacing" | "shadow" | "other";

export interface DesignToken {
  /** The custom property, without the leading dashes: `color-ink`, not `--color-ink`. */
  name: string;
  /** Exactly as written, `var(--gray-500)` and all. */
  value: string;
  /**
   * The value with `var()` chased to something concrete, or null when it cannot be.
   *
   * Null is a real answer rather than a gap: a token pointing at a property defined somewhere
   * the parser did not read — `next/font` injects `--font-inter` at runtime, for instance — is
   * genuinely unresolved, and showing the raw `var(--x)` is more honest than a guessed colour.
   */
  resolved: string | null;
  kind: TokenKind;
}
