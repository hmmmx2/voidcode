/**
 * Collapsing the recommender's output into something readable.
 *
 * `models:recommend` returns *every* candidate with its verdict, deliberately — the handler's
 * comment says a user on an 8 GB card deserves to see why the 14B was passed over. That was
 * six rows. Since the catalogue gained a quantisation ladder per family it is twenty-one, and
 * four of them differ only in a suffix and a decimal. Showing all of them would turn an
 * honest payload into noise, which is the same failure the payload was designed to avoid,
 * arrived at from the other direction.
 *
 * So: one row per family, showing the best quantisation that fits, with the rest available
 * underneath. Nothing is dropped — it is folded.
 *
 * Pure, so it can be tested without a machine to scan.
 */
import type { FitTier, FitVerdict, ModelSpec } from "@shared/hardware-types";

export interface Ranked {
  model: ModelSpec;
  fit: FitVerdict;
}

export interface ModelFamily {
  /** `qwen2.5-coder:7b` — the id with its quantisation suffix removed. */
  id: string;
  /** The label with its parenthesised quantisation stripped: "Qwen2.5-Coder 7B". */
  label: string;
  /** The variant to show collapsed: the highest precision that fits best. */
  best: Ranked;
  /** Every variant, in the order the recommender ranked them. `best` is included. */
  variants: Ranked[];
}

/**
 * Rank order, mirroring `fit.ts`'s own.
 *
 * Duplicated rather than imported because `fit.ts` keeps it module-private, and exporting it
 * to share four numbers would widen a pure module's surface for a display concern. The
 * duplication is pinned by a test that walks every `FitTier`, so adding a tier fails here.
 */
const TIER_RANK: Record<FitTier, number> = {
  comfortable: 0,
  tight: 1,
  "cpu-only": 2,
  offload: 3,
  "wont-fit": 4,
};

/** Everything before the quantisation suffix. `qwen2.5-coder:7b-q4_K_M` → `qwen2.5-coder:7b`. */
export function familyId(modelId: string): string {
  return modelId.replace(/-q\d.*$/i, "");
}

/** "Qwen2.5-Coder 7B (Q4_K_M)" → "Qwen2.5-Coder 7B". Leaves an unsuffixed label alone. */
export function familyLabel(label: string): string {
  return label.replace(/\s*\((?:Q\d[^)]*)\)\s*$/i, "").trim();
}

/**
 * Group ranked models by family, preserving the recommender's order throughout.
 *
 * The first variant of a family to appear is its `best` — the input is already sorted by
 * tier and then, within a tier, by the catalogue's descending-precision order. Re-sorting
 * here would silently substitute this module's judgement for `fit.ts`'s, and `fit.ts` is the
 * one with the arithmetic.
 */
export function groupByFamily(
  ranked: readonly Ranked[],
  /**
   * Which variants are already on this machine, if known.
   *
   * When a family has an installed variant, that is the row to show folded — whatever the fit
   * calculator would have picked. Without this the page showed "Download 6.3 GB" for the 7B
   * family on a machine that already had the 7B: the best-fitting variant was Q6 and the
   * installed one was Q4, so the row you needed was hidden behind the expander and the row
   * you saw was an offer to re-download something you owned.
   */
  isInstalled?: (id: string) => boolean
): ModelFamily[] {
  const families: ModelFamily[] = [];
  const byId = new Map<string, ModelFamily>();

  for (const entry of ranked) {
    const id = familyId(entry.model.id);
    const existing = byId.get(id);

    if (existing === undefined) {
      const family: ModelFamily = {
        id,
        label: familyLabel(entry.model.label),
        best: entry,
        variants: [entry],
      };
      byId.set(id, family);
      families.push(family);
      continue;
    }

    existing.variants.push(entry);

    /**
     * Installed beats fit, and a later variant otherwise replaces `best` only on a strictly
     * better tier.
     *
     * Within one tier the input order already encodes the preference, so "strictly better"
     * rather than "better or equal" is what keeps a lower-precision variant from displacing
     * the higher one it was deliberately listed behind.
     */
    const bestIsInstalled = isInstalled?.(existing.best.model.id) ?? false;
    const entryIsInstalled = isInstalled?.(entry.model.id) ?? false;

    if (entryIsInstalled && !bestIsInstalled) {
      existing.best = entry;
    } else if (
      entryIsInstalled === bestIsInstalled &&
      TIER_RANK[entry.fit.tier] < TIER_RANK[existing.best.fit.tier]
    ) {
      existing.best = entry;
    }
  }

  return families;
}

/** Does any variant of this family run at all? Drives whether the row offers a download. */
export function familyIsUsable(family: ModelFamily): boolean {
  return family.best.fit.tier !== "wont-fit";
}
