"use client";

import { useCallback, useEffect, useState } from "react";
import { IdePanel, IdeBar, useToast } from "@/components/app";

/**
 * Project memory, in the left rail.
 *
 * Takes the Explorer's place while open, like Search — the same arrangement, and the same
 * reason: a results list needs the whole rail to show a path, a line and a snippet without
 * truncating all three.
 *
 * The panel exists mostly to make indexing an *explicit* act with visible consequences. There
 * is no automatic trigger anywhere: a folder picker that quietly starts reading thousands of
 * files and running a model over them is not something anyone asked for, and on a large
 * repository it looks like the app has hung. So the button says what it will do, the progress
 * says how far it got, and the status says plainly when the index is incomplete or stale.
 */

interface MemoryStatus {
  indexed: boolean;
  consent: "granted" | "declined" | "unasked";
  chunkCount: number;
  fileCount: number;
  truncated: boolean;
  updatedAt: string | null;
  embeddingsAvailable: boolean;
  location: string;
}

interface MemoryHit {
  chunk: { path: string; startLine: number; endLine: number; text: string; symbol: string | null };
  score: number;
  stale: boolean;
}

export default function MemoryPanel({
  onOpenMatch,
  onClose,
}: {
  onOpenMatch: (path: string) => void;
  onClose: () => void;
}) {
  const notify = useToast();
  const [status, setStatus] = useState<MemoryStatus | undefined>(undefined);
  const [progress, setProgress] = useState<
    { phase: string; done: number; total: number } | undefined
  >(undefined);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [ran, setRan] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.host?.memory?.status());
    } catch {
      // No project, or memory is unavailable in this window. The empty state is correct.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => window.host?.onMemoryProgress?.(setProgress), []);

  const index = useCallback(async () => {
    const memory = window.host?.memory;
    if (memory === undefined) return;

    setProgress({ phase: "scanning", done: 0, total: 0 });
    try {
      const result = await memory.index({});
      notify(
        result.chunks === 0 ? "Nothing to index" : `Indexed ${result.indexed} files`,
        result.truncated
          ? {
              // Silent truncation reads as "that is all of it", which is the failure this
              // whole feature would otherwise introduce quietly.
              detail: `${result.skipped} files were left out — index a folder for finer coverage.`,
              tone: "warn",
            }
          : {}
      );
      await refresh();
    } catch (err) {
      notify("Could not index this project", {
        detail: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
    } finally {
      setProgress(undefined);
    }
  }, [notify, refresh]);

  const search = useCallback(async () => {
    const memory = window.host?.memory;
    if (memory === undefined || query.trim() === "") return;

    setSearching(true);
    try {
      const result = await memory.search({ query });
      setHits(result.hits);
      setRan(true);
    } catch (err) {
      notify("Search failed", {
        detail: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
    } finally {
      setSearching(false);
    }
  }, [query, notify]);

  const busy = progress !== undefined;

  return (
    <IdePanel className="flex min-h-0 flex-col bg-ide-panel">
      <IdeBar>
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Memory</span>
        <button
          type="button"
          onClick={onClose}
          title="Back to the file tree"
          className="shrink-0 text-[11px] text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink"
        >
          Explorer
        </button>
      </IdeBar>

      <div className="border-b border-line px-3 py-2">
        {status?.embeddingsAvailable === false ? (
          // Naming what to install beats "unavailable", which leaves the user with nowhere
          // to go.
          <p className="text-[11px] leading-relaxed text-ink-3">
            Indexing needs the <code className="text-ink-2">nomic-embed-text</code> model. Pull it
            in Ollama, then come back.
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void index()}
              disabled={busy}
              className="w-full rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
            >
              {busy
                ? `${progress.phase}… ${progress.total > 0 ? `${progress.done}/${progress.total}` : ""}`
                : status?.indexed === true
                  ? "Re-index project"
                  : "Index this project"}
            </button>

            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
              {status?.indexed === true
                ? `${status.fileCount} files, ${status.chunkCount} chunks. Stored in the project at .voidcode/index.`
                : "Reads the project and stores an index inside it. Everything stays on this machine."}
            </p>

            {status?.truncated === true && (
              <p className="mt-1 text-[11px] text-diff-remove-ink">
                The index is incomplete — the project is larger than the cap.
              </p>
            )}
          </>
        )}
      </div>

      <div className="px-3 py-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
          placeholder="Search by meaning"
          disabled={status?.indexed !== true}
          className="w-full rounded-md border border-line bg-ide-code px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink disabled:opacity-40"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {searching && <p className="px-2 py-3 text-[11px] text-ink-3">Searching…</p>}

        {!searching && ran && hits.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-ink-3">Nothing similar found.</p>
        )}

        {hits.map((hit) => (
          <button
            key={`${hit.chunk.path}:${hit.chunk.startLine}`}
            type="button"
            onClick={() => onOpenMatch(hit.chunk.path)}
            className="block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:bg-ide-raised"
          >
            <span className="block truncate text-[11px] text-ink-3">
              {hit.chunk.path}:{hit.chunk.startLine}
              {hit.chunk.symbol !== null && ` — ${hit.chunk.symbol}`}
              {/* Reported, not hidden. A memory that is occasionally and invisibly wrong is
                  worse than one that admits it. */}
              {hit.stale && <span className="ml-1 text-diff-remove-ink">changed since</span>}
            </span>
            <span className="mt-0.5 block max-h-8 overflow-hidden font-mono text-[11px] leading-4 text-ink-2">
              {hit.chunk.text.split("\n").slice(0, 2).join(" ")}
            </span>
          </button>
        ))}
      </div>
    </IdePanel>
  );
}
