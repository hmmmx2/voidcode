/**
 * The agent loop.
 *
 * ```
 *   plan ──▶ agent ⇄ tools ──▶ END      (conditional edge on finishReason === "tool_calls")
 * ```
 *
 * Kept deliberately small. A large graph is where agents fail invisibly: every extra node is
 * another place a run can stall in a state nobody is watching, and the debugging surface grows
 * faster than the capability does.
 *
 * **The approval step is outside the graph, and that is deliberate.** The plan drew it as a
 * `propose ──▶ interrupt` node. `interrupt` is the right tool when a run must *pause and
 * resume* around a human decision — but nothing here resumes: `propose_edit` stores a diff and
 * the run carries on, and the user's yes-or-no arrives later, possibly after the window has
 * been closed and reopened. Modelling that as a suspended graph would mean keeping a live run
 * alive across the whole approval, which is a lot of machinery for a decision that has no
 * further work behind it. The diffs outlive the run in `diffs.ts`, where they expire on their
 * own, and `agent:applyDiffs` gates them on a native dialog.
 *
 * **Why LangGraph is here at all**, given the loop could be a `while`: checkpointed state a run
 * can be inspected and resumed into, rather than a promise chain that exists only while it runs.
 *
 * **Why there is no `BaseChatModel` subclass.** The plan called for one — ~150 lines wrapping
 * our providers so LangGraph's prebuilt agent could drive them. Nothing here needs it: the
 * `agent` node calls `completeWithTools` below, so an adapter would be a layer with no
 * consumer, and a layer with no consumer is the dead branch P10 deleted. The reason the plan
 * gave for writing one — *never* adopt `@langchain/ollama` or `@langchain/openai`, because
 * they add a second ungoverned outbound HTTP path from main — is honoured more strictly by not
 * involving LangChain in the model call whatsoever. Outbound HTTP stays where it was.
 */
import { StateGraph, Annotation, START, END, MemorySaver } from "@langchain/langgraph";
import type { WebContents } from "electron";
import { providerById } from "../inference/registry.js";
import { toolsForSurface } from "../inference/personas.js";
import {
  DEFAULT_MODE,
  POLICIES,
  recursionLimitFor,
  systemPromptFor,
  toolDefinitionsFor,
  toolsFor,
  type AgentMode,
} from "./modes.js";
import type { Surface } from "../inference/personas.js";
import type { ChatMessage, MessageContent, ProviderId, ToolCall } from "../inference/types.js";

import {
  dispatchTool,
  newBudget,
  BudgetExhausted,
  MAX_TOOL_CALLS,
  type RunBudget,
  type ToolResult,
} from "./dispatch.js";
import { sealTelemetry } from "./telemetry.js";
import { looksLikeUnwrappedToolCall, unwrappedToolCallMessage } from "./unwrapped.js";
import type { PendingDiff } from "../build/diffs.js";
import type { PlanDoc } from "../../shared/plan.js";
import type { DesignSpec } from "../../shared/design.js";

/** One step, as the UI shows it and `agent_steps` stores it. */
export interface AgentStep {
  kind: "thought" | "tool" | "proposal" | "error" | "command" | "applied";
  text: string;
  toolName?: string;
  diffId?: string;
  /** On a `proposal`: the diff to render, so the panel can show it the moment it is proposed. */
  diff?: PendingDiff;
  /**
   * Set by `write_plan`: the plan as a document, on the step that recorded it.
   *
   * Kind stays `tool`. A plan is not a sixth thing an agent does — it is a tool call that
   * happens to carry a structured payload, exactly as a `proposal` carries a diff. Adding a
   * `kind` would mean altering a SQLite `CHECK` constraint, which needs a table rebuild, to
   * express something the existing kinds already say correctly.
   */
  plan?: PlanDoc;
  /** Set by `write_design_spec`. Carried exactly as `plan` is, and for the same reasons. */
  design?: DesignSpec;
}

const AgentState = Annotation.Root({
  /**
   * The question, carried as state rather than seeded into `messages`.
   *
   * Seeding it directly was the first attempt and produced `[user, system]`: the reducer
   * concatenates, so the persona `plan` adds landed *after* the user's turn. Many
   * OpenAI-compatible servers reject a system message that is not first, and the ones that
   * accept it weight it differently — so the ordering is built in one place, by `plan`, rather
   * than being an emergent property of which node ran when.
   */
  question: Annotation<MessageContent>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  messages: Annotation<ChatMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  steps: Annotation<AgentStep[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Diff ids awaiting the approval dialog. The graph never applies them itself. */
  proposedDiffIds: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Why the run ended, for the transcript. */
  finishReason: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  /**
   * Turns through the `agent` node.
   *
   * In the annotation rather than on `RunBudget`, unlike `toolCalls`. The budget is a mutable
   * object the nodes close over, invisible to the checkpoint; a counter in state is part of
   * the record a stopped run leaves behind, which is what makes "it stopped after twelve
   * turns" answerable afterwards instead of a guess.
   *
   * A turn is not a tool call. A model making six calls in one turn is working; a model taking
   * six turns is circling, and the two deserve different ceilings.
   */
  turns: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
});

export type AgentStateType = typeof AgentState.State;

export interface RunContext {
  sender: WebContents;
  surface: Surface;
  /**
   * What the agent may do this turn -- see `modes.ts`.
   *
   * Named `agentMode` rather than `mode` on purpose: `mode` already means `WindowMode`
   * ("study" | "build") throughout main, including `ctx.mode` in the very handler that builds
   * this object. Two different things called `mode` one line apart is how the wrong one gets
   * passed, and the types are similar enough that it would compile.
   */
  agentMode: AgentMode;
  providerId: ProviderId;
  model: string;
  signal?: AbortSignal;
  /**
   * Each step as it happens.
   *
   * A push, not the return value, for the reason `memory:index` already gives about indexing:
   * a run can spend twenty-four tool calls before it resolves, and a promise that settles at
   * the end tells the user nothing for minutes. Worse here than there — an agent reading files
   * and proposing edits is exactly the thing someone wants to watch, and a silent spinner is
   * indistinguishable from a hang.
   *
   * The returned steps are still the complete record; this is the same information arriving
   * earlier, not a second source of truth.
   */
  onStep?: (step: AgentStep) => void;
  /**
   * Prose as the model produces it.
   *
   * Separate from `onStep`, which fires once per completed step. A "thought" step is only
   * emitted when a turn ends, so a panel driven by steps alone shows nothing for the whole
   * time the model is writing — which is most of a run. This is what makes the unified surface
   * feel like a conversation rather than a job queue.
   */
  onToken?: (text: string) => void;
}

/**
 * One non-streaming turn that keeps tool calls.
 *
 * `registry.completeChat` drops them — it accumulates `token` chunks and returns text, which is
 * correct for its callers and useless here.
 *
 * No accumulator: a `tool_call` chunk already carries a *complete* call. Reassembling OpenAI's
 * `index`-keyed argument fragments is `openai.ts`'s job and it does it behind the interface, so
 * a second `ToolCallAccumulator` here would be fed whole calls and re-concatenate their
 * arguments into nonsense. Collecting them is all that is left to do.
 */
async function completeWithTools(
  context: RunContext,
  messages: ChatMessage[]
): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string }> {
  const provider = providerById(context.providerId);
  if (provider === undefined) throw new Error(`Unknown provider: ${context.providerId}`);

  const tools = toolDefinitionsFor(context.surface, context.agentMode);
  const toolCalls: ToolCall[] = [];
  const parts: string[] = [];
  let finishReason = "stop";

  const request = {
    model: context.model,
    messages,
    ...(tools.length > 0 ? { tools, toolChoice: "auto" as const } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  };

  for await (const chunk of provider.chat(request)) {
    if (chunk.kind === "token") {
      parts.push(chunk.text);
      context.onToken?.(chunk.text);
    }
    else if (chunk.kind === "tool_call") toolCalls.push(chunk.call);
    // Optional on the chunk, and absent reads as "stop" — the reading `types.ts` documents.
    // Defaulting to anything else would make a provider that omits it loop forever.
    else if (chunk.kind === "done") finishReason = chunk.finishReason ?? "stop";
    else if (chunk.kind === "error") throw new Error(chunk.message);
  }

  return { text: parts.join(""), toolCalls, finishReason };
}

/**
 * Build the graph for one run.
 *
 * Constructed per run rather than once at module scope because the nodes close over the
 * sender, the surface and the budget — all of which belong to this run and to no other. A
 * shared graph would need that state threaded through the channel instead, which is the same
 * information with more chances to attach it to the wrong window.
 */
export function buildAgentGraph(context: RunContext, budget: RunBudget) {
  const policy = POLICIES[context.agentMode];
  /**
   * The intersection, not the mode's list.
   *
   * `toolsFor` narrows the mode's tools by the surface's, so a mode can only ever take
   * capability away. `toolsForSurface` stays imported below as the thing that check is made
   * against -- it is the ceiling, and this is a choice underneath it.
   */
  const allowed = toolsFor(context.surface, context.agentMode);

  /**
   * `plan` seeds the conversation with the persona.
   *
   * A node rather than a caller's responsibility, because the system prompt is main's to set —
   * the same rule as `chat:open`. There is no path into this graph that supplies its own.
   */
  const plan = (state: AgentStateType): Partial<AgentStateType> => ({
    messages: [
      { role: "system", content: systemPromptFor(context.surface, context.agentMode) },
      { role: "user", content: state.question },
    ],
  });

  /**
   * Record a step and hand it to the watcher in the same breath.
   *
   * One function rather than an `onStep` call beside each `push`, because the two must not be
   * able to disagree: a step that reaches the panel but not the returned record — or the
   * reverse — is a run whose live view and final transcript tell different stories, and
   * whichever one someone happens to read is the one they will believe.
   */
  const record = (into: AgentStep[], step: AgentStep): void => {
    into.push(step);
    context.onStep?.(step);
  };

  const agent = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { text, toolCalls, finishReason } = await completeWithTools(context, state.messages);

    const steps: AgentStep[] = [];
    if (text.trim() !== "") record(steps, { kind: "thought", text });

    /**
     * The model meant to call a tool and the transport did not see it.
     *
     * Without this the turn ends looking like a model that chose to answer in prose, which is
     * the one failure shape nobody can debug from the outside. See `unwrapped.ts` — it is a
     * real property of the panel's own default model.
     */
    if (toolCalls.length === 0) {
      const attempted = looksLikeUnwrappedToolCall(text, allowed);
      if (attempted !== null) {
        record(steps, {
          kind: "error",
          text: unwrappedToolCallMessage(context.model, attempted),
        });
        return {
          messages: [{ role: "assistant", content: text }],
          steps,
          finishReason: "stop",
          turns: 1,
        };
      }
    }
    const assistant: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    // `turns: 1` and not an assignment: the reducer sums, so each pass adds one and the
    // count survives in the checkpoint rather than living in a closure.
    return { messages: [assistant], steps, finishReason, turns: 1 };
  };

  const tools = async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const last = state.messages[state.messages.length - 1];
    const calls = last?.role === "assistant" ? (last.toolCalls ?? []) : [];

    const messages: ChatMessage[] = [];
    const steps: AgentStep[] = [];
    const proposedDiffIds: string[] = [];

    for (const call of calls) {
      let result: ToolResult;
      try {
        result = await dispatchTool(context.sender, call, allowed, budget, context.signal);
      } catch (err) {
        /**
         * A budget ending the run still has to answer every call that was made.
         *
         * An assistant turn with three tool calls and two tool replies is a malformed
         * conversation, and an OpenAI-compatible server rejects the whole thing. So the
         * remaining calls get a reply saying why, and the run ends cleanly on the next edge
         * rather than by throwing out of the graph.
         */
        const message = err instanceof BudgetExhausted ? err.message : String(err);
        for (const remaining of calls.slice(calls.indexOf(call))) {
          messages.push({
            role: "tool",
            toolCallId: remaining.id,
            name: remaining.name,
            content: message,
          });
        }
        record(steps, { kind: "error", text: message });
        return { messages, steps, proposedDiffIds, finishReason: "budget" };
      }

      messages.push({
        role: "tool",
        toolCallId: result.toolCallId,
        name: result.name,
        content: result.content,
      });

      if (result.diffId !== undefined) {
        proposedDiffIds.push(result.diffId);
        record(steps, {
          kind: "proposal",
          text: result.content,
          diffId: result.diffId,
          ...(result.diff !== undefined ? { diff: result.diff } : {}),
        });
      } else {
        /**
         * A shell invocation gets its own kind.
         *
         * `command` rather than `tool` is the entire reason migration 12 rebuilt a table: the
         * audit log is where "it ran `rm -rf build`" has to be legible, and filing that under
         * the same label as reading a file makes the record unusable for the one question it
         * exists to answer.
         */
        const kind =
          result.isError ? "error" : result.name === "run_command" ? "command" : "tool";
        record(steps, {
          kind,
          text: result.content,
          toolName: result.name,
          ...(result.plan !== undefined ? { plan: result.plan } : {}),
          ...(result.design !== undefined ? { design: result.design } : {}),
        });
      }
    }

    return { messages, steps, proposedDiffIds, finishReason: null };
  };

  /**
   * Where the loop stops.
   *
   * `finishReason === "tool_calls"` is the only thing that continues it, which is why P5 made
   * that field load-bearing: without it nothing distinguishes "the model finished" from "the
   * model wants tools run", and an agent either stops early or never stops.
   *
   * The tool-call ceiling is re-checked here as well as in the dispatcher. The dispatcher's
   * throw ends a call; this ends the *loop*, and a model that keeps asking would otherwise
   * bounce between the two nodes collecting budget errors.
   */
  const shouldContinue = (state: AgentStateType): typeof END | "tools" => {
    if (state.finishReason === "budget") return END;
    /**
     * The mode's turn ceiling, ended here rather than left to `recursionLimit`.
     *
     * Both would stop the run; only one of them stops it *cleanly*. Exceeding
     * `recursionLimit` raises `GraphRecursionError` out of `graph.invoke`, which nothing
     * catches -- so the steps and proposed diffs accumulated so far are discarded and the
     * panel shows a bare error instead of the work. Ending on an edge returns the state, and
     * `finishReason` says why.
     *
     * `recursionLimitFor` still derives a backstop from the same number, so the two cannot
     * drift apart the way a hardcoded 64 drifted from every budget around it.
     */
    if (state.turns >= policy.maxTurns) return END;
    if (budget.toolCalls >= MAX_TOOL_CALLS) return END;
    if (state.finishReason !== "tool_calls") return END;

    const last = state.messages[state.messages.length - 1];
    const calls = last?.role === "assistant" ? (last.toolCalls ?? []) : [];
    // A provider that reports `tool_calls` and sends none would loop forever otherwise.
    return calls.length === 0 ? END : "tools";
  };

  return new StateGraph(AgentState)
    .addNode("plan", plan)
    .addNode("agent", agent)
    .addNode("tools", tools)
    .addEdge(START, "plan")
    .addEdge("plan", "agent")
    .addConditionalEdges("agent", shouldContinue, { tools: "tools", [END]: END })
    .addEdge("tools", "agent")
    .compile({ checkpointer: new MemorySaver() });
}

export interface AgentRunResult {
  steps: AgentStep[];
  /** Ids the user may now be asked to approve. Nothing has been written. */
  proposedDiffIds: string[];
  finishReason: string | null;
}

/** Run one question to completion. */
export async function runAgent(
  context: RunContext,
  question: MessageContent,
  threadId: string,
  now: number
): Promise<AgentRunResult> {
  /**
   * Before anything imports its way into a trace exporter.
   *
   * `@langchain/core` pulls in `langsmith`, which uploads run contents when an inherited
   * environment variable says so. See `telemetry.ts` — this is the call that makes "off by
   * default" into "off".
   */
  sealTelemetry();

  const budget = newBudget(now);
  const graph = buildAgentGraph(context, budget);

  const final = (await graph.invoke(
    { question },
    {
      configurable: { thread_id: threadId },
      // The backstop, not the bound -- `shouldContinue` ends a run at `maxTurns` first, and
      // cleanly. Derived so that raising a mode's turn ceiling cannot silently exceed this.
      recursionLimit: recursionLimitFor(context.agentMode),
    }
  )) as AgentStateType;

  return {
    steps: final.steps,
    proposedDiffIds: final.proposedDiffIds,
    finishReason: final.finishReason,
  };
}
