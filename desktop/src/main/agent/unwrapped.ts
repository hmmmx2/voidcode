/**
 * Catching a model that tried to call a tool and got the format wrong.
 *
 * Found by pointing the agent at `qwen2.5-coder:7b`, which is what the Build panel defaults to.
 * Ollama advertises `tools` for it, its template instructs the model to wrap calls in
 * `<tool_call></tool_call>`, and Ollama parses those tags back into a structured `tool_calls`
 * field. The model emits the right JSON and **omits the tags**, so nothing is ever parsed:
 *
 *   content:    {"name": "read_file", "arguments": {"path": "hello.ts"}}
 *   tool_calls: null
 *
 * Downstream, that is indistinguishable from a model that simply chose to answer in prose. The
 * loop sees no calls, `finishReason` is `stop`, the turn ends, and the assistant appears to have
 * ignored a direct instruction to read a file. Precisely the "agent occasionally does nothing"
 * failure the plan named as hardest to diagnose — arriving from a direction nothing guarded,
 * because the *provider* supports tools and the *model* does not.
 *
 * **Detected, not repaired.** Parsing this back into a call is tempting and wrong: it would make
 * the agent work by accident on a model that emits the tags sometimes and not others, turning a
 * reproducible failure into an intermittent one. It is also the fenced-block convention that
 * `propose_edit` exists to replace. `registry.ts` already sets the rule — reject rather than
 * degrade — and this is the same rule one layer up.
 */

/**
 * Does this text look like a tool call the transport failed to parse?
 *
 * Deliberately narrow. It must not fire on a model *discussing* a tool — "you could use
 * read_file here" is prose and stays prose — so it requires a whole JSON object naming a tool
 * the model was actually offered.
 */
export function looksLikeUnwrappedToolCall(
  text: string,
  offeredToolNames: readonly string[]
): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || offeredToolNames.length === 0) return null;

  /**
   * A fenced block anywhere in the reply counts, with prose on either side.
   *
   * This has been widened twice, each time by a live run rather than by a unit test:
   *
   *   v1 required the whole reply to be the object. qwen2.5-coder emits the call fenced and
   *   then a sentence asking the *user* to go and read the file, so v1 matched nothing.
   *
   *   v2 required the reply to *open* with the fence. llama3.1 explains what it is about to do
   *   first — "I will call the read_file function" — and fences the call after, so v2 matched
   *   nothing either.
   *
   * What keeps this narrow is not position but content: a fenced block whose entire body is a
   * JSON object naming a tool the model was actually offered, with arguments. "You could use
   * read_file here" has no such block and stays prose, which is the false positive that would
   * make this worse than the silence it replaces.
   */
  const candidates: string[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi)) {
    if (match[1] !== undefined) candidates.push(match[1].trim());
  }
  // The unfenced whole reply is still a candidate — some models emit the bare object.
  candidates.push(trimmed);

  // Every candidate is tried, not just the first object-shaped one — a reply can open with a
  // fenced snippet of ordinary code and carry the botched call in a later block.
  for (const candidate of candidates) {
    const name = toolNameIn(candidate, offeredToolNames);
    if (name !== null) return name;
  }
  return null;
}

/** One candidate: is this exactly a tool-call object for a tool that was offered? */
function toolNameIn(candidate: string, offeredToolNames: readonly string[]): string | null {
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const object = parsed as Record<string, unknown>;
  const name = object["name"];
  if (typeof name !== "string") return null;
  // Named a tool it was actually given — otherwise this is some other JSON reply, and a model
  // returning structured output is a legitimate thing to do.
  if (!offeredToolNames.includes(name)) return null;
  // `parameters` as well as `arguments`: llama3.1 uses the former when it writes one out by
  // hand, which is the schema's word rather than the call format's.
  if (!Object.hasOwn(object, "arguments") && !Object.hasOwn(object, "parameters")) return null;

  return name;
}

/**
 * What to tell the user.
 *
 * Names the model, because the model is the thing to change — and says what to do, because
 * "tool calling is unsupported" without a next step is a dead end. The suggestions are models
 * whose Ollama templates emit the tags reliably at this size.
 */
export function unwrappedToolCallMessage(model: string, toolName: string): string {
  return (
    `${model} tried to call "${toolName}" but emitted it as plain text rather than a tool ` +
    `call, so nothing ran. This model cannot drive the assistant's tools reliably — it is a ` +
    `code-completion model, and it is a good choice for inline completion. For tasks that need ` +
    `tools, pull a model whose tool calling works, such as llama3.1:8b or qwen3:8b, and pick it ` +
    `above.`
  );
}
