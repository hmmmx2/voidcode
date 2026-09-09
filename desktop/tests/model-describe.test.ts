/**
 * The table's columns, derived from a tag.
 *
 * `ModelSpec` carries what the fit calculator needs — layers, kvHeads, bitsPerWeight — and a
 * label meant for a sentence. Architecture, parameter size and quantisation are not fields,
 * because nothing needed them apart until there was a column each. Deriving them keeps the
 * tag as the single source of truth; adding three denormalised fields would create a second
 * place for a model to be named, and the two would disagree the first time a tag changed.
 */
import { describe, it, expect } from "vitest";
import {
  describeContext,
  describeModel,
  formatParameters,
  quantisationFromBits,
  quantisationFromId,
} from "../renderer/src/lib/models/describe.js";
import { CATALOGUE } from "../src/main/hardware/catalogue.js";
import type { FitVerdict, ModelSpec } from "../src/shared/hardware-types.js";

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: "qwen2.5-coder:7b-q4_K_M",
  label: "Qwen2.5-Coder 7B (Q4_K_M)",
  paramsB: 7.62,
  bitsPerWeight: 4.8,
  layers: 28,
  kvHeads: 4,
  headDim: 128,
  maxContext: 32768,
  licence: "Apache-2.0",
  downloadGB: 4.7,
  ...over,
});

const verdict = (over: Partial<FitVerdict> = {}): FitVerdict => ({
  tier: "comfortable",
  contextTokens: 32768,
  weightsGB: 4.3,
  kvCacheGB: 1.8,
  overheadGB: 0.6,
  requiredGB: 6.6,
  usableGB: 13.4,
  gpuLayers: 28,
  estimatedTokensPerSecond: 84,
  explanation: "Fits comfortably.",
  ...over,
});

describe("quantisation from the tag", () => {
  it("reads the suffix", () => {
    expect(quantisationFromId("qwen2.5-coder:7b-q4_K_M")).toBe("Q4_K_M");
    expect(quantisationFromId("qwen2.5-coder:14b-q8_0")).toBe("Q8_0");
    expect(quantisationFromId("deepseek-coder:6.7b-q5_K_M")).toBe("Q5_K_M");
  });

  it("returns null for a tag with none", () => {
    // The vision model ships unsuffixed. Inventing a quantisation for it would be worse than
    // saying nothing, which is why this is null rather than a default.
    expect(quantisationFromId("qwen2.5vl:7b")).toBeNull();
    expect(quantisationFromId("mistral:7b-instruct")).toBeNull();
  });

  it("does not mistake a size or a version for a quantisation", () => {
    // `-q` followed by a digit is the marker. `6.7b`, `2.5`, and `-instruct` must survive it.
    expect(quantisationFromId("deepseek-coder:6.7b")).toBeNull();
    expect(quantisationFromId("qwen2.5-coder:1.5b")).toBeNull();
  });

  it("falls back to naming the bit rate", () => {
    // `qwen2.5vl:7b` is Q4_K_M in practice and the catalogue records that as 4.8 bits.
    // Showing "—" would suggest an unquantised 7B, which does not fit in 6 GB.
    expect(quantisationFromBits(4.8)).toBe("Q4");
    expect(quantisationFromBits(5.6)).toBe("Q5");
    expect(quantisationFromBits(6.6)).toBe("Q6");
    expect(quantisationFromBits(8.5)).toBe("Q8");
  });

  it("names an unusual rate rather than rounding it into a bucket", () => {
    expect(quantisationFromBits(3.4)).toBe("3.4-bit");
  });

  it("actually falls back to the bit rate for an unsuffixed model", () => {
    /**
     * The mutation that survived the first pass. `quantisationFromBits` being correct is
     * worth nothing if `describeModel` renders "—" instead of calling it — and the only
     * unsuffixed entry in the catalogue is the vision model, which is exactly the row where
     * a dash would read as "unquantised" for a 7B shipping in 6 GB.
     */
    expect(describeModel(spec({ id: "qwen2.5vl:7b", bitsPerWeight: 4.8 })).quantisation).toBe("Q4");
  });

  it("prefers the tag over the bit rate when both are available", () => {
    // Q4_K_M and Q4_0 have the same effective rate and different names. The tag is specific;
    // the rate is an inference from it.
    expect(describeModel(spec()).quantisation).toBe("Q4_K_M");
  });

  it("never leaves a catalogue entry without a quantisation", () => {
    for (const model of CATALOGUE) {
      const value = describeModel(model).quantisation;
      expect(value, `${model.id} has no quantisation`).toBeTruthy();
      expect(value).not.toBe("—");
    }
  });
});

describe("parameters", () => {
  it("shows one decimal", () => {
    expect(formatParameters(7.62)).toBe("7.6B");
    expect(formatParameters(1.54)).toBe("1.5B");
    expect(formatParameters(14.8)).toBe("14.8B");
  });

  it("drops a trailing zero", () => {
    // "2.0B" reads as false precision for a round number.
    expect(formatParameters(2)).toBe("2B");
  });
});

describe("architecture", () => {
  it("writes known families the way their authors do", () => {
    // A capitalisation heuristic cannot produce both "Qwen2.5-Coder" and "DeepSeek-R1" — the
    // capital S is not derivable — and guessing gives "Deepseek-R1", which is wrong in a way
    // that looks careless rather than broken. Likewise "QwQ", which no rule produces.
    expect(describeModel(spec()).architecture).toBe("Qwen2.5-Coder");
    expect(describeModel(spec({ id: "deepseek-r1:7b-qwen-distill-q4_K_M" })).architecture).toBe(
      "DeepSeek-R1"
    );
    expect(describeModel(spec({ id: "qwq:32b-q4_K_M" })).architecture).toBe("QwQ");
    expect(describeModel(spec({ id: "mistral:7b-instruct-q4_K_M" })).architecture).toBe("Mistral");
    expect(describeModel(spec({ id: "qwen2.5vl:7b" })).architecture).toBe("Qwen2.5-VL");
  });

  it("shows the raw prefix for an unmapped family", () => {
    // Honest: an unknown family shows its tag rather than a mangled guess at a brand name.
    expect(describeModel(spec({ id: "newthing:8b-q4_K_M" })).architecture).toBe("newthing");
  });

  it("covers every family in the catalogue", () => {
    /**
     * The mutation this guards. Adding a family to the catalogue without adding it to the
     * map leaves its architecture column showing a lowercase tag — a small ugliness that no
     * other test would notice, in the column a developer reads first.
     */
    for (const model of CATALOGUE) {
      const prefix = model.id.split(":")[0] ?? "";
      expect(
        describeModel(model).architecture,
        `${model.id} has no architecture mapping`
      ).not.toBe(prefix);
    }
  });
});

describe("format", () => {
  it("is GGUF for everything, which is why it is not its own column", () => {
    // Every entry is served by Ollama. A column reading "GGUF" twenty-one times tells you
    // nothing, so it pairs with the quantisation instead. This becomes a real column the day
    // a provider serves AWQ — llama.cpp is already in the registry and does not.
    const formats = new Set(CATALOGUE.map((m) => describeModel(m).format));
    expect([...formats]).toEqual(["GGUF"]);
  });
});

describe("context", () => {
  it("shows what the model will actually run at", () => {
    const described = describeContext(spec(), verdict({ contextTokens: 32768 }));
    expect(described.label).toBe("32k");
    expect(described.reduced).toBe(false);
  });

  it("marks a context the machine forced down", () => {
    /**
     * `assessFit` halves the requested context until the model fits, so a 14B on a 16 GB card
     * lands at 4k rather than 32k. Showing only the maximum would advertise a capability this
     * machine cannot deliver; showing only the negotiated figure would hide that the model
     * can do more elsewhere. Both, with the reduction marked.
     */
    const described = describeContext(spec(), verdict({ contextTokens: 4096 }));
    expect(described.label).toBe("4k");
    expect(described.reduced).toBe(true);
    expect(described.title).toContain("32,768");
    expect(described.title).toContain("4,096");
  });
});
