/**
 * The problem store's public surface.
 *
 * Pure data tests — no Pyodide, no Electron — because the properties worth checking
 * are about what the renderer can and cannot see. Grading behaviour is exercised
 * end-to-end by the smoke check, which has a real sandbox to run against.
 */
import { describe, it, expect } from "vitest";
import {
  getProblem,
  listProblems,
  toPublic,
  type Problem,
} from "../src/main/content/problems.js";

describe("the problem store", () => {
  it("returns undefined for an unknown id", () => {
    expect(getProblem("does-not-exist")).toBeUndefined();
  });

  it("is not fooled by prototype keys", () => {
    // Backed by a Map for this reason. Object indexing would return
    // `Object.prototype` for "__proto__" and a function for "toString" — the same
    // bug the IPC broker's gate 1 had, and `id` comes from the renderer.
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(getProblem(key)).toBeUndefined();
    }
  });

  it("has a reference and a template for every problem", () => {
    for (const summary of listProblems()) {
      const full = getProblem(summary.id) as Problem;
      expect(full.reference.trim().length).toBeGreaterThan(0);
      expect(full.template.trim().length).toBeGreaterThan(0);
      // The template must not be a working solution.
      expect(full.template).not.toBe(full.reference);
      expect(full.template).toContain("...");
    }
  });

  it("declares no expected outputs anywhere", () => {
    // The rule from spec §2.6, asserted structurally. A hand-written expected value
    // is a guess that looks like a fact; expectations must come from executing the
    // reference. If a future content edit adds an `expected` field, this fails.
    for (const summary of listProblems()) {
      const full = getProblem(summary.id) as Problem;
      for (const c of full.cases) {
        expect(Object.keys(c).sort()).toEqual(["args", "id", "label", "visible"]);
      }
    }
  });
});

describe("what the renderer is allowed to see", () => {
  it("never includes the reference implementation", () => {
    for (const summary of listProblems()) {
      const full = getProblem(summary.id) as Problem;
      const serialised = JSON.stringify(summary);

      // Absent from the serialised value, not merely from the type — the wire is what
      // matters, and a `reference` key surviving `toPublic` would still typecheck.
      expect(summary as unknown as Record<string, unknown>).not.toHaveProperty("reference");

      // Compare on the reference's *solution body*. Checking for "def " would flag the
      // template, which is supposed to carry the signature — the leak we care about is
      // the logic, not the shape.
      const bodyLines = full.reference
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) =>
            l.length > 0 &&
            !l.startsWith("#") &&
            !l.startsWith("import ") &&
            !l.startsWith("from ") &&
            !l.startsWith("def ")
        );

      expect(bodyLines.length).toBeGreaterThan(0); // else this test proves nothing
      for (const line of bodyLines) {
        expect(serialised).not.toContain(line);
      }
    }
  });

  it("withholds the arguments of hidden cases but admits they exist", () => {
    const sigmoid = getProblem("sigmoid") as Problem;
    const published = toPublic(sigmoid);

    const hidden = published.cases.filter((c) => !c.visible);
    expect(hidden.length).toBeGreaterThan(0);
    for (const c of hidden) {
      // A learner should know a hidden case exists — "4 tests, 3 shown" is useful —
      // without being handed the input it checks.
      expect(c.args).toBeUndefined();
      expect(c.label.length).toBeGreaterThan(0);
    }

    const visible = published.cases.filter((c) => c.visible);
    expect(visible.length).toBeGreaterThan(0);
    for (const c of visible) expect(c.args).toBeDefined();
  });

  it("keeps the case count honest", () => {
    const sigmoid = getProblem("sigmoid") as Problem;
    expect(toPublic(sigmoid).cases).toHaveLength(sigmoid.cases.length);
  });

  it("publishes the limits so the UI can show them before a run", () => {
    // §1.5: constraints belong in the runner chrome, not in prose. That requires them
    // to be data the renderer actually has.
    for (const summary of listProblems()) {
      expect(summary.timeLimitMs).toBeGreaterThan(0);
      expect(summary.memoryLimitMb).toBeGreaterThan(0);
      expect(Array.isArray(summary.allowedImports)).toBe(true);
    }
  });
});
