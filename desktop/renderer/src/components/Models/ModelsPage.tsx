"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { HardwareProfile, ModelSpec } from "@shared/hardware-types";
import { familyId, groupByFamily, type Ranked } from "@/lib/models/group";
import { isInstalled, registerCatalogue } from "@/lib/models/installed";
import { describeModel } from "@/lib/models/describe";
import { usePulls } from "@/lib/models/usePulls";
import { reportError } from "@/lib/shell/report-error";
import { NO_MODEL_INSTALLED } from "@/lib/copy";
import { Surface } from "@/components/app";
import MachinePanel from "./MachinePanel";
import VoidCodeAccount from "./VoidCodeAccount";
import ModelTable, { STATUS, TIER, TIER_ORDER } from "./ModelTable";

/**
 * The local model manager.
 *
 * Almost all of this existed in main with no way in. `hw:scan`, `models:list`,
 * `models:recommend` and `models:pull` were implemented and unit-tested for as long as the
 * status bar had a GPU name in it, and the status bar was the only caller — for two strings.
 * `fit.ts` alone is a context-negotiating five-tier fit calculator whose bandwidth constant
 * was calibrated against a measurement on real hardware, and every verdict it produced
 * reached nobody.
 *
 * Four rules the page keeps, each inherited rather than invented:
 *
 * **The catalogue is not an inventory.** `models.list()` is what can be downloaded;
 * `providers.list()` is what is installed. Presenting the first as the second makes a fresh
 * machine look like it already owns twenty models — it briefly did, reporting 340 because
 * OpenRouter's remote catalogue was being counted as local.
 *
 * **`explanation` is shown verbatim.** It is a sentence written to be read, and a badge
 * saying "Stretching" without "needs 12.7 GB of 13.4 usable" gives the conclusion and hides
 * the reason.
 *
 * **`wont-fit` cannot be downloaded.** The justification for the fit module is not letting
 * someone watch a 9 GB download finish and then OOM.
 *
 * **`unknowns` is shown.** The scanner's rule is that every value is measured or absent, so
 * the absences are part of the answer.
 */

/**
 * What the list is filtered to.
 *
 * These were `both | chat | fim`, passed straight through to `recommend()` — where "both"
 * meant the *intersection* while reading like a superset, and quietly removed five models
 * from the page. They are capabilities now, every one of them additive from a complete list.
 *
 * There is no "chat" filter because every model here can chat. A filter that excludes nothing
 * is a control that teaches the user their clicks do not matter — which is also why "Inline
 * completion" has gone: it promised a model that "can drive ghost text", and there is no ghost
 * text to drive.
 */
type Capability = "all" | "vision";

const CAPABILITIES: ReadonlyArray<{ id: Capability; label: string; hint: string }> = [
  { id: "all", label: "All models", hint: "Every model in the catalogue, whether it fits or not" },
  { id: "vision", label: "Vision", hint: "Reads images — screenshots, diagrams, terminal output" },
];

/** What the assistant asks for. `assessFit` halves down from here until a model fits. */
const CONTEXT_TOKENS = 32_768;

interface Loaded {
  profile: HardwareProfile;
  recommendations: Ranked[];
  catalogue: ModelSpec[];
  installed: string[];
  cannotDownload: string | null;
}

export default function ModelsPage() {
  const [capability, setCapability] = useState<Capability>("all");
  const [data, setData] = useState<Loaded | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const { pulls, start, dismiss } = usePulls();

  const load = useCallback(
    async (): Promise<Loaded | undefined> => {
      const host = typeof window === "undefined" ? undefined : window.host;
      if (host?.models === undefined) return undefined;

      /**
       * `allSettled`, not `all`. A machine with Ollama stopped still has hardware worth
       * showing, and a provider probe that fails should not blank the catalogue.
       */
      const [recommended, catalogue, providers] = await Promise.allSettled([
        host.models.recommend({ contextTokens: CONTEXT_TOKENS }),
        host.models.list(),
        host.providers.list(),
      ]);

      if (recommended.status === "rejected") return undefined;

      const providerList = providers.status === "fulfilled" ? providers.value.providers : [];
      const puller = providerList.find((p) => p.id === "ollama");

      return {
        profile: recommended.value.profile,
        recommendations: recommended.value.recommendations,
        catalogue: catalogue.status === "fulfilled" ? catalogue.value.models : [],
        // Local backends only. OpenRouter's `models` is its entire remote catalogue, and
        // summing it reported "340 installed" on a machine with three.
        installed: providerList.filter((p) => !p.capabilities.remote).flatMap((p) => p.models),
        cannotDownload:
          puller === undefined
            ? "Ollama is not running, so nothing can be downloaded from here."
            : null,
      };
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await load();
        if (cancelled) return;
        if (next === undefined) {
          setError("Model management is only available in the desktop app.");
          return;
        }
        setData(next);
      } catch (err) {
        if (cancelled) return;
        reportError(err, { region: "models" });
        setError("Could not load the model catalogue.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Re-scan on demand.
   *
   * `scanHardware` caches for 30 seconds in main, so this is not always a fresh probe — and
   * that is fine, because the thing it is really for is picking up a change you just made:
   * starting Ollama, closing a game that was holding VRAM, freeing disk. The minimum visible
   * duration exists because a scan that returns from cache in 4ms produces a flash rather
   * than feedback, and a button that appears not to have worked gets pressed again.
   */
  const rescan = useCallback(async () => {
    setScanning(true);
    const started = Date.now();
    try {
      const next = await load();
      if (next !== undefined) setData(next);
    } catch (err) {
      reportError(err, { region: "models", action: "rescan" });
    } finally {
      const elapsed = Date.now() - started;
      const minimum = 450;
      if (elapsed < minimum) await new Promise((r) => setTimeout(r, minimum - elapsed));
      setScanning(false);
    }
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      const host = typeof window === "undefined" ? undefined : window.host;
      try {
        const result = await host?.models?.remove({ id });
        // `removed: false` is the user cancelling at the native dialog. Not an error, and
        // re-reading the catalogue for a deletion that did not happen would be pointless.
        if (result?.removed === true) {
          const next = await load();
          if (next !== undefined) setData(next);
        }
      } catch (err) {
        reportError(err, { region: "models", action: "remove", id });
      }
    },
    [load]
  );

  /**
   * Everything the capability filter allows, in rank order.
   *
   * Both the recommendation and the legend read from this rather than from `rows`: the
   * recommendation must not change because you typed in the search box, and a legend counting
   * only visible rows would report zero of a state the moment the fold hid it.
   */
  const capable = useMemo(() => {
    if (data === undefined) return [];
    return data.recommendations.filter((row) =>
      capability === "all" ? true : row.model.vision === true
    );
  }, [data, capability]);

  /**
   * The head of the current ranking.
   *
   * `recommend()` ranks by tier and then by descending size, so the first entry is the
   * largest model that fits best — and nothing in the table said which one that was. Ten
   * models share the `comfortable` tier on a 16 GB card, so "Optimal" answers "will this run
   * well" rather than "which should I pick".
   *
   * **It is the best fit, not the best choice for a given job**, and the badge's tooltip says
   * so. With no filter this marks the vision model on this machine, because at 8.3B it is the
   * largest thing that runs comfortably — which is true and is not what someone wanting a
   * coding model should install. That is what the capability filter is for: narrowing to
   * Inline completion re-ranks within the models that can actually drive ghost text.
   *
   * Deliberately not second-guessed here. `pickAgentModel` in main already decides what the
   * assistant runs, using a tool-capability list this page cannot see, and inventing a second
   * preference in the UI would give the app two answers to one question.
   *
   * Null when even the best cannot run, because recommending something that will not start is
   * worse than recommending nothing.
   */
  const recommendedFamily = useMemo(() => {
    const best = capable[0];
    if (best === undefined || best.fit.tier === "wont-fit") return null;
    return familyId(best.model.id);
  }, [capable]);

  /** How many models land in each state, including the ones with none. */
  const tierCounts = useMemo(() => {
    const counts = new Map(TIER_ORDER.map((tier) => [tier, 0]));
    for (const row of capable) counts.set(row.fit.tier, (counts.get(row.fit.tier) ?? 0) + 1);
    return counts;
  }, [capable]);

  /**
   * Rows for the table: one per family by default, every variant when expanded.
   *
   * The recommender returns all twenty-one candidates on purpose — seeing why the 14B was
   * passed over is the point of it — but four rows differing by a suffix and a decimal is
   * how an honest payload becomes noise. Search always looks at everything, because someone
   * typing "q8" is asking for exactly the rows the fold hides.
   */
  const rows = useMemo(() => {
    if (data === undefined) return [];
    const needle = query.trim().toLowerCase();

    // Which bare Ollama tags are unambiguous depends on the whole catalogue, not on one entry,
    // so the alias rule has to see every row the recommender returned before any of them is
    // asked whether it is installed.
    registerCatalogue(data.catalogue);

    const folded = groupByFamily(capable, (id) => isInstalled(id, new Set(data.installed))).map(
      (family) => family.best
    );

    const pool = needle !== "" || showAll ? capable : folded;

    if (needle === "") return pool;
    return pool.filter((row) => {
      const described = describeModel(row.model);
      return [
        row.model.id,
        row.model.label,
        row.model.licence,
        described.architecture,
        described.quantisation,
        described.parameters,
      ].some((field) => field.toLowerCase().includes(needle));
    });
  }, [data, query, showAll, capable]);

  /**
   * The visible row that carries the badge.
   *
   * Marking `capable[0]` directly put the badge on a row the fold had replaced, so selecting
   * Inline completion showed seven Optimal models and recommended none of them — the
   * recommendation existed and had nowhere to sit. Resolving it against the rendered rows
   * means the badge lands on the row standing in for that family, which is the one you can
   * click. Absent only when the family is genuinely not on screen, which search can do.
   */
  const recommendedId = useMemo(() => {
    if (recommendedFamily === null) return null;
    return rows.find((row) => familyId(row.model.id) === recommendedFamily)?.model.id ?? null;
  }, [rows, recommendedFamily]);

  if (error !== undefined) {
    return <p className="page-list text-sm text-ink-3">{error}</p>;
  }

  if (data === undefined) {
    return <p className="page-list text-sm text-ink-3">Reading this machine…</p>;
  }

  const installed = new Set(data.installed);

  /**
   * Counts by status, mirroring exactly what the Status column renders.
   *
   * The three are mutually exclusive because the column is: a row shows Recommended *or*
   * Matched *or* Not matched, never two. Counting the recommended model in both — which it
   * literally is, since it fits — made the footer read "Recommended 1 · Matched 21" for
   * twenty-one models, and a reader who adds them up is owed a total that lands.
   *
   * From the capability-filtered ranking rather than the visible rows, so folding to one row
   * per family does not report six models across three states on a machine holding
   * twenty-one.
   */
  const notMatched = capable.filter((row) => STATUS[row.fit.tier] === "not-matched").length;
  const recommendedCount = recommendedId === null ? 0 : 1;
  const matched = capable.length - notMatched - recommendedCount;

  const filters = (
    <>
      {CAPABILITIES.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => setCapability(option.id)}
          title={option.hint}
          aria-pressed={capability === option.id}
          className={`rounded-md border px-2 py-1 text-[11px] transition-colors duration-150 ease-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
            capability === option.id
              ? "border-line-strong bg-ide-raised text-ink"
              : "border-line text-ink-3 hover:bg-ide-raised hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}

      <span aria-hidden className="mx-1 h-4 w-px bg-line" />

      <button
        type="button"
        onClick={() => setShowAll((open) => !open)}
        aria-pressed={showAll}
        title="Show every quantisation of every model, not just the best fit per family"
        className={`rounded-md border px-2 py-1 text-[11px] transition-colors duration-150 ease-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
          showAll
            ? "border-line-strong bg-ide-raised text-ink"
            : "border-line text-ink-3 hover:bg-ide-raised hover:text-ink"
        }`}
      >
        All quantisations
      </button>
    </>
  );

  /**
   * The footer: status counts, then tier counts, then what is being shown.
   *
   * Both levels are text and both are always on screen. A count behind a tooltip is reachable
   * rather than visible, and the point of showing "Incompatible 0" at all is that the absence
   * is part of the answer.
   */
  const footer = (
    <>
      <span className="flex items-center gap-3">
        <Count label="Recommended" value={recommendedCount} />
        <Count label="Matched" value={matched} />
        <Count label="Not matched" value={notMatched} />
      </span>

      <span aria-hidden className="h-3 w-px bg-line" />

      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {TIER_ORDER.map((tier) => {
          const count = tierCounts.get(tier) ?? 0;
          return (
            <span key={tier} className="flex items-center gap-1.5">
              {/*
                A dashed ring rather than a dimmed one for an empty state.
                
                `opacity-40` was here and it rendered "nothing is Incompatible" as a visual
                default — the same mistake `scan.ts` refuses to make with `unknowns`. Full
                strength, a literal 0, and a marker that reads as "none" rather than "faint".
              */}
              <span
                aria-hidden
                className={`inline-block h-2 w-2 rounded-full border ${
                  count === 0 ? "border-dashed border-line-strong" : TIER[tier].dot
                }`}
              />
              <span title={TIER[tier].rank}>{TIER[tier].label}</span>
              <span className="font-mono tabular-nums">{count}</span>
            </span>
          );
        })}
      </span>

      <span className="w-full text-ink-3">
        Showing {rows.length} of {data.recommendations.length} models in the download catalogue
        {!showAll && query.trim() === "" && capability === "all"
          ? " — one row per family, expand with All quantisations"
          : ""}
        . {installed.size === 0
          ? "None are installed yet."
          : `${installed.size} installed on this machine.`}
        {data.cannotDownload !== null && ` ${data.cannotDownload}`}
        {/**
         * Where Ollama comes from, and only when it is not here.
         *
         * `cannotDownload` already says "Ollama is not running, so nothing can be downloaded from
         * here" — accurate, and it assumes the reader has Ollama and has not started it. For someone
         * who has never heard of it, the sentence is a dead end: it names a program, implies they
         * should have it, and does not say where to get it. This is that one missing clause, appended
         * to the existing message rather than replacing it, because both readings are real.
         *
         * Conditional on the same flag, so a machine with Ollama running never sees it.
         */}
        {data.cannotDownload !== null && (
          <>
            {" "}
            It is a separate free download from{" "}
            <a
              href={NO_MODEL_INSTALLED.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline underline-offset-2 transition-colors hover:text-ink-2"
            >
              ollama.com
            </a>
            . {NO_MODEL_INSTALLED.reassurance}
          </>
        )}
      </span>
    </>
  );

  return (
    <div className="page-list flex flex-col gap-8">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-ink">Models</h1>
        <p className="text-sm text-ink-3">
          What runs on this machine, what it would cost to add, and why.
        </p>
      </header>

      {/*
        Scan lives on the panel it refreshes rather than in the hero. It re-reads the hardware
        these rings and figures come from, and a button two hundred pixels above the numbers it
        changes reads as a page-level action.
      */}
      <MachinePanel profile={data.profile} scanning={scanning} onRescan={() => void rescan()} />

      {/* Beside the machine panel because it answers the same question that panel does — what can
          answer my questions — with the one option that is not this machine. */}
      <VoidCodeAccount />

      <OpenRouterKeyPanel />



      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-3">
          {query.trim() === "" ? "Ranked for this machine" : `Matching “${query.trim()}”`}
        </h2>

        <ModelTable
          rows={rows}
          recommendedId={recommendedId}
          installed={installed}
          pulls={pulls}
          cannotDownload={data.cannotDownload}
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          footer={footer}
          onPull={start}
          onRemove={(id) => void remove(id)}
          onDismiss={dismiss}
        />
      </section>
    </div>
  );
}

/**
 * Where an OpenRouter key goes.
 *
 * The provider has been declared in `inference/registry.ts` all along and shown on this page, and
 * there was no way to give it a key — `vault:set` had a schema, a handler and safeStorage behind it,
 * and no caller, because the `vault` namespace was missing from `host.d.ts` and therefore invisible
 * to TypeScript. A backend listed as available that cannot be made to work is a worse claim than one
 * that is absent.
 *
 * It lives on this page rather than in a settings screen because this is where the app already sends
 * people: the attachment notice says "install a vision model from the model manager", and a remote
 * provider is one of the answers to that.
 *
 * **It survives a restart now, and the copy reports which of two things happened rather than
 * asserting one.** This panel used to say the key was held in memory only, because it was: the
 * ciphertext lived in a module variable and nothing wrote it to disk. `inference/vault.ts` answers
 * the two questions that deferral named — the ciphertext lives in the `secrets` table, and
 * `vault:clear` (plus an undecryptable row) is what removes it.
 *
 * It is still conditional, and the condition is real rather than defensive: on a Linux desktop
 * Electron does not recognise, the selected safeStorage backend encrypts with a hardcoded key, so
 * main deliberately keeps that ciphertext in memory instead of writing a recoverable credential to
 * disk. `set` returns `storedDurably`, and this reads it. Assuming the good case would put the copy
 * straight back into the state it was just corrected out of.
 *
 * **Write-only, which is why Remove exists.** There is no channel that returns the key, so this can
 * report that one is stored and can never show it. While keys died with the process, "remove" was a
 * restart. Now it is not, and a user who suspects the wrong key is stored cannot look — so replacing
 * it would mean needing a second key just to displace the first.
 *
 * The field is cleared on save for the same write-only reason: leaving the value on screen would be
 * the only copy of it outside safeStorage.
 */
function OpenRouterKeyPanel() {
  const [stored, setStored] = useState<boolean | undefined>(undefined);
  /**
   * Undefined until a `set` in this session says otherwise.
   *
   * `has` cannot answer it — a key read back from the `secrets` table is durable by definition, and
   * a session-only one is indistinguishable from it at that point. So the panel describes the
   * general rule until it has watched a save, and the specific outcome afterwards. Guessing would
   * mean telling a Linux user on the weak backend that their key is saved.
   */
  const [durable, setDurable] = useState<boolean | undefined>(undefined);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void window.host?.vault
      .has({ key: "openrouter" })
      .then((has) => {
        if (live) setStored(has);
      })
      .catch(() => {
        if (live) setStored(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(async () => {
    const key = value.trim();
    if (key === "") return;

    setSaving(true);
    setProblem(undefined);
    try {
      const result = await window.host?.vault.set({ key: "openrouter", value: key });
      setStored(true);
      setDurable(result?.storedDurably);
      // Cleared immediately: safeStorage in main is where it lives, and a key left in a React
      // state is a second copy nobody asked for.
      setValue("");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [value]);

  const clear = useCallback(async () => {
    setClearing(true);
    setProblem(undefined);
    try {
      await window.host?.vault.clear({ key: "openrouter" });
      setStored(false);
      setDurable(undefined);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }, []);

  // Nothing to offer in a Study window, which has no vault namespace at all.
  if (window.host?.vault === undefined) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-ink-3">OpenRouter</h2>
      <Surface radius="panel" className="flex flex-col gap-3 p-5">
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">
          A key lets this machine reach models it cannot run locally. It is encrypted with the
          operating system&rsquo;s credential store and never leaves this machine except in the
          requests you make.{" "}
          {stored === true
            ? "A key is stored. Saving another replaces it, and it can never be shown back to you."
            : "No key is stored, so OpenRouter models are listed but not usable."}
        </p>

        <p className="max-w-[62ch] text-[12px] leading-relaxed text-ink-3">
          {durable === false
            ? "This key is held for this session only. Your desktop environment has no keyring this app can use, and the fallback encrypts with a key that is not secret — so writing it to disk would not protect it. Enter it again after a restart."
            : durable === true
              ? "Saved, so it will still be here after a restart."
              : "Kept until you remove it, on systems whose keyring can protect it. Where none can, it lasts the session and this line will say so after you save."}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder={stored === true ? "Replace the stored key" : "Paste your key"}
            aria-label="OpenRouter API key"
            spellCheck={false}
            autoComplete="off"
            className="min-w-[22rem] flex-1 rounded-md border border-line bg-void-1 px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || value.trim() === ""}
            className="rounded-md bg-ink px-3 py-1.5 text-[12px] text-void-0 transition-opacity duration-150 ease-void hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save key"}
          </button>

          {/*
            Only when there is something to remove. A Remove button beside "No key is stored" is a
            control that cannot do anything, which is the same class of thing as a per-file Apply on
            an agent diff.
          */}
          {stored === true && (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={clearing}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-2 transition-colors duration-150 ease-void hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
            >
              {clearing ? "Removing…" : "Remove key"}
            </button>
          )}
        </div>

        {problem !== undefined && (
          <p className="text-[12px] leading-relaxed text-diff-remove-ink">{problem}</p>
        )}
      </Surface>
    </section>
  );
}

/** One status count. Zero renders as `0`, never as absence. */
function Count({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="font-mono tabular-nums text-ink-2">{value}</span>
    </span>
  );
}
