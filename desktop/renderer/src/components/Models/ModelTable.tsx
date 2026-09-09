"use client";

import { motion } from "framer-motion";
import type { FitTier } from "@shared/hardware-types";
import type { Ranked } from "@/lib/models/group";
import { describeContext, describeModel } from "@/lib/models/describe";
import type { Pull } from "@/lib/models/usePulls";
import { installedTagFor, isInstalled } from "@/lib/models/installed";

/**
 * The model table, and the toolbar that filters it.
 *
 * A table because every column is a comparison: choosing between a 14B at Q4 and a 7B at Q8
 * means reading their VRAM requirements against each other, and a stack of cards makes that
 * the reader's job.
 *
 * **The search lives here rather than in the page hero.** It filters these rows and used to sit
 * roughly 700px above them, on the far side of the hardware panel — so the control and the
 * thing it controlled were never on screen together. It is welded to the table now, along with
 * the capability filters, in a sticky strip.
 *
 * **`overflow-x-auto` is on an inner wrapper, not on the bordered container.** A `sticky`
 * child of a scroll container sticks to that container, and a horizontal scroller has no
 * vertical range — the toolbar would have looked sticky in the markup and done nothing. Same
 * reason there is no `sticky` on `thead`.
 *
 * Six columns, down from seven. Params and Quantisation were always read together and are one
 * "Build" cell; the format left its column because it read "GGUF" twenty-one times.
 */

/**
 * How each fit tier is written and coloured.
 *
 * `line2` is deliberately the same `text-ink-3` for `offload` and `cpu-only`. An opacity
 * ladder between two 10px greys is a distinction no eye resolves — a signal that looks like
 * information and carries none. The words differ, and that is what does the work.
 */
export const TIER: Record<FitTier, { label: string; dot: string; line2: string; rank: string }> = {
  comfortable: {
    label: "Optimal",
    dot: "border-status-up/40",
    line2: "text-status-up/80",
    rank: "Fits with headroom to spare",
  },
  tight: {
    label: "Stretching",
    dot: "border-line-strong",
    line2: "text-ink-3",
    rank: "Fits, with nothing left over",
  },
  offload: {
    label: "Partial",
    dot: "border-line-strong",
    line2: "text-ink-3",
    rank: "Some layers run on the CPU",
  },
  "cpu-only": {
    label: "CPU only",
    dot: "border-line-strong",
    line2: "text-ink-3",
    rank: "No GPU acceleration",
  },
  "wont-fit": {
    label: "Incompatible",
    dot: "border-diff-remove-ink/50",
    line2: "text-ink-3",
    rank: "Will not run on this machine",
  },
};

/** Best to worst. `fit.ts` ranks in this order too. */
export const TIER_ORDER: FitTier[] = ["comfortable", "tight", "offload", "cpu-only", "wont-fit"];

/**
 * A restatement of the calibrated tier, not a second opinion.
 *
 * A lookup with no thresholds and no arithmetic — it cannot disagree with `fit.ts` because it
 * does not compute anything. It is the same predicate `Action` already uses to decide whether
 * downloading is blocked, and the tier itself survives verbatim one line below on every row.
 */
export const STATUS: Record<FitTier, "matched" | "not-matched"> = {
  comfortable: "matched",
  tight: "matched",
  offload: "matched",
  "cpu-only": "matched",
  "wont-fit": "not-matched",
};

interface ModelTableProps {
  rows: Ranked[];
  /** The one row that answers "which should I install". Not a tier — exactly one, or none. */
  recommendedId: string | null;
  installed: ReadonlySet<string>;
  pulls: ReadonlyMap<string, Pull>;
  /** Why downloading is unavailable at all, or null when it is available. */
  cannotDownload: string | null;
  query: string;
  onQueryChange: (next: string) => void;
  /** The capability segments and the expand toggle, rendered into the toolbar's right side. */
  filters: React.ReactNode;
  /** Counts and the "showing N of M" sentence, rendered into the footer strip. */
  footer: React.ReactNode;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onDismiss: (id: string) => void;
}

export default function ModelTable({
  rows,
  recommendedId,
  installed,
  pulls,
  cannotDownload,
  query,
  onQueryChange,
  filters,
  footer,
  onPull,
  onRemove,
  onDismiss,
}: ModelTableProps) {
  return (
    <div className="rounded-xl border border-line">
      {/* The toolbar. Sticky against the page scroller, which is why it sits outside the
          horizontal wrapper below rather than inside it. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-line-strong bg-ide-bar/90 px-3 py-2 backdrop-blur-sm">
        <label className="relative flex min-w-[14rem] flex-1 items-center">
          <span className="sr-only">Search models</span>
          {/* Inline SVG rather than a `⌕` glyph: the character renders differently per font
              and is missing from some, which is why the icon policy exists. */}
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-ink-3"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search by name, architecture, quantisation or licence"
            className="h-8 w-full rounded-md border border-line bg-ide-code pl-7 pr-3 text-sm text-ink-2 placeholder:text-ink-3 focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-ink/30"
          />
        </label>

        <div className="flex flex-wrap items-center gap-1">{filters}</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-3">
              <Th className="w-[26%]">Model</Th>
              <Th className="w-[14%]">Build</Th>
              <Th className="w-[10%] text-right">Context</Th>
              <Th className="w-[14%] text-right">VRAM</Th>
              <Th className="w-[18%]">Status</Th>
              <Th className="w-[18%]">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-sm text-ink-3">
                  Nothing matches that search.
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <Row
                key={row.model.id}
                row={row}
                recommended={row.model.id === recommendedId}
                installed={isInstalled(row.model.id, installed)}
                installedTag={installedTagFor(row.model.id, installed)}
                // One rule where the answer changes, rather than a badge on every row.
                startsTierRun={index > 0 && rows[index - 1]!.fit.tier !== row.fit.tier}
                pull={pulls.get(row.model.id)}
                cannotDownload={cannotDownload}
                onPull={onPull}
                onRemove={onRemove}
                onDismiss={onDismiss}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-ink-3">
        {footer}
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-3 py-2 font-medium ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Row({
  row,
  recommended,
  installed,
  installedTag,
  startsTierRun,
  pull,
  cannotDownload,
  onPull,
  onRemove,
  onDismiss,
}: {
  row: Ranked;
  recommended: boolean;
  installed: boolean;
  installedTag: string;
  startsTierRun: boolean;
  pull: Pull | undefined;
  cannotDownload: string | null;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const described = describeModel(row.model);
  const context = describeContext(row.model, row.fit);
  const tier = TIER[row.fit.tier];
  const status = STATUS[row.fit.tier];

  return (
    <tr
      className={`border-b border-line last:border-0 transition-colors hover:bg-ide-bar/40 ${
        startsTierRun ? "border-t border-t-line-strong" : ""
      } ${recommended ? "bg-ide-bar/30" : installed ? "bg-ide-bar/15" : ""}`}
    >
      <td className="relative px-3 py-2">
        {/*
          One channel, two weights. Recommended takes `ink` because it is the answer;
          installed takes `line-strong` because it is inventory. Spending the app's scarcest
          value on "you already own this" would invert the hierarchy.
        */}
        {(recommended || installed) && (
          <span
            aria-hidden
            className={`absolute inset-y-1 left-0 w-0.5 ${recommended ? "bg-ink" : "bg-line-strong"}`}
          />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-ink">{described.architecture}</span>
          <span className="truncate font-mono text-[11px] text-ink-3" title={row.model.id}>
            {row.model.id}
            {installed && <span className="text-ink-2"> · installed</span>}
          </span>
        </div>
      </td>

      <td className="px-3 py-2 font-mono text-ink-2" title={`${described.format} format`}>
        {described.parameters} · {described.quantisation}
      </td>

      <td className="px-3 py-2 text-right">
        <span
          className={`font-mono tabular-nums ${context.reduced ? "text-ink-3" : "text-ink-2"}`}
          title={context.title}
        >
          {context.label}
          {/* A 14B showing 4k rather than its 32k maximum is the most surprising number here. */}
          {context.reduced && <span aria-hidden>*</span>}
        </span>
      </td>

      <td className="px-3 py-2 text-right">
        {/*
          Required against usable — two numbers `fit.ts` already returns, plotted. The bar is
          not a verdict, it is the ratio the verdict was computed from, which is why it can sit
          beside the tier without competing with it.
        */}
        <div className="flex flex-col items-end gap-1" title={row.fit.explanation}>
          <span className="font-mono tabular-nums text-ink-2">
            {row.fit.requiredGB.toFixed(1)}
            <span className="text-ink-3"> / {row.fit.usableGB.toFixed(1)}</span>
          </span>
          <span aria-hidden className="block h-px w-full max-w-[5rem] bg-ide-raised">
            <span
              className="block h-px bg-ink-3"
              style={{
                // Guarded: a machine with no GPU has `usableGB` at 0 and the division would
                // render NaN, which silently collapses the bar rather than filling it.
                width:
                  row.fit.usableGB > 0
                    ? `${Math.min(100, (row.fit.requiredGB / row.fit.usableGB) * 100)}%`
                    : "100%",
              }}
            />
          </span>
        </div>
      </td>

      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          {/* Exactly one pill on the whole screen, and it marks the answer. */}
          {recommended ? (
            <span
              title="Best fit for this hardware in the current view. Not what the assistant runs — that is chosen separately."
              className="inline-flex w-fit items-center rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium leading-none text-void-0"
            >
              Recommended
            </span>
          ) : status === "matched" ? (
            <span className="text-[12px] leading-none text-ink-2">Matched</span>
          ) : (
            <span className="text-[12px] leading-none text-diff-remove-ink">Not matched</span>
          )}

          {/* The tier verbatim, plus the throughput projection that was computed and never
              rendered. A screen reader reads "Recommended, Optimal · ~84 tok/s". */}
          <span
            title={`${tier.rank}. ${row.fit.explanation}`}
            className={`font-mono text-[10px] leading-none ${tier.line2}`}
          >
            {tier.label}
            {row.fit.tier !== "wont-fit" &&
              ` · ~${Math.round(row.fit.estimatedTokensPerSecond)} tok/s`}
          </span>
        </div>
      </td>

      <td className="px-3 py-2 text-right">
        <Action
          row={row}
          installed={installed}
          installedTag={installedTag}
          pull={pull}
          cannotDownload={cannotDownload}
          onPull={onPull}
          onRemove={onRemove}
          onDismiss={onDismiss}
        />
      </td>
    </tr>
  );
}

/**
 * One control, four states: download, downloading, installed, failed.
 *
 * The progress state replaces the button rather than sitting beside it — a download that can
 * be started twice is a download that will be, and Ollama would happily run two.
 */
function Action({
  row,
  installed,
  installedTag,
  pull,
  cannotDownload,
  onPull,
  onRemove,
  onDismiss,
}: {
  row: Ranked;
  installed: boolean;
  /** What Ollama calls it, which may lack the catalogue's quantisation suffix. */
  installedTag: string;
  pull: Pull | undefined;
  cannotDownload: string | null;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const id = row.model.id;

  if (pull?.phase === "pulling") {
    return (
      <div className="flex min-w-[8rem] flex-col items-end gap-1">
        <div className="h-1 w-full overflow-hidden rounded-full bg-ide-raised">
          <motion.div
            className="h-full rounded-full bg-ink"
            initial={{ width: 0 }}
            animate={{ width: `${Math.round((pull.fraction ?? 0) * 100)}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
          />
        </div>
        {/* Ollama's own status verbatim — "pulling manifest", "verifying sha256" — because
            those words are what the wait is actually made of. */}
        <span className="truncate font-mono text-[10px] text-ink-3">
          {pull.fraction === null
            ? pull.status
            : `${Math.round(pull.fraction * 100)}% · ${pull.status}`}
        </span>
      </div>
    );
  }

  if (pull?.phase === "failed") {
    return (
      <button
        type="button"
        onClick={() => onDismiss(id)}
        title={pull.error ?? undefined}
        className="rounded-md border border-diff-remove-ink/50 px-2 py-0.5 text-[11px] text-diff-remove-ink transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        Failed — retry
      </button>
    );
  }

  if (installed || pull?.phase === "done") {
    return (
      <button
        type="button"
        onClick={() => onRemove(installedTag)}
        title={`Remove ${installedTag} from this machine`}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-diff-remove-ink/50 hover:text-diff-remove-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        Remove
      </button>
    );
  }

  /**
   * A model that cannot run cannot be downloaded.
   *
   * The whole justification for `fit.ts` is not letting someone watch a 9 GB download finish
   * and then OOM. Offering the button anyway would make the calculation decorative.
   */
  const blocked =
    row.fit.tier === "wont-fit"
      ? row.fit.explanation
      : cannotDownload !== null
        ? cannotDownload
        : null;

  return (
    <button
      type="button"
      onClick={() => onPull(id)}
      disabled={blocked !== null}
      title={blocked ?? `Download ${row.model.downloadGB} GB`}
      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      Download {row.model.downloadGB} GB
    </button>
  );
}
