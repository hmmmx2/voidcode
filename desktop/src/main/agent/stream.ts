/**
 * One agentic turn, streamed.
 *
 * This is what makes chat and the agent the same thing. Before it there were two surfaces with
 * half a product each: chat streamed prose and could not call a tool, the agent called tools
 * and produced no text until the whole run had finished. A user had to decide which kind of
 * question they were about to ask, which is not a decision anyone should be asked to make.
 *
 * Built on the same `MessageChannelMain` transport as `chat:open`, deliberately, and not on
 * another `invoke`:
 *
 *   - Tokens do not go through the broker. That was the original reason for the port and it
 *     applies identically here.
 *   - **The port is the run's lifetime.** Closing it aborts — which is how Stop works, with no
 *     second channel and no run-id bookkeeping. `agent:run` needed neither because it had no
 *     way to stop at all.
 *
 * `chat:open` stays exactly as it is. Study mode uses it, the tutor has no tools, and rebuilding
 * the tutor's transport to gain a capability it is deliberately denied would be a change with
 * only risk on one side.
 */
import { MessageChannelMain, type WebContents } from "electron";
import type { MessageContent, ProviderId } from "../inference/types.js";
import type { Surface } from "../inference/personas.js";
import { runAgent, type AgentStep } from "./graph.js";
import { beginRun, recordStep, recordPlan, recordDesign, finishRun } from "../store/agent.js";
import { POLICIES, type AgentMode } from "./modes.js";
import { isArmed } from "./arming.js";
import { captureBeforeWrite, closeCheckpoint } from "./checkpoint.js";
import { commitAgentDiffs, describeAgentDiffs } from "../build/diffs.js";
import { noToolModelMessage } from "./models.js";

/**
 * What crosses the port.
 *
 * MUST MATCH `AgentEvent` in `renderer/src/lib/build/agent-stream.ts`. Hand-maintained for the
 * same reason `ChatChunk` is: two TypeScript projects, one MessagePort, and no import that
 * would let the compiler check it. `tests/agent-event-parity.test.ts` asserts they have not
 * drifted — the duplicate `ChatChunk` has already silently broken streaming once in this
 * codebase, which is why that test exists rather than a comment asking people to be careful.
 */
/** What an Auto run wrote, and whether it can be taken back. */
export interface AgentApplied {
  paths: string[];
  failed: Array<{ path: string; reason: string }>;
  /**
   * A checkpoint exists for this run, so "Undo this run" can be offered.
   *
   * False when the capture hit its bound. The offer must then be withheld or qualified — an
   * undo that silently restores some of the files is worse than none.
   */
  revertable: boolean;
}

export type AgentEvent =
  /** Prose, as the model writes it. */
  | { kind: "token"; text: string }
  /** A tool ran, or a thought completed. Carries a diff when the step proposed one. */
  | { kind: "step"; step: AgentStep }
  | {
      kind: "done";
      finishReason: string | null;
      /** Which model answered — main resolves it, so it may differ from what was asked for. */
      model: string;
      /** Ids the user may now approve. Nothing has been written. */
      proposedDiffIds: string[];
      runId: string;
      /**
       * Present only when the run wrote without asking — Auto mode, in an armed window.
       *
       * Its absence is what "nothing has been written" above rests on, so it is optional
       * rather than a boolean that defaults to false: a panel that forgets to check it renders
       * no undo offer, which is a missing affordance rather than a false claim of safety.
       */
      applied?: AgentApplied;
    }
  | { kind: "error"; message: string };

export interface AgentStreamHandle {
  port: Electron.MessagePortMain;
  cancel: () => void;
}

/**
 * Start a run and stream it.
 *
 * The transcript is written here rather than in the handler, because this is now the only
 * place a run begins — putting it anywhere else would mean a second start path that forgets to
 * record.
 */
/**
 * Write an Auto run's proposals, having first recorded how to undo them.
 *
 * Order is the whole design. The checkpoint is captured BEFORE `commitAgentDiffs`, so a crash
 * between the two leaves a recoverable project rather than an overwritten one — and every
 * capture is flushed to disk as it is taken, so a run whose window dies mid-way is still
 * undoable.
 *
 * `armed` is read here and passed as its own named argument. It is not a callback that returns
 * true: `diffs.ts` documents why a truthy `approve` lambda would delete the only real control
 * in that module while leaving every signature looking untouched.
 *
 * An unarmed Auto run writes nothing. The mode is the renderer's choice; arming is not.
 */
async function autoApply(
  sender: WebContents,
  runId: string,
  projectRoot: string,
  ids: readonly string[],
  emitStep: (step: AgentStep) => void
): Promise<AgentApplied> {
  if (!isArmed(sender, projectRoot)) {
    const step: AgentStep = {
      kind: "error",
      text:
        "Auto mode is not armed for this project, so nothing was written. The changes are " +
        "still proposed and can be applied from the panel.",
    };
    emitStep(step);
    return { paths: [], failed: [], revertable: false };
  }

  // Snapshot every path first. `describeAgentDiffs` gives the display paths that are about to
  // be written, which are the ones to capture.
  const batch = describeAgentDiffs(sender, ids);
  /**
   * Every path has to be covered, or the undo is partial and must not be offered as whole.
   *
   * Two ways coverage is lost, and both count: the capture throwing, and the checkpoint
   * reaching its bound and quietly stopping. Only the first used to be detected — the second
   * set a flag inside the checkpoint that nothing here could read — so a run that wrote past
   * 200 files still got a clean-looking "Undo file changes" and the user learned it was
   * partial only after pressing it.
   */
  let covered = true;
  for (const displayPath of batch.displayPaths) {
    try {
      const { recorded } = await captureBeforeWrite(runId, projectRoot, displayPath);
      if (!recorded) covered = false;
    } catch {
      covered = false;
    }
  }

  const outcome = await commitAgentDiffs(sender, ids, {
    // Required and never called on this path: `armed` is what satisfies the gate. Passing a
    // function that returns true would be the bypass this design exists to avoid.
    approve: async () => false,
    armed: true,
  });

  const written = outcome.results.filter((r) => r.ok).map((r) => r.path);
  const failed = outcome.results
    .filter((r) => !r.ok)
    .map((r) => ({ path: r.path, reason: r.reason ?? "unknown" }));

  for (const path of written) {
    // `applied`, a step kind that exists because of migration 12. Recording these as `tool`
    // would file an unreviewed write under the same label as reading a file.
    emitStep({ kind: "applied", text: `Wrote ${path}` });
  }

  /**
   * `revertable` means the undo would restore EVERY file this run touched.
   *
   * When it is false the panel withholds the offer and says so instead — a button that
   * silently restores some of the files reads as a completed undo, which is worse than no
   * button at all.
   */
  return { paths: written, failed, revertable: covered && written.length > 0 };
}

export function openAgentStream(
  sender: WebContents,
  options: {
    projectRoot: string;
    surface: Surface;
    /**
     * What the agent may do this turn. See `modes.ts`.
     *
     * `agentMode`, not `mode`: `mode` already means `WindowMode` in main, and these options
     * are assembled in a handler that has `ctx.mode` in scope.
     */
    agentMode: AgentMode;
    providerId: ProviderId;
    model: string;
    question: MessageContent;
    /** For the transcript, which stores text. Image blocks are not written to the database. */
    questionText: string;
    /** Nothing installed is known to call tools, so say so before the turn rather than after. */
    unverifiedModel?: boolean;
    /**
     * The conversation this turn belongs to.
     *
     * Passed in at `agent:open` rather than reported back on `done`, which is the cheaper of
     * the two designs and the more honest one. The renderer already knows the session — it
     * created it — whereas `runId` reaches the renderer only on the terminal event, so a run
     * that is cancelled or errors would never get linked. Recording the tie when the run
     * *starts* means an abandoned run is still attributable to the conversation that began it.
     *
     * It also avoids widening `AgentEvent`, which is hand-duplicated either side of the
     * process boundary and guarded by `agent-event-parity.test.ts`.
     */
    sessionId?: string | null;
  }
): AgentStreamHandle {
  const { port1, port2 } = new MessageChannelMain();
  const controller = new AbortController();

  port1.on("close", () => controller.abort());
  port1.start();

  const runId = beginRun({
    projectRoot: options.projectRoot,
    question: options.questionText,
    provider: options.providerId,
    model: options.model,
    sessionId: options.sessionId ?? null,
  });
  let seq = 0;

  /**
   * Posting to a closed port throws, and the port closes the moment the user hits Stop.
   *
   * Swallowing that is correct: the run is being torn down, and an exception raised inside the
   * abort path would surface as an unhandled rejection in main — which is a modal dialog, the
   * failure mode that cost a whole debugging session earlier in this project.
   */
  /**
   * A step, recorded and then shown — in that order and through one function.
   *
   * `autoApply` used to `post` its steps directly, which showed "Wrote src/a.ts" in the panel
   * and recorded nothing. For a mode that writes unattended that is the wrong way round: the
   * transcript is the only account of what happened once the window is closed, and the steps
   * most worth having in it are exactly the ones about writes nobody reviewed. Migration 12
   * rebuilt a table so that `applied` and `command` could be stored, which would have been for
   * nothing.
   */
  const emitStep = (step: AgentStep): void => {
    try {
      recordStep(runId, seq++, step);
      // The plan goes to its own table in the same breath, and inside the same try, so it
      // cannot end up recorded when the step it arrived on is not — or the reverse. A plan
      // with no step behind it is a document nothing in the transcript accounts for.
      if (step.plan !== undefined) recordPlan(runId, step.plan);
      if (step.design !== undefined) recordDesign(runId, step.design);
    } catch {
      // A failed write must not kill a run in progress. The work the user asked for matters
      // more than the record of it.
    }
    post({ kind: "step", step });
  };

  const post = (event: AgentEvent): void => {
    try {
      port1.postMessage(event);
    } catch {
      // The renderer has gone. The transcript below is still written.
    }
  };

  void (async () => {
    try {
      if (options.unverifiedModel === true) {
        // Emitted before the model is asked anything, so the caveat is on screen while the
        // user waits rather than arriving as an explanation afterwards.
        emitStep({ kind: "error", text: noToolModelMessage(options.model) });
      }

      const result = await runAgent(
        {
          sender,
          surface: options.surface,
          agentMode: options.agentMode,
          providerId: options.providerId,
          model: options.model,
          signal: controller.signal,
          onToken: (text) => post({ kind: "token", text }),
          onStep: emitStep,
        },
        options.question,
        runId,
        Date.now()
      );

      /**
       * Auto's write, and the only place in the app that skips the review dialog.
       *
       * Here rather than in the graph, deliberately: `propose_edit` still only ever proposes,
       * so the graph has no path to disk in any mode -- a property you can check by reading
       * one file instead of auditing four.
       *
       * Two conditions, and both are required. `policy.autoApply` is the mode saying this is
       * an unattended run; `isArmed` is a human having said so, for this window and this
       * project, through a window main owns. Neither is sufficient alone, and the second
       * cannot be satisfied by anything the renderer sends.
       *
       * Until this existed, `POLICIES.auto.autoApply` was read by no production code at all
       * while its own docstring claimed this function read it. That is now true.
       */
      const policy = POLICIES[options.agentMode];
      let applied: AgentApplied | undefined;
      if (policy.autoApply && result.proposedDiffIds.length > 0) {
        applied = await autoApply(
          sender,
          runId,
          options.projectRoot,
          result.proposedDiffIds,
          emitStep
        );
      }

      finishRun(runId, result.finishReason);
      post({
        kind: "done",
        finishReason: result.finishReason,
        // Anything auto-applied is no longer awaiting approval, so it must not be offered for
        // it. Reporting both would give the panel an Apply button for files already written.
        proposedDiffIds: applied === undefined ? result.proposedDiffIds : [],
        runId,
        model: options.model,
        ...(applied !== undefined ? { applied } : {}),
      });
    } catch (err) {
      /**
       * A cancelled run is not an error, and `finish_reason` stays null for it.
       *
       * That null is the honest record: the run genuinely has no ending. Writing "cancelled"
       * would be inventing a state the graph never reached.
       */
      const aborted = controller.signal.aborted;
      if (!aborted) {
        post({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      port1.close();
    }
  })();

  // Also abort if the window goes away without the port being closed first.
  const id = sender.id;
  sender.once("destroyed", () => {
    void id;
    controller.abort();
  });

  return { port: port2, cancel: () => controller.abort() };
}

/**
 * Flatten a question for the transcript.
 *
 * Images are recorded as a count rather than as base64: a screenshot is a megabyte, the audit
 * question is "what was it asked", and a database that grows by a megabyte per question stops
 * being something a user can back up.
 */
export function questionText(content: MessageContent): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = content.filter((block) => block.type === "image").length;
  if (images === 0) return text;
  return `${text}\n[${String(images)} image${images === 1 ? "" : "s"}]`.trim();
}
