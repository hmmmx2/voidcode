"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IdePanel } from "@/components/app";

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

/**
 * Find in Files, in the left rail.
 *
 * Takes the Explorer's place while searching rather than opening a fourth column — the same
 * arrangement every editor uses, and the reason is width: a results list needs the whole rail
 * to show a path and a line of context without truncating both.
 *
 * The search itself runs in main (`fs:search`), bounded there. This only renders what came
 * back, and says plainly when the bounds cut it short.
 */
export default function SearchPanel({
  onOpenMatch,
  onClose,
}: {
  /** Path, plus where in it: a hit that opened at line 1 would be a hit you have to find again. */
  onOpenMatch: (path: string, line: number, column: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const [ran, setRan] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * On submit, not on keystroke.
   *
   * A project-wide walk per character would queue searches faster than they finish, and every
   * one of them runs in the main process — the thing the whole UI depends on staying
   * responsive. Debouncing would help; pressing Enter is honest about the cost.
   */
  const run = useCallback(async () => {
    const host = window.host;
    if (host?.fs?.search === undefined || query.trim() === "") return;

    setSearching(true);
    setError(undefined);
    try {
      const result = await host.fs.search({ query });
      setMatches(result.matches);
      setTruncated(result.truncated);
      setRan(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMatches([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <IdePanel className="flex min-h-0 flex-col bg-ide-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Search</span>
        <button
          type="button"
          onClick={onClose}
          title="Back to the file tree"
          className="text-[11px] text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink"
        >
          Explorer
        </button>
      </div>

      <div className="px-3 py-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="Find in files"
          className="w-full rounded-md border border-line bg-ide-code px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {error !== undefined && <p className="px-2 py-3 text-[11px] text-ink-3">{error}</p>}

        {error === undefined && searching && (
          <p className="px-2 py-3 text-[11px] text-ink-3">Searching…</p>
        )}

        {error === undefined && !searching && ran && matches.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-ink-3">No matches.</p>
        )}

        {matches.map((match) => (
          <button
            key={`${match.path}:${match.line}:${match.column}`}
            type="button"
            onClick={() => onOpenMatch(match.path, match.line, match.column)}
            className="block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:bg-ide-raised"
          >
            <span className="block truncate text-[11px] text-ink-3">
              {match.path}:{match.line}
            </span>
            <span className="block truncate font-mono text-[11px] text-ink-2">
              {match.preview}
            </span>
          </button>
        ))}

        {truncated && (
          // Silent truncation reads as "that is all of them". Saying so is the difference
          // between a bounded search and a wrong one.
          <p className="px-2 py-2 text-[11px] text-ink-3">
            Showing the first {matches.length} matches. Narrow the search to see the rest.
          </p>
        )}
      </div>
    </IdePanel>
  );
}
