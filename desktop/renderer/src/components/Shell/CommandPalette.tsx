"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * ⌘K over destinations and shell commands.
 *
 * Deliberately small for now: it navigates and toggles. Files and problems belong in here
 * too, but a palette that searches everything badly is worse than one that searches a little
 * well — the thing that makes a palette usable is that the first result is right.
 *
 * One of the few surfaces that genuinely floats, so it is one of the few that carries a
 * shadow. Inside the workbench, regions are separated by hairlines and nothing is elevated.
 */

export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned context — the destination an item belongs to, or its shortcut. */
  hint?: string;
  /** Heading this sits under. Items are shown in the order groups first appear. */
  group: string;
  run: () => void;
}

/**
 * Per group, when the query is empty.
 *
 * Opening the palette on a large project would otherwise dump every file and every problem
 * into a scroller, which is a list rather than an answer. Typing narrows past this instantly.
 */
const UNFILTERED_PER_GROUP = 5;

interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
}

export default function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    // Focus after paint; focusing a node that is not in the document yet silently does
    // nothing and the palette opens with the caret elsewhere.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  /**
   * Flat and ordered by group, not nested.
   *
   * The headings are rendered inline when the group changes, so the selectable list stays
   * one array — arrow-key navigation therefore cannot land on a heading, which is the usual
   * way this control goes wrong.
   */
  /**
   * Ids must be unique, because they are React keys.
   *
   * There was a real duplicate here: `DESTINATIONS` yields an entry for the section-less
   * `code` destination, and a hardcoded `{ id: "code" }` sat immediately after it — two rows,
   * same label, same key. React reports that as a `console.error`, and the build smoke already
   * collects renderer console errors, so this assertion turns the whole class of mistake into
   * a CI failure rather than a warning nobody reads.
   *
   * Development only: in production a duplicate key is a rendering quirk, not worth the scan.
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      const seen = new Set<string>();
      const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
      console.error(`Command palette has duplicate ids: ${duplicates.join(", ")}`);
    }
  }, [items]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching =
      needle === ""
        ? items
        : items.filter((item) => item.label.toLowerCase().includes(needle));

    const seen = new Map<string, PaletteItem[]>();
    for (const item of matching) {
      const bucket = seen.get(item.group) ?? [];
      if (needle !== "" || bucket.length < UNFILTERED_PER_GROUP) bucket.push(item);
      seen.set(item.group, bucket);
    }
    return [...seen.values()].flat();
  }, [items, query]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    onClose();
    item.run();
  };

  return (
    <div
      // Click-through backdrop rather than a modal overlay: dismissing by clicking away is
      // the behaviour people already have for this control.
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      onMouseDown={onClose}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        /*
         * Glass here is correct where it would be wrong on a panel: this floats over the
         * workbench, so `backdrop-filter` has real content to sample rather than the flat
         * neighbouring panel that makes IDE glass look like grey plastic.
         *
         * `.glass-edge` supplies the hairline that is brighter along the top — the detail
         * that reads as a lit curved edge rather than a translucent box. Opaque by default,
         * film added only under `@supports`, matching `GlassSurface`: the other way round, a
         * browser without `backdrop-filter` gets a white haze over the editor with no blur
         * to separate them, which is unreadable rather than merely plainer.
         */
        className="glass-edge relative w-[36rem] max-w-[80vw] overflow-hidden rounded-2xl border border-line-strong bg-ide-panel/95 shadow-[var(--shadow-panel)] supports-[backdrop-filter]:bg-white/[0.045] supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-150"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") return onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]);
            }
          }}
          placeholder="Search files, problems and commands…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
        />

        <ul className="max-h-80 overflow-y-auto py-1">
          {matches.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-3">No matches</li>
          )}
          {matches.map((item, i) => (
            <li key={item.id}>
              {(i === 0 || matches[i - 1]?.group !== item.group) && (
                // `aria-hidden` because the group is already announced per item through the
                // hint; reading the heading again would double every result.
                <p
                  aria-hidden
                  className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-[0.12em] text-ink-3 first:pt-1"
                >
                  {item.group}
                </p>
              )}
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(item)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  i === index ? "bg-ide-raised text-ink" : "text-ink-2"
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.hint !== undefined && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-ink-3">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
