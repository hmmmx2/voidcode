/**
 * The columns a developer wants, derived from the fields the catalogue actually has.
 *
 * `ModelSpec` carries architecture figures for the fit calculator — layers, kvHeads, headDim,
 * bitsPerWeight — and a label meant for a sentence. It does not carry "architecture",
 * "parameter size" or "quantisation" as separate values, because nothing needed them apart
 * until there was a table with a column each.
 *
 * Deriving them rather than adding three denormalised fields keeps one source of truth: the
 * tag. An `architecture` field would be a second place for `qwen2.5-coder:7b-q4_K_M` to be
 * called something, and the two would disagree the first time a tag changed.
 *
 * Pure, so the parsing is testable without a catalogue.
 */
import type { FitVerdict, ModelSpec } from "@shared/hardware-types";

export interface ModelDescription {
  /** "Qwen2.5-Coder". The family, without size or quantisation. */
  architecture: string;
  /** "7.6B". One decimal, trailing zero dropped. */
  parameters: string;
  /** "Q4_K_M". Derived from the tag, or from the bit rate when the tag omits it. */
  quantisation: string;
  /** "GGUF". Constant today — see the note on `FORMAT`. */
  format: string;
}

/**
 * How a family's tag prefix is written out.
 *
 * An explicit map rather than a capitalisation heuristic. "qwen2.5-coder" has no rule that
 * produces "Qwen2.5-Coder" and also produces "DeepSeek-Coder" from "deepseek-coder" — the
 * capital S is not derivable from anything. Guessing gets "Deepseek-Coder", which is wrong in
 * a way that looks careless rather than broken.
 *
 * The fallback is the raw prefix, which is honest: an unmapped family shows its tag rather
 * than a mangled guess at a brand name.
 */
const ARCHITECTURE: Record<string, string> = {
  "deepseek-r1": "DeepSeek-R1",
  "devstral-small-2": "Devstral",
  gemma4: "Gemma 4",
  "granite4.1": "Granite",
  magistral: "Magistral",
  mathstral: "Mathstral",
  "ministral-3": "Ministral",
  mistral: "Mistral",
  "mistral-nemo": "Mistral NeMo",
  "mistral-small3.2": "Mistral Small",
  "olmo-3": "Olmo 3",
  "olmo-3.1": "Olmo 3.1",
  olmo2: "OLMo 2",
  phi4: "Phi-4",
  "phi4-mini": "Phi-4-mini",
  "phi4-reasoning": "Phi-4-reasoning",
  "qwen2.5-coder": "Qwen2.5-Coder",
  "qwen2.5vl": "Qwen2.5-VL",
  qwen3: "Qwen3",
  "qwen3-coder": "Qwen3-Coder",
  "qwen3-vl": "Qwen3-VL",
  "qwen3.5": "Qwen3.5",
  "qwen3.6": "Qwen3.6",
  qwq: "QwQ",
  smollm2: "SmolLM2",
};

/**
 * Everything in the catalogue is GGUF, because everything in it is served by Ollama.
 *
 * Kept as a field rather than a column of its own: a table column reading "GGUF" twenty-one
 * times is a column that tells you nothing, so this pairs with the quantisation instead. It
 * becomes worth separating the day a provider serves AWQ or GPTQ — llama.cpp is already in
 * the registry and does not, so this is not that day.
 */
const FORMAT = "GGUF";

/** `Q4_K_M` from a tag suffix, case-normalised. Null when the tag carries no quantisation. */
export function quantisationFromId(id: string): string | null {
  const match = /-(q\d+[a-z0-9_]*)$/i.exec(id);
  if (match?.[1] === undefined) return null;
  // Ollama writes `q4_K_M`; upper-casing the leading letter matches how it is written in
  // model cards and in this catalogue's own labels.
  return match[1].replace(/^q/i, "Q");
}

/**
 * A readable quantisation for a tag that has none.
 *
 * `qwen2.5vl:7b` is published without a suffix and is Q4_K_M in practice, which the catalogue
 * records as `bitsPerWeight: 4.8`. Showing "—" there would suggest the model is unquantised,
 * which for a 7B in 6 GB is not possible; naming the rate is the honest middle.
 */
export function quantisationFromBits(bitsPerWeight: number): string {
  if (bitsPerWeight >= 8) return "Q8";
  if (bitsPerWeight >= 6.2) return "Q6";
  if (bitsPerWeight >= 5.2) return "Q5";
  if (bitsPerWeight >= 4.4) return "Q4";
  return `${bitsPerWeight.toFixed(1)}-bit`;
}

/** `7.62` → `"7.6B"`, `14.8` → `"14.8B"`, `2` → `"2B"`. */
export function formatParameters(paramsB: number): string {
  const oneDecimal = paramsB.toFixed(1);
  return `${oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal}B`;
}

export function describeModel(model: ModelSpec): ModelDescription {
  const prefix = model.id.split(":")[0] ?? model.id;
  return {
    architecture: ARCHITECTURE[prefix] ?? prefix,
    parameters: formatParameters(model.paramsB),
    quantisation: quantisationFromId(model.id) ?? quantisationFromBits(model.bitsPerWeight),
    format: FORMAT,
  };
}

/**
 * The context the model will actually run at, and whether that is what it was asked for.
 *
 * `assessFit` halves the requested context until the model fits, so `fit.contextTokens` is
 * frequently below `model.maxContext` — a 14B on a 16 GB card lands at 4k rather than 32k.
 * Showing only the maximum would be advertising a capability this machine cannot deliver;
 * showing only the negotiated figure would hide that the model can do more elsewhere.
 */
export function describeContext(
  model: ModelSpec,
  fit: FitVerdict
): { label: string; reduced: boolean; title: string } {
  const reduced = fit.contextTokens < model.maxContext;
  return {
    label: `${Math.round(fit.contextTokens / 1024)}k`,
    reduced,
    title: reduced
      ? `Reduced to ${fit.contextTokens.toLocaleString()} tokens to fit this machine. The model supports ${model.maxContext.toLocaleString()}.`
      : `${fit.contextTokens.toLocaleString()} tokens, the model's maximum.`,
  };
}
