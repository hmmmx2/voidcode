"use client";

import { useMemo, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";

/**
 * A typeset equation.
 *
 * On a platform whose premise is "read the maths, then implement it", the equation is the
 * specification — so it is authored, unlike shapes and expected outputs, which are derived
 * because they must agree with what the code does. A definition has no reference to disagree
 * with; it *is* the reference.
 *
 * **Copying gives you the LaTeX.** KaTeX emits MathML for assistive technology and HTML for
 * sighted readers, and a plain text selection serialises both — so copying an equation off a
 * page like this normally yields every symbol two or three times, in an order that parses as
 * nothing. On a site where the most common action is "copy the formula and go implement it",
 * that is the defect worth not repeating. The `copy` handler below replaces the clipboard
 * with the source that produced the render.
 */
export function Math({
  latex,
  display = true,
  className,
}: {
  latex: string;
  /** Centred on its own line, versus inline with surrounding text. */
  display?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode: display,
        // Render the error rather than throwing: a malformed expression in content should
        // show as a visibly wrong equation someone fixes, not as a blank panel or a crash
        // that takes the whole problem page with it.
        throwOnError: false,
        // KaTeX's own error colour is a red that does not exist in this palette. Inheriting
        // keeps a broken equation legible instead of introducing a new hue for a failure.
        errorColor: "currentColor",
        output: "htmlAndMathml",
        /**
         * Stated, not left to the default, because it is the whole reason the injection below
         * is safe on model output.
         *
         * `trust: false` is what disables `\href`, `\url`, `\includegraphics`, `\htmlClass`,
         * `\htmlId` and `\htmlStyle` — every KaTeX command that can put an attribute or a URL
         * of the author's choosing into the emitted HTML. With it off, KaTeX escapes what it
         * cannot typeset and the output is markup KaTeX wrote, not markup the input asked for.
         *
         * Writing it here means the guarantee is visible next to the `dangerouslySetInnerHTML`
         * that depends on it, rather than being a default a later upgrade could change quietly.
         */
        trust: false,
      });
    } catch {
      return undefined;
    }
  }, [latex, display]);

  /**
   * Only ever KaTeX's own output.
   *
   * This used to say "never model output", and that stopped being true when `Markdown.tsx`
   * began routing ```` ```math ```` fences here — so it is corrected rather than left standing,
   * because a comment asserting a control that no longer holds is worse than no comment.
   *
   * What makes it still safe is `trust: false` above: KaTeX with trust disabled cannot be made
   * to emit an attribute or URL its input chose, so the string below is markup KaTeX authored
   * from a LaTeX AST. Everything else in this app — prose, code, tool output — is rendered as
   * React text nodes and never reaches an HTML sink at all.
   */
  if (html === undefined) {
    return <code className={cn("font-mono text-[13px] text-ink-2", className)}>{latex}</code>;
  }

  return (
    <span
      ref={ref}
      // Kept on the element so the copy handler has the source without a lookup, and so it
      // is inspectable — someone reading the DOM can see what produced the render.
      data-latex={latex}
      onCopy={(event) => {
        const selection = window.getSelection();
        if (selection === null || ref.current === null) return;
        // Only rewrite when the selection is inside this equation. A selection spanning
        // prose *and* an equation should still copy the prose.
        if (!ref.current.contains(selection.anchorNode)) return;

        event.clipboardData.setData("text/plain", latex);
        event.preventDefault();
      }}
      className={cn(display && "block text-center", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
