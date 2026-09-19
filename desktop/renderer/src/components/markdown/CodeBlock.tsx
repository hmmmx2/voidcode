"use client";

import { useEffect, useState } from "react";
import { useMonaco } from "@monaco-editor/react";
import { colourForToken, styleForToken } from "@/lib/monaco-theme";

/**
 * A fenced code block, highlighted by the editor's own tokenizer.
 *
 * **`editor.tokenize()`, not `editor.colorize()`.** They do the same job and only one of them
 * is safe here: `colorize` returns an HTML *string*, which would have to be injected with
 * `dangerouslySetInnerHTML` — the exact pattern this whole phase exists to remove. `tokenize`
 * returns arrays of `{ offset, type }`, so the spans are built as React elements and model
 * output can never become markup.
 *
 * It also means no new dependency. Monaco is already here for the editor, so chat code blocks
 * are painted from the same theme table the editor uses (`colourForToken`) — a separate
 * highlighter would drift, and a code block in nearly-the-editor's colours reads as a bug.
 *
 * Degrades to plain text on purpose, in three cases that all really happen:
 *   - Monaco has not loaded. `useMonaco()` returns `undefined` before it does — a lesson this
 *     codebase has already paid for once — and chat renders long before the editor is needed.
 *   - The language is unknown, or the fence had no language at all.
 *   - Tokenizing throws. It is a parser being handed a fragment of a half-streamed file.
 */

/** Monaco's ids for the fence languages a coding assistant actually emits. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  html: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  md: "markdown",
  markdown: "markdown",
};

export interface Span {
  text: string;
  colour: string;
  bold: boolean;
  italic: boolean;
}

/** One line's worth of Monaco tokens: a start offset and a scope name. */
export interface Token {
  offset: number;
  type: string;
}

/**
 * Turn Monaco's per-line token arrays into styled spans.
 *
 * EXPORTED FOR A TEST, AND THE REASON IS WORTH STATING. The painting used to be inline in the
 * effect below, where nothing could reach it: effects do not run under `renderToStaticMarkup`,
 * which is what `markdown-render.test.ts` uses and the only reason a component is renderable in
 * this suite at all. So the *fallback* to plain text was covered and the *success* path — the
 * one with all the arithmetic in it — was not, for as long as the fence-highlighting feature has
 * existed. That is the wrong way round: a fence rendering as plain text is what a silently
 * broken Monaco looks like, so the plain-text assertion passes hardest exactly when something
 * is wrong.
 *
 * Two pieces of arithmetic live here and both have an off-by-one available. A token's end is
 * the *next* token's offset, and the last token on a line runs to the end of the line — using
 * the token's own offset as an end would drop every final token. A line Monaco returns no
 * tokens for is emitted whole in the default colour rather than dropped.
 */
export function paintTokens(code: string, tokenized: readonly (readonly Token[])[]): Span[][] {
  return code.split("\n").map((line, index) => {
    const tokens = tokenized[index] ?? [];
    if (tokens.length === 0) {
      return [{ text: line, colour: colourForToken(""), bold: false, italic: false }];
    }
    return tokens.map((token, tokenIndex) => {
      const start = token.offset;
      const end = tokens[tokenIndex + 1]?.offset ?? line.length;
      const style = styleForToken(token.type);
      return {
        text: line.slice(start, end),
        colour: colourForToken(token.type),
        bold: style.bold,
        italic: style.italic,
      };
    });
  });
}

export default function CodeBlock({
  code,
  lang,
  streaming = false,
}: {
  code: string;
  lang: string;
  /** The closing fence has not arrived yet, so this is a block still being written. */
  streaming?: boolean;
}) {
  const monaco = useMonaco();
  const [lines, setLines] = useState<Span[][] | null>(null);
  const [copied, setCopied] = useState(false);

  const language = LANGUAGE_ALIASES[lang.toLowerCase()];

  useEffect(() => {
    // `undefined`, not `null` — `useMonaco()` returns undefined until the loader resolves, and
    // testing for null here is a bug this repo has shipped before.
    if (monaco === undefined || monaco === null || language === undefined) {
      setLines(null);
      return;
    }

    let cancelled = false;
    try {
      const painted = paintTokens(code, monaco.editor.tokenize(code, language));

      if (!cancelled) setLines(painted);
    } catch {
      // A tokenizer handed a fragment of a half-written file. Plain text is a fine answer.
      if (!cancelled) setLines(null);
    }

    return () => {
      cancelled = true;
    };
  }, [monaco, code, language]);

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-line bg-ide-code">
      <div className="flex items-center gap-2 border-b border-line bg-ide-bar px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-3">
          {lang === "" ? "text" : lang}
          {streaming && " · writing"}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="rounded px-1 text-[10px] text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
        <code>
          {lines === null
            ? code
            : lines.map((spans, lineIndex) => (
                <span key={lineIndex}>
                  {spans.map((span, spanIndex) => (
                    <span
                      key={spanIndex}
                      style={{
                        color: span.colour,
                        ...(span.bold ? { fontWeight: 600 } : {}),
                        ...(span.italic ? { fontStyle: "italic" } : {}),
                      }}
                    >
                      {span.text}
                    </span>
                  ))}
                  {lineIndex < lines.length - 1 && "\n"}
                </span>
              ))}
        </code>
      </pre>
    </div>
  );
}
