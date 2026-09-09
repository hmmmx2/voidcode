/**
 * The error log, which only earns its place if it survives the thing it is reporting.
 *
 * Every assertion here is about a way a logger quietly stops working: it leaks a secret it
 * was handed, it grows without bound, it loses the last entry — the one you opened the file
 * for — or it throws while reporting and turns one failure into two with nothing left to
 * record the second.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: () => {
      throw new Error("getPath called — the test seam should have taken precedence");
    },
    getVersion: () => "0.1.0",
  },
}));

const { write, redact, describe: describeErr, logError, logFile, __setLogDir } = await import(
  "../src/main/log.js"
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "voidcode-log-"));
  __setLogDir(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  __setLogDir(undefined);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const lines = (): Array<Record<string, unknown>> =>
  readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("what reaches the file", () => {
  it("writes one parseable object per line", () => {
    logError("main", new Error("boom"));
    logError("main", new Error("again"));

    const all = lines();
    expect(all).toHaveLength(2);
    expect(all[0]?.message).toBe("Error: boom");
    expect(all[1]?.message).toBe("Error: again");
  });

  it("keeps the stack, which is the whole point", () => {
    logError("main", new Error("boom"));
    // Not just "a stack exists" — it has to name this file, or it is someone else's stack.
    expect(String(lines()[0]?.stack)).toContain("log.test.ts");
  });

  it("records which process failed, so the fix is looked for in the right half", () => {
    logError("renderer", new Error("x"));
    logError("ipc", new Error("y"), { channel: "fs:read" });

    const all = lines();
    expect(all[0]?.source).toBe("renderer");
    expect(all[1]?.source).toBe("ipc");
    expect(all[1]?.context).toMatchObject({ channel: "fs:read" });
  });

  it("timestamps every entry", () => {
    logError("main", new Error("x"));
    expect(String(lines()[0]?.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("creates the directory rather than dropping the entry", () => {
    const nested = path.join(dir, "does", "not", "exist");
    __setLogDir(nested);
    logError("main", new Error("x"));
    expect(existsSync(path.join(nested, "voidcode.log"))).toBe(true);
  });
});

describe("anything throwable, not just Error", () => {
  it("handles a thrown string", () => {
    // `throw "nope"` is legal and reaches catch blocks. Assuming `instanceof Error` is how a
    // logger comes to record `undefined` for the message that mattered.
    expect(describeErr("nope")).toEqual({ message: "nope", stack: null });
  });

  it("handles a thrown object", () => {
    expect(describeErr({ code: 7 }).message).toBe('{"code":7}');
  });

  it("handles something that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Must not throw. A reporter that throws while describing an error is the worst case.
    expect(() => describeErr(cyclic)).not.toThrow();
    expect(describeErr(cyclic).message).toBe("[object Object]");
  });

  it("names the error type, not only its message", () => {
    expect(describeErr(new TypeError("bad")).message).toBe("TypeError: bad");
  });
});

describe("secrets never reach the file", () => {
  it("redacts by key, case-insensitively and as a substring", () => {
    const out = redact({
      openaiApiKey: "sk-live-1234",
      API_KEY: "sk-live-5678",
      refresh_token: "rt-abc",
      Authorization: "Bearer xyz",
      password: "hunter2",
      model: "qwen3:8b",
    }) as Record<string, string>;

    expect(out.openaiApiKey).toBe("[redacted]");
    expect(out.API_KEY).toBe("[redacted]");
    expect(out.refresh_token).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    // The point of redacting by key: everything else survives, so the log stays useful.
    expect(out.model).toBe("qwen3:8b");
  });

  it("redacts nested, not only at the top level", () => {
    const out = redact({ provider: { config: { apiKey: "sk-live-9" } } });
    expect(JSON.stringify(out)).not.toContain("sk-live-9");
  });

  it("redacts through the real write path, not only in the helper", () => {
    // The helper being correct is worth nothing if `write` forgets to call it.
    logError("main", new Error("request failed"), { headers: { authorization: "Bearer top" } });
    expect(readFileSync(logFile(), "utf8")).not.toContain("Bearer top");
  });

  it("survives a cycle instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(JSON.stringify(redact(cyclic))).toContain("[circular]");
  });

  it("bounds depth and array length, so one entry cannot become the log", () => {
    let deep: Record<string, unknown> = { end: "leaf" };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain("[deep]");

    const wide = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as {
      items: number[];
    };
    expect(wide.items).toHaveLength(50);
  });
});

describe("the file stays bounded", () => {
  it("rotates once past the cap and keeps exactly one previous", () => {
    const file = logFile();
    // Just over 2MB, so the next write must rotate.
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1), "utf8");

    logError("main", new Error("after rotation"));

    expect(existsSync(`${file}.1`)).toBe(true);
    // The live file is fresh: it holds the new entry and not the 2MB that preceded it.
    expect(statSync(file).size).toBeLessThan(10_000);
    expect(lines()).toHaveLength(1);
    // And no third generation accumulates.
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it("does not rotate below the cap", () => {
    const file = logFile();
    writeFileSync(file, "small\n", "utf8");
    logError("main", new Error("x"));
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it("rotates before writing, so the cap holds rather than being noticed later", () => {
    const file = logFile();
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    logError("main", new Error("first past the post"));
    // After-the-fact rotation would leave this entry appended to the oversized file.
    expect(statSync(file).size).toBeLessThan(10_000);
  });
});

describe("logging never becomes the second failure", () => {
  it("swallows an unwritable directory", () => {
    // A path whose parent is a file cannot be created. On every platform this fails somewhere
    // inside mkdir/appendFile — and none of it may surface.
    const file = path.join(dir, "blocker");
    writeFileSync(file, "not a directory", "utf8");
    __setLogDir(path.join(file, "logs"));

    expect(() => logError("main", new Error("x"))).not.toThrow();
  });

  it("still reaches the console when the file cannot be written", () => {
    const file = path.join(dir, "blocker2");
    writeFileSync(file, "not a directory", "utf8");
    __setLogDir(path.join(file, "logs"));

    logError("main", new Error("visible anyway"));
    // What actually preserves this is the `catch` around the file write, not the ordering of
    // the two — moving the console line after the write changes nothing, which a mutation
    // confirmed. The property is that a disk failure costs the file and not the message.
    expect(console.error).toHaveBeenCalled();
  });

  it("writes synchronously, so a process that dies next still has the entry", () => {
    // The assertion is that the entry is readable the instant `write` returns — no flush, no
    // tick, no `await`. An async logger passes every other test in this file and still loses
    // the last line, which is the one that says why the process died.
    write({ level: "error", source: "main", message: "last words", stack: null, context: null });
    expect(readFileSync(logFile(), "utf8")).toContain("last words");
  });
});
