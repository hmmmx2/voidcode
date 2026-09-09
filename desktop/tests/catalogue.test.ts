/**
 * The catalogue, and the ordering invariant that is invisible from the file itself.
 *
 * `recommend()` sorts by fit tier and breaks ties with `b.paramsB - a.paramsB`. Two
 * quantisations of one model have **identical** `paramsB`, so they always tie — and
 * `Array.prototype.sort` is stable, which means the order entries appear in `CATALOGUE` is
 * what actually decides which quantisation is recommended when several fit equally well.
 *
 * Nothing in `catalogue.ts` or `fit.ts` says that. Sorting the file alphabetically, or adding
 * a variant in the wrong place, silently downgrades every recommendation for that family and
 * no other test notices. That is what this file is for.
 */
import { describe, it, expect } from "vitest";
import { CATALOGUE, findModel } from "../src/main/hardware/catalogue.js";
import { recommend } from "../src/main/hardware/fit.js";
import type { HardwareProfile, ModelSpec } from "../src/shared/hardware-types.js";

/** Everything before the quantisation suffix: `qwen2.5-coder:7b-q4_K_M` → `qwen2.5-coder:7b`. */
function family(model: ModelSpec): string {
  return model.id.replace(/-q\d.*$/i, "");
}

function familiesOf(models: readonly ModelSpec[]): Map<string, ModelSpec[]> {
  const out = new Map<string, ModelSpec[]>();
  for (const model of models) {
    const key = family(model);
    out.set(key, [...(out.get(key) ?? []), model]);
  }
  return out;
}

const profile = (vramGB: number, bandwidth = 448): HardwareProfile => ({
  gpus: [
    { vendor: "nvidia", name: "test", vramTotalMB: vramGB * 1024, memoryBandwidthGBs: bandwidth },
  ],
  unifiedMemory: false,
  hasDisplay: true,
  cpu: { model: "test", physicalCores: 8, flags: [] },
  ramTotalMB: 32 * 1024,
  diskFreeMB: 500_000,
  backends: {},
  unknowns: [],
  scannedAt: "",
});

describe("the ordering the recommender depends on", () => {
  it("lists every family descending by bitsPerWeight", () => {
    // THE mutation this file exists for. Reordering a family ascending leaves every other
    // test green while flipping which quantisation gets recommended.
    for (const [name, variants] of familiesOf(CATALOGUE)) {
      const bits = variants.map((v) => v.bitsPerWeight);
      const descending = [...bits].sort((a, b) => b - a);
      expect(bits, `${name} must be listed highest-precision first`).toEqual(descending);
    }
  });

  it("has no duplicate bit-widths inside a family, so the order is total", () => {
    // Two entries at the same precision would tie on paramsB *and* bitsPerWeight, leaving
    // the winner decided by nothing anyone wrote down.
    for (const [name, variants] of familiesOf(CATALOGUE)) {
      const bits = variants.map((v) => v.bitsPerWeight);
      expect(new Set(bits).size, `${name} has a repeated quantisation`).toBe(bits.length);
    }
  });

  it("actually recommends the highest precision that still fits comfortably", () => {
    // The behaviour the ordering buys, asserted end-to-end rather than by inspection. On a
    // 16 GB card the 7B family's Q8 is too large to be comfortable, so Q6 should win — and
    // it should beat Q5 and Q4, which also fit.
    const ranked = recommend(CATALOGUE, profile(16), 32768);
    const comfortable7b = ranked.filter(
      (r) => r.fit.tier === "comfortable" && family(r.model) === "qwen2.5-coder:7b-instruct"
    );

    expect(comfortable7b.length).toBeGreaterThan(1);
    const bits = comfortable7b.map((r) => r.model.bitsPerWeight);
    expect(bits).toEqual([...bits].sort((a, b) => b - a));
  });
});

describe("what the entries claim", () => {
  it("gives every model a unique id", () => {
    const ids = CATALOGUE.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only OSI licences", () => {
    // Duplicated from fit.test.ts deliberately: that one guards the *policy*, this one guards
    // it surviving a 3.5x expansion of the list.
    for (const model of CATALOGUE) {
      expect(["Apache-2.0", "MIT", "BSD-3-Clause"]).toContain(model.licence);
    }
  });

  it("keeps Q4 as the floor", () => {
    // A Q3 14B puts weights near 6.3 GB, on the usable line an 8 GB card sits at — close
    // enough to flip fit.test.ts's assertion that the 14B is not the top pick there, which
    // exists because "fits" would mean a 9 GB download followed by a crash.
    for (const model of CATALOGUE) {
      expect(model.bitsPerWeight, `${model.id} is below the Q4 floor`).toBeGreaterThanOrEqual(4.8);
    }
  });

  it("grows downloadGB with precision inside a family", () => {
    // Not an arithmetic check — these are published GGUF sizes, not computed ones. But a
    // higher-precision file that claims to be smaller is a transcription error, and this is
    // the only place it would ever be caught.
    for (const [name, variants] of familiesOf(CATALOGUE)) {
      if (variants.length < 2) continue;
      const sizes = variants.map((v) => v.downloadGB);
      expect(sizes, `${name} download sizes disagree with its precisions`).toEqual(
        [...sizes].sort((a, b) => b - a)
      );
    }
  });

  it("never derives downloadGB from paramsB", () => {
    // The catalogue header promises these are measured. A computed figure would land
    // suspiciously close to weightsGB; a real GGUF carries metadata and vocab on top.
    for (const model of CATALOGUE) {
      const naive = (model.paramsB * 1e9 * (model.bitsPerWeight / 8)) / 2 ** 30;
      expect(model.downloadGB, `${model.id} looks computed rather than published`).not.toBeCloseTo(
        naive,
        2
      );
    }
  });

  it("still finds a model by id after the expansion", () => {
    expect(findModel("qwen2.5-coder:7b-instruct-q4_K_M")?.paramsB).toBe(7.62);
    expect(findModel("nope:1b")).toBeUndefined();
  });

  it("keeps the vision model, which the consent dialog names as the local alternative", () => {
    // "A local vision model keeps everything on this machine" needs something real behind it.
    expect(CATALOGUE.some((m) => m.vision === true)).toBe(true);
  });

  it("names no tag in the shape that was silently 404ing", () => {
    /**
     * Sixteen of the previous twenty-one entries were unpullable. `qwen2.5-coder:7b-q4_K_M`
     * looks exactly like a real tag and is not one — the published tags carry an `-instruct-`
     * or `-base-` infix — so every download button on those rows answered 404. Nothing noticed,
     * because installed-detection resolves the bare alias and nobody had run a pull end to end.
     *
     * This cannot re-check the registry from a unit test. What it can do is pin the specific
     * shape that was wrong: for the two families that ship only variant-suffixed builds, a bare
     * `size-quant` id means someone has reintroduced the bug.
     */
    const variantOnly = ["qwen2.5-coder", "deepseek-r1"];
    for (const model of CATALOGUE) {
      const [family, tag] = model.id.split(":");
      if (!variantOnly.includes(family!)) continue;
      expect(
        /^[\d.]+b-q\d/i.test(tag!),
        `${model.id} has no variant segment — ${family} publishes none of those`
      ).toBe(false);
    }
  });

  it("only claims a licence it was checked against", () => {
    // DeepSeek-Coder sat here labelled MIT while shipping the DeepSeek License Agreement, whose
    // Attachment A carries use-based restrictions that fail clause 6 of the Open Source
    // Definition. The label passed the test above for as long as it was wrong. It is gone; this
    // stops it, or anything under those terms, coming back by the same route.
    expect(CATALOGUE.some((m) => m.id.startsWith("deepseek-coder:"))).toBe(false);
  });

  it("describes hybrid attention and MoE only where they apply", () => {
    for (const model of CATALOGUE) {
      if (model.kvLayers !== undefined) {
        expect(model.kvLayers, `${model.id} caches on more layers than it has`).toBeLessThan(
          model.layers
        );
        expect(model.kvLayers, `${model.id} caches on no layers`).toBeGreaterThan(0);
      }
      if (model.activeParamsB !== undefined) {
        expect(
          model.activeParamsB,
          `${model.id} routes to at least its whole self, so it is not MoE`
        ).toBeLessThan(model.paramsB);
        expect(model.activeParamsB).toBeGreaterThan(0);
      }
    }
  });

  it("carries both kinds of model the fit calculator now distinguishes", () => {
    // Without an example of each, the kvLayers and activeParamsB branches in fit.ts are dead
    // code that no catalogue entry exercises.
    expect(CATALOGUE.some((m) => m.kvLayers !== undefined)).toBe(true);
    expect(CATALOGUE.some((m) => m.activeParamsB !== undefined)).toBe(true);
    expect(CATALOGUE.some((m) => m.kvLayers === undefined)).toBe(true);
    expect(CATALOGUE.some((m) => m.activeParamsB === undefined)).toBe(true);
  });

  it("offers something at every size a real machine comes in", () => {
    // The expansion is pointless if it only adds models nobody's card can hold. One entry that
    // fits comfortably on 8 GB, and one that uses more than 16, means the ladder spans the
    // hardware rather than clustering at one end.
    const small = recommend(CATALOGUE, profile(8), 8192);
    expect(small.filter((r) => r.fit.tier === "comfortable").length).toBeGreaterThan(5);
    expect(CATALOGUE.some((m) => m.downloadGB > 16)).toBe(true);
  });

  it("keeps a coding model that runs on a small machine", () => {
    // Mirrors fit.test.ts's claim, which the expansion could have broken by displacing the
    // 1.5B entries behind a wall of larger variants.
    const ranked = recommend(CATALOGUE, profile(8), 8192);
    expect(ranked.some((r) => r.fit.tier !== "wont-fit")).toBe(true);
  });
});

/**
 * Nothing is silently absent.
 *
 * `recommend()` filters with `purpose === "chat" ? true : m.fim`, so every value except
 * "chat" drops non-FIM models *before scoring them* — they do not appear in any tier, marked
 * unsuitable or otherwise. The page asked for "both" and five models were simply missing: the
 * vision model and all four Mistral variants, with nothing to indicate they existed.
 *
 * The fix is that the page always asks for "chat" and filters locally, so hiding a model is
 * a choice the user made. These tests pin why that request value is the right one, because
 * "chat" reading like a narrower option than "both" is exactly what made it easy to get wrong.
 */
describe("asking for the whole catalogue", () => {
  const machine = profile(16);

  it("assesses every model when the purpose is chat", () => {
    // The load-bearing claim. If this ever stops holding, the page starts hiding models again.
    expect(recommend(CATALOGUE, machine, 32768)).toHaveLength(CATALOGUE.length);
  });

  it("scores every model, including the ones the old purpose filter hid", () => {
    // `recommend` used to take a purpose and drop anything without fill-in-the-middle, so the
    // vision model and every Mistral were unasked rather than unfittable. There is no filter
    // now; each gets a real tier and a real requirement.
    const ranked = recommend(CATALOGUE, machine, 32768);
    const mistral = ranked.find((r) => r.model.id.startsWith("mistral:"));
    expect(mistral).toBeDefined();
    expect(mistral!.fit.requiredGB).toBeGreaterThan(0);
    expect(mistral!.fit.explanation.length).toBeGreaterThan(0);
  });
});
