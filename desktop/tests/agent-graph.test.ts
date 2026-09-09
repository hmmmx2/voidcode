/**
 * The agent loop.
 *
 * Driven by a scripted provider, because the questions worth asking are all about the
 * *sequence* of chunks a model produces, and a live model cannot be made to produce a
 * particular one on demand.
 *
 * What is being pinned:
 *
 *   The loop terminates. `finishReason === "tool_calls"` continues it and nothing else does —
 *   the field P5 added for exactly this. Get it wrong in either direction and the agent either
 *   stops before running the tools it asked for, or never stops at all.
 *
 *   Every tool call gets a reply. An assistant turn with three calls and two replies is a
 *   malformed conversation an OpenAI-compatible server rejects outright, and the symptom is a
 *   run that dies with no useful message.
 *
 *   **No diff is committed without approval.** The run may propose; only a human applies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { __setProjectRoot } from "../src/main/workspace.js";
import { __resetDiffs } from "../src/main/build/diffs.js";
import { __scriptProvider } from "../src/main/inference/registry.js";
import type { AgentMode } from "../src/main/agent/modes.js";
import { runAgent } from "../src/main/agent/graph.js";
import { MAX_TOOL_CALLS } from "../src/main/agent/dispatch.js";
import type { ChatChunk, ChatRequest, InferenceProvider } from "../src/main/inference/types.js";

function fakeSender(id: number): WebContents {
  return { id, once: () => {}, isDestroyed: () => false } as unknown as WebContents;
}

const sender = fakeSender(11);
let root: string;

/** A provider that yields a scripted turn each time it is called. */
function scriptedProvider(turns: ChatChunk[][]): InferenceProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  let turn = 0;

  return {
    id: "ollama",
    label: "Scripted",
    capabilities: { tools: true, grammar: true, remote: false },
    seen,
    available: async () => true,
    listModels: async () => [],
    chat(request: ChatRequest): AsyncIterable<ChatChunk> {
      seen.push(request);
      // Past the end, answer plainly rather than throwing — a loop that failed to terminate
      // should show up as a wrong assertion, not as an exception from the harness.
      const chunks = turns[turn++] ?? [{ kind: "token" as const, text: "done" }, { kind: "done" as const, finishReason: "stop" as const }];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

beforeEach(async () => {
  __resetDiffs();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-graph-"));
  await fsp.writeFile(path.join(root, "hello.ts"), "export const greeting = 'hi';\n", "utf8");
  __setProjectRoot(sender, root);
});

afterEach(() => {
  __scriptProvider("ollama", undefined);
});

/**
 * A run context for the tests that were written before modes existed.
 *
 * `acceptEdits` because it is the mode whose tool set matches what those tests assume: every
 * read tool plus `propose_edit`, which is what the surface used to hand out unconditionally.
 * Stating it rather than defaulting it in `RunContext` is deliberate -- a required field made
 * the compiler point at all four call sites, which is what a mode should do.
 */
const context = (agentMode: AgentMode = "acceptEdits") =>
  ({
    sender,
    surface: "assistant" as const,
    agentMode,
    providerId: "ollama" as const,
    model: "test",
  });

describe("the loop", () => {
  it("stops when the model stops", async () => {
    const provider = scriptedProvider([
      [{ kind: "token", text: "Here is the answer." }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "hello?", "t1", Date.now());

    expect(provider.seen).toHaveLength(1);
    expect(result.steps.map((s) => s.kind)).toEqual(["thought"]);
    expect(result.proposedDiffIds).toEqual([]);
  });

  it("runs a tool the model asked for, then finishes", async () => {
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: { id: "c1", name: "read_file", argumentsJson: '{"path":"hello.ts"}' },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "It exports greeting." }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "what does hello.ts do?", "t2", Date.now());

    expect(provider.seen).toHaveLength(2);
    // The tool's output went back to the model as a `tool` turn answering the call by id.
    const second = provider.seen[1]?.messages ?? [];
    const toolTurn = second.find((m) => m.role === "tool");
    expect(toolTurn).toMatchObject({ toolCallId: "c1", name: "read_file" });
    expect(String(toolTurn?.content)).toContain("greeting");
    expect(result.steps.some((s) => s.kind === "tool")).toBe(true);
  });

  it("puts the persona in as the system turn, and only main can", async () => {
    const provider = scriptedProvider([[{ kind: "done", finishReason: "stop" }]]);
    __scriptProvider("ollama", provider);

    await runAgent(context(), "hi", "t3", Date.now());

    const messages = provider.seen[0]?.messages ?? [];
    expect(messages[0]?.role).toBe("system");
  });

  it("offers the tutor no tools at all", async () => {
    // Structural, not a matter of the model declining.
    const provider = scriptedProvider([[{ kind: "done", finishReason: "stop" }]]);
    __scriptProvider("ollama", provider);

    await runAgent({ ...context(), surface: "tutor" }, "hi", "t4", Date.now());

    expect(provider.seen[0]?.tools ?? []).toEqual([]);
  });

  it("answers every call in a multi-call turn", async () => {
    const provider = scriptedProvider([
      [
        { kind: "tool_call", call: { id: "a", name: "read_file", argumentsJson: '{"path":"hello.ts"}' } },
        { kind: "tool_call", call: { id: "b", name: "search_project", argumentsJson: '{"query":"greeting"}' } },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    await runAgent(context(), "look around", "t5", Date.now());

    const replies = (provider.seen[1]?.messages ?? []).filter((m) => m.role === "tool");
    expect(replies.map((r) => (r.role === "tool" ? r.toolCallId : ""))).toEqual(["a", "b"]);
  });

  it("does not spin when a provider claims tool_calls but sends none", async () => {
    // Seen in the wild, and it is an infinite loop if the edge trusts the flag alone.
    const provider = scriptedProvider([
      [{ kind: "token", text: "thinking" }, { kind: "done", finishReason: "tool_calls" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "go", "t6", Date.now());
    expect(provider.seen).toHaveLength(1);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("ends the run when the tool budget is spent, and still answers the call", async () => {
    // A model that asks for a tool on every turn, forever.
    const loop: ChatChunk[] = [
      { kind: "tool_call", call: { id: "x", name: "read_file", argumentsJson: '{"path":"hello.ts"}' } },
      { kind: "done", finishReason: "tool_calls" },
    ];
    const provider = scriptedProvider(Array.from({ length: 200 }, () => loop));
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "loop forever", "t7", Date.now());

    // Bounded, and by the ceiling rather than by the harness running out of scripted turns.
    expect(provider.seen.length).toBeLessThanOrEqual(MAX_TOOL_CALLS + 2);
    const last = provider.seen[provider.seen.length - 1]?.messages ?? [];
    // Every assistant turn that asked for a tool got a reply, even the one that was refused.
    const assistantCalls = last.filter((m) => m.role === "assistant" && m.toolCalls !== undefined).length;
    const toolReplies = last.filter((m) => m.role === "tool").length;
    expect(toolReplies).toBe(assistantCalls);
  });

  it("keeps going after a tool returns an error", async () => {
    const provider = scriptedProvider([
      [
        { kind: "tool_call", call: { id: "e", name: "read_file", argumentsJson: "{bad json" } },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "let me try again" }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "read something", "t8", Date.now());

    // The mistake reached the model rather than ending the run — that is what lets it correct.
    expect(provider.seen).toHaveLength(2);
    const reply = (provider.seen[1]?.messages ?? []).find((m) => m.role === "tool");
    expect(String(reply?.content)).toContain("not valid JSON");
    expect(result.steps.some((s) => s.kind === "error")).toBe(true);
  });
});

describe("watching a run in flight", () => {
  it("emits each step as it happens, not only at the end", async () => {
    const provider = scriptedProvider([
      [
        { kind: "token", text: "Let me look." },
        { kind: "tool_call", call: { id: "c", name: "read_file", argumentsJson: '{"path":"hello.ts"}' } },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "Done." }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const seen: string[] = [];
    const result = await runAgent(
      { ...context(), onStep: (step) => seen.push(step.kind) },
      "look",
      "t11",
      Date.now()
    );

    // Arrived at all, and in order.
    expect(seen).toEqual(["thought", "tool", "thought"]);
    /**
     * And the pushes match the returned record exactly.
     *
     * The two are produced by one function for this reason: a live timeline that disagrees
     * with the final transcript is worse than having only one of them, because whichever the
     * user happens to be looking at is the one they will believe.
     */
    expect(result.steps.map((s) => s.kind)).toEqual(seen);
  });

  it("carries the diff on a proposal step so the panel can render it", async () => {
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "p",
            name: "propose_edit",
            argumentsJson: JSON.stringify({ path: "hello.ts", contents: "next\n" }),
          },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const seen: Array<{ kind: string; diff?: unknown }> = [];
    await runAgent({ ...context(), onStep: (s) => seen.push(s) }, "rewrite it", "t12", Date.now());

    const proposal = seen.find((s) => s.kind === "proposal");
    expect(proposal?.diff).toMatchObject({ displayPath: "hello.ts", origin: "agent" });
  });

  it("sends the diff view, not the stored diff", async () => {
    /**
     * `baseline`, `next` and `ownerId` stay in main — the same three fields `proposeWrite`
     * strips before returning to `fs:writeWithDiff`.
     *
     * Note what is deliberately *not* asserted: that the proposed text is absent. It is
     * present, as `+` lines, because that is what a diff is — withholding it would leave the
     * panel showing a review with nothing to review. An earlier version of this test looked
     * for a payload string and failed for exactly that reason.
     *
     * That is not the hole it first appears to be. A renderer able to reconstruct the file
     * and write it with `fs.save` could equally have written any other content: `fs.save` is
     * the user's own buffer path and has always been an arbitrary write. What the approval
     * dialog protects is narrower and still intact — that a proposal *the model authored*,
     * possibly steered by text it fetched, does not reach the disk on the agent's say-so.
     */
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "p",
            name: "propose_edit",
            argumentsJson: JSON.stringify({ path: "hello.ts", contents: "next\n" }),
          },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const seen: unknown[] = [];
    await runAgent({ ...context(), onStep: (s) => seen.push(s) }, "rewrite", "t13", Date.now());

    const diff = (seen as Array<{ kind: string; diff?: object }>).find((s) => s.kind === "proposal")?.diff;
    expect(diff).toBeDefined();
    for (const withheld of ["baseline", "next", "ownerId"]) {
      expect(Object.hasOwn(diff as object, withheld)).toBe(false);
    }
  });
});

describe("the write path", () => {
  it("proposes without writing, and hands back an id for approval", async () => {
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "w",
            name: "propose_edit",
            argumentsJson: JSON.stringify({ path: "hello.ts", contents: "rewritten\n" }),
          },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "Proposed." }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context(), "rewrite hello.ts", "t9", Date.now());

    expect(result.proposedDiffIds).toHaveLength(1);
    // THE ASSERTION THIS PHASE EXISTS FOR: the run completed and the file is untouched.
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toContain("greeting");
  });

  it("cannot write even when the model asks repeatedly", async () => {
    const propose: ChatChunk[] = [
      {
        kind: "tool_call",
        call: {
          id: "w",
          name: "propose_edit",
          argumentsJson: JSON.stringify({ path: "hello.ts", contents: "again\n" }),
        },
      },
      { kind: "done", finishReason: "tool_calls" },
    ];
    __scriptProvider("ollama", scriptedProvider(Array.from({ length: 30 }, () => propose)));

    await runAgent(context(), "just write it", "t10", Date.now());

    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toContain("greeting");
  });
});

/**
 * The graph honours the mode, rather than the mode table merely existing.
 *
 * These were written after mutation testing showed the pure tests in `agent-modes.test.ts`
 * had no reach here: binding the *surface's* tools instead of the *mode's* left every one of
 * them passing. A table nothing reads is the failure `personas.ts` already documented once —
 * "a documented intent with a passing unit test and nothing reading it".
 *
 * `scriptedProvider.seen` is what makes this checkable: it records the request as it reached
 * the provider, so what the model was actually told is an assertion rather than an inference.
 */
describe("the mode reaches the model", () => {
  const answer = (): ChatChunk[][] => [
    [{ kind: "token", text: "Understood." }, { kind: "done", finishReason: "stop" }],
  ];

  it("binds no editing tool in plan mode", async () => {
    const provider = scriptedProvider(answer());
    __scriptProvider("ollama", provider);

    await runAgent(context("plan"), "what would you change?", "t-plan", Date.now());

    const names = (provider.seen[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("propose_edit");
  });

  it("binds nothing at all in manual mode", async () => {
    const provider = scriptedProvider(answer());
    __scriptProvider("ollama", provider);

    await runAgent(context("manual"), "explain this", "t-manual", Date.now());

    expect(provider.seen[0]?.tools ?? []).toEqual([]);
  });

  it("binds propose_edit in acceptEdits mode", async () => {
    const provider = scriptedProvider(answer());
    __scriptProvider("ollama", provider);

    await runAgent(context("acceptEdits"), "fix it", "t-accept", Date.now());

    expect((provider.seen[0]?.tools ?? []).map((t) => t.name)).toContain("propose_edit");
  });

  it("sends a different system prompt per mode", async () => {
    const systemOf = async (mode: AgentMode, thread: string): Promise<string> => {
      const provider = scriptedProvider(answer());
      __scriptProvider("ollama", provider);
      await runAgent(context(mode), "hello", thread, Date.now());
      const first = provider.seen[0]?.messages[0];
      return first?.role === "system" ? String(first.content) : "";
    };

    const plan = await systemOf("plan", "s-plan");
    const manual = await systemOf("manual", "s-manual");
    const accept = await systemOf("acceptEdits", "s-accept");

    // Distinct, and each says the thing that is true of its own mode.
    expect(new Set([plan, manual, accept]).size).toBe(3);
    expect(manual).toMatch(/no tools/i);
    expect(accept).toContain("propose_edit");
    expect(plan).not.toContain("propose_edit");

    // Still first, which is the ordering `plan`'s docstring exists to guarantee.
    expect(plan.startsWith("You are the VoidCode coding assistant")).toBe(true);
  });

  it("refuses a tool the mode does not grant, without ending the run", async () => {
    /**
     * The enforcement, not the advertisement.
     *
     * A model can ask for a tool it was never offered — it has its own ideas, and a hostile
     * page can give it more. Plan mode must answer that with a refusal the model can read,
     * not by writing a file. `dispatch.ts`'s rule is that a bad call is a result, not a throw,
     * so the run continues and the transcript records what was attempted.
     */
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "c1",
            name: "propose_edit",
            argumentsJson: JSON.stringify({ path: "hello.ts", contents: "wiped" }),
          },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "I cannot edit in this mode." }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context("plan"), "rewrite hello.ts", "t-refuse", Date.now());

    // Nothing was proposed, and the file is untouched.
    expect(result.proposedDiffIds).toEqual([]);
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toBe(
      "export const greeting = 'hi';\n"
    );

    /**
     * The refusal by its actual words, not merely "an error happened".
     *
     * That weaker assertion passed under a mutation binding the surface's tools instead of the
     * mode's: the call got through the allowlist and then crashed inside the dispatcher on
     * unrelated state, producing a `TypeError` step. Both "no diff" and "some error" still
     * held, so the test reported success while the guard it exists for was gone.
     *
     * Only the allowlist path produces this sentence, and it names what the mode *does* have —
     * which is also what the model needs in order to do something useful next.
     */
    const refusal = result.steps.find((s) => s.kind === "error");
    expect(refusal?.text).toContain('No tool named "propose_edit" is available');
    expect(refusal?.text).toContain("read_file");
  });

  it("stops manual mode after one turn even if the model asks for more", async () => {
    /**
     * `maxTurns: 1`, ended on an edge rather than by exceeding `recursionLimit`.
     *
     * The distinction matters: a recursion trip throws `GraphRecursionError` out of
     * `graph.invoke`, which nothing catches, so the steps collected so far are discarded and
     * the panel shows a bare error instead of the work.
     */
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: { id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "hello.ts" }) },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "second turn" }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context("manual"), "read it", "t-one-turn", Date.now());

    // One request only: the loop never came back for a second.
    expect(provider.seen).toHaveLength(1);
    expect(result.steps.some((s) => s.kind === "tool")).toBe(false);
  });
});

/**
 * Auto mode, end to end through the graph.
 *
 * The mode that writes without asking, so what is asserted here is mostly what it must NOT do.
 * `runAgent` is the graph; the auto-apply itself lives in `stream.ts` and is covered by the
 * source assertions in `agent-modes.test.ts` — what this file can prove is that the graph
 * binds the shell only in Auto, and that a command really runs.
 */
describe("auto mode", () => {
  it("binds the shell in auto and in nothing else", async () => {
    const provider = scriptedProvider([
      [{ kind: "token", text: "ok" }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    await runAgent(context("auto"), "check the build", "t-auto-tools", Date.now());

    const names = (provider.seen[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("run_command");
    expect(names).toContain("propose_edit");
  });

  it("actually runs a command and reports its exit code", async () => {
    const echo = process.platform === "win32" ? "echo from-the-agent" : "printf from-the-agent";
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: { id: "c1", name: "run_command", argumentsJson: JSON.stringify({ command: echo }) },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "done" }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context("auto"), "run it", "t-auto-cmd", Date.now());

    const reply = (provider.seen[1]?.messages ?? []).find((m) => m.role === "tool");
    expect(String(reply?.content)).toContain("from-the-agent");
    expect(String(reply?.content)).toContain("exit code: 0");

    /**
     * Recorded as `command`, which is the whole reason migration 12 rebuilt a table.
     *
     * An audit log that files a shell invocation under the same label as reading a file cannot
     * answer the one question it exists for.
     */
    expect(result.steps.some((s) => s.kind === "command")).toBe(true);
  }, 30_000);

  it("refuses the shell in every other mode", async () => {
    // The intersection, exercised rather than described: the surface offers `run_command`, and
    // only Auto's policy asks for it.
    for (const mode of ["plan", "acceptEdits"] as const) {
      const provider = scriptedProvider([
        [
          {
            kind: "tool_call",
            call: {
              id: "c1",
              name: "run_command",
              argumentsJson: JSON.stringify({ command: "echo nope" }),
            },
          },
          { kind: "done", finishReason: "tool_calls" },
        ],
        [{ kind: "token", text: "ok" }, { kind: "done", finishReason: "stop" }],
      ]);
      __scriptProvider("ollama", provider);

      const result = await runAgent(context(mode), "run it", `t-no-shell-${mode}`, Date.now());

      const refusal = result.steps.find((s) => s.kind === "error");
      expect(refusal?.text, `${mode} should refuse the shell`).toContain(
        'No tool named "run_command" is available'
      );
    }
  }, 30_000);

  it("proposes rather than writes, even in auto — the graph has no path to disk", async () => {
    /**
     * The property that keeps Auto auditable: `propose_edit` proposes in every mode, and the
     * write happens in `stream.ts` behind the arming check. So a run driven straight through
     * the graph — as this test does, bypassing `stream.ts` entirely — changes nothing on disk.
     *
     * If this ever fails, the write has moved into the graph and the arming gate has been
     * bypassed rather than satisfied.
     */
    const provider = scriptedProvider([
      [
        {
          kind: "tool_call",
          call: {
            id: "c1",
            name: "propose_edit",
            argumentsJson: JSON.stringify({ path: "hello.ts", contents: "rewritten\n" }),
          },
        },
        { kind: "done", finishReason: "tool_calls" },
      ],
      [{ kind: "token", text: "proposed" }, { kind: "done", finishReason: "stop" }],
    ]);
    __scriptProvider("ollama", provider);

    const result = await runAgent(context("auto"), "rewrite it", "t-auto-propose", Date.now());

    expect(result.proposedDiffIds).toHaveLength(1);
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toBe(
      "export const greeting = 'hi';\n"
    );
  });
});
