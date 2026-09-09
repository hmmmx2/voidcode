/**
 * What the right pane shows, derived from the transcript rather than tracked beside it.
 *
 * The pane needs the current run's steps and the plan behind them. Both are already in the
 * conversation — every step reaches `AssistantPanel` as a block, and Part 2 put the plan on the
 * step that wrote it — so this reads them back out instead of keeping a second copy that updates
 * on the same events. A second copy is how a pane and a transcript come to disagree about a run,
 * and whichever one someone happens to be looking at is the one they will believe.
 *
 * Deriving also means the pane needs no special case for a *past* run: `openRun` replaces the
 * turns wholesale, and this produces the right answer from them without knowing that happened.
 *
 * Written against a structural shape rather than importing `Turn` from the panel, so the panel's
 * internal types stay internal and this stays testable without mounting anything.
 */
import type { PlanDoc } from "@shared/plan";
import type { DesignSpec } from "@shared/design";

/**
 * The only thing this needs to know about a step: it may carry a plan.
 *
 * Generic over the step rather than importing `AgentStepPayload`, and that is not fastidiousness
 * — `agent-stream.ts` refers to `BuildDiff` and `window.host`, both declared in renderer-only
 * ambient files that the root tsconfig does not include. Importing it would compile fine in the
 * renderer and break the moment a test in `tests/` reached this module, which is exactly what
 * happened. Staying structural keeps the module testable from either program.
 */
export interface StepLike {
  plan?: PlanDoc;
  design?: DesignSpec;
}

/** The transcript, as much of its shape as this needs. */
export interface TurnLike<S extends StepLike = StepLike> {
  role: "user" | "assistant";
  blocks?: ReadonlyArray<{ kind: string; step?: S }>;
}

export interface RunView<S extends StepLike = StepLike> {
  /**
   * The steps of the most recent assistant turn.
   *
   * Scoped to one turn because a turn *is* a run — each user message starts a new one, with its
   * own id and its own row in `agent_runs`. Showing every step in the conversation would put
   * three runs' work under one heading and make the count meaningless.
   */
  steps: S[];
  /**
   * The most recent plan anywhere in the conversation, not just in the last turn.
   *
   * This is the one place the two fields are scoped differently, and deliberately. The usual
   * shape of planning is that one turn writes the plan and later turns carry it out — so scoping
   * the plan to the last turn would make it vanish the moment the agent started work on it,
   * which is precisely when someone wants to look at it.
   *
   * Null when no turn has planned. `plan` mode is a choice, and most turns are not made in it.
   */
  plan: PlanDoc | null;
  /**
   * The most recent design spec, scoped exactly as `plan` is and for the same reason.
   *
   * One turn writes the design and later turns build it. A spec that vanished when the work
   * started would disappear precisely when someone wanted to check the code against it.
   */
  design: DesignSpec | null;
}

export const EMPTY_RUN_VIEW: RunView<never> = { steps: [], plan: null, design: null };

export function runViewOf<S extends StepLike>(turns: ReadonlyArray<TurnLike<S>>): RunView<S> {
  let plan: PlanDoc | null = null;
  let design: DesignSpec | null = null;
  let steps: S[] = [];

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;

    // Reset per assistant turn rather than filtering at the end: the last turn's steps are
    // whatever survives the loop, and a turn that ran no tools correctly clears the list rather
    // than leaving the previous turn's steps on screen under a new run.
    steps = [];
    for (const block of turn.blocks ?? []) {
      if (block.kind !== "step" || block.step === undefined) continue;
      steps.push(block.step);
      // Last one wins. A second `write_plan` is the model reconsidering, and `agent_plans` keys
      // on run id precisely so the revision replaces rather than accumulates.
      if (block.step.plan !== undefined) plan = block.step.plan;
      if (block.step.design !== undefined) design = block.step.design;
    }
  }

  return { steps, plan, design };
}
