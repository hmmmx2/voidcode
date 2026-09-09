/**
 * Does this model fit on this machine, and what will it feel like?
 *
 * Pure arithmetic, no I/O, so it is unit-testable against known configurations — which
 * matters because the failure mode of getting it wrong is a user watching a 5 GB
 * download finish and then OOM. The formulas and the reasoning behind each constant
 * are in docs/desktop-app-spec.md §2.5.
 */
/**
 * Types live in `src/shared` so the renderer sees the same declaration main computes against.
 * They are re-exported here because every existing importer reaches for `./fit.js`, and a
 * module that moved its types without leaving a forwarding door is a rename pretending to be
 * a refactor.
 */
import type { HardwareProfile } from "../../shared/hardware-types.js";

export type {
  FitTier,
  FitVerdict,
  GpuInfo,
  GpuVendor,
  HardwareProfile,
  ModelSpec,
} from "../../shared/hardware-types.js";

import type { FitTier, FitVerdict, ModelSpec } from "../../shared/hardware-types.js";


const GIB = 1024 ** 3;

/** CUDA/Metal context plus activation scratch. Measured empirically, not derived. */
const RUNTIME_OVERHEAD_GB = 0.6;

/**
 * VRAM a desktop keeps for itself.
 *
 * A Windows machine with a display attached loses roughly this to the compositor and
 * whatever else is on screen; a headless compute card loses almost nothing. Assuming
 * zero is how you produce a recommendation that OOMs the moment a browser is open.
 */
function desktopReserveGB(profile: HardwareProfile): number {
  if (profile.unifiedMemory) return 3.0; // macOS keeps the OS and UI in the same pool
  return profile.hasDisplay ? 1.2 : 0.1;
}

export function weightsGB(model: ModelSpec): number {
  return (model.paramsB * 1e9 * (model.bitsPerWeight / 8)) / GIB;
}

/**
 * Weight bytes touched per generated token.
 *
 * The same as `weightsGB` for a dense model, and a small fraction of it for a
 * mixture-of-experts one, which routes each token through a few experts and leaves the rest
 * untouched in memory. This is the divisor for a bandwidth-bound throughput estimate;
 * `weightsGB` remains the right number for "does it fit".
 */
export function readPerTokenGB(model: ModelSpec): number {
  const active = model.activeParamsB ?? model.paramsB;
  return (active * 1e9 * (model.bitsPerWeight / 8)) / GIB;
}

/**
 * KV cache at fp16.
 *
 * 2 for K and V. Uses `kvHeads`, which for a GQA model is far below the attention
 * head count — the reason an 8B model at 4k costs ~0.5 GiB rather than ~2 GiB.
 */
export function kvCacheGB(model: ModelSpec, contextTokens: number): number {
  // `kvLayers` where a model caches on only some layers — hybrid-attention models interleave
  // linear-attention layers that hold nothing. Using `layers` for those overstates the cache
  // by the interleave ratio, which is 4x on Qwen3.5 and 6x on Gemma 4.
  const cachingLayers = model.kvLayers ?? model.layers;
  const bytes = 2 * cachingLayers * model.kvHeads * model.headDim * contextTokens * 2;
  return bytes / GIB;
}

function usableVramGB(profile: HardwareProfile): number {
  const gpu = profile.gpus[0];
  if (gpu === undefined) return 0;
  // 0.92 rather than 1.0: drivers, fragmentation, and the fact that reported total is
  // never all addressable.
  return (gpu.vramTotalMB / 1024) * 0.92 - desktopReserveGB(profile);
}

/**
 * Memory-bandwidth efficiency actually achieved, against the spec-sheet figure.
 *
 * Calibrated, not guessed. Qwen2.5-Coder-7B Q4_K_M on an RTX 5060 Ti (448 GB/s nominal)
 * measured 84.8 tok/s where the uncorrected formula projected 105 — about 81% of peak,
 * which matches the usual 70–85% range for real achieved bandwidth.
 *
 * Erring optimistic is the worse direction here: the projection's whole purpose is to set
 * an expectation before a multi-gigabyte download, and a number the hardware then misses
 * by a quarter is worse than no number.
 */
const BANDWIDTH_EFFICIENCY = 0.8;

/**
 * Very rough throughput projection.
 *
 * Memory-bandwidth bound, so tokens/sec tracks achieved bandwidth divided by
 * bytes-read-per-token (≈ the weights). Deliberately crude: the number's job is to
 * distinguish "usable" from "you will hate this", not to be a benchmark, and it is always
 * labelled as an estimate.
 *
 * **Bytes read, not bytes resident.** On a mixture-of-experts model those differ by most of
 * the model: Qwen3-Coder-30B-A3B keeps 30.5B in VRAM and reads 3.3B per token. Dividing by the
 * resident size would project ~9x too slow and make every MoE entry look unusable, which is
 * the opposite of the truth — reading little per token is the reason they run well on modest
 * cards.
 */
function projectTokensPerSecond(
  model: ModelSpec,
  profile: HardwareProfile,
  gpuLayers: number
): number {
  const gpu = profile.gpus[0];
  const read = readPerTokenGB(model);
  const gpuFraction = model.layers === 0 ? 0 : gpuLayers / model.layers;

  const gpuBandwidth = gpu?.memoryBandwidthGBs ?? (profile.unifiedMemory ? 200 : 300);
  const cpuBandwidth = profile.unifiedMemory ? gpuBandwidth : 40; // DDR4/5 dual channel

  // Harmonic-ish blend: the CPU portion dominates once anything is offloaded, which is
  // exactly the intuition a user needs before choosing to offload.
  const effective = gpuFraction * gpuBandwidth + (1 - gpuFraction) * cpuBandwidth;
  return Math.max(1, Math.round((effective * BANDWIDTH_EFFICIENCY) / read));
}

export function assessFit(
  model: ModelSpec,
  profile: HardwareProfile,
  requestedContext: number
): FitVerdict {
  const wGB = weightsGB(model);
  const overhead = RUNTIME_OVERHEAD_GB;
  const usable = usableVramGB(profile);
  const hasGpu = profile.gpus.length > 0 && usable > 0;

  // Try the requested context, then halve until it fits. Reporting "fits at 4k" beats
  // "does not fit" when the user asked for 8k and would happily take 4k.
  let context = Math.min(requestedContext, model.maxContext);
  let kv = kvCacheGB(model, context);

  if (hasGpu) {
    while (wGB + kv + overhead > usable && context > 1024) {
      context = Math.floor(context / 2);
      kv = kvCacheGB(model, context);
    }
  }

  const required = wGB + kv + overhead;

  if (!hasGpu) {
    // CPU-only is a supported tier, not a failure (spec §4.4). What decides it is
    // system RAM, and the app must still be fully usable if the user declines a model.
    const ramGB = profile.ramTotalMB / 1024;
    const fitsInRam = required + 2 /* OS headroom */ < ramGB;
    const tps = projectTokensPerSecond(model, profile, 0);
    return {
      tier: fitsInRam ? "cpu-only" : "wont-fit",
      contextTokens: context,
      weightsGB: wGB,
      kvCacheGB: kv,
      overheadGB: overhead,
      requiredGB: required,
      usableGB: ramGB,
      gpuLayers: 0,
      estimatedTokensPerSecond: tps,
      explanation: fitsInRam
        ? `No usable GPU detected, so this runs on the CPU at roughly ${tps} tokens/sec. Workable for short questions; slow for long answers.`
        : `Needs about ${required.toFixed(1)} GB and this machine has ${ramGB.toFixed(1)} GB of RAM. Try a smaller model.`,
    };
  }

  if (required <= usable * 0.7) {
    const tps = projectTokensPerSecond(model, profile, model.layers);
    return {
      tier: "comfortable",
      contextTokens: context,
      weightsGB: wGB,
      kvCacheGB: kv,
      overheadGB: overhead,
      requiredGB: required,
      usableGB: usable,
      gpuLayers: model.layers,
      estimatedTokensPerSecond: tps,
      explanation: `Fits comfortably at ${context} tokens of context, using about ${required.toFixed(1)} of ${usable.toFixed(1)} GB. Around ${tps} tokens/sec.`,
    };
  }

  if (required <= usable) {
    const tps = projectTokensPerSecond(model, profile, model.layers);
    const shrunk = context < Math.min(requestedContext, model.maxContext);
    return {
      tier: "tight",
      contextTokens: context,
      weightsGB: wGB,
      kvCacheGB: kv,
      overheadGB: overhead,
      requiredGB: required,
      usableGB: usable,
      gpuLayers: model.layers,
      estimatedTokensPerSecond: tps,
      explanation: shrunk
        ? `Fits only after reducing context to ${context} tokens (${required.toFixed(1)} of ${usable.toFixed(1)} GB). Around ${tps} tokens/sec. Close another GPU-heavy app if it struggles.`
        : `Fits, but with little room: ${required.toFixed(1)} of ${usable.toFixed(1)} GB. Around ${tps} tokens/sec.`,
    };
  }

  // Partial offload. Solve for how many layers fit, leaving room for KV and overhead.
  const perLayerGB = wGB / model.layers;
  const budget = usable - kv - overhead;
  const gpuLayers = Math.max(0, Math.min(model.layers, Math.floor(budget / perLayerGB)));
  const tps = projectTokensPerSecond(model, profile, gpuLayers);

  return {
    tier: "offload",
    contextTokens: context,
    weightsGB: wGB,
    kvCacheGB: kv,
    overheadGB: overhead,
    requiredGB: required,
    usableGB: usable,
    gpuLayers,
    estimatedTokensPerSecond: tps,
    // The honest version of the spec's "≈6 tok/s, 18 layers on CPU" example. Telling
    // someone this before a 5 GB download is the whole point of the tier.
    explanation: `Too big to fit entirely: needs ${required.toFixed(1)} GB, ${usable.toFixed(1)} GB available. ${gpuLayers} of ${model.layers} layers would run on the GPU and the rest on the CPU, at roughly ${tps} tokens/sec.`,
  };
}

/**
 * Best model for a machine, by purpose.
 *
 * Prefers a comfortable fit over a bigger model in a tight one: a 14B that thrashes is
 * worse than a 7B that does not, and the user cannot easily tell which they have until
 * they have waited for the download.
 */
export function recommend(
  models: readonly ModelSpec[],
  profile: HardwareProfile,
  contextTokens: number
): Array<{ model: ModelSpec; fit: FitVerdict }> {
  const RANK: Record<FitTier, number> = {
    comfortable: 0,
    tight: 1,
    "cpu-only": 2,
    offload: 3,
    "wont-fit": 4,
  };

  return models
    .map((model) => ({ model, fit: assessFit(model, profile, contextTokens) }))
    .sort((a, b) => {
      const byTier = RANK[a.fit.tier] - RANK[b.fit.tier];
      if (byTier !== 0) return byTier;
      // Within a tier, more parameters is better.
      return b.model.paramsB - a.model.paramsB;
    });
}
