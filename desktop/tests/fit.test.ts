/**
 * The fit calculator, against known configurations.
 *
 * The spec names these cases (§Verification) because the failure mode is expensive: a
 * user watches a 5 GB download complete and then hits an OOM. Pure arithmetic, so they
 * are cheap to check and there is no excuse for not checking them.
 */
import { describe, it, expect } from "vitest";
import {
  assessFit,
  weightsGB,
  readPerTokenGB,
  kvCacheGB,
  recommend,
} from "../src/main/hardware/fit.js";
import { CATALOGUE, findModel } from "../src/main/hardware/catalogue.js";
import type { HardwareProfile } from "../src/main/hardware/scan.js";

function profile(over: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    gpus: [],
    unifiedMemory: false,
    hasDisplay: true,
    cpu: { model: "test", physicalCores: 8, flags: [] },
    ramTotalMB: 32 * 1024,
    diskFreeMB: 500 * 1024,
    backends: {},
    unknowns: [],
    scannedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const gpu = (name: string, vramGB: number, bandwidth?: number): HardwareProfile["gpus"][0] => ({
  vendor: "nvidia",
  name,
  vramTotalMB: vramGB * 1024,
  ...(bandwidth !== undefined ? { memoryBandwidthGBs: bandwidth } : {}),
});

const q7 = findModel("qwen2.5-coder:7b-instruct-q4_K_M")!;
const q14 = findModel("qwen2.5-coder:14b-instruct-q4_K_M")!;
const q1_5 = findModel("qwen2.5-coder:1.5b-instruct-q4_K_M")!;

/**
 * The MHA example, and no longer DeepSeek-Coder.
 *
 * That entry claimed MIT and shipped the DeepSeek License Agreement, whose Attachment A
 * carries use-based restrictions — so it left the catalogue. OLMo 2 fills the same teaching
 * role and is genuinely Apache-2.0: 40 KV heads against Qwen's 4, every layer caching.
 */
const mhaModel = findModel("olmo2:13b-1124-instruct-q4_K_M")!;

/** Hybrid attention: three linear-attention layers per full-attention one. */
const hybrid = findModel("qwen3.5:9b-q4_K_M")!;

/** Mixture-of-experts: 30.5B resident, 3.3B read per token. */
const moe = findModel("qwen3-coder:30b-a3b-q4_K_M")!;

describe("the arithmetic", () => {
  it("matches real GGUF sizes for Q4_K_M", () => {
    // A 7.62B model at ~4.8 bits/weight lands near 4.3 GiB, which is what the published
    // GGUF weighs. If this drifts, `bitsPerWeight` is wrong and every verdict shifts.
    expect(weightsGB(q7)).toBeGreaterThan(4.0);
    expect(weightsGB(q7)).toBeLessThan(4.7);
  });

  it("shows why GQA matters", () => {
    // 4 KV heads against 40, and a user comparing two mid-size models has no way to know
    // that without being shown. Per layer, so the comparison is head count not depth.
    const perLayer = (m: typeof q7) => kvCacheGB(m, 4096) / (m.kvLayers ?? m.layers);
    expect(perLayer(mhaModel) / perLayer(q7)).toBeGreaterThan(7);
  });

  it("counts only the layers that actually hold a KV cache", () => {
    // Qwen3.5 interleaves 3 linear-attention layers per full-attention one, so 8 of its 32
    // layers cache. Billing all 32 would overstate the cache 4x and report the model as too
    // big for cards that run it comfortably.
    expect(hybrid.kvLayers).toBe(8);
    expect(hybrid.layers).toBe(32);

    const actual = kvCacheGB(hybrid, 4096);
    const ifEveryLayerCached =
      (2 * hybrid.layers * hybrid.kvHeads * hybrid.headDim * 4096 * 2) / 2 ** 30;
    expect(ifEveryLayerCached / actual).toBeCloseTo(4, 1);
  });

  it("scales the KV cache linearly with context", () => {
    expect(kvCacheGB(q7, 8192)).toBeCloseTo(kvCacheGB(q7, 4096) * 2, 5);
  });

  it("reads only the active experts per token, but keeps them all resident", () => {
    // The distinction the whole MoE story turns on. A 30.5B model that routes 3.3B per token
    // needs 30.5B of VRAM and generates at 3.3B speed; conflating the two would either
    // promise memory it does not have or project a ninth of the speed it delivers.
    expect(weightsGB(moe)).toBeCloseTo((30.53 * 1e9 * 0.6) / 2 ** 30, 1);
    expect(readPerTokenGB(moe)).toBeCloseTo((3.3 * 1e9 * 0.6) / 2 ** 30, 1);
    expect(weightsGB(moe) / readPerTokenGB(moe)).toBeGreaterThan(8);
  });

  it("leaves dense models reading everything they hold", () => {
    expect(readPerTokenGB(q7)).toBe(weightsGB(q7));
  });

  it("projects MoE speed from what it reads, not from what it holds", () => {
    /**
     * The end-to-end version, and the one that matters. Asserting `readPerTokenGB` in isolation
     * says nothing about whether `assessFit` uses it — swapping the divisor back to the
     * resident weights left every direct test of the helper green.
     *
     * Same card, same quantisation, near-identical resident size: 30.5B of experts against a
     * 32.8B dense model. The MoE routes ~3.3B per token, so it should project several times
     * faster despite being the same weight on disk.
     */
    const big = profile({ gpus: [gpu("NVIDIA RTX 6000 Ada", 48, 960)] });
    const dense = findModel("qwen3:32b-q4_K_M")!;

    expect(assessFit(moe, big, 4096).tier).toBe("comfortable");
    expect(assessFit(dense, big, 4096).tier).toBe("comfortable");
    expect(Math.abs(weightsGB(moe) - weightsGB(dense))).toBeLessThan(2);

    const moeSpeed = assessFit(moe, big, 4096).estimatedTokensPerSecond;
    const denseSpeed = assessFit(dense, big, 4096).estimatedTokensPerSecond;
    expect(moeSpeed / denseSpeed).toBeGreaterThan(5);
  });
});

describe("8 GB RTX 4060", () => {
  const machine = profile({ gpus: [gpu("NVIDIA GeForce RTX 4060", 8, 272)] });

  it("takes a 7B but not comfortably", () => {
    const fit = assessFit(q7, machine, 8192);
    expect(["tight", "comfortable"]).toContain(fit.tier);
    expect(fit.requiredGB).toBeLessThanOrEqual(fit.usableGB);
  });

  it("predicts offload for a 14B instead of OOMing", () => {
    // The case that matters. Reporting "fits" here would mean a 9 GB download followed
    // by a crash.
    const fit = assessFit(q14, machine, 4096);
    expect(fit.tier).toBe("offload");
    expect(fit.gpuLayers).toBeGreaterThan(0);
    expect(fit.gpuLayers).toBeLessThan(q14.layers);
    expect(fit.explanation).toContain("CPU");
  });

  it("reserves VRAM for the desktop", () => {
    // 8 GB reported is not 8 GB available: 0.92 addressable, minus ~1.2 GB for the
    // compositor. Assuming otherwise is how a recommendation OOMs with a browser open.
    const fit = assessFit(q7, machine, 4096);
    expect(fit.usableGB).toBeLessThan(7.2);
  });
});

describe("24 GB RTX 3090", () => {
  const machine = profile({ gpus: [gpu("NVIDIA GeForce RTX 3090", 24, 936)] });

  it("takes a 14B comfortably", () => {
    const fit = assessFit(q14, machine, 8192);
    expect(fit.tier).toBe("comfortable");
    expect(fit.gpuLayers).toBe(q14.layers);
  });

  it("projects faster generation than a low-bandwidth card", () => {
    // Throughput tracks memory bandwidth, not VRAM size.
    const fast = assessFit(q7, machine, 4096);
    const slow = assessFit(q7, profile({ gpus: [gpu("NVIDIA GeForce RTX 4060", 8, 272)] }), 4096);
    expect(fast.estimatedTokensPerSecond).toBeGreaterThan(slow.estimatedTokensPerSecond);
  });
});

describe("M2 with 16 GB unified memory", () => {
  // VRAM is system RAM, so the budget is Metal's recommended working set (~75%), not
  // total RAM — and the desktop reserve is larger because the OS lives in the same pool.
  const machine = profile({
    unifiedMemory: true,
    ramTotalMB: 16 * 1024,
    gpus: [{ vendor: "apple", name: "Apple M2", vramTotalMB: Math.round(16 * 1024 * 0.75) }],
  });

  it("takes a 7B", () => {
    const fit = assessFit(q7, machine, 4096);
    expect(["comfortable", "tight"]).toContain(fit.tier);
  });

  it("budgets below total RAM", () => {
    const fit = assessFit(q7, machine, 4096);
    expect(fit.usableGB).toBeLessThan(16);
  });
});

describe("no GPU", () => {
  it("recommends the CPU path rather than refusing", () => {
    // A supported tier, not a failure (spec §4.4).
    const fit = assessFit(q1_5, profile({ ramTotalMB: 8 * 1024 }), 4096);
    expect(fit.tier).toBe("cpu-only");
    expect(fit.gpuLayers).toBe(0);
    expect(fit.estimatedTokensPerSecond).toBeGreaterThan(0);
    expect(fit.explanation).toContain("CPU");
  });

  it("declines when even RAM is short, and says why", () => {
    const fit = assessFit(q14, profile({ ramTotalMB: 4 * 1024 }), 4096);
    expect(fit.tier).toBe("wont-fit");
    expect(fit.explanation).toContain("smaller model");
  });
});

describe("context negotiation", () => {
  it("reduces context rather than reporting a failure", () => {
    // "Fits at 4k" is more useful than "does not fit" to someone who asked for 32k and
    // would happily take less.
    const machine = profile({ gpus: [gpu("NVIDIA GeForce RTX 4060", 8, 272)] });
    const fit = assessFit(mhaModel, machine, 16384);
    if (fit.tier !== "offload") {
      expect(fit.contextTokens).toBeLessThan(16384);
      expect(fit.requiredGB).toBeLessThanOrEqual(fit.usableGB);
    }
  });

  it("never proposes more context than the weights support", () => {
    const machine = profile({ gpus: [gpu("NVIDIA RTX A6000", 48, 768)] });
    expect(assessFit(mhaModel, machine, 1_000_000).contextTokens).toBeLessThanOrEqual(
      mhaModel.maxContext
    );
  });
});

describe("recommendation", () => {
  it("prefers a comfortable smaller model over a tight larger one", () => {
    const machine = profile({ gpus: [gpu("NVIDIA GeForce RTX 4060", 8, 272)] });
    const best = recommend(CATALOGUE, machine, 4096)[0]!;
    expect(["comfortable", "tight"]).toContain(best.fit.tier);
    expect(best.model.paramsB).toBeLessThan(q14.paramsB);
  });

  it("scores every model in the catalogue, with nothing filtered out", () => {
    // This asserted the opposite: `recommend` took a purpose and dropped anything without
    // fill-in-the-middle. Inline completion is gone and so is the parameter, so the models that
    // used to be silently excluded — the vision model and every Mistral — are ranked like the rest.
    const machine = profile({ gpus: [gpu("NVIDIA GeForce RTX 3090", 24, 936)] });
    const ids = recommend(CATALOGUE, machine, 4096).map((r) => r.model.id);
    expect(ids).toContain("mistral:7b-instruct-v0.3-q4_K_M");
    expect(ids).toHaveLength(CATALOGUE.length);
  });

  it("still returns something on a GPU-less machine", () => {
    const results = recommend(CATALOGUE, profile({ ramTotalMB: 8 * 1024 }), 4096);
    expect(results[0]?.fit.tier).toBe("cpu-only");
  });
});

describe("the catalogue", () => {
  it("offers only OSI-approved licences", () => {
    // Spec §4.2. Llama and Gemma are user-installable but never defaults, so a new user
    // is not steered onto weights under bespoke commercial terms.
    const OSI = new Set(["Apache-2.0", "MIT", "BSD-3-Clause"]);
    for (const model of CATALOGUE) expect(OSI.has(model.licence)).toBe(true);
  });

  it("has at least one coding model small enough for a CPU-only machine", () => {
    // The "runs on any desktop or laptop" claim is only true if something useful fits on the
    // median laptop. This asked for a fill-in-the-middle model while inline completion existed;
    // the coding models are the same set, and the claim they support is unchanged.
    const cpuOnly = profile({ ramTotalMB: 8 * 1024 });
    const usable = CATALOGUE.filter(
      (m) => m.id.includes("coder") && assessFit(m, cpuOnly, 4096).tier === "cpu-only"
    );
    expect(usable.length).toBeGreaterThan(0);
  });
});
