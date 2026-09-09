/**
 * The Python half of Tier A, driven directly through Pyodide in Node.
 *
 * This does not go through `utilityProcess`, because the logic worth testing is in
 * `runtime/bootstrap.py`: the import allowlist, the ordering trick that keeps numpy's
 * own imports from tripping it, and the output normalisation the grader compares on.
 * Electron adds process plumbing, not behaviour.
 *
 * Slow by unit-test standards — Pyodide boots once, ~1.5 s, then numpy ~1.7 s.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { loadPyodide } from "pyodide";

interface RunResult {
  outcome: string;
  cases: Array<{ id: string; ok: boolean; repr?: string; error?: string; elapsedMs: number }>;
  stdout: string;
  error?: string;
  pythonPeakBytes: number;
}

let py: Awaited<ReturnType<typeof loadPyodide>>;
let bootstrap: Record<string, (...args: unknown[]) => unknown>;

const root = path.resolve(__dirname, "..");

beforeAll(async () => {
  py = await loadPyodide({
    indexURL: path.join(root, "node_modules", "pyodide"),
    packageCacheDir: path.join(root, "vendor", "pyodide-packages"),
  });
  const source = await fs.readFile(
    path.join(root, "src", "main", "exec", "runtime", "bootstrap.py"),
    "utf8"
  );
  py.runPython(source);
  bootstrap = py.pyimport("__main__") as typeof bootstrap;
  await py.loadPackage("numpy");
}, 180_000);

/** Mirror what `sandbox.ts` does: prepare, then run. */
function run(
  source: string,
  entry: string,
  cases: Array<{ id: string; args: unknown[] }>,
  allowed: string[] = ["numpy"],
  preimport: string[] = ["numpy"]
): RunResult {
  (bootstrap.prepare as (a: unknown, b: unknown) => void)(allowed, preimport);
  const raw = (bootstrap.run as (a: unknown, b: unknown, c: unknown) => unknown)(
    source,
    entry,
    cases
  ) as { toJs(o: { dict_converter: unknown }): unknown };
  return raw.toJs({ dict_converter: Object.fromEntries }) as RunResult;
}

const SIGMOID = `
import numpy as np

def sigmoid(x):
    x = np.asarray(x, dtype=float)
    return 1.0 / (1.0 + np.exp(-x))
`;

describe("a real exercise", () => {
  it("runs numpy and matches the reference values", () => {
    const result = run(SIGMOID, "sigmoid", [
      { id: "vector", args: [[0, 2, -2]] },
      { id: "scalar", args: [0] },
      { id: "matrix", args: [[[-1, 0], [1, 2]]] },
    ]);

    expect(result.outcome).toBe("ran");
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);

    // The three examples from the exercise statement.
    expect(result.cases[0]?.repr).toBe("[0.5, 0.88079708, 0.11920292]");
    expect(result.cases[1]?.repr).toBe("0.5");
    expect(result.cases[2]?.repr).toBe("[[0.26894142, 0.5], [0.73105858, 0.88079708]]");
  });

  it("measures per-case time and peak Python memory", () => {
    const result = run(SIGMOID, "sigmoid", [{ id: "a", args: [[0, 1]] }]);
    expect(result.cases[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    // A sigmoid over two elements must be far inside the exercise's 200 ms budget;
    // if this ever fails, the harness is measuring something other than the call.
    expect(result.cases[0]?.elapsedMs).toBeLessThan(200);
    expect(result.pythonPeakBytes).toBeGreaterThan(0);
  });

  it("normalises numpy output so container type does not decide correctness", () => {
    // Returning a list rather than an ndarray is not a wrong answer to "compute
    // sigmoid", and the grader must not say it is.
    const asList = run(
      `
def sigmoid(x):
    import math
    if isinstance(x, (int, float)):
        return 1.0 / (1.0 + math.exp(-x))
    return [1.0 / (1.0 + math.exp(-v)) for v in x]
`,
      "sigmoid",
      [{ id: "vector", args: [[0, 2, -2]] }],
      ["math"],
      []
    );
    expect(asList.cases[0]?.repr).toBe("[0.5, 0.88079708, 0.11920292]");
  });
});

describe("the import allowlist", () => {
  it("does not trip on numpy's own internal imports", () => {
    // The ordering trick in `prepare`. If the guard were armed before numpy warmed
    // up, numpy's private submodule imports would raise and the learner would see a
    // failure for an import they never wrote. This is the test that guards it.
    const result = run(SIGMOID, "sigmoid", [{ id: "a", args: [[0]] }]);
    expect(result.outcome).toBe("ran");
    expect(result.cases[0]?.ok).toBe(true);
  });

  it("blocks a package the exercise does not permit", () => {
    const result = run(
      `
import os

def leak():
    return os.listdir("/")
`,
      "leak",
      [{ id: "a", args: [] }],
      ["numpy"],
      ["numpy"]
    );

    expect(result.outcome).toBe("compile_or_import");
    expect(result.error).toContain("not permitted");
    // The message must name what *is* allowed, or the learner is guessing.
    expect(result.error).toContain("numpy");
  });

  it("blocks a disallowed import made lazily inside the function", () => {
    // Moving the import inside the body is the obvious way to dodge a naive
    // source-text check. The guard is at import time, so it does not care where.
    const result = run(
      `
def leak():
    import subprocess
    return 1
`,
      "leak",
      [{ id: "a", args: [] }],
      ["numpy"],
      ["numpy"]
    );

    expect(result.outcome).toBe("ran");
    expect(result.cases[0]?.ok).toBe(false);
    expect(result.cases[0]?.error).toContain("not permitted");
  });

  it("always tolerates the unavoidable stdlib", () => {
    const result = run(
      `
import math

def area(r):
    return math.pi * r * r
`,
      "area",
      [{ id: "a", args: [2] }],
      [],
      []
    );
    expect(result.outcome).toBe("ran");
    expect(result.cases[0]?.repr).toBe("12.56637061");
  });
});

describe("failure reporting", () => {
  it("distinguishes a missing entry point from a broken one", () => {
    const result = run(`def wrong_name(x): return x`, "sigmoid", [{ id: "a", args: [1] }]);
    expect(result.outcome).toBe("missing_entry");
    expect(result.error).toContain("sigmoid");
  });

  it("reports a syntax error without running any case", () => {
    const result = run(`def broken(:`, "broken", [{ id: "a", args: [1] }]);
    expect(result.outcome).toBe("compile_or_import");
    expect(result.cases).toHaveLength(0);
  });

  it("reports a per-case exception and keeps going", () => {
    const result = run(
      `
def half(x):
    return 1 / x
`,
      "half",
      [
        { id: "ok", args: [2] },
        { id: "boom", args: [0] },
        { id: "also-ok", args: [4] },
      ],
      [],
      []
    );

    expect(result.outcome).toBe("ran");
    expect(result.cases.map((c) => c.ok)).toEqual([true, false, true]);
    expect(result.cases[1]?.error).toContain("ZeroDivisionError");
  });

  it("strips our own frames from the traceback", () => {
    const result = run(`def boom(): raise ValueError("nope")`, "boom", [
      { id: "a", args: [] },
    ]);
    const tb = (result.cases[0] as { traceback?: string }).traceback ?? "";
    // A learner should see their code, not `bootstrap.run` above it.
    expect(tb).not.toContain("bootstrap.py");
  });

  it("captures stdout rather than letting print vanish", () => {
    const result = run(
      `
def noisy(x):
    print("checkpoint", x)
    return x
`,
      "noisy",
      [{ id: "a", args: [7] }],
      [],
      []
    );
    expect(result.stdout).toContain("checkpoint 7");
  });
});
