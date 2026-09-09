/**
 * What the machine is, and whether a model fits on it.
 *
 * Shared rather than mirrored. `host.d.ts` used to hand-declare a *subset* of
 * `HardwareProfile` — no `unifiedMemory`, no `diskFreeMB`, no `backends`, and none of
 * `GpuInfo`'s optional fields — so the renderer could not see most of what main had already
 * measured, and widening it meant editing two files that no test compared. That is the exact
 * failure `agent-event-parity.test.ts` and `chat-chunk-parity.test.ts` exist to police, twice
 * over. One declaration, imported by both projects, is cheaper than a third parity test.
 *
 * **Types only.** This file has no imports and no runtime values, for the same reason
 * `commands.ts` does not: `contract.ts` reaches into shared, and shared reaching back is how
 * a cycle starts.
 *
 * **`T | null`, never `T?`** on anything that crosses the boundary — `exactOptionalPropertyTypes`
 * is on for `desktop/tsconfig.json` and off for the renderer, so an optional property means
 * two different things depending on which compiler is reading it. The pre-existing `vision?`
 * and `vramFreeMB?` are kept as-is rather than churned; new fields follow the rule.
 */

/** Who made the adapter. Determines which tool was asked, and how much to trust the answer. */
export type GpuVendor = "nvidia" | "amd" | "apple" | "intel";

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  /**
   * Total VRAM in MB.
   *
   * On Windows for AMD/Intel this comes from `Win32_VideoController.AdapterRAM`, a 32-bit
   * field that wraps above 4 GB — so it is trusted only below 4096 and otherwise discarded
   * into `unknowns`. When it is present for those vendors it is a floor, not a measurement.
   */
  vramTotalMB: number;
  /** Absent when the vendor's tooling does not report it. Only nvidia-smi does today. */
  vramFreeMB?: number;
  computeCapability?: string;
  driver?: string;
  /** Only for adapters in `scan.ts`'s lookup table. Absent means "not in the table". */
  memoryBandwidthGBs?: number;
}

export interface HardwareProfile {
  gpus: GpuInfo[];
  /** Apple Silicon. Changes the desktop reserve from 1.2 GB to 3.0 GB. */
  unifiedMemory: boolean;
  /**
   * Hardcoded `true` in `scan.ts` — there is no portable API for it.
   *
   * Load-bearing despite being a constant: `desktopReserveGB` subtracts 1.2 GB on its
   * strength. A UI must not present it as a measurement.
   */
  hasDisplay: boolean;
  cpu: {
    model: string;
    /** `os.cpus().length / 2`, described in `scan.ts` as "a floor rather than a fact". */
    physicalCores: number;
    /**
     * ALWAYS EMPTY. AVX2/AVX512 detection was specified and never implemented.
     *
     * Kept in the type because the scanner returns the key. Anything branching on it is
     * branching on `[]` forever — check `scan.ts` before writing that code, not this comment.
     */
    flags: string[];
  };
  ramTotalMB: number;
  /** `0` when `statfs` failed, which is indistinguishable from a genuinely full disk. */
  diskFreeMB: number;
  backends: {
    ollama?: string;
    llamaCpp?: string;
    /** Declared in the scanner and never populated. */
    vllm?: string;
  };
  /**
   * What could not be determined, in plain language, ready to show.
   *
   * `scan.ts`'s governing rule is "every value here is measured or absent — there are no
   * fallback guesses that look like data". This is where the absences go, and a UI that drops
   * it silently re-introduces the guess by omission.
   */
  unknowns: string[];
  scannedAt: string;
}

export interface ModelSpec {
  id: string;
  label: string;
  paramsB: number;
  /**
   * The *effective* bits per weight, not the nominal one.
   *
   * Q4_K_M averages ~4.8 because it keeps some tensors at higher precision, which is why an
   * "8B Q4" GGUF is ~4.9 GB rather than 4.0 GB.
   */
  bitsPerWeight: number;
  /**
   * Parameters actually read per token, when that differs from `paramsB`.
   *
   * Mixture-of-experts only. Every expert has to be resident, so VRAM keeps following
   * `paramsB`; but generation is memory-bandwidth bound on the weights it *reads*, and a
   * 30.5B model routing to 3.3B per token generates about nine times faster than its total
   * size suggests. Absent on dense models, where the two are the same number.
   */
  activeParamsB?: number;
  layers: number;
  /**
   * Layers that hold a KV cache, when that is not all of them.
   *
   * Qwen3.5 and Qwen3.6 interleave three linear-attention layers per full-attention one,
   * Gemma 4 runs five to one, Olmo 3 three to one. Only the full-attention layers cache
   * anything, so counting all of them overstates the KV cache four- to six-fold — enough to
   * report a model as too big for a card that runs it comfortably. Absent where every layer
   * caches, which is the conventional case.
   */
  kvLayers?: number;
  kvHeads: number;
  headDim: number;
  maxContext: number;
  vision?: boolean;
  licence: string;
  /** Published GGUF size. Never computed — see the catalogue header. */
  downloadGB: number;
}

/**
 * How well a model fits, worst to best: it runs comfortably, it runs with no headroom, it
 * runs partly on the CPU, it runs entirely on the CPU, or it does not run.
 */
export type FitTier = "comfortable" | "tight" | "offload" | "cpu-only" | "wont-fit";

export interface FitVerdict {
  tier: FitTier;
  /** May be below what was asked for — `assessFit` halves until it fits, floor 1024. */
  contextTokens: number;
  weightsGB: number;
  kvCacheGB: number;
  overheadGB: number;
  requiredGB: number;
  usableGB: number;
  gpuLayers: number;
  estimatedTokensPerSecond: number;
  /** Plain language, written to be shown verbatim rather than summarised. */
  explanation: string;
}

/**
 * Live load, as opposed to the static profile above.
 *
 * **Every field is `number | null`, and null means "not measured on this machine" — never
 * "zero".** GPU utilisation comes only from `nvidia-smi`, so on AMD, Intel and Apple those
 * three fields are permanently null; `cpuBusy` is null for the first sample because
 * utilisation is the *difference* between two readings of a cumulative counter and there is
 * no previous one yet.
 *
 * A UI that renders null as an empty bar is claiming an idle machine. It has to say "not
 * reported" instead, which is the same rule `scan.ts` states for `unknowns` and the reason
 * this type refuses to default anything.
 */
export interface TelemetrySample {
  at: string;
  /** 0–1. Null on the first sample, and whenever two reads land inside one counter tick. */
  cpuBusy: number | null;
  ramTotalMB: number;
  ramUsedMB: number;
  /** 0–1, NVIDIA only. */
  gpuBusy: number | null;
  /** NVIDIA only. This is the number that decides whether another model fits beside this one. */
  vramUsedMB: number | null;
  vramTotalMB: number | null;
}
