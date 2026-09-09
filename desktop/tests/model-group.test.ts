/**
 * Folding twenty-one ranked models into a readable list.
 *
 * The recommender returns every candidate with its verdict on purpose — seeing *why* the 14B
 * was passed over is the point of it. That was six rows before the catalogue gained a
 * quantisation ladder and twenty-one after, four of which differ only in a suffix. Grouping
 * has to fold them without dropping any and without substituting its own judgement for
 * `fit.ts`'s.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  familyId,
  familyLabel,
  familyIsUsable,
  groupByFamily,
  type Ranked,
} from "../renderer/src/lib/models/group.js";
import type { FitTier, FitVerdict, ModelSpec } from "../src/shared/hardware-types.js";

const verdict = (tier: FitTier): FitVerdict => ({
  tier,
  contextTokens: 32768,
  weightsGB: 4,
  kvCacheGB: 1,
  overheadGB: 0.6,
  requiredGB: 5.6,
  usableGB: 13.4,
  gpuLayers: 28,
  estimatedTokensPerSecond: 80,
  explanation: `test ${tier}`,
});

const spec = (id: string, label: string, bits: number): ModelSpec => ({
  id,
  label,
  paramsB: 7.62,
  bitsPerWeight: bits,
  layers: 28,
  kvHeads: 4,
  headDim: 128,
  maxContext: 32768,
  licence: "Apache-2.0",
  downloadGB: 4.7,
});

const ranked = (id: string, label: string, bits: number, tier: FitTier): Ranked => ({
  model: spec(id, label, bits),
  fit: verdict(tier),
});

describe("splitting a tag into family and quantisation", () => {
  it("strips the quantisation suffix", () => {
    expect(familyId("qwen2.5-coder:7b-q4_K_M")).toBe("qwen2.5-coder:7b");
    expect(familyId("qwen2.5-coder:14b-q8_0")).toBe("qwen2.5-coder:14b");
    expect(familyId("deepseek-coder:6.7b-q5_K_M")).toBe("deepseek-coder:6.7b");
  });

  it("leaves a tag with no suffix alone", () => {
    // The vision model ships as a bare tag. Mangling it would split it into its own family
    // of one with a truncated name.
    expect(familyId("qwen2.5vl:7b")).toBe("qwen2.5vl:7b");
  });

  it("does not eat a version number that looks like a quantisation", () => {
    // `-q` followed by a digit is the marker; `2.5` and `6.7b` must survive it.
    expect(familyId("qwen2.5-coder:1.5b-q4_K_M")).toBe("qwen2.5-coder:1.5b");
  });

  it("strips the parenthesised quantisation from the label", () => {
    expect(familyLabel("Qwen2.5-Coder 7B (Q4_K_M)")).toBe("Qwen2.5-Coder 7B");
    expect(familyLabel("Qwen2.5-Coder 14B (Q8_0)")).toBe("Qwen2.5-Coder 14B");
  });

  it("keeps a parenthesised label that is not a quantisation", () => {
    // The vision model's label ends "(vision)", which is the useful part of its name.
    expect(familyLabel("Qwen2.5-VL 7B (vision)")).toBe("Qwen2.5-VL 7B (vision)");
  });
});

describe("grouping", () => {
  it("collapses a family to one entry and keeps every variant", () => {
    const groups = groupByFamily([
      ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, "tight"),
      ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
      ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "comfortable"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("M 7B");
    // Folded, not dropped — the disclosure shows all three.
    expect(groups[0]?.variants).toHaveLength(3);
  });

  it("picks the best tier as the collapsed representative", () => {
    const groups = groupByFamily([
      ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, "tight"),
      ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
    ]);
    expect(groups[0]?.best.model.id).toBe("m:7b-q6_K");
  });

  it("keeps the input's order within a tier rather than re-sorting", () => {
    /**
     * The mutation this guards. The catalogue lists each family descending by precision
     * *because* `recommend()` ties on paramsB and sort stability then decides — so within one
     * tier the incoming order already encodes the preference. Replacing `<` with `<=` here
     * would let the last equal-tier variant win, which is the lowest precision, silently
     * inverting the very thing the catalogue's ordering exists to express.
     */
    const groups = groupByFamily([
      ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
      ranked("m:7b-q5_K_M", "M 7B (Q5_K_M)", 5.6, "comfortable"),
      ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "comfortable"),
    ]);
    expect(groups[0]?.best.model.id).toBe("m:7b-q6_K");
  });

  it("shows the installed variant folded, whatever the fit calculator would pick", () => {
    /**
     * Found in the running app. The 7B family's best fit was Q6 and the installed variant was
     * Q4, so the folded row offered "Download 6.3 GB" on a machine that already had the 7B —
     * the row you needed was behind the expander and the row you saw was an offer to
     * re-download something you owned.
     */
    const groups = groupByFamily(
      [
        ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
        ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "comfortable"),
      ],
      (id) => id === "m:7b-q4_K_M"
    );
    expect(groups[0]?.best.model.id).toBe("m:7b-q4_K_M");
  });

  it("prefers an installed variant even when it fits worse", () => {
    // Having it beats fitting well: you already paid for the download, and the page's job is
    // to tell you what is there.
    const groups = groupByFamily(
      [
        ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "comfortable"),
        ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, "offload"),
      ],
      (id) => id === "m:7b-q8_0"
    );
    expect(groups[0]?.best.model.id).toBe("m:7b-q8_0");
  });

  it("falls back to fit when nothing in the family is installed", () => {
    const groups = groupByFamily(
      [
        ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, "tight"),
        ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
      ],
      () => false
    );
    expect(groups[0]?.best.model.id).toBe("m:7b-q6_K");
  });

  it("keeps the tier rule between two installed variants", () => {
    // The predicate breaks ties against fit, not within them.
    const groups = groupByFamily(
      [
        ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, "offload"),
        ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
      ],
      () => true
    );
    expect(groups[0]?.best.model.id).toBe("m:7b-q6_K");
  });

  it("preserves the order families first appeared in", () => {
    // The recommender ranked them; re-ordering here would discard that.
    const groups = groupByFamily([
      ranked("a:7b-q4_K_M", "A 7B (Q4_K_M)", 4.8, "comfortable"),
      ranked("b:7b-q4_K_M", "B 7B (Q4_K_M)", 4.8, "tight"),
      ranked("a:7b-q5_K_M", "A 7B (Q5_K_M)", 5.6, "comfortable"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["a:7b", "b:7b"]);
  });

  it("loses nothing", () => {
    const input = [
      ranked("a:7b-q4_K_M", "A 7B (Q4_K_M)", 4.8, "comfortable"),
      ranked("b:7b-q4_K_M", "B 7B (Q4_K_M)", 4.8, "wont-fit"),
      ranked("a:7b-q8_0", "A 7B (Q8_0)", 8.5, "offload"),
    ];
    const total = groupByFamily(input).reduce((n, g) => n + g.variants.length, 0);
    expect(total).toBe(input.length);
  });

  it("handles an empty ranking", () => {
    expect(groupByFamily([])).toEqual([]);
  });

  it("ranks every tier, so adding one cannot silently sort as undefined", () => {
    // `TIER_RANK` is duplicated from fit.ts's module-private table. This walks every member of
    // the union: a new tier makes the record a type error and this a runtime failure.
    const tiers: FitTier[] = ["comfortable", "tight", "offload", "cpu-only", "wont-fit"];
    for (const worse of tiers) {
      const groups = groupByFamily([
        ranked("m:7b-q8_0", "M 7B (Q8_0)", 8.5, worse),
        ranked("m:7b-q6_K", "M 7B (Q6_K)", 6.6, "comfortable"),
      ]);
      const expected = worse === "comfortable" ? "m:7b-q8_0" : "m:7b-q6_K";
      expect(groups[0]?.best.model.id, `tier ${worse} ranked wrongly`).toBe(expected);
    }
  });
});

describe("usability", () => {
  it("calls a family unusable only when its best variant will not run", () => {
    expect(familyIsUsable(groupByFamily([ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "wont-fit")])[0]!)).toBe(false);
    expect(familyIsUsable(groupByFamily([ranked("m:7b-q4_K_M", "M 7B (Q4_K_M)", 4.8, "cpu-only")])[0]!)).toBe(true);
  });
});

/**
 * The catalogue-versus-inventory confusion, committed by the page that warns about it.
 *
 * `providers.list()` returns every reachable backend, and when an OpenRouter key is
 * configured that includes a remote service whose `models` is its entire several-hundred-model
 * catalogue. Summing them reported "340 installed on this machine" on a machine with three —
 * directly under a line of copy explaining that the catalogue is not the inventory.
 *
 * Found by reading the running page, not the diff. Source-read because the count is computed
 * inside a `useEffect` in a component that fetches over IPC.
 */
describe("installed means local", () => {
  const page = readFileSync(
    new URL("../renderer/src/components/Models/ModelsPage.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("filters remote providers out of the installed set", () => {
    // The mutation: dropping the filter restores the 340.
    expect(page).toMatch(/installed:\s*providerList\s*\.filter\(\(p\) => !p\.capabilities\.remote\)/);
  });

  it("asks main for the whole catalogue, with no filter to slice it", () => {
    /**
     * The regression this replaces hid five models.
     *
     * `recommend()` took a purpose and filtered with `purpose === "chat" ? true : m.fim`, so
     * "chat" was the only value that scored every entry. The page asked for "both" — which reads
     * like a superset and is the intersection — and the vision model plus all four Mistral
     * variants never appeared in any tier.
     *
     * The parameter is gone with inline completion, so the bug is now unrepresentable rather
     * than merely fixed. This pins that no purpose comes back.
     */
    expect(page).toMatch(/models\.recommend\(\{\s*contextTokens:/);
    expect(page).not.toMatch(/purpose:/);
  });

  it("filters by capability in the renderer, where the user can see it", () => {
    // Hiding a model has to be a choice someone made, and the count beneath the table has to
    // say how many that was.
    expect(page).toMatch(/capability === "all"/);
    expect(page).toContain("Showing {rows.length} of {data.recommendations.length}");
  });

  it("still counts every local provider, not just Ollama", () => {
    // llama.cpp serves models locally too; hardcoding one provider id would undercount.
    expect(page).not.toMatch(/installed:.*p\.id === "ollama"/);
  });
});

/**
 * The two states the table could not express.
 *
 * "Optimal" is a fit tier that ten models share on a 16 GB card — it answers "will this run
 * well", not "which one should I pick", and the table had no way to say the second. And a
 * state with no members was indistinguishable from a state that had never been built:
 * nothing on a 16 GB machine is Incompatible, and an absent badge does not say whether that
 * is because nothing qualifies.
 */
describe("recommended, and the states with nobody in them", () => {
  const page = readFileSync(
    new URL("../renderer/src/components/Models/ModelsPage.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const table = readFileSync(
    new URL("../renderer/src/components/Models/ModelTable.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("marks exactly one row as recommended", () => {
    // A single id compared per row, not a predicate that could match several.
    expect(table).toMatch(/recommended=\{row\.model\.id === recommendedId\}/);
    expect(table).toMatch(/>\s*Recommended\s*<\/span>/);
  });

  it("does not claim the badge is what the assistant would pick", () => {
    /**
     * It said exactly that, and it was false. The badge marks the head of the ranking, which
     * on a 16 GB card with no filter is the vision model — the largest thing that fits
     * comfortably. `pickAgentModel` in main chooses the assistant's model from a
     * tool-capability list this page cannot see and would never choose that one.
     */
    const table = readFileSync(
      new URL("../renderer/src/components/Models/ModelTable.tsx", import.meta.url),
      "utf8"
    );
    expect(table).not.toContain("what the assistant would pick");
    // Asserted as two claims rather than one literal: it must say the badge is about fit in
    // the current view, and it must say out loud what it is not.
    expect(table).toMatch(/Best fit for this hardware in the current view/);
    expect(table).toMatch(/Not what the assistant runs/);
  });

  it("takes the recommendation from the ranking, not from the visible rows", () => {
    // `capable`, not `rows`: which family is best must not change because someone typed in
    // the search box or collapsed the fold.
    expect(page).toMatch(/const best = capable\[0\]/);
  });

  it("lands the badge on a row that is actually rendered", () => {
    /**
     * The bug this caught. Marking `capable[0]` directly put the badge on a variant the fold
     * had replaced, so selecting Inline completion showed seven Optimal models and
     * recommended none — the recommendation existed with nowhere to sit.
     *
     * Resolving through `rows` is what guarantees the badge is on something clickable.
     */
    expect(page).toMatch(/rows\.find\(\(row\) => familyId\(row\.model\.id\) === recommendedFamily\)/);
  });

  it("identifies the pick by family, so the fold can substitute a variant", () => {
    // The fold shows the installed variant when there is one, which is frequently not the
    // top-ranked variant of the same family.
    expect(page).toMatch(/return familyId\(best\.model\.id\)/);
  });

  it("recommends nothing rather than something that will not run", () => {
    // The head of the ranking on a 4 GB machine is still wont-fit. Naming it would be worse
    // than naming none.
    expect(page).toMatch(/best\.fit\.tier === "wont-fit"\) return null/);
  });

  it("makes the three status counts add up to the models counted", () => {
    /**
     * The column shows one of Recommended / Matched / Not matched per row, never two — but
     * the counts double-counted the recommendation, which is also matched. The footer read
     * "Recommended 1 · Matched 21 · Not matched 0" for twenty-one models, and anyone adding
     * them up got twenty-two.
     */
    expect(page).toMatch(/const matched = capable\.length - notMatched - recommendedCount/);
  });

  it("derives Status by lookup, never by its own arithmetic", () => {
    /**
     * The constraint the whole page rests on: `fit.ts` decides suitability with a calibrated
     * model — a desktop reserve, a 0.92 fragmentation factor, context halving — and a second
     * opinion in the UI would give the app two answers to one question.
     *
     * `STATUS` is a `Record<FitTier, …>` with no thresholds and no access to the gigabyte
     * figures, so it *cannot* disagree. A mutation replacing it with
     * `requiredGB <= usableGB` looks equivalent and is not: it drops the reserve, which is
     * exactly how you end up telling someone a model fits and watching it OOM.
     */
    // Source-read rather than imported: the component pulls in framer-motion and React, and
    // this is a claim about how the value is written, not about what it evaluates to.
    const map = table.slice(table.indexOf("export const STATUS"), table.indexOf("interface ModelTableProps"));

    expect(map).toMatch(/comfortable:\s*"matched"/);
    expect(map).toMatch(/tight:\s*"matched"/);
    expect(map).toMatch(/offload:\s*"matched"/);
    expect(map).toMatch(/"cpu-only":\s*"matched"/);
    expect(map).toMatch(/"wont-fit":\s*"not-matched"/);

    // No gigabyte figures anywhere in the projection — it cannot reach the numbers the tier
    // was computed from, which is what makes disagreement impossible rather than unlikely.
    // (Not a bare `<` check: `Record<FitTier, …>` is a type annotation, not a comparison.)
    expect(map).not.toMatch(/requiredGB|usableGB|weightsGB|kvCacheGB/);

    // And the row reads it rather than computing one.
    expect(table).toMatch(/const status = STATUS\[row\.fit\.tier\]/);
    expect(table).not.toMatch(/requiredGB\s*<=?\s*.*usableGB/);
  });

  it("marks an empty tier as absent rather than faint", () => {
    /**
     * `opacity-40` was here. Dimming the count that says "nothing is Incompatible" renders
     * the absence of data as a visual default — the same mistake `scan.ts` refuses to make
     * with `unknowns`, and the reason the count is shown at all.
     */
    expect(page).toMatch(/count === 0 \? "border-dashed border-line-strong"/);

    /**
     * Banned unprefixed, not banned outright.
     *
     * This was `not.toContain("opacity-40")` over the whole file, which is the right intent stated
     * too widely: it also forbids `disabled:opacity-40` on a button, where dimming an unavailable
     * control is exactly what the class is for and says nothing about missing data. The
     * OpenRouter key panel's Save button tripped it.
     *
     * The lookbehind is what keeps the original claim: a *bare* `opacity-40` is a permanent dimming
     * of something that is present, which is how the tier count came to render absence as a
     * default.
     */
    expect(page).not.toMatch(/(?<![:-])opacity-40/);
  });

  it("counts every tier, including the empty ones", () => {
    // Seeded from TIER_ORDER so a state with no members renders as 0 rather than vanishing.
    expect(page).toMatch(/new Map\(TIER_ORDER\.map\(\(tier\) => \[tier, 0\]\)\)/);
  });

  it("counts against the capability filter, not the folded rows", () => {
    // Folding to one row per family would otherwise report 6 models across all five states
    // on a machine holding 21.
    expect(page).toMatch(/for \(const row of capable\)/);
  });

  it("names all five states in one place", () => {
    for (const label of ["Optimal", "Stretching", "Partial", "CPU only", "Incompatible"]) {
      expect(table).toContain(`"${label}"`);
    }
  });
});
