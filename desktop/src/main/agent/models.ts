/**
 * Picking a model that can actually call a tool.
 *
 * Direct parallel to `pickFimModel`, and the same lesson: that function is an allowlist rather
 * than a preference over everything installed, because "a model with no FIM training will
 * happily accept the sentinels and produce prose". Tools fail the same way and worse.
 *
 * Established by pointing the agent at `qwen2.5-coder:7b`, which the Build panel hardcoded as
 * its default. Ollama reports `tools` for it; its template instructs the model to wrap calls in
 * `<tool_call></tool_call>`; Ollama parses those tags back out. The model emits the JSON and
 * omits the tags, so `tool_calls` is never populated and the agent silently calls nothing.
 *
 * **So the provider's capability flag is not enough, and neither is the daemon's.** Both said
 * yes. The only thing that predicted the truth was which model it was — hence a list of
 * families, kept honest by the fact that everything on it has been checked to emit the tags.
 *
 * Resolved in main, not named by the renderer: a hardcoded
 * preference that is not installed becomes a 404 on every request, and "inline completion
 * shipped pointing at a 1.5b nobody had" is the mistake already made once here.
 */

/**
 * Families whose Ollama templates emit tool-call tags reliably.
 *
 * Deliberately conservative. A model missing from this list is not refused — it is used with a
 * warning — because the cost of being wrong in that direction is a message, and the cost of
 * being wrong the other way is an assistant that silently does nothing.
 */
const TOOL_FAMILIES: readonly string[] = [
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "qwen3",
  "mistral-nemo",
  "mistral-small",
  "firefunction",
  "command-r",
  "hermes3",
  "granite3",
];

/**
 * Variants that are code-completion models first.
 *
 * `qwen2.5-coder` is the reason this exists: it matches nothing above, but a looser rule like
 * "any qwen" would have picked it, and it is the specific model that provoked all of this.
 * Excluded explicitly so a future widening of the families list cannot quietly readmit it.
 */
const COMPLETION_VARIANTS = /coder|code-|starcoder|codellama|codegemma|stable-code/i;

/** `llama3.1:8b` -> 8. Unknown tags sort last, so a tagged model is preferred over a bare one. */
function parameterBillions(modelId: string): number {
  const match = /[:\-](\d+(?:\.\d+)?)b\b/i.exec(modelId);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

export function isToolCapable(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (COMPLETION_VARIANTS.test(id)) return false;
  return TOOL_FAMILIES.some((family) => id.includes(family));
}

export interface AgentModelChoice {
  model: string;
  /**
   * True when nothing installed is known to call tools, so this is a guess.
   *
   * The run still happens — refusing outright would be wrong when the list is merely
   * incomplete — but the caller can say so, and `unwrapped.ts` catches the failure if the
   * guess turns out badly.
   */
  unverified: boolean;
}

/**
 * Choose the model for an agentic turn.
 *
 * The caller's preference wins **only if it is tool-capable**. That is the whole difference
 * from `pickFimModel`, which honours a preference it finds installed: here, honouring a
 * preference that cannot call tools is how the assistant ends up doing nothing at all.
 *
 * Largest rather than smallest. This is the opposite of what a completion model wants — that is
 * small model wins; deciding which tool to call and with what arguments is a reasoning problem,
 * and a 3B that calls the wrong tool is not faster in any sense the user cares about.
 */
export function pickAgentModel(
  installed: readonly string[],
  preferred: string
): AgentModelChoice | undefined {
  if (installed.length === 0) return undefined;

  if (installed.includes(preferred) && isToolCapable(preferred)) {
    return { model: preferred, unverified: false };
  }

  const capable = installed
    .filter((id) => isToolCapable(id))
    .sort((a, b) => parameterBillions(b) - parameterBillions(a));

  if (capable[0] !== undefined) return { model: capable[0], unverified: false };

  // Nothing known-good. Prefer what was asked for, so the message names the model the user
  // chose rather than one they have never heard of.
  const fallback = installed.includes(preferred) ? preferred : installed[0];
  return fallback === undefined ? undefined : { model: fallback, unverified: true };
}

/** Said when nothing installed is known to call tools. Names what to pull. */
export function noToolModelMessage(model: string): string {
  return (
    `No installed model is known to call tools reliably, so this turn used ${model}. If the ` +
    `assistant answers without using its tools, pull one that does — llama3.1:8b or qwen3:8b — ` +
    `and it will be picked automatically.`
  );
}
