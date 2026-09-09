/**
 * What the agent may do this turn.
 *
 * One table, read by the graph. The alternative — branching on a mode string in the prompt
 * builder, the tool binder and the loop condition — spreads "what can Auto do" across five
 * files and makes it a question you answer by reading code rather than by reading a value.
 *
 * **The intersection in `toolsFor` is the load-bearing line.** The renderer names the mode,
 * which is legitimate: the user chose it. But a mode may only ever *narrow* what the surface
 * already permits, so there is no value of `mode` that hands the tutor a filesystem tool. Get
 * that backwards — treat the policy list as authoritative and the surface as advisory — and a
 * renderer would be choosing its own privileges, which is the thing `personas.ts` exists to
 * prevent.
 *
 * **The prompt is part of the policy, not decoration.** `personas.ts` records what this
 * codebase already paid for: *"an instruction in the persona outranks a tool definition,
 * because the model reads both and the prose is more specific."* A prompt that says "call
 * propose_edit" in a mode without that tool does not produce a refusal — it produces a model
 * announcing a call it cannot make and stopping. So the paragraph about tools and writes is
 * per-mode and lives here, beside the tool list it has to agree with.
 */
import type { AgentMode } from "../../shared/agent-modes.js";
import type { Surface } from "../inference/personas.js";
import type { ToolDefinition } from "../inference/types.js";
import {
  ASSISTANT_CORE,
  TUTOR_PROMPT,
  toolDefinitionsFromNames,
  toolsForSurface,
} from "../inference/personas.js";

/**
 * The names live in `shared/` so the composer can offer them without importing main.
 *
 * Re-exported here rather than made a second declaration: `SELECTABLE_MODES` is what the
 * contract's enum is built from and what the renderer's dropdown iterates, and those two
 * agreeing by construction is the point.
 */
export type { AgentMode, SelectableMode } from "../../shared/agent-modes.js";
export {
  DEFAULT_MODE,
  SELECTABLE_MODES,
  isSelectableMode,
} from "../../shared/agent-modes.js";

export interface ModePolicy {
  /** Tool names bound for this mode. Intersected with the surface's list, never widened. */
  tools: readonly string[];
  /**
   * May a proposal reach disk without a per-batch dialog? True for exactly one mode.
   *
   * Read by `stream.ts`, not by the graph. `propose_edit` still only ever *proposes*; keeping
   * the write out of the graph means the graph has no path to disk in any mode, which is a
   * property you can check by reading one file instead of auditing four.
   */
  autoApply: boolean;
  /**
   * Turns through the agent node, on top of the budgets in `dispatch.ts`.
   *
   * `1` means a single turn with no loop. This is a *turn* bound, not a tool-call bound — the
   * two are different failure modes: a model that calls twenty tools in one turn is working,
   * a model that takes twenty turns is stuck.
   */
  maxTurns: number;
  /**
   * The paragraph about tools and writes, replacing the core persona's silence on both.
   *
   * Replaces rather than appends. Appending to a base prompt that already says "call
   * propose_edit" would leave both sentences in front of the model, and it would believe the
   * more specific one.
   */
  writeGuidance: string;
}

/** Every read-only tool the assistant has. Shared so Plan and the write modes cannot drift. */
const READ_ONLY = [
  "read_file",
  "list_files",
  "search_project",
  "memory_search",
  "web_fetch",
] as const;

/**
 * Bound wherever the assistant has tools at all — but deliberately not folded into `READ_ONLY`.
 *
 * It writes nothing in the project, so it is safe in Plan; that is the whole reason it can be
 * bound there. But it does write — into VoidCode's own store, where the right pane reads it —
 * and putting it in a list called `READ_ONLY` would make the next person to read that name
 * believe something untrue about it. The cost of a separate constant is one line.
 *
 * Not in Manual, which binds nothing: a mode whose contract is "no tools this turn" does not get
 * an exception for a convenient one.
 *
 * `write_design_spec` joins it on the same argument: it records a design rather than applying
 * one, so it is safe in Plan, and it writes into VoidCode's own store rather than the project.
 */
const PLANNING = ["write_plan", "write_design_spec"] as const;

/**
 * Note what Plan's text does not do: name the editing tool, even to forbid it.
 *
 * "Do not call propose_edit" reads as a prohibition to a person and as a capability to a
 * model — it is the same sentence that tells it the tool exists. `personas.ts` records what
 * this cost the last time: a persona describing a convention outranked the tool definitions
 * and models kept using it after the code was deleted. `agent-modes.test.ts` asserts that no
 * mode's guidance names a tool the mode does not bind, and it caught this line.
 */
const PLAN_GUIDANCE = `You are in Plan mode. You can read the project — read_file, list_files,
search_project, memory_search, web_fetch — and you cannot change it. No editing tool is bound
this turn, so do not announce an edit, do not write out a tool call as JSON for the user to
run, and do not ask the user to apply something for you.

Produce a plan instead, and record it by calling write_plan: a title, then one step per thing
you would do, in order. Give each step the files it expects to touch. Read enough of the code
first that the plan names real functions and real paths rather than plausible ones.

Call write_plan once, when you know the shape of the work — not before you have read anything.
After it, say in your own words what you are unsure about and what would change the plan; the
steps carry the sequence, so do not repeat them back as a list.`;

const MANUAL_GUIDANCE = `You are in Manual mode. You have no tools this turn. You cannot read
files, search the project, fetch a page, or propose an edit.

Answer from the conversation and from whatever the user has shown you. If you need to see a
file, ask for it — do not announce a tool call, do not write one out as JSON, and never claim
to have read something you were not given. If the answer depends on code you cannot see, say
so and say what you would need.`;

const ACCEPT_EDITS_GUIDANCE = `Read before you write. Call read_file to look at the actual
file rather than guessing at its contents, and search_project to find where something is.

Use the tools by calling them. Do not describe a call, do not write it out as JSON, and do not
ask the user to run it for you or to paste a file's contents — you can read the file yourself.

To change a file, call propose_edit with the project-relative path and the COMPLETE new
contents. The contents replace the file wholesale, so partial output silently deletes the
rest — if you have not read the file, read it first. One call per file.

Nothing you propose is applied automatically: the user sees every change as a diff and
approves it before anything is written. Because nothing has been written yet, reading a file
you have already proposed a change to returns the ORIGINAL contents, not your version. That is
expected. Do not treat it as your edit having failed, and do not propose the same change again
to correct it.`;

const AUTO_GUIDANCE = `Read before you write. Call read_file to look at the actual file rather
than guessing at its contents, and search_project to find where something is.

To change a file, call propose_edit with the project-relative path and the COMPLETE new
contents. The contents replace the file wholesale, so partial output silently deletes the
rest — if you have not read the file, read it first. One call per file.

You are in Auto mode, so your edits are written to the file as soon as you propose them, with
no dialog and no one reviewing them first. Reading a file back therefore shows your own
changes. The user may not be watching: do not end a turn by asking them to approve something,
and do not leave the project in a state that does not build. You can run commands with
run_command — use it to check your work, and read the exit code and output before continuing.`;

export const POLICIES: Record<AgentMode, ModePolicy> = {
  plan: {
    tools: [...READ_ONLY, ...PLANNING],
    autoApply: false,
    maxTurns: 8,
    writeGuidance: PLAN_GUIDANCE,
  },
  /**
   * No tools, and therefore no loop — with nothing bound, a provider can never return
   * `tool_calls` as its finish reason, so `shouldContinue` ends the run after one pass. That
   * it needs no special case is the sign the abstraction is right, and `maxTurns: 1` states
   * the same thing a second way rather than relying on it.
   */
  manual: {
    tools: [],
    autoApply: false,
    maxTurns: 1,
    writeGuidance: MANUAL_GUIDANCE,
  },
  acceptEdits: {
    tools: [...READ_ONLY, ...PLANNING, "propose_edit"],
    autoApply: false,
    maxTurns: 12,
    writeGuidance: ACCEPT_EDITS_GUIDANCE,
  },
  auto: {
    tools: [...READ_ONLY, ...PLANNING, "propose_edit", "run_command"],
    autoApply: true,
    maxTurns: 24,
    writeGuidance: AUTO_GUIDANCE,
  },
};

/**
 * What this conversation may call: the mode's list, intersected with the surface's.
 *
 * The surface is the ceiling and the mode is a choice underneath it. A tutor conversation gets
 * `[]` for every mode including `auto`, because `toolsForSurface("tutor")` is `[]` and
 * intersecting anything with the empty set is the empty set. That is not a check that could be
 * forgotten — it is the shape of the operation.
 *
 * The corollary is a real implementation trap: a tool must be added to the SURFACE list as
 * well as to a policy. `run_command` in `POLICIES.auto` alone would be intersected away,
 * leaving Auto with no terminal and no error saying why.
 */
export function toolsFor(surface: Surface, mode: AgentMode): readonly string[] {
  const permitted = new Set(toolsForSurface(surface));
  return POLICIES[mode].tools.filter((name) => permitted.has(name));
}

/**
 * The graph's recursion ceiling for a mode.
 *
 * Was hardcoded at 64. Auto's 24 turns is roughly 50 nodes plus planning, which is close
 * enough that raising `maxTurns` would silently blow the limit — and LangGraph reports that as
 * `GraphRecursionError`, an unexplained death nobody would trace back to a number in another
 * file. Deriving it means the two cannot disagree.
 */
export function recursionLimitFor(mode: AgentMode): number {
  return POLICIES[mode].maxTurns * 2 + 8;
}

/**
 * The definitions bound for this turn.
 *
 * Built from `toolsFor`, so the tools the model is *told* about are exactly the tools
 * `dispatch.ts` will accept a call for. Describing one it cannot call is the same class of bug
 * as the persona describing one — the model believes the description either way.
 */
export function toolDefinitionsFor(surface: Surface, mode: AgentMode): ToolDefinition[] {
  return toolDefinitionsFromNames(toolsFor(surface, mode));
}

/**
 * The system prompt for an agentic turn: the core, plus the paragraph for this mode.
 *
 * Composed here rather than in `personas.ts` for two reasons. The import would be a cycle —
 * this file already depends on that one for the surface lists. And the join belongs next to
 * the guidance it joins, where the tool list is visible in the same table: the thing that must
 * never drift is "what the prompt says" against "what is bound", and both are on this screen.
 *
 * The tutor is unchanged and mode-independent. It has no tools in any mode, so a paragraph
 * about which ones it has this turn would be a paragraph about nothing.
 */
export function systemPromptFor(surface: Surface, mode: AgentMode): string {
  if (surface === "tutor") return TUTOR_PROMPT;
  return `${ASSISTANT_CORE}\n\n${POLICIES[mode].writeGuidance}`;
}
