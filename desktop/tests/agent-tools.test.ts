/**
 * The agent's tool layer.
 *
 * Two claims, and the second is the one this phase exists for:
 *
 *   **A bad tool call is a result, not an exception.** Malformed JSON, a missing argument, an
 *   escaping path, an unknown name — each comes back as text the model can read and correct.
 *   Throwing would end the run, and the model would appear to simply stop, which the plan
 *   names as the hardest agent failure to diagnose.
 *
 *   **An agent's proposal cannot reach the disk through the human's door.** `propose_edit`
 *   marks its diff `origin: "agent"`, and `commitDiff` refuses it. This is the "two steps are
 *   not two parties" fix, and it is the reason the whole phase is safe to ship.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { __setProjectRoot } from "../src/main/workspace.js";
import {
  proposeWrite,
  commitDiff,
  commitAgentDiffs,
  describeAgentDiffs,
  AgentDiffError,
  __resetDiffs,
} from "../src/main/build/diffs.js";
import {
  dispatchTool,
  newBudget,
  BudgetExhausted,
  MAX_TOOL_CALLS,
  MAX_FETCHES,
} from "../src/main/agent/dispatch.js";
import { toolsForSurface } from "../src/main/inference/personas.js";
import { sealTelemetry, __TELEMETRY_VARS } from "../src/main/agent/telemetry.js";
import type { ToolCall } from "../src/main/inference/types.js";

/** A stand-in for a real WebContents — the modules only ever read `.id`. */
function fakeSender(id: number): WebContents {
  return { id, once: () => {}, isDestroyed: () => false } as unknown as WebContents;
}

const sender = fakeSender(1);
const allowed = toolsForSurface("assistant");
let root: string;

function call(name: string, args: unknown, id = "call-1"): ToolCall {
  return { id, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) };
}

beforeEach(async () => {
  __resetDiffs();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-agent-"));
  await fsp.writeFile(path.join(root, "hello.ts"), "export const greeting = 'hi';\n", "utf8");
  __setProjectRoot(sender, root);
});

describe("a bad tool call comes back as a result", () => {
  it("reports malformed JSON with what was received", async () => {
    const result = await dispatchTool(sender, call("read_file", "{not json"), allowed, newBudget(Date.now()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not valid JSON");
    // Handed back verbatim: models correct this when shown their own output.
    expect(result.content).toContain("{not json");
  });

  it("reports a schema mismatch by field", async () => {
    const result = await dispatchTool(sender, call("read_file", { wrong: 1 }), allowed, newBudget(Date.now()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("did not match the schema");
  });

  it("refuses an unknown tool and lists what exists", async () => {
    const result = await dispatchTool(sender, call("rm_rf", {}), allowed, newBudget(Date.now()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read_file");
  });

  it("refuses a tool the surface does not have, even though it exists", async () => {
    // The tutor gets nothing. A paper's text can ask as hard as it likes.
    const result = await dispatchTool(
      sender,
      call("read_file", { path: "hello.ts" }),
      toolsForSurface("tutor"),
      newBudget(Date.now())
    );
    expect(result.isError).toBe(true);
  });

  it("refuses a prototype key rather than resolving it", async () => {
    // `Object.hasOwn`, not `in` — the broker's gate-1 rule.
    for (const name of ["constructor", "toString", "__proto__"]) {
      const result = await dispatchTool(sender, call(name, {}), allowed, newBudget(Date.now()));
      expect(result.isError).toBe(true);
    }
  });

  it("refuses a binary file instead of returning replacement characters", async () => {
    /**
     * `fs.readFile(_, "utf8")` never fails, which is the whole problem it replaced.
     *
     * Handed a PNG it returned 64KB of `�` and this tool returned them as the file's
     * contents — so the model spent a large slice of its budget reading nothing and then
     * reasoned about what it had "seen". Saying the file is binary is both true and actionable.
     */
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4_096),
    ]);
    await fsp.writeFile(path.join(root, "logo.png"), png);

    const result = await dispatchTool(
      sender,
      call("read_file", { path: "logo.png" }),
      allowed,
      newBudget(Date.now())
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("binary");
    expect(result.content).toContain("logo.png");
    // The size, so the model can tell a stub from a real asset.
    expect(result.content).toContain("4104");
    // And none of the mojibake that used to come back as the answer.
    expect(result.content).not.toContain("�");
  });

  it("refuses a path that escapes the project, and says so", async () => {
    /**
     * A file that really exists, outside the root.
     *
     * `../../../etc/passwd` was the first attempt and it was a decorative assertion on
     * Windows: `resolveWithin` calls `realpath` before the containment check, so a
     * *non-existent* escaping path fails with ENOENT and never reaches the guard being tested.
     * Confinement was fine; the test was proving nothing. A real file forces the guard to run
     * on every platform.
     */
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    await fsp.writeFile(outside, "secret\n", "utf8");
    try {
      const result = await dispatchTool(
        sender,
        call("read_file", { path: `../${path.basename(outside)}` }),
        allowed,
        newBudget(Date.now())
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/outside|permitted/i);
      expect(result.content).not.toContain("secret");
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it("reads a leading slash as project-relative, which is what models write", async () => {
    /**
     * llama3.1 asked to edit `/hello.ts` on its first real turn here.
     * `path.isAbsolute("/hello.ts")` is true on Windows, so it escaped confinement and came
     * back refused — and the model spent its next turn apologising instead of working.
     */
    const result = await dispatchTool(
      sender,
      call("read_file", { path: "/hello.ts" }),
      allowed,
      newBudget(Date.now())
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("greeting");
  });

  it("cannot be used to widen access, only to narrow it", async () => {
    /**
     * The property that makes the rewrite safe: stripping a leading separator turns an
     * absolute path into a relative one, and every relative path still resolves inside the
     * root. An escape attempt is refused for a different reason, never allowed.
     */
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    await fsp.writeFile(outside, "secret\n", "utf8");
    try {
      for (const attempt of ["/etc/passwd", `//${path.basename(outside)}`, "\\Windows\\win.ini"]) {
        const result = await dispatchTool(
          sender,
          call("read_file", { path: attempt }),
          allowed,
          newBudget(Date.now())
        );
        expect(result.isError).toBe(true);
        expect(result.content).not.toContain("secret");
      }

      // And a drive-qualified path is left alone, so it is still refused as an escape.
      const drive = await dispatchTool(
        sender,
        call("read_file", { path: outside }),
        allowed,
        newBudget(Date.now())
      );
      expect(drive.isError).toBe(true);
      expect(drive.content).not.toContain("secret");
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it("tells the model the path convention when it refuses one", async () => {
    // "Outside the permitted root" alone sent llama3.1 looking for the file instead of
    // retrying with a relative path.
    const outside = path.join(path.dirname(root), `esc-${path.basename(root)}.txt`);
    await fsp.writeFile(outside, "x\n", "utf8");
    try {
      const result = await dispatchTool(
        sender,
        call("read_file", { path: `../${path.basename(outside)}` }),
        allowed,
        newBudget(Date.now())
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("relative to the project root");
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it("stamps the call id onto the result", async () => {
    // An OpenAI-compatible server rejects a tool reply whose id matches no call, and that
    // presents as the run stopping for no visible reason.
    const result = await dispatchTool(
      sender,
      call("read_file", { path: "hello.ts" }, "abc-123"),
      allowed,
      newBudget(Date.now())
    );
    expect(result.toolCallId).toBe("abc-123");
  });

  it("reads a real file through the workspace resolver", async () => {
    const result = await dispatchTool(
      sender,
      call("read_file", { path: "hello.ts" }),
      allowed,
      newBudget(Date.now())
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("greeting");
  });
});

describe("budgets end the run rather than the call", () => {
  it("throws once the tool-call ceiling is reached", async () => {
    const budget = newBudget(Date.now());
    budget.toolCalls = MAX_TOOL_CALLS;
    await expect(
      dispatchTool(sender, call("read_file", { path: "hello.ts" }), allowed, budget)
    ).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it("throws once the wall clock is spent", async () => {
    const budget = newBudget(Date.now() - 60 * 60 * 1000);
    await expect(
      dispatchTool(sender, call("read_file", { path: "hello.ts" }), allowed, budget)
    ).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it("throws once the fetch ceiling is reached, separately from the call ceiling", async () => {
    const budget = newBudget(Date.now());
    budget.fetches = MAX_FETCHES;
    await expect(
      dispatchTool(sender, call("web_fetch", { url: "https://docs.python.org/3/" }), allowed, budget)
    ).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it("counts a call even when it fails, so a loop of errors still terminates", async () => {
    const budget = newBudget(Date.now());
    await dispatchTool(sender, call("read_file", "{bad"), allowed, budget);
    expect(budget.toolCalls).toBe(1);
  });
});

describe("two steps are not two parties", () => {
  it("marks an agent proposal so the human commit channel refuses it", async () => {
    const diff = await proposeWrite(sender, "hello.ts", "changed\n", "agent");
    expect(diff.origin).toBe("agent");

    await expect(commitDiff(sender, diff.id)).rejects.toBeInstanceOf(AgentDiffError);

    // And nothing was written.
    const onDisk = await fsp.readFile(path.join(root, "hello.ts"), "utf8");
    expect(onDisk).toContain("greeting");
  });

  it("does not consume the diff when refusing it", async () => {
    /**
     * A compromised renderer racing the user to `fs:commitDiff` must not be able to *destroy*
     * pending proposals. The legitimate route stays open after a refusal.
     */
    const diff = await proposeWrite(sender, "hello.ts", "changed\n", "agent");
    await expect(commitDiff(sender, diff.id)).rejects.toBeInstanceOf(AgentDiffError);

    const batch = describeAgentDiffs(sender, [diff.id]);
    expect(batch.ids).toEqual([diff.id]);
  });

  it("still lets a person's own diff through the human channel", async () => {
    // The gate must not have made the ordinary path harder — that is the regression to fear.
    const diff = await proposeWrite(sender, "hello.ts", "by hand\n");
    expect(diff.origin).toBe("user");
    await expect(commitDiff(sender, diff.id)).resolves.toMatchObject({ path: "hello.ts" });
  });

  it("writes nothing when the approval dialog is declined", async () => {
    const diff = await proposeWrite(sender, "hello.ts", "changed\n", "agent");
    const declined = vi.fn(async () => false);

    const result = await commitAgentDiffs(sender, [diff.id], { approve: declined });

    expect(declined).toHaveBeenCalledOnce();
    expect(result.approved).toBe(false);
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toContain("greeting");
  });

  it("writes only after approval", async () => {
    const diff = await proposeWrite(sender, "hello.ts", "approved\n", "agent");
    const result = await commitAgentDiffs(sender, [diff.id], { approve: async () => true });

    expect(result.approved).toBe(true);
    expect(result.results).toEqual([{ path: "hello.ts", ok: true, reason: null }]);
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toBe("approved\n");
  });

  it("names every file in the batch before anything is written", async () => {
    await fsp.writeFile(path.join(root, "other.ts"), "x\n", "utf8");
    const a = await proposeWrite(sender, "hello.ts", "1\n", "agent");
    const b = await proposeWrite(sender, "other.ts", "2\n", "agent");

    let named: string[] = [];
    await commitAgentDiffs(sender, [a.id, b.id], {
      approve: async (batch) => {
        named = [...batch.displayPaths];
        // Nothing may have been written at the moment the user is asked.
        expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toContain("greeting");
        return true;
      },
    });

    expect(named.sort()).toEqual(["hello.ts", "other.ts"]);
  });

  it("does not ask at all when no id survives vetting", async () => {
    const approve = vi.fn(async () => true);
    const result = await commitAgentDiffs(sender, ["not-a-real-id"], { approve });
    expect(approve).not.toHaveBeenCalled();
    expect(result.approved).toBe(false);
  });

  it("refuses to describe another window's diffs", async () => {
    const other = fakeSender(2);
    __setProjectRoot(other, root);
    const diff = await proposeWrite(other, "hello.ts", "theirs\n", "agent");

    expect(describeAgentDiffs(sender, [diff.id]).ids).toEqual([]);
  });

  it("refuses a user-origin diff on the agent channel", async () => {
    // Both directions. A renderer must not be able to launder its own proposal through the
    // batch dialog either — the dialog says "proposed by the assistant".
    const diff = await proposeWrite(sender, "hello.ts", "mine\n");
    expect(describeAgentDiffs(sender, [diff.id]).ids).toEqual([]);
  });

  it("applies the rest of an approved batch when one file changed underneath", async () => {
    await fsp.writeFile(path.join(root, "other.ts"), "x\n", "utf8");
    const a = await proposeWrite(sender, "hello.ts", "1\n", "agent");
    const b = await proposeWrite(sender, "other.ts", "2\n", "agent");

    // Someone edits one of them after the proposal but before approval.
    await fsp.writeFile(path.join(root, "hello.ts"), "moved on\n", "utf8");

    const result = await commitAgentDiffs(sender, [a.id, b.id], { approve: async () => true });

    expect(result.results.find((r) => r.path === "hello.ts")?.ok).toBe(false);
    // The one the user approved and which did not change is still applied — the `saveAll`
    // lesson, and worse here because they already said yes.
    expect(result.results.find((r) => r.path === "other.ts")?.ok).toBe(true);
    expect(await fsp.readFile(path.join(root, "other.ts"), "utf8")).toBe("2\n");
  });
});

describe("propose_edit through the dispatcher", () => {
  it("marks its diff as the agent's and writes nothing", async () => {
    const result = await dispatchTool(
      sender,
      call("propose_edit", { path: "hello.ts", contents: "new\n" }),
      allowed,
      newBudget(Date.now())
    );

    expect(result.isError).toBe(false);
    expect(result.diffId).toBeDefined();
    /**
     * The instruction that survives every mode, and the claim that could not.
     *
     * "It is NOT written yet — the user must approve it" was true in Accept Edits and false in
     * Auto, where it is written moments later. The dispatcher has no mode by the time a call
     * reaches it, so the result states what is true either way and each mode's guidance says
     * what becomes of a proposal.
     *
     * "Do not propose it again" stays, because it is what stops a model rewriting its own edit
     * against a file it has not re-read.
     */
    expect(result.content).toContain("Do not propose the same change again");
    expect(result.content).not.toMatch(/must approve/i);
    expect(await fsp.readFile(path.join(root, "hello.ts"), "utf8")).toContain("greeting");

    await expect(commitDiff(sender, result.diffId as string)).rejects.toBeInstanceOf(AgentDiffError);
  });
});

describe("telemetry", () => {
  it("removes every tracing variable it claims to cover", () => {
    const env: Record<string, string | undefined> = {};
    for (const name of __TELEMETRY_VARS) env[name] = "true";

    const removed = sealTelemetry(env);

    expect(removed.sort()).toEqual([...__TELEMETRY_VARS].sort());
    // And the two flags the library actually reads are left explicitly off, not merely absent.
    expect(env["LANGSMITH_TRACING"]).toBe("false");
    expect(env["LANGCHAIN_TRACING_V2"]).toBe("false");
  });

  it("covers the legacy LANGCHAIN_ spelling as well as LANGSMITH_", () => {
    // Honouring only the modern name would leave the old one working.
    expect(__TELEMETRY_VARS).toContain("LANGCHAIN_TRACING_V2");
    expect(__TELEMETRY_VARS).toContain("LANGCHAIN_API_KEY");
  });

  it("reports nothing removed on a clean environment", () => {
    const env: Record<string, string | undefined> = {};
    expect(sealTelemetry(env)).toEqual([]);
  });
});

/**
 * Stop reaching the tool layer.
 *
 * Closing the port aborts the run's `AbortSignal`, and until now only `run_command` and the
 * provider stream watched it. A queued `read_file` or `search_project` ran to completion
 * against a run nobody was watching — the panel went idle while the disk kept working, which
 * reads as Stop not working rather than as work still finishing.
 */
describe("stopping a run reaches the tools", () => {
  it("refuses a call that was queued behind the stop", async () => {
    /**
     * The common case, and the one a per-tool check would miss.
     *
     * A turn's calls are dispatched in sequence, so pressing Stop during the third of five
     * leaves two behind it. Neither should start.
     */
    const controller = new AbortController();
    controller.abort();

    const result = await dispatchTool(
      sender,
      call("read_file", { path: "hello.ts" }),
      allowed,
      newBudget(Date.now()),
      controller.signal
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("stopped");
    // Nothing was read, so nothing of the file comes back with it.
    expect(result.content).not.toContain("greeting");
  });

  it("does not spend budget on a call it refuses", async () => {
    // A stopped run must not report having used its allowance on calls that never ran.
    const controller = new AbortController();
    controller.abort();
    const budget = newBudget(Date.now());

    await dispatchTool(sender, call("read_file", { path: "hello.ts" }), allowed, budget, controller.signal);

    expect(budget.toolCalls).toBe(0);
  });

  it("still runs normally when nothing has been stopped", async () => {
    // The guard must be on `aborted`, not on the signal merely existing — passing one is the
    // normal case for every live run.
    const controller = new AbortController();

    const result = await dispatchTool(
      sender,
      call("read_file", { path: "hello.ts" }),
      allowed,
      newBudget(Date.now()),
      controller.signal
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("greeting");
  });

  it("stops a search part-way rather than walking the whole project", async () => {
    /**
     * `searchInFiles` is seconds of I/O on a real repository, so the abort has to be visible
     * *inside* the walk and not only before it starts.
     *
     * Checked by aborting during the call and asserting the result is empty: a walk that
     * ignored the signal would find the match that is sitting there in `hello.ts`.
     */
    const { searchInFiles } = await import("../src/main/build/search.js");
    const controller = new AbortController();
    controller.abort();

    const result = await searchInFiles(sender, "greeting", { signal: controller.signal });

    expect(result.matches).toEqual([]);
    expect(result.filesSearched).toBe(0);
  });

  it("stops a search already in progress, not only one that had not started", async () => {
    /**
     * The guard inside the loop, which is the one that matters.
     *
     * A pre-aborted search is caught by the check at the top of `walk`, so aborting before the
     * call cannot tell the two apart -- mutation testing showed exactly that, with the inner
     * check deleted and the test still green.
     *
     * Every file goes in ONE directory on purpose: that is a single `walk` invocation, so the
     * top-of-walk check runs once, before the abort. Only a per-entry check can stop it
     * part-way. Aborting on the next tick lands inside the loop.
     */
    const { searchInFiles } = await import("../src/main/build/search.js");
    const many = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-many-"));
    const flat = fakeSender(4242);
    try {
      for (let i = 0; i < 400; i += 1) {
        await fsp.writeFile(path.join(many, `f${i}.ts`), "const needle = 1;\n", "utf8");
      }
      __setProjectRoot(flat, many);

      const controller = new AbortController();
      const pending = searchInFiles(flat, "needle", { signal: controller.signal });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      // Some files may have been read before the abort landed; the point is that it stopped.
      expect(result.filesSearched).toBeLessThan(400);
    } finally {
      await fsp.rm(many, { recursive: true, force: true });
    }
  }, 30_000);

  it("searches normally without an abort", async () => {
    // The other half: the guard must not break the tool it is guarding.
    const { searchInFiles } = await import("../src/main/build/search.js");
    const result = await searchInFiles(sender, "greeting", {});

    expect(result.matches.length).toBeGreaterThan(0);
  });
});
