"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { highlight, rankPaths } from "@/lib/build/fuzzy";

/**
 * Pick a file or folder from the project, by typing part of its path.
 *
 * **There is no file-open dialog to reuse.** `fs.openProject()` is a *directory* picker — it
 * grants a root, which is a privilege change, not a way to choose a file. Everything the
 * assistant can be given must already be inside the granted root, so the honest picker is one
 * over the tree this window already has: no new IPC, no new capability, and nothing outside the
 * project is even nameable.
 *
 * The ranking is `fuzzy.ts` and is tested there. This component holds the query, the cursor and
 * the keyboard, and nothing else — the same division `CommandPalette` uses, which is why the two
 * feel identical to use.
 */

interface QuickOpenProps {
  /** Project-relative paths, in tree order. Files or folders depending on what was asked for. */
  paths: readonly string[];
  title: string;
  placeholder: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Enough to fill the list twice over without ranking four thousand paths on every keystroke. */
const LIMIT = 50;

export default function QuickOpen({
  paths,
  title,
  placeholder,
  onPick,
  onClose,
}: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => rankPaths(query, paths, LIMIT), [query, paths]);

  // Typing changes the list under the cursor; leaving it where it was would select whatever
  // happened to land there.
  useEffect(() => setIndex(0), [query]);

  useEffect(() => inputRef.current?.focus(), []);

  // Keep the active row on screen when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (path: string | undefined): void => {
    if (path === undefined) return;
    onPick(path);
    onClose();
  };

  return (
    <div
      // Click-away closes. On the backdrop rather than a document listener, so it cannot fire
      // for a click that started inside the dialog and ended outside it during a drag.
      onMouseDown={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center bg-void-0/60 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[36rem] max-w-[80vw] overflow-hidden rounded-2xl border border-line-strong bg-ide-panel shadow-[var(--shadow-panel)]"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          aria-label={title}
          role="combobox"
          aria-expanded
          aria-controls="quick-open-list"
          aria-activedescendant={matches[index] === undefined ? undefined : `quick-open-${index}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]?.path);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
        />

        <ul id="quick-open-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {matches.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-3">
              {paths.length === 0 ? "Nothing to choose from" : "No matches"}
            </li>
          )}

          {matches.map((match, i) => {
            const cut = match.path.lastIndexOf("/") + 1;
            return (
              <li
                key={match.path}
                id={`quick-open-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(match.path);
                }}
                onMouseEnter={() => setIndex(i)}
                className={`cursor-pointer px-4 py-1.5 text-[13px] ${
                  i === index ? "bg-ide-raised text-ink" : "text-ink-2"
                }`}
              >
                {/*
                  Name first, then its folder, dimmed. A list of full paths is a wall of
                  `src/components/...` where the only part that differs is at the end — putting
                  the basename first is what makes the list scannable at a glance.
                */}
                <span className="font-mono">
                  {renderPath(match.path, match.positions, cut)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * Draw a path with its matches marked and its basename brightened.
 *
 * The offset is accumulated as the segments are walked rather than recovered with `indexOf`,
 * which was the first version and is wrong the moment a path repeats a fragment — `src/src/a.ts`
 * would locate every segment at the first occurrence and mark the wrong characters.
 */
function renderPath(
  path: string,
  positions: readonly number[],
  cut: number
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let offset = 0;

  for (const [index, segment] of highlight(path, positions).entries()) {
    const start = offset;
    offset += segment.text.length;

    // A segment can straddle the boundary between the directory and the basename.
    const pieces =
      cut > start && cut < start + segment.text.length
        ? [
            { text: segment.text.slice(0, cut - start), inName: false },
            { text: segment.text.slice(cut - start), inName: true },
          ]
        : [{ text: segment.text, inName: start >= cut }];

    for (const [piece, part] of pieces.entries()) {
      nodes.push(
        <span
          key={`${index}-${piece}`}
          className={
            part.inName
              ? segment.hit
                ? "text-ink underline decoration-ink-3 underline-offset-2"
                : "text-ink"
              : segment.hit
                ? "text-ink-2"
                : "text-ink-3"
          }
        >
          {part.text}
        </span>
      );
    }
  }
  return nodes;
}
