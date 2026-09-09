/**
 * How the file on screen reaches the model.
 *
 * **Inlining its contents suppresses tool calling, and that was measured rather than suspected.**
 * Driving Ollama with the two models `unwrapped.ts` recommends, on the app's own captured
 * request — an 11KB `docs/api.md` prepended to a short question — with eight runs per cell:
 *
 *                     contents inlined     file named instead
 *     qwen3:8b             2/8                    8/8
 *     llama3.1:8b          3/8                    6/8
 *
 * The turn that carried the file mostly produced prose: no `read_file`, no `list_files`, no
 * `write_plan`. Naming the file instead restored tool calling to the same rate as sending no
 * context at all. This is why the Plan pane was usually empty in practice — the model was not
 * refusing to plan, it was never reaching for the tool that records one.
 *
 * Two shapes were tried and rejected. A size cap fixes qwen3, which holds to 8KB, and does
 * nothing for llama3.1, which falls to 0/3 at five hundred characters — for that model it is the
 * presence of an attachment rather than its size. Putting the file in a separate earlier turn
 * was llama3.1's best result (3/3) and qwen3's worst (0/3). Naming the file is the only shape
 * both models agree on, which is what makes it the answer rather than a preference.
 *
 * **The cost is real and worth stating.** The comment this replaces argued that making the model
 * spend a tool call on the file already on screen is "a round trip for nothing". That was a fair
 * trade when the alternative was one extra call; it is not a fair trade when the alternative is
 * the model not calling anything at all for the rest of the turn.
 *
 * **Manual mode is the exception, and it inverts the argument.** It binds no tools, so there is
 * no `read_file` for the model to reach — naming the file would describe something it cannot
 * open. There the contents must be inlined, which is also harmless: a turn with no tools has no
 * tool calling to suppress.
 */
import { POLICIES } from "./modes.js";
import type { AgentMode } from "../../shared/agent-modes.js";
import type { MessageContent, ContentBlock } from "../inference/types.js";

export interface OpenFile {
  path: string;
  contents: string;
}

/**
 * Whether the model can fetch the file itself this turn.
 *
 * Read off the policy table rather than taken as a parameter, so this cannot disagree with what
 * is actually bound. A mode that gains or loses `read_file` changes this answer by changing the
 * table, which is the only place the decision should live.
 */
function canReadFiles(mode: AgentMode): boolean {
  return (POLICIES[mode].tools as readonly string[]).includes("read_file");
}

/** The wording measured above. Kept verbatim, because the numbers are about these words. */
function reference(path: string): string {
  return `The file \`${path}\` is open on screen. Read it with read_file if you need it.`;
}

function inlined(file: OpenFile): string {
  return `Currently open file \`${file.path}\`:\n\n\`\`\`\n${file.contents}\n\`\`\``;
}

/**
 * Weave the open file into the turn, in whichever form this mode can use.
 *
 * Composed in main, not the renderer. `personas.ts` records the rule — prompt text never arrives
 * from a renderer — and the renderer was quietly breaking it by wrapping the file in a sentence
 * and a fence. It now sends the path and the bytes; what is said about them is main's.
 */
export function withOpenFile(
  content: MessageContent,
  file: OpenFile | undefined,
  mode: AgentMode
): MessageContent {
  if (file === undefined) return content;
  const prefix = `${canReadFiles(mode) ? reference(file.path) : inlined(file)}\n\n`;

  if (typeof content === "string") return `${prefix}${content}`;

  /**
   * With images, the prefix joins the first text block rather than becoming a new one.
   *
   * Some providers treat a leading text block and a merged one differently when images follow,
   * and a turn that reads `[text, text, image]` where every other turn reads `[text, image]` is
   * a difference nothing else in this codebase creates. Prepending to the existing block keeps
   * the shape identical to what the renderer has always sent.
   */
  const first = content.findIndex((block) => block.type === "text");
  if (first === -1) {
    return [{ type: "text", text: prefix.trimEnd() }, ...content] as ContentBlock[];
  }

  return content.map((block, index) =>
    index === first && block.type === "text" ? { ...block, text: `${prefix}${block.text}` } : block
  );
}
