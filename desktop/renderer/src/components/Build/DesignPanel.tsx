"use client";

import { useEffect, useMemo, useState } from "react";
import type { DesignSpec } from "@shared/design";
import { unknownTokens } from "@shared/design";
import type { DesignToken } from "@shared/design-tokens";

/**
 * A design, shown as a specification with its claims checked.
 *
 * **The check is the reason this is not just formatted prose.** A section says it uses
 * `color-line`; the project's own CSS either declares that or it does not. A spec naming three
 * tokens the codebase lacks is a design that will not build, and the difference between finding
 * that out here and finding it out when the CSS compiles to nothing is the whole argument for
 * generating a spec rather than a picture.
 *
 * Tokens are shown by name with their resolved value, not as a colour swatch alone. A swatch
 * says what the colour is today; the name says what it will still be after the palette moves,
 * which is what the design actually committed to.
 */
export default function DesignPanel({
  host,
  spec,
  projectRoot,
}: {
  host: NonNullable<Window["host"]>;
  spec: DesignSpec | null;
  /** Re-read the project's tokens when the project changes — the answer is about that project. */
  projectRoot: string | undefined;
}) {
  const [tokens, setTokens] = useState<DesignToken[] | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setTokens(undefined);
    void host.design
      ?.tokens()
      .then((result) => {
        if (alive) setTokens(result.tokens);
      })
      .catch(() => {
        // No project open, or no stylesheet where one is conventionally kept. Both mean the same
        // thing to the only question this drives: there is nothing to check names against.
        if (alive) setTokens([]);
      });
    return () => {
      alive = false;
    };
  }, [host, projectRoot]);

  const byName = useMemo(() => {
    const map = new Map<string, DesignToken>();
    for (const token of tokens ?? []) map.set(token.name, token);
    return map;
  }, [tokens]);

  const missing = useMemo(
    // Nothing is checked until the tokens have arrived: reporting every name as unknown while
    // the read is still in flight would flash a page of red on every project open.
    () =>
      spec === null || tokens === undefined
        ? new Set<string>()
        : new Set(unknownTokens(spec, [...byName.keys()])),
    [spec, tokens, byName]
  );

  if (spec === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="max-w-xs">
          <h2 className="text-[13px] font-medium text-ink-2">No design yet</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
            Ask the assistant to design a screen and its spec appears here, with the tokens it
            uses checked against this project.
          </p>
          {tokens !== undefined && tokens.length > 0 && (
            <p className="mt-2 font-mono text-[10px] text-ink-3">
              {tokens.length} tokens found in this project
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[80ch] flex-col gap-3">
      <header>
        <h2 className="text-sm font-medium text-ink">{spec.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">{spec.intent}</p>
      </header>

      {missing.size > 0 && (
        /*
          The finding, above the sections rather than buried in them.

          It is the one thing on this surface that means work: every other line describes an
          intention, and this says the intention cannot be carried out as written.
        */
        <p className="rounded border border-diff-remove-ink/40 bg-diff-remove-ink/10 px-2 py-1.5 text-xs text-diff-remove-ink">
          {missing.size === 1
            ? "1 token named here is not defined in this project. It is marked below."
            : `${String(missing.size)} tokens named here are not defined in this project. They are marked below.`}
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {spec.sections.map((section, index) => (
          // Index as key: a spec is replaced wholesale by a new write_design_spec call, never
          // reordered in place.
          <li key={index} className="border-l-2 border-line pl-2.5">
            <h3 className="text-xs font-medium text-ink-2">{section.name}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{section.purpose}</p>

            {section.tokens !== undefined && section.tokens.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {section.tokens.map((name) => (
                  <TokenChip
                    key={name}
                    name={name}
                    token={byName.get(name.replace(/^--/, ""))}
                    unknown={missing.has(name)}
                  />
                ))}
              </ul>
            )}

            {section.notes !== undefined && section.notes.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {section.notes.map((note, noteIndex) => (
                  <li key={noteIndex} className="text-xs text-ink-3">
                    — {note}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One token: its name, whether the project has it, and what it resolves to.
 *
 * The swatch is drawn from the *resolved* value, so a token defined as `var(--gray-950)` shows
 * the grey rather than nothing. It is deliberately small and beside the name rather than instead
 * of it — the name is what the design committed to.
 */
function TokenChip({
  name,
  token,
  unknown,
}: {
  name: string;
  token: DesignToken | undefined;
  unknown: boolean;
}) {
  const swatch = token?.kind === "color" ? token.resolved : null;

  return (
    <li
      title={unknown ? "Not defined in this project" : (token?.resolved ?? token?.value ?? name)}
      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
        unknown
          ? "border-diff-remove-ink/40 text-diff-remove-ink"
          : "border-line text-ink-3"
      }`}
    >
      {swatch !== null && (
        // `aria-hidden`: the name beside it already says which token this is, and a screen
        // reader announcing "swatch" for every chip is noise.
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-[2px] border border-line"
          style={{ background: swatch }}
        />
      )}
      {name}
      {/* A cross rather than colour alone, so the finding survives being read in greyscale or
          by someone who cannot separate the two reds. */}
      {unknown && <span aria-label="not defined">✕</span>}
    </li>
  );
}
