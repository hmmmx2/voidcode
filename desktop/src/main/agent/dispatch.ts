/**
 * Running a tool the model asked for.
 *
 * The rule that shapes everything here: **a bad tool call is a result, not an exception.**
 * Malformed JSON, a missing argument, a path that escapes the project, an unknown tool name —
 * all of these come back to the model as text it can read and correct. Throwing would kill the
 * run, and the model would never learn what it got wrong; it would simply appear to stop, which
 * is the hardest agent failure to diagnose.
 *
 * The exception to that rule is the budget. A run that has spent its allowance ends, because
 * telling the model "you are out of calls" and letting it continue is how a loop becomes
 * infinite while looking productive.
 *
 * **No privileged path, for the file tools.** Every path argument goes through the same
 * `readWorkspaceFile` / `proposeWrite` as the IPC handlers, so those tools cannot reach a file
 * a renderer cannot — enforced by *reuse* rather than by a second implementation that agrees
 * today.
 *
 * **`run_command` is outside that sentence, and this is the honest statement of it.** A shell
 * command does not go through `paths.ts`, `writeWorkspacePath`, the diff gate, `origin:
 * "agent"` or the approval window. `echo x >> ~/.bashrc` reaches none of them. The confinement
 * every other tool here relies on is "the agent touches files only through these resolvers",
 * and that stops being true of this one.
 *
 * This paragraph replaces a claim that used to read "an agent cannot reach a file a renderer
 * cannot", which became false the moment the shell was added. A stale comment asserting a
 * control that no longer exists is worse than the missing control, because the next reader
 * trusts it.
 *
 * What does bound it: the command runs with `cwd` at the project root, only in Auto mode,
 * only in a window a human armed for this project, with every invocation and its output in
 * `agent_steps`, and killed as a process tree when the run's port closes. What does not:
 * anything the command chooses to do outside that directory, or over the network. That was a
 * deliberate choice — an allowlist was considered and declined — and it is written down here
 * rather than left for someone to discover.
 */
import fs from "node:fs/promises";
import type { WebContents } from "electron";
import { z } from "zod";
import { readWorkspaceFile, currentProjectRoot } from "../workspace.js";
import { runCommand } from "./run-command.js";
import { readProjectTree } from "../build/tree.js";
import { searchInFiles } from "../build/search.js";
import { searchMemory } from "../memory/index.js";
import { proposeWrite, type PendingDiff } from "../build/diffs.js";
import { readTextFile } from "../build/text-file.js";
import { fetchPage } from "../net/fetch.js";
import { wrapUntrusted } from "../net/html-text.js";
import { FetchRefused } from "../net/allowlist.js";
import type { ToolCall } from "../inference/types.js";
import type { PlanDoc } from "../../shared/plan.js";
import type { DesignSpec } from "../../shared/design.js";

/**
 * What a run may spend.
 *
 * Every one of these has been exceeded by a real agent somewhere. The tool cap stops a loop
 * that keeps re-reading the same file; the byte cap stops a single `list_files` on a large
 * repository filling the context; the fetch cap bounds how much of the run is outbound network.
 */
export const MAX_TOOL_CALLS = 24;
export const MAX_RESULT_BYTES = 512 * 1024;
export const MAX_FETCHES = 6;
export const MAX_WALL_CLOCK_MS = 5 * 60 * 1000;

/** One tool result, in the shape the transcript stores and the model reads back. */
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  /** True when this was a refusal or a mistake rather than an answer. */
  isError: boolean;
  /** Set by `propose_edit`, so the graph knows what is awaiting approval. */
  diffId?: string;
  /**
   * The rendered diff, for the panel.
   *
   * Carried rather than re-fetched by id: it is already computed at propose time, and the
   * alternative is a channel that hands out diff bodies on request — a second read path into
   * pending state, for data the caller was about to be given anyway.
   *
   * Safe to send. This is the same view `fs:writeWithDiff` returns, which deliberately omits
   * `baseline`, `next` and `ownerId` — a renderer cannot reconstruct the proposed file from it
   * and apply it behind the gate.
   */
  diff?: PendingDiff;
  /**
   * The plan `write_plan` recorded, for the panel and the store.
   *
   * Carried on the result rather than announced as its own event kind. A plan arrives *because*
   * a tool ran, so it is already travelling — and `agent_steps.kind` is a SQLite `CHECK`
   * constraint, which cannot be altered without rebuilding the table. A new field on a `tool`
   * step needs none of that.
   */
  plan?: PlanDoc;
  /** Set by `write_design_spec`, and carried exactly as `plan` is. */
  design?: DesignSpec;
}

export interface RunBudget {
  toolCalls: number;
  resultBytes: number;
  fetches: number;
  startedAt: number;
}

export function newBudget(startedAt: number): RunBudget {
  return { toolCalls: 0, resultBytes: 0, fetches: 0, startedAt };
}

export class BudgetExhausted extends Error {
  constructor(readonly which: string) {
    super(`The assistant reached its ${which} limit for this run`);
    this.name = "BudgetExhausted";
  }
}

/**
 * The argument schemas.
 *
 * Deliberately beside the dispatcher rather than beside the JSON Schema in `personas.ts`: that
 * one is what the model is *told*, this is what is *enforced*. They describe the same shape,
 * and keeping the enforcing copy next to the code that acts on it means a change here cannot
 * be forgotten. `.strict()` throughout, so an extra key is a rejection the model can see.
 */
const SCHEMAS = {
  read_file: z.object({ path: z.string().min(1).max(1_024) }).strict(),
  list_files: z.object({}).strict(),
  search_project: z.object({ query: z.string().min(1).max(2_000) }).strict(),
  memory_search: z.object({ query: z.string().min(1).max(2_000) }).strict(),
  web_fetch: z.object({ url: z.string().min(1).max(2_048) }).strict(),
  propose_edit: z
    .object({ path: z.string().min(1).max(1_024), contents: z.string().max(2_000_000) })
    .strict(),
  run_command: z.object({ command: z.string().min(1).max(4_000) }).strict(),
  /**
   * The plan's schema, and the only thing holding the model to it.
   *
   * `json: true` exists on the inference layer and is a boolean, not a schema — Ollama sends
   * `format: "json"`, the OpenAI-compatible path sends `response_format: {type:"json_object"}`,
   * and neither describes a shape. This does, and a call that misses it comes back to the model
   * as its own validation error rather than as a plan the renderer has to defend against.
   *
   * Bounded like every other tool here. Thirty steps is past the point where a plan is a plan;
   * a model that wants more has decomposed the task wrongly, and truncating silently would hide
   * that from the person reading it.
   */
  write_plan: z
    .object({
      title: z.string().min(1).max(200),
      steps: z.preprocess(
        planSteps,
        z
          .array(
            z
              .object({
                title: z.string().min(1).max(200),
                detail: z.string().max(2_000).optional(),
                files: z.array(z.string().min(1).max(1_024)).max(20).optional(),
              })
              .strict()
          )
          .min(1)
          .max(30)
      ),
    })
    .strict(),
  /**
   * The design spec's schema, mirroring `write_plan` above and for the same reasons.
   *
   * `tokens` is the field that makes this a specification rather than a paragraph: names from
   * the project's own CSS, checkable against it. Bounded like everything else here — twelve
   * sections is already a large design, and a model producing forty has described a product
   * rather than a screen.
   */
  write_design_spec: z
    .object({
      title: z.string().min(1).max(200),
      intent: z.string().min(1).max(4_000),
      sections: z
        .array(
          z
            .object({
              name: z.string().min(1).max(200),
              purpose: z.string().min(1).max(2_000),
              tokens: z.preprocess(
                stringsOrEncoded,
                z.array(z.string().min(1).max(120)).max(40).optional()
              ),
              notes: z.preprocess(
                stringsOrEncoded,
                z.array(z.string().min(1).max(1_000)).max(20).optional()
              ),
            })
            .strict()
        )
        .min(1)
        .max(12),
    })
    .strict(),
} as const;

/**
 * The same JSON-encoding quirk `planSteps` normalises, for the two arrays here.
 *
 * llama3.1:8b sends nested arrays as strings — `tokens: "[\"color-ink\"]"` — which strict
 * validation rejects with a message about a type the model cannot see it produced. Observed
 * driving the agent at Ollama with the models the app recommends for tool use.
 *
 * Anything that is not an encoded array passes through untouched, to be rejected exactly as
 * before. `undefined` passes through too, because both fields are optional.
 */
function stringsOrEncoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * The two shapes real models send for `steps`, normalised before validation.
 *
 * **Both were observed rather than imagined**, driving the agent at Ollama with the models the
 * app itself recommends for tool use:
 *
 *   llama3.1:8b sends the array JSON-encoded — `steps: "[{\"title\": ...}]"` — a string where
 *   an array belongs. Strict validation rejects it, the model gets "expected array, received
 *   string", and a model that cannot see its own serialisation bug is unlikely to fix it on a
 *   retry. That is a plan pane permanently empty for one of two recommended models.
 *
 *   Both models send bare strings for steps — `["Create the file", "Write the entry"]` — when
 *   the wording nudges them even slightly toward a simple list.
 *
 * **Normalising is not the same as guessing.** Every value here is already unambiguous: a
 * JSON-encoded array is that array, and a step that is a sentence is that sentence's title.
 * Nothing is invented, no field is defaulted, and anything that is not one of these two shapes
 * passes through untouched to be rejected by the schema exactly as before — which is why this
 * is a `preprocess` on the way in rather than a `catch` that swallows failures.
 *
 * This is the same judgement `projectRelative` makes one function below about a leading slash:
 * meet a model where its serialisation reliably lands, and keep the strictness for the cases
 * that are genuinely wrong.
 */
function planSteps(value: unknown): unknown {
  let steps = value;

  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch {
      // Not JSON, so not the encoding bug — leave it for the schema to reject with a message
      // about the type, which is the accurate complaint.
      return value;
    }
  }

  if (!Array.isArray(steps)) return value;
  return steps.map((step) => (typeof step === "string" ? { title: step } : step));
}

type ToolName = keyof typeof SCHEMAS;

function errorResult(call: ToolCall, message: string): ToolResult {
  return { toolCallId: call.id, name: call.name, content: message, isError: true };
}

/**
 * Read a leading slash as "from the project root", which is what a model means by it.
 *
 * Models write `/hello.ts` for a root-relative path constantly — llama3.1 did it on its first
 * `propose_edit` here. `path.isAbsolute("/hello.ts")` is true on Windows, so it resolved
 * against the drive root, escaped confinement, and came back refused. The model then spent its
 * next turn apologising and planning a search instead of doing the work.
 *
 * **This cannot widen access, and that is the whole reason it is safe.** Stripping a leading
 * separator can only turn an absolute path into a relative one, and every relative path is
 * resolved inside the root by `resolveWithin` exactly as before — `/etc/passwd` becomes
 * `etc/passwd`, which is refused for not existing rather than for escaping. A drive-qualified
 * path like `C:\Windows` is left alone and still refused.
 *
 * Applied to agent arguments only. Renderer paths keep going through the resolver untouched,
 * because a renderer is not a model guessing at conventions.
 */
function asProjectRelative(candidate: string): string {
  return candidate.replace(/^[/\\]+/, "");
}

/** Clip a result so one enormous file cannot consume the whole budget in a single call. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated — ${String(text.length - limit)} more characters]`;
}

/**
 * Run one tool call.
 *
 * Never throws for anything the model did. Throws only `BudgetExhausted`, which is the run
 * ending rather than a call failing.
 */
export async function dispatchTool(
  sender: WebContents,
  call: ToolCall,
  allowed: readonly string[],
  budget: RunBudget,
  signal?: AbortSignal
): Promise<ToolResult> {
  /**
   * Already stopped, so do not start.
   *
   * A turn's tool calls are dispatched in sequence, so pressing Stop during the third of five
   * leaves two queued behind it. Without this they each run to completion against a run
   * nobody is watching — reading files and walking the project after the panel has gone idle.
   *
   * A result rather than a throw, following this file's rule: only the budget throws.
   */
  if (signal?.aborted === true) {
    return errorResult(call, "The run was stopped before this tool ran.");
  }

  if (Date.now() - budget.startedAt > MAX_WALL_CLOCK_MS) throw new BudgetExhausted("time");
  if (budget.toolCalls >= MAX_TOOL_CALLS) throw new BudgetExhausted("tool call");
  if (budget.resultBytes >= MAX_RESULT_BYTES) throw new BudgetExhausted("tool output");
  budget.toolCalls += 1;

  /**
   * The surface's list is the authority, checked before the name is looked up anywhere.
   *
   * A model can emit any string it likes, including the name of a tool another surface has.
   * `Object.hasOwn` rather than `in`, following the broker's gate-1 rule: `constructor` and
   * `toString` are on every object's prototype and are not tools.
   */
  if (!allowed.includes(call.name) || !Object.hasOwn(SCHEMAS, call.name)) {
    return errorResult(
      call,
      `No tool named "${call.name}" is available. Available tools: ${allowed.join(", ")}.`
    );
  }
  const name = call.name as ToolName;

  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    // Handed back verbatim so the model can see what it produced. Models routinely emit
    // trailing commas and unescaped newlines, and they correct it when shown.
    return errorResult(
      call,
      `The arguments were not valid JSON. Received: ${clip(call.argumentsJson, 500)}`
    );
  }

  const parsed = SCHEMAS[name].safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return errorResult(call, `The arguments did not match the schema. ${issues}`);
  }

  try {
    const result = await run(sender, name, parsed.data, budget, signal);
    budget.resultBytes += Buffer.byteLength(result.content, "utf8");
    /**
     * The id is stamped here, not inside `run`.
     *
     * `run` has no reason to know it, and an OpenAI-compatible server rejects the whole
     * request when a `tool` message's id does not match a call the assistant made. That
     * presents as the run stopping for no visible reason — the failure shape the plan calls
     * the hardest to chase — so it is set in exactly one place rather than in each branch.
     */
    return { ...result, toolCallId: call.id };
  } catch (err) {
    if (err instanceof BudgetExhausted) throw err;
    /**
     * A refused path arrives here and becomes a result, not a crash.
     *
     * Deliberately the same message a renderer would get from `fs:read` — the agent is not
     * told more about the filesystem than a page is, and "outside the project" is already
     * everything it needs to try a different path.
     */
    const message = err instanceof Error ? err.message : String(err);
    // Tell the model the convention rather than only that it broke one. A bare "outside the
    // permitted root" sent llama3.1 off to search for the file instead of retrying the path.
    return errorResult(
      call,
      message.includes("outside the permitted root")
        ? `${message}. Paths are relative to the project root — use "src/a.ts", not an absolute path.`
        : message
    );
  }
}

async function run(
  sender: WebContents,
  name: ToolName,
  args: z.infer<(typeof SCHEMAS)[ToolName]>,
  budget: RunBudget,
  signal?: AbortSignal
): Promise<ToolResult> {
  const done = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({
    toolCallId: "",
    name,
    content,
    isError: false,
    ...extra,
  });

  switch (name) {
    case "read_file": {
      const { path } = args as z.infer<typeof SCHEMAS.read_file>;
      // Resolve then read — `readWorkspaceFile` returns the confined absolute path, exactly as
      // `fs:read` uses it. Reusing the resolver rather than reimplementing confinement is the
      // point; an agent reaches no file a renderer could not.
      const absolute = await readWorkspaceFile(sender, asProjectRelative(path));
      /**
       * `readTextFile` rather than `fs.readFile(_, "utf8")`, which never fails.
       *
       * Handed a PNG, the old call returned 64KB of replacement characters and this returned
       * them as the file's contents — so the model spent a large slice of its budget reading
       * `????` and then reasoned about what it had "seen". Telling it the file is binary is
       * both true and actionable: it can go and read something else.
       *
       * The signal is threaded through for the same reason it always was. A 60MB file on a slow
       * disk is where it is the difference between Stop working and Stop being a label.
       */
      const file = await readTextFile(absolute, signal ? { signal } : {});
      if (file.kind === "binary") {
        return {
          toolCallId: "",
          name,
          content:
            `${path} is a binary file (${String(file.bytes)} bytes), not text. ` +
            `Its contents cannot be read as source. Do not guess at what is in it.`,
          isError: true,
        };
      }
      return done(clip(file.contents, 64_000));
    }

    case "list_files": {
      /**
       * The whole tree, and the tool takes no arguments because of it.
       *
       * `readProjectTree` walks from the root with its own bounds and skip list; there is no
       * per-directory variant. A `path` argument was drafted here and removed — it would have
       * been accepted and ignored, which makes the description the model reads a lie, and adds
       * a second path-resolution site for a string the model supplies. Better to not offer it.
       */
      const root = currentProjectRoot(sender);
      if (root === undefined) return done("No project is open.");
      const tree = await readProjectTree(root);
      return done(clip(JSON.stringify(tree), 64_000));
    }

    case "search_project": {
      const { query } = args as z.infer<typeof SCHEMAS.search_project>;
      const result = await searchInFiles(sender, query, { ...(signal ? { signal } : {}) });
      if (result.matches.length === 0) {
        // Said plainly, because "no output" reads to a model like a tool that broke.
        return done(`No matches for "${query}" in the project.`);
      }
      const lines = result.matches
        .slice(0, 60)
        .map((m) => `${m.path}:${String(m.line)}: ${m.preview}`)
        .join("\n");
      return done(clip(result.truncated ? `${lines}\n[more matches were not shown]` : lines, 32_000));
    }

    case "memory_search": {
      const { query } = args as z.infer<typeof SCHEMAS.memory_search>;
      const root = (await import("../workspace.js")).currentProjectRoot(sender);
      if (root === undefined) return done("No project is open.");
      const hits = await searchMemory(root, query, 8);
      if (hits.length === 0) {
        return done("Nothing found. This project may not have been indexed yet.");
      }
      const rendered = hits
        .map(
          (h) =>
            `${h.chunk.path}:${String(h.chunk.startLine)}${h.stale ? " (may be out of date)" : ""}\n${h.chunk.text}`
        )
        .join("\n\n---\n\n");
      return done(clip(rendered, 32_000));
    }

    case "web_fetch": {
      const { url } = args as z.infer<typeof SCHEMAS.web_fetch>;
      if (budget.fetches >= MAX_FETCHES) throw new BudgetExhausted("web fetch");
      budget.fetches += 1;
      try {
        // No signal: `fetchPage`'s second parameter is its injected dependencies, and it
        // enforces its own 15s timeout and byte cap internally. Passing a signal here would
        // have silently replaced its real `dns`/`https` with an AbortSignal.
        const page = await fetchPage(url);
        // Wrapped, and the wrapper's own docstring says the marker is hygiene rather than a
        // control. What actually bounds this is `paths.ts` and the approval dialog.
        return done(clip(wrapUntrusted(page), 48_000));
      } catch (err) {
        if (err instanceof FetchRefused) {
          return {
            toolCallId: "",
            name,
            content: `That URL was refused (${err.reason}): ${err.message}`,
            isError: true,
          };
        }
        throw err;
      }
    }

    case "propose_edit": {
      const { path, contents } = args as z.infer<typeof SCHEMAS.propose_edit>;
      /**
       * `origin: "agent"` is set HERE, in main, and is the whole security fix.
       *
       * It cannot be influenced by the model's arguments or by the renderer — this call site
       * is the only way a diff acquires it, and `fs:commitDiff` refuses anything carrying it.
       * An agent's proposal can only reach the disk through the native approval dialog.
       */
      const diff = await proposeWrite(sender, asProjectRelative(path), contents, "agent");
      /**
       * Says what happened, not what happens next.
       *
       * This used to end "It is NOT written yet — the user must approve it", which is true in
       * Accept Edits and false in Auto, where the proposal is written moments later. The
       * dispatcher does not know the mode — by the time a call reaches here the surface and
       * mode have been flattened into an `allowed` list — and threading one in purely to
       * choose a sentence would put the same claim in a third place.
       *
       * So the result states the fact common to both, and each mode's guidance in
       * `agent/modes.ts` says what becomes of a proposal. "Do not propose it again" survives
       * because it is true either way and is the instruction that stops a model rewriting its
       * own edit against a file it has not re-read.
       */
      return done(
        `Proposed a change to ${diff.displayPath} (+${String(diff.added)} −${String(diff.removed)}). ` +
          `Do not propose the same change again.`,
        { diffId: diff.id, diff }
      );
    }

    case "write_plan": {
      const { title, steps } = args as z.infer<typeof SCHEMAS.write_plan>;
      /**
       * Every step starts `pending`, and the model is not asked for status.
       *
       * A plan is written before any of it happens, so the only honest answer at this point is
       * "none of it". Letting the model set status would let it report a step done in the same
       * call that invented the step — which is exactly the kind of claim a plan pane exists to
       * make checkable rather than to repeat.
       */
      const plan: PlanDoc = {
        title,
        steps: steps.map((step) => ({
          title: step.title,
          status: "pending" as const,
          ...(step.detail !== undefined ? { detail: step.detail } : {}),
          ...(step.files !== undefined ? { files: step.files } : {}),
        })),
      };
      return done(
        `Recorded a plan: ${String(plan.steps.length)} step${plan.steps.length === 1 ? "" : "s"}. ` +
          `Now carry it out. Do not call write_plan again unless the plan itself changes.`,
        { plan }
      );
    }

    case "write_design_spec": {
      const { title, intent, sections } = args as z.infer<typeof SCHEMAS.write_design_spec>;
      const spec: DesignSpec = {
        title,
        intent,
        sections: sections.map((section) => ({
          name: section.name,
          purpose: section.purpose,
          ...(section.tokens !== undefined ? { tokens: section.tokens } : {}),
          ...(section.notes !== undefined ? { notes: section.notes } : {}),
        })),
      };
      /**
       * The result names the tokens back, so the model can see what it committed to.
       *
       * Whether those tokens exist is checked where the project's CSS is — the renderer, which
       * has both halves. Telling the model here would mean reading the project's stylesheets on
       * every call to report something the panel says better and in colour.
       */
      const named = new Set(sections.flatMap((section) => section.tokens ?? []));
      return done(
        `Recorded a design spec: ${String(spec.sections.length)} section` +
          `${spec.sections.length === 1 ? "" : "s"}` +
          `${named.size === 0 ? "" : `, using ${String(named.size)} tokens`}. ` +
          `Now write the UI code to match it.`,
        { design: spec }
      );
    }

    case "run_command": {
      const { command } = args as z.infer<typeof SCHEMAS.run_command>;
      const root = currentProjectRoot(sender);
      // `done(..., { isError: true })` rather than `errorResult`, which needs the `ToolCall`
      // this function deliberately does not receive — by here the call has been validated and
      // reduced to a name and typed arguments.
      if (root === undefined) return done("No project is open.", { isError: true });

      const result = await runCommand(root, command, signal);

      /**
       * Assembled so the model can act on it without guessing.
       *
       * The exit code first, because that is the verdict; then each stream labelled, because
       * "printed to stderr and still exited 0" is a warning and the same bytes with a non-zero
       * exit is a failure. A timeout and a truncation both say so rather than presenting a
       * partial answer as a whole one.
       */
      const parts = [`$ ${result.command}`];
      parts.push(
        result.timedOut
          ? "timed out after 120s and was killed"
          : `exit code: ${result.exitCode === null ? "killed" : String(result.exitCode)}`
      );
      if (result.stdout.trim() !== "") parts.push(`stdout:\n${result.stdout.trimEnd()}`);
      if (result.stderr.trim() !== "") parts.push(`stderr:\n${result.stderr.trimEnd()}`);
      if (result.stdout.trim() === "" && result.stderr.trim() === "") parts.push("(no output)");
      if (result.truncated) parts.push("(output was truncated at 256KB)");

      return done(parts.join("\n"));
    }
  }
}
