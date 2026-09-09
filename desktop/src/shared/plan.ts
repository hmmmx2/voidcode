/**
 * A plan, as data rather than as prose.
 *
 * Plan mode has always existed and has never produced one of these. It is a *tool-restriction
 * profile*: it binds the read-only tools and asks, in the system prompt, for "what you would
 * change, in which files, in what order". What comes back is a paragraph, arriving as an
 * `AgentStep` of kind `thought` — indistinguishable from any other paragraph, and impossible for
 * a panel to render as anything but text.
 *
 * **The shape is enforced by a tool's arguments, not by asking for JSON.** The inference layer
 * does have a `json` flag, and it is a boolean rather than a schema: Ollama sends
 * `format: "json"` and the OpenAI-compatible path sends `response_format: {type:"json_object"}`,
 * neither of which describes the shape wanted. `vision/describe.ts` says so in its own comment
 * and carries defensive coercion to prove it. A tool call is different — `agent/dispatch.ts`
 * validates every one against a strict zod schema and hands the model back its own errors — so
 * making the plan a tool makes the schema the contract the model is held to.
 *
 * Lives in `src/shared` because main writes it and the renderer draws it, and a second
 * declaration is how the two drift.
 */

/** One thing the agent intends to do. */
export interface PlanStep {
  title: string;
  /** Why, or how — anything the title cannot carry. Optional: many steps do not need one. */
  detail?: string;
  /**
   * Project-relative paths this step expects to touch.
   *
   * A guess made before the work, not a record of what happened. It is worth having because it
   * is the part of a plan a reader checks first — "is it going to touch the thing I care
   * about?" — and worth marking as an intention so nobody reads it as an outcome.
   */
  files?: string[];
  status: PlanStepStatus;
}

/**
 * Where a step has got to.
 *
 * Every plan is written before any of it happens, so a freshly written plan is entirely
 * `pending`. The other two exist because the pane showing a plan is the same pane you watch
 * while it runs, and a plan that cannot say where it is has to be re-read from the top each
 * time you look at it.
 */
export type PlanStepStatus = "pending" | "active" | "done";

export interface PlanDoc {
  title: string;
  steps: PlanStep[];
}

/**
 * The persisted envelope.
 *
 * A version beside the document, following `window_workspace.state`: this shape will change, and
 * a stored document that cannot say which shape it is has to be guessed at. The reader below
 * refuses rather than guesses.
 */
export const PLAN_VERSION = 1;

export interface StoredPlan {
  version: number;
  doc: PlanDoc;
}

/**
 * Read a stored plan, or nothing.
 *
 * Total, and deliberately strict about the parts a renderer would otherwise have to defend
 * against: a step with no title renders as an empty row, and a `status` outside the union
 * becomes a class name that matches no style. Both are the kind of thing that survives a long
 * time because the panel merely looks slightly wrong.
 */
export function parseStoredPlan(value: unknown): PlanDoc | null {
  if (typeof value !== "object" || value === null) return null;
  const outer = value as Partial<StoredPlan>;
  if (outer.version !== PLAN_VERSION) return null;

  const doc = outer.doc;
  if (typeof doc !== "object" || doc === null) return null;
  const { title, steps } = doc as Partial<PlanDoc>;
  if (typeof title !== "string" || title.length === 0) return null;
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const parsed: PlanStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) return null;
    const s = step as Partial<PlanStep>;
    if (typeof s.title !== "string" || s.title.length === 0) return null;
    if (s.status !== "pending" && s.status !== "active" && s.status !== "done") return null;
    parsed.push({
      title: s.title,
      status: s.status,
      ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
      ...(Array.isArray(s.files) && s.files.every((f) => typeof f === "string")
        ? { files: s.files }
        : {}),
    });
  }

  return { title, steps: parsed };
}

/** How far through a plan is, for a caller that wants to say so in one line. */
export function planProgress(doc: PlanDoc): { done: number; total: number } {
  return {
    done: doc.steps.filter((s) => s.status === "done").length,
    total: doc.steps.length,
  };
}
