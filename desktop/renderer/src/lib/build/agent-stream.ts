/**
 * Driving one agentic turn from the renderer.
 *
 * `host.agent.open()` resolves to a transferred port, so prose, tool steps and proposals all
 * arrive on one channel in the order they happened. That ordering is the point: a turn where
 * the model says "let me look at that file", reads it, and then explains what it found should
 * read as those three things in sequence, not as a block of text with a separate list of tools
 * beside it.
 *
 * The port is also the run's lifetime — `cancel()` is `close()`, and main ties the model's
 * `AbortSignal` to it. There is no stop channel and no run id to track.
 */

/**
 * MUST MATCH `AgentEvent` IN `src/main/agent/stream.ts`.
 *
 * Hand-maintained, because the two projects are separate TypeScript builds and this type
 * crosses a MessagePort — there is no import that would make the compiler check it. The
 * equivalent duplicate for `ChatChunk` has already broken streaming silently once in this
 * codebase, which is why `tests/agent-event-parity.test.ts` exists rather than a comment asking
 * people to be careful.
 */
import type { SelectableMode } from "@shared/agent-modes";
import type { PlanDoc } from "@shared/plan";
import type { DesignSpec } from "@shared/design";

export interface AgentStepPayload {
  kind: "thought" | "tool" | "proposal" | "error" | "command" | "applied";
  text: string;
  toolName?: string;
  diffId?: string;
  diff?: BuildDiff;
  /**
   * Set by `write_plan`: the plan as a document, on the step that recorded it.
   *
   * Kind stays `tool`. A plan is not a sixth thing an agent does — it is a tool call that
   * happens to carry a structured payload, exactly as a `proposal` carries a diff. Adding a
   * `kind` would mean altering a SQLite `CHECK` constraint, which needs a table rebuild, to
   * express something the existing kinds already say correctly.
   */
  plan?: PlanDoc;
  /** Set by `write_design_spec`. Carried exactly as `plan` is. */
  design?: DesignSpec;
}

export type AgentEvent =
  | { kind: "token"; text: string }
  | { kind: "step"; step: AgentStepPayload }
  | {
      kind: "done";
      finishReason: string | null;
      /** Which model answered — main resolves it, so it may differ from what was asked for. */
      model: string;
      proposedDiffIds: string[];
      runId: string;
      /** Present only when an Auto run wrote without asking. Its absence means nothing was. */
      applied?: {
        paths: string[];
        failed: Array<{ path: string; reason: string }>;
        revertable: boolean;
      };
    }
  | { kind: "error"; message: string };

/** Mirrors the contract's content union — a string, or blocks for a vision model. */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };

export interface AgentRunOutcome {
  finishReason: string | null;
  proposedDiffIds: string[];
  runId: string;
  /** What actually answered. The panel shows this rather than what it asked for. */
  model: string;
  /** Set when an Auto run wrote without asking, so the panel can offer the undo. */
  applied?: {
    paths: string[];
    failed: Array<{ path: string; reason: string }>;
    revertable: boolean;
  };
}

export interface AgentStreamHandle {
  /** Resolves when the turn ends. Rejects on a provider or tool-layer failure. */
  completed: Promise<AgentRunOutcome>;
  /** Abort the run. Safe to call after it has finished. */
  cancel(): void;
}

/**
 * Start a turn.
 *
 * Note there is no system prompt and no tool list — both are main's, chosen from the window's
 * surface. Naming a provider is not the same as naming a capability.
 */
export function streamAgent(
  host: NonNullable<Window["host"]>,
  request: {
    provider: "ollama" | "llamacpp" | "openrouter";
    model: string;
    content: string | AgentContentBlock[];
    /**
     * The conversation this turn belongs to, so main can record it on the run.
     *
     * Sent at open rather than reported back on `done`: `runId` only reaches the renderer on
     * the terminal event, so a cancelled or errored run would never be linked to anything.
     */
    sessionId?: string | null;
    /**
     * The file on screen, as a path and its bytes.
     *
     * Sent rather than described: main decides how to present it, because that decision depends
     * on whether the mode binds a `read_file` — see `agent/open-file.ts`, which carries the
     * measurements showing that inlining the contents suppresses tool calling badly.
     */
    openFile?: { path: string; contents: string };
    /**
     * What the agent may do this turn.
     *
     * Main is the enforcer: `toolsFor` intersects the mode's tools with the surface's, so this
     * can only ever narrow what is already permitted. The channel's enum is built from
     * `SELECTABLE_MODES`, so a value outside that set is rejected rather than honoured.
     */
    mode?: SelectableMode;
  },
  handlers: {
    onToken: (text: string) => void;
    onStep: (step: AgentStepPayload) => void;
  }
): AgentStreamHandle {
  let stream: { close(): void } | undefined;
  let cancelled = false;

  const completed = new Promise<AgentRunOutcome>((resolve, reject) => {
    const open = host.agent?.open;
    if (open === undefined) {
      reject(new Error("The agent is not available in this window."));
      return;
    }

    void open(request)
      .then((opened) => {
        if (cancelled) {
          opened.close();
          resolve({ finishReason: null, proposedDiffIds: [], runId: "", model: "" });
          return;
        }
        stream = opened;

        opened.onChunk((raw) => {
          const event = raw as AgentEvent;
          /**
           * Only `done` and `error` are terminal.
           *
           * The chat client got this wrong in a way worth remembering: it treated *anything*
           * that was not a token as terminal, so the first tool call would have closed the
           * stream and resolved the turn. Enumerating the terminal cases rather than
           * defaulting to "terminal" is what stops a new event kind silently ending runs.
           */
          if (event.kind === "token") {
            handlers.onToken(event.text);
            return;
          }
          if (event.kind === "step") {
            handlers.onStep(event.step);
            return;
          }

          opened.close();
          if (event.kind === "error") reject(new Error(event.message));
          else {
            resolve({
              finishReason: event.finishReason,
              proposedDiffIds: event.proposedDiffIds,
              runId: event.runId,
              model: event.model,
              // Carried through rather than defaulted: absent means nothing was written, and
              // a default object would be a claim the event did not make.
              ...(event.applied !== undefined ? { applied: event.applied } : {}),
            });
          }
        });
      })
      .catch(reject);
  });

  return {
    completed,
    cancel() {
      cancelled = true;
      stream?.close();
    },
  };
}
