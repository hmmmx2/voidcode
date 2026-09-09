"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GlassSurface, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import type { InterviewListData, InterviewSummary } from "@/lib/api/interviews";
import { CompanyMark } from "./CompanyMark";
import { accentFor } from "./domains";

/**
 * The question bank, grouped by domain.
 *
 * DELIBERATELY NOT SHAPED LIKE THE PROBLEMS CATALOGUE.
 *
 * That page is a flat filtered list because problems are a queue — you work
 * them in curriculum order and the only real question is what is next. This one
 * is a map: you arrive knowing you are shaky on CUDA, so domain is the page's
 * structure rather than one filter among four, and each domain is a section you
 * can scroll to and read the shape of.
 *
 * Consequences of that choice, each of which is the opposite of the problems
 * page on purpose:
 *   - Cards, not rows. A card can carry a prompt preview and the company marks,
 *     which is what makes the bank browsable without opening anything.
 *   - No domain filter. Domain is the layout; a control that hides five of six
 *     sections would just be a worse scroll.
 *   - Colour, budgeted per domain. See `domains.ts` for the rules.
 *
 * Company and difficulty remain URL-backed filters, matching the problems page,
 * because those genuinely are filters and a shared idiom is worth keeping where
 * the job really is the same.
 */

export default function InterviewCatalogue({ data }: { data: InterviewListData }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const difficulty = params.get("difficulty");
  const kind = params.get("kind");
  const status = params.get("status") ?? "all";
  const companies = useMemo(
    () => params.get("company")?.split(",").filter(Boolean) ?? [],
    [params]
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router]
  );

  const toggleCompany = (name: string) => {
    const next = companies.includes(name)
      ? companies.filter((c) => c !== name)
      : [...companies, name];
    setParam("company", next.join(","));
  };

  const visible = useMemo(() => {
    let out = data.questions;
    if (difficulty) out = out.filter((q) => q.difficulty === difficulty);
    if (kind) out = out.filter((q) => q.kind === kind);
    if (companies.length > 0) {
      // OR, not AND. "Asked at Meta or OpenAI" is the question people have, and
      // AND would return almost nothing — few questions are reported at all
      // five labs. This is the opposite of the problems page's category filter,
      // where AND is what narrowing means.
      out = out.filter((q) => companies.some((c) => q.companies.includes(c)));
    }
    if (status === "unattempted") out = out.filter((q) => !q.attempted);
    if (status === "shaky") {
      out = out.filter((q) => q.selfRating !== null && q.selfRating < 3);
    }
    if (status === "solid") out = out.filter((q) => q.selfRating === 3);
    return out;
  }, [data.questions, difficulty, kind, companies, status]);

  /** Domains in the server's order, carrying only what survived the filters. */
  const sections = useMemo(
    () =>
      data.facets.domains
        .map((d) => ({
          ...d,
          questions: visible.filter((q) => q.domain === d.key),
          solid: data.questions.filter(
            (q) => q.domain === d.key && q.selfRating === 3
          ).length,
        }))
        .filter((d) => d.questions.length > 0),
    [data.facets.domains, data.questions, visible]
  );

  const filtered =
    Boolean(difficulty) || Boolean(kind) || companies.length > 0 || status !== "all";
  const clear = () => router.replace(pathname, { scroll: false });
  const pct = data.progress.total
    ? Math.round((data.progress.solid / data.progress.total) * 100)
    : 0;
  const runnable = data.questions.filter((q) => q.hasWorkspace).length;

  return (
    <div className="space-y-10">
      {/* ── Overview ─────────────────────────────────────────── */}
      <GlassSurface radius="panel" className="overflow-hidden p-7">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
              Your readiness
            </p>
            <p className="mt-3 flex items-baseline gap-2 text-ink">
              <span className="text-[2.75rem] font-light leading-none tabular-nums tracking-tight">
                {data.progress.solid}
              </span>
              <span className="text-lg font-light text-ink-3">
                / {data.progress.total}
              </span>
            </p>
            <p className="mt-2 max-w-[42ch] text-xs leading-relaxed text-ink-3">
              Counts only what you rated <span className="text-ink-2">solid</span>.
              {data.progress.attempted > data.progress.solid && (
                <> {data.progress.attempted} attempted in total.</>
              )}
            </p>
          </div>

          {/* Per-domain readiness. This is the thing the single overall ring
              could never say: which domain to open next. */}
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            {data.facets.domains.map((d) => {
              const solid = data.questions.filter(
                (q) => q.domain === d.key && q.selfRating === 3
              ).length;
              const accent = accentFor(d.key);
              return (
                <div key={d.key} className="w-[76px]">
                  {/* The key, not the label. "Machine Learning" and
                      "CUDA & Systems" truncated to "MACHINE LEARN…" at any tile
                      width that keeps six of these on one row, and a clipped
                      word is worse than an abbreviation the section headings
                      below spell out in full anyway. */}
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">
                    {d.key === "maths" ? "MATH" : d.key.toUpperCase()}
                  </p>
                  <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-void-3">
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-void"
                      style={{
                        width: `${d.total ? (solid / d.total) * 100 : 0}%`,
                        background: `rgb(${accent.rgb})`,
                      }}
                    />
                  </div>
                  <p className="mt-1.5 font-mono text-[10px] tabular-nums text-ink-3">
                    {solid}/{d.total}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Overall bar, full width under both columns. */}
        <div className="mt-7 h-px w-full overflow-hidden bg-line">
          <div
            className="h-full bg-ink transition-[width] duration-500 ease-void"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Say how many are actually openable, up front.

            Without this the page looks broken: most cards do not respond and
            nothing explains why. One line here costs nothing and turns "this is
            broken" into "this is in progress". Disappears once the bank is
            fully authored, so it cannot become permanent furniture. */}
        {runnable < data.progress.total && (
          <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
            <span className="text-ink-2">
              {runnable} of {data.progress.total}
            </span>{" "}
            are runnable so far. The rest are written but still need test cases
            and a verified solution before they can be opened in the editor.
          </p>
        )}
      </GlassSurface>

      {/* ── Filters ──────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
            Asked at
          </span>
          {data.facets.companies.map((c) => {
            const selected = companies.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCompany(c.key)}
                aria-pressed={selected}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium",
                  "transition-colors duration-200 ease-void",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                  "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
                  selected
                    ? "border-ink bg-ink text-void-0"
                    : "border-line bg-void-2 text-ink-2 hover:border-line-strong hover:text-ink"
                )}
              >
                <CompanyMark company={c.key} className="h-3.5 w-3.5" />
                {c.label}
                <span
                  className={cn(
                    "rounded-full px-1 text-[10px] tabular-nums",
                    selected ? "bg-void-0/15 text-void-0" : "bg-void-3 text-ink-3"
                  )}
                >
                  {c.total}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            label="Kind"
            options={[
              { key: "", label: "All" },
              ...data.facets.kinds.map((k) => ({ key: k.key, label: k.label })),
            ]}
            value={kind ?? ""}
            onChange={(v) => setParam("kind", v || null)}
          />
          <Segmented
            label="Difficulty"
            options={[
              { key: "", label: "Any" },
              ...data.facets.difficulties.map((d) => ({ key: d.key, label: d.label })),
            ]}
            value={difficulty ?? ""}
            onChange={(v) => setParam("difficulty", v || null)}
          />
          <Segmented
            label="Status"
            options={[
              { key: "all", label: "All" },
              { key: "unattempted", label: "Not attempted" },
              { key: "shaky", label: "Needs work" },
              { key: "solid", label: "Solid" },
            ]}
            value={status}
            onChange={(v) => setParam("status", v === "all" ? null : v)}
          />
          {filtered && (
            <button
              type="button"
              onClick={clear}
              className="text-xs text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline focus-visible:outline-none"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Sections ─────────────────────────────────────────── */}
      {sections.map((section) => {
        const accent = accentFor(section.key);
        return (
          <section key={section.key} className="space-y-5">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-4">
              <span
                aria-hidden
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{
                  background: `rgb(${accent.rgb})`,
                  boxShadow: `0 0 16px 1px rgb(${accent.rgb} / 0.55)`,
                }}
              />
              <h2 className="text-xl font-light tracking-tight text-ink">
                {section.label}
              </h2>
              <span className="font-mono text-[11px] tabular-nums text-ink-3">
                {section.questions.length}
                {section.questions.length !== section.total && ` / ${section.total}`}
              </span>
              <p className="w-full text-xs leading-relaxed text-ink-3 sm:w-auto sm:flex-1">
                {accent.blurb}
              </p>
            </div>

            {/*
              More cards, not wider ones.

              `page-grid` takes the container to 90rem on a 24" screen and 125rem on a 34"
              ultrawide. Left at a fixed three columns a card would grow past 600px, which is a
              lot of width for a question title and a two-line blurb.

              `auto-fill` with a 20rem floor rather than a chain of `3xl:`/`4xl:` column counts,
              for two reasons. It says the actual intent — cards are about 20rem and a row holds
              as many as fit — and it holds at container widths nobody enumerated. It also
              sidesteps a real trap: a breakpoint defined in `@theme` above Tailwind's own scale
              emits its rules *before* the built-in ones, so `xl:grid-cols-3` wins over
              `4xl:grid-cols-5` at 2560px even though both match. That version looked right in
              the source and rendered three columns.

              The result is the ladder that was wanted anyway: 3 columns at 1152px, 4 at 1440,
              5 at 1760, 6 at 2000 — every card between 320 and 375px throughout.
            */}
            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]">
              {section.questions.map((q) => (
                <QuestionCard key={q.slug} question={q} rgb={accent.rgb} />
              ))}
            </div>
          </section>
        );
      })}

      {sections.length === 0 && (
        <Surface radius="panel" className="px-5 py-16 text-center">
          <p className="text-sm text-ink-2">Nothing matches those filters.</p>
          <p className="mx-auto mt-1 max-w-[44ch] text-xs leading-relaxed text-ink-3">
            Companies combine with OR, so this is a narrow difficulty or status.
            Try widening one.
          </p>
          <Pill variant="outline" size="sm" className="mt-5" onClick={clear}>
            Clear filters
          </Pill>
        </Surface>
      )}

      {/* Nominative use, stated where it is visible rather than buried in a
          source comment. */}
      <p className="border-t border-line pt-6 text-[11px] leading-relaxed text-ink-3/70">
        Company names and marks are trademarks of their respective owners, used
        here only to indicate where a question is commonly reported. VoidCode AI
        is not affiliated with, sponsored by, or endorsed by any of them.
      </p>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

function QuestionCard({
  question,
  rgb,
}: {
  question: InterviewSummary;
  rgb: string;
}) {
  const rating = question.selfRating;

  return (
    <Link
      /* EVERY question is openable, runnable or not.

         Two earlier versions got this wrong. The first dimmed unrunnable cards
         to 45% and swallowed the click, which read as a broken page. The
         second added a badge but still blocked the click — better, but it
         still refused to show you a question you could perfectly well read
         and answer in prose.

         The route now picks the experience: an executable question opens the
         IDE, everything else opens a two-column written workspace where the
         tutor marks your answer. "Not runnable" is a different exercise, not
         a locked door. */
      href={`/interviews/${question.slug}`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-panel border border-line",
        "bg-void-0/40 p-5 transition-all duration-200 ease-void",
        "hover:border-line-strong hover:bg-void-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      )}
      style={{ ["--accent" as string]: `rgb(${rgb})` }}
    >
      {/* Accent edge. Opacity-only on hover so the card does not shift, and the
          hue never becomes a fill. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px opacity-40 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background: `linear-gradient(90deg, transparent, rgb(${rgb} / 0.9), transparent)`,
        }}
      />

      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] font-medium leading-snug text-ink-2 transition-colors group-hover:text-ink">
          {question.title}
        </h3>
        {question.hasWorkspace ? (
          <span
            aria-hidden
            className={cn(
              "mt-1 h-2 w-2 flex-shrink-0 rounded-full border",
              rating === 3 && "border-ink bg-ink",
              rating !== null && rating < 3 && "border-ink-3 bg-ink-3/40",
              rating === null && "border-line-strong"
            )}
          />
        ) : (
          /* Replaces the rating dot rather than sitting beside it: an
             unopenable question has no rating to show, and two markers in one
             corner reads as noise. */
          <span className="mt-0.5 flex-shrink-0 whitespace-nowrap rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
            Written
          </span>
        )}
      </div>

      <p className="mt-3 line-clamp-3 flex-1 text-xs leading-relaxed text-ink-3">
        {question.promptPreview}
      </p>

      {!question.hasWorkspace && (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-3/80">
          Answered in prose &mdash; the tutor marks it against the reference.
        </p>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <span className="flex items-center gap-2 text-ink-3">
          {question.companies.map((c) => (
            <CompanyMark key={c} company={c} className="h-[15px] w-[15px]" />
          ))}
        </span>
        <span className="flex items-center gap-2">
          {/* Kind carries the accent; difficulty stays plain. Every question is
              technical now, so "what do I actually do here" is the more useful
              of the two at a glance — and giving both the same weight would
              make neither readable. */}
          <span
            className="rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]"
            style={{
              color: `rgb(${rgb})`,
              borderColor: `rgb(${rgb} / 0.35)`,
              backgroundColor: `rgb(${rgb} / 0.08)`,
            }}
          >
            {question.kindLabel}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
            {question.difficulty}
          </span>
        </span>
      </div>

      <span className="sr-only">
        {rating === 3
          ? "Rated solid"
          : rating !== null
            ? "Needs work"
            : "Not attempted"}
        . Asked at {question.companies.join(", ")}.
      </span>
    </Link>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex flex-wrap rounded-full border border-line bg-void-2 p-0.5"
      >
        {options.map((option) => {
          const selected = value === option.key;
          return (
            <button
              key={option.key || "any"}
              type="button"
              onClick={() => onChange(option.key)}
              aria-pressed={selected}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium",
                "transition-colors duration-150 ease-void",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
                selected ? "bg-ink text-void-0" : "text-ink-2 hover:text-ink"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
