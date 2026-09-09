/**
 * Every chat request the renderer makes must reach main.
 *
 * This exists because of one specific bug, and the bug was invisible for months. The history
 * dropdown had a delete button. `api/chat.ts` exported `deleteSession`, which issued
 * `DELETE /v1/chat/sessions/{id}`. `client.ts` intercepts `app://api` and dispatches to
 * `window.host.*` through a route table — and that table had no `DELETE` entry, so the request
 * matched nothing, fell through to the 501 fallback, and the rejection went to `console.error`.
 * A user clicked, nothing happened, and no test anywhere failed.
 *
 * There are four places a chat call has to be declared, and every one of them is a separate
 * edit someone can forget:
 *
 *   1. `api/chat.ts`      — the fetch the component calls
 *   2. `client.ts`        — the route that turns it into an IPC call
 *   3. `host.d.ts`        — the method on the preload surface
 *   4. `ipc/contract.ts`  — the channel and its schema, in main
 *
 * Asserting them against each other is the only thing that makes the chain a unit. These are
 * source-text assertions rather than behavioural ones on purpose: the failure being prevented
 * is a *missing declaration*, which no amount of exercising the happy path can reveal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relative: string): string =>
  readFileSync(join(__dirname, "..", relative), "utf8");

const CLIENT = read("renderer/src/lib/api/client.ts");
const CHAT_API = read("renderer/src/lib/api/chat.ts");
const HOST_TYPES = read("renderer/src/types/host.d.ts");
const CONTRACT = read("src/main/ipc/contract.ts");
const HANDLERS = read("src/main/ipc/handlers/index.ts");

/** The `["METHOD /path", ...]` keys declared in `IPC_ROUTES`. */
function declaredRoutes(): string[] {
  return [...CLIENT.matchAll(/"(GET|POST|PUT|PATCH|DELETE) (\/v1\/[^"]*)"/g)].map(
    (m) => `${m[1]} ${m[2]}`
  );
}

/**
 * `matchIpcRoute`'s rule, reimplemented: longest matching prefix, where a route also covers
 * anything under it. Reimplemented rather than imported because the function is private, and
 * exporting internals purely for a test makes the module's surface a lie.
 */
function routeExistsFor(method: string, path: string): boolean {
  const key = `${method} ${path}`;
  return declaredRoutes().some(
    (entry) => key === entry || key.startsWith(`${entry}?`) || key.startsWith(`${entry}/`)
  );
}

describe("every chat fetch has a route", () => {
  /**
   * Method and path of each `fetch` in `api/chat.ts`.
   *
   * Template holes become `{id}`, which is a path segment for matching purposes — the route
   * table is prefix-based, so the concrete value never matters.
   */
  function chatRequests(): Array<{ method: string; path: string }> {
    const out: Array<{ method: string; path: string }> = [];
    // `fetch(`${API_BASE}/v1/...`, { method: "X" ... })`, across line breaks.
    for (const match of CHAT_API.matchAll(
      /fetch\(\s*`\$\{API_BASE\}(\/v1\/[^`]*)`\s*,?\s*(\{[\s\S]{0,400}?\})?/g
    )) {
      const path = (match[1] ?? "").replace(/\$\{[^}]+\}/g, "{id}").replace(/\?.*$/, "");
      const verb = /method:\s*"(GET|POST|PUT|PATCH|DELETE)"/.exec(match[2] ?? "");
      out.push({ method: verb?.[1] ?? "GET", path });
    }
    return out;
  }

  it("finds the requests to check, so this test cannot pass by matching nothing", () => {
    // A regex that silently stops matching turns this whole file into a no-op that reports
    // success. The count is asserted loosely — the point is "several", not an exact number.
    const requests = chatRequests();
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  it("has an IPC route for every one of them", () => {
    const orphans = chatRequests().filter((r) => !routeExistsFor(r.method, r.path));
    // The exact failure that shipped: `DELETE /v1/chat/sessions/{id}` with no entry.
    expect(orphans).toEqual([]);
  });
});

describe("the four declarations agree", () => {
  const CHANNELS = ["deleteSession", "searchSessions"] as const;

  it.each(CHANNELS)("%s is declared on the host surface", (name) => {
    expect(HOST_TYPES).toContain(`${name}(input:`);
  });

  it.each(CHANNELS)("%s has a contract channel", (name) => {
    expect(CONTRACT).toContain(`"chat:${name}"`);
  });

  it.each(CHANNELS)("%s has a handler", (name) => {
    expect(HANDLERS).toContain(`setHandler("chat:${name}"`);
  });

  it("routes DELETE to the delete channel and not to the list handler", () => {
    /**
     * The matcher is longest-prefix over `${method} ${path}`, so `DELETE` cannot be confused
     * with the existing `GET`/`POST` entries — but a bare `DELETE /v1/chat/sessions` with no
     * id must not be allowed to fall through and delete something. It answers 400.
     */
    expect(routeExistsFor("DELETE", "/v1/chat/sessions/abc")).toBe(true);
    expect(CLIENT).toContain("A session id is required");
  });
});

describe("Run carries a problem to run against", () => {
  /**
   * The Run button never worked on the desktop, and nothing failed.
   *
   * `executeCode` kept the web's Judge0 signature — source, language, stdin, no problem —
   * because on FastAPI plus Judge0 the endpoint ran code in a sandbox that knew nothing about
   * problems. On the desktop the same path is `exec:run`, which grades in main and needs to
   * know what to grade against. The seam substituted an empty string, the channel's `min(1)`
   * rejected it, and every Run came back `Invalid payload for exec:run`.
   *
   * Submit was fixed at some point and Run was not, which is why one worked and the other did
   * not. Source assertions, because the failure is a *missing field*: everything compiled and
   * every layer behaved correctly on the value it was handed.
   */
  const code = (relative: string): string =>
    readFileSync(join(__dirname, "..", relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  /**
   * The text of one declaration, from its name to the next blank-line-separated block.
   *
   * Scoped rather than whole-file, and that is the whole point: the first version of these
   * assertions searched all of `judge0.ts` for `problem_id: payload.problemId` — which
   * `submitCode` has always contained. Deleting it from `executeCode` left every assertion
   * green. A test that cannot say *which* function it is looking at is not testing the one
   * that was broken.
   */
  const declaration = (source: string, name: string): string => {
    const at = source.indexOf(name);
    if (at < 0) return "";
    const next = source.indexOf("\nexport ", at + name.length);
    return source.slice(at, next < 0 ? source.length : next);
  };

  it("sends a problem id from executeCode, which is the one that lacked it", () => {
    const run = declaration(code("renderer/src/lib/api/grading.ts"), "async function executeCode");
    expect(run).not.toBe("");
    // Required, not optional: a Run with nothing to run against is not a Run here.
    expect(run).toContain("problemId: string;");
    expect(run).toContain("problem_id: payload.problemId");
    // And it is genuinely `executeCode` being read, not the next function along.
    expect(run).not.toContain("function submitCode");
  });

  it("refuses an empty id rather than forwarding one the channel will reject", () => {
    /**
     * `problemId: b.problem_id ?? ""` is what turned a missing field into an invalid payload,
     * and the user was shown the channel's name for it. The seam answers 400 with a sentence.
     *
     * Asserted on the condition, not just on the message: a message that is never reached
     * because the branch was disabled is a string in a file, not a guard.
     */
    const client = code("renderer/src/lib/api/client.ts");
    expect(client).not.toContain('problemId: b.problem_id ?? ""');
    expect(client).toMatch(
      /if \(b\.problem_id === undefined \|\| b\.problem_id === ""\)/
    );
    expect(client).toContain("Running needs a problem to run against.");
  });

  it("guards in the component too, so the failure is named before it is sent", () => {
    // The same guard `performSubmit` has. An error state rather than a silent return: a Run
    // that does nothing and says nothing looks identical to one still thinking.
    const workspace = code("renderer/src/components/Layout/WorkspaceClient.tsx");
    expect(workspace).toContain("problemId: problem.id");
    expect(workspace).toContain("Open a problem before running");
  });

  it("keeps exec:run strict, so the id cannot go back to being optional", () => {
    /**
     * The schema is what caught this in the first place. Loosening it to accept an empty
     * string would make Run "succeed" by grading against nothing.
     *
     * Scoped to the channel: `z.string().min(1).max(128)` appears throughout the contract, so
     * a whole-file search is satisfied by any other channel that happens to use it.
     */
    const contract = code("src/main/ipc/contract.ts");
    const at = contract.indexOf('"exec:run"');
    expect(at).toBeGreaterThan(-1);
    const block = contract.slice(at, contract.indexOf("modes:", at));
    expect(block).toContain("problemId: z.string().min(1).max(128)");
  });
});

describe("Run shows what the code produced", () => {
  /**
   * "I pressed Run and there is no output" — and the panel was right, there was none.
   *
   * The execute response was shaped to imitate Judge0, which could only report a process's
   * stdout and stderr. `exec:run` does not run a process and hope: it invokes the function on
   * every case and compares the result, so `grade.verdicts` already holds what the code
   * returned and what it should have. The seam dropped them on the floor.
   *
   * A correct solution defines a function and prints nothing, so stdout was empty and the tab
   * said "No output produced" — which reads as Run having done nothing at all.
   */
  const scoped = (relative: string, name: string): string => {
    const source = readFileSync(join(__dirname, "..", relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const at = source.indexOf(name);
    if (at < 0) return "";
    const next = source.indexOf("\nexport ", at + name.length);
    return source.slice(at, next < 0 ? source.length : next);
  };

  it("carries the visible verdicts through the seam", () => {
    const client = readFileSync(join(__dirname, "../renderer/src/lib/api/client.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(client).toContain("cases: grade.verdicts");
    // Visible only. A hidden case's expected value is deliberately absent from its verdict,
    // and surfacing hidden cases here is what Submit is for.
    expect(client).toContain("verdict.visible");
    expect(client).toContain("actual: verdict.actual");
  });

  it("parses them on the way in", () => {
    const parse = scoped("renderer/src/lib/api/grading.ts", "function parseExecutionResult");
    expect(parse).toContain("cases:");
    expect(parse).toContain("actual: (c.actual");
  });

  it("renders them, so a silent solution is not a blank panel", () => {
    /**
     * The assertion that would have caught the original report. Rendering only `stdout` is
     * exactly what produced "No output produced" for a correct answer.
     */
    const console_ = readFileSync(
      join(__dirname, "../renderer/src/components/Editor/TestConsole.tsx"),
      "utf8"
    );
    expect(console_).toContain("executionState.result.cases.length > 0");
    expect(console_).toContain("Returned");
    // Expected is shown only on a failure — on a pass it is the same string twice.
    expect(console_).toContain("!testCase.passed && testCase.expected !== null");
  });

  it("describes Run by what it does now", () => {
    // The empty state promised "the first visible case". The grader evaluates all of them,
    // and the panel now shows all of them, so the copy says so.
    const console_ = readFileSync(
      join(__dirname, "../renderer/src/components/Editor/TestConsole.tsx"),
      "utf8"
    );
    expect(console_).toContain("evaluates every visible");
    expect(console_).not.toContain("executes the first");
  });
});

describe("each surface names itself", () => {
  /**
   * The column only separates the two histories if both panels actually set it, and a default
   * of 'tutor' means the Build assistant is the one that fails silently — its conversations
   * would be filed as the tutor's and appear in the wrong list, with nothing throwing.
   *
   * Source assertions, because the failure is a *missing argument*: every call still compiles,
   * every query still runs, and the only symptom is a row with the wrong value in it.
   */
  const code = (relative: string): string =>
    readFileSync(join(__dirname, "..", relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("has the tutor create and search as the tutor", () => {
    const panel = code("renderer/src/components/VoidCodeAI/VoidCodeAIPanel.tsx");
    expect(panel).toContain('surface: "tutor"');
    expect(panel).toContain('searchSessions(query, 50, userId, "tutor")');
    expect(panel).not.toContain('surface: "assistant"');
  });

  it("has the Build assistant create and search as the assistant", () => {
    const panel = code("renderer/src/components/Build/AssistantPanel.tsx");
    expect(panel).toContain('surface: "assistant"');
    expect(panel).toContain('surface: "assistant" }');
    expect(panel).not.toContain('surface: "tutor"');
  });

  it("carries the surface at every hop between them", () => {
    // Five files, and a gap in any one silently reverts to "both".
    expect(code("renderer/src/lib/api/chat.ts")).toContain("surface?: ChatSurface");
    expect(code("renderer/src/lib/api/client.ts")).toContain('surface === "tutor" || surface === "assistant"');
    expect(code("renderer/src/types/host.d.ts")).toContain('surface?: "tutor" | "assistant"');
    expect(code("src/main/ipc/contract.ts")).toContain('surface: z.enum(["tutor", "assistant"])');
    expect(code("src/main/ipc/handlers/index.ts")).toContain("input.surface");
  });
});

describe("the agent run carries its conversation", () => {
  it("declares sessionId at every hop", () => {
    // Four files again: the panel sends it, the stream helper passes it, the preload type
    // admits it, and main's schema accepts it. A gap anywhere means runs silently unlinked.
    expect(read("renderer/src/lib/build/agent-stream.ts")).toContain("sessionId");
    expect(HOST_TYPES).toContain("sessionId?: string | null;");
    expect(CONTRACT).toContain("sessionId: z.string().uuid().nullable().optional()");
    expect(read("src/main/agent/stream.ts")).toContain("sessionId: options.sessionId ?? null");
  });
});
