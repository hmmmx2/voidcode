/**
 * Shape derivation.
 *
 * These matter more than most display logic: this is a rail on an exercise *about* shapes, so
 * a confidently wrong `(2, 2)` would be worse than showing nothing. Most of what follows is
 * about the cases where the honest answer is "no shape".
 */
import { describe, it, expect } from "vitest";
import { shapeOf, parameterNames, deriveShapes, derivePlot } from "../src/main/content/shapes.js";
import { getProblem, listProblems } from "../src/main/content/problems.js";
import type { Problem } from "../src/main/content/problems.js";

describe("shapeOf", () => {
  it("uses Python's 1-tuple notation for a vector", () => {
    // `(3)` is a different thing in Python — the trailing comma is what the learner sees
    // when they print `arr.shape`, so it is what the rail must show.
    expect(shapeOf([1, 2, 3])).toBe("(3,)");
  });

  it("reads a rectangular nested list as two dimensions", () => {
    expect(shapeOf([[1, 2, 3], [4, 5, 6]])).toBe("(2, 3)");
  });

  it("goes deeper than two dimensions", () => {
    expect(shapeOf([[[1], [2]], [[3], [4]]])).toBe("(2, 2, 1)");
  });

  it("stops at a ragged level rather than reporting the first row's width", () => {
    // The failure worth preventing: `(2, 2)` here would be a confident lie about data that
    // has no rectangular shape at all.
    expect(shapeOf([[1, 2], [3]])).toBe("(2,)");
  });

  it("describes an empty list as empty, not as unknown", () => {
    expect(shapeOf([])).toBe("(0,)");
  });

  it("names scalars by type", () => {
    expect(shapeOf(0)).toBe("scalar");
    expect(shapeOf(1.5)).toBe("scalar");
    expect(shapeOf(true)).toBe("bool");
    expect(shapeOf("ab")).toBe("str");
  });

  it("gives no shape for something it cannot describe", () => {
    expect(shapeOf({ a: 1 })).toBe("—");
    expect(shapeOf(null)).toBe("—");
  });
});

describe("parameterNames", () => {
  function withTemplate(template: string, entry = "f"): Problem {
    return { entry, template } as Problem;
  }

  it("reads the names the learner is handed", () => {
    expect(parameterNames(withTemplate("def f(x, y):\n    pass"))).toEqual(["x", "y"]);
  });

  it("strips annotations and defaults", () => {
    expect(
      parameterNames(withTemplate("def f(x: list, eps: float = 1e-5):\n    pass"))
    ).toEqual(["x", "eps"]);
  });

  it("handles a signature wrapped across lines", () => {
    expect(
      parameterNames(withTemplate("def f(\n    a,\n    b,\n):\n    pass"))
    ).toEqual(["a", "b"]);
  });

  it("returns nothing rather than guessing when the entry is absent", () => {
    expect(parameterNames(withTemplate("def other(x):\n    pass"))).toEqual([]);
  });

  it("ignores a no-argument signature", () => {
    expect(parameterNames(withTemplate("def f():\n    pass"))).toEqual([]);
  });
});

describe("deriveShapes against real problems", () => {
  it("labels softmax's input with the template's own name", () => {
    const problem = getProblem("stable-softmax");
    expect(problem).toBeDefined();

    const shapes = deriveShapes(problem!);
    expect(shapes?.inputs).toHaveLength(1);
    expect(shapes?.inputs[0]?.shape).toBe("(3,)");
    // Whatever the template calls it — asserting a specific name here would make this test
    // fail when the content is reworded, which is not a bug.
    expect(shapes?.inputs[0]?.name).not.toMatch(/^arg /);
  });

  it("takes its sample from a visible case", () => {
    // Hidden cases are often deliberately degenerate — softmax's `single` is a one-element
    // list — and describing the exercise from one would mislead.
    const problem = getProblem("stable-softmax")!;
    const shapes = deriveShapes(problem);
    expect(shapes?.inputs[0]?.shape).not.toBe("(1,)");
  });

  it("derives the output shape from a reference repr", () => {
    const problem = getProblem("stable-softmax")!;
    const shapes = deriveShapes(problem, "[0.09003057, 0.24472847, 0.66524096]");
    expect(shapes?.output).toBe("(3,)");
  });

  it("reads Python's spelling of literals", () => {
    const problem = getProblem("stable-softmax")!;
    // The sandbox normalises with `repr`, so lists of strings and booleans arrive in
    // Python's spelling rather than JSON's.
    expect(deriveShapes(problem, "['ab', 'ab', 'c']")?.output).toBe("(3,)");
    expect(deriveShapes(problem, "[True, False]")?.output).toBe("(2,)");
  });

  it("omits the output rather than guessing when the repr will not parse", () => {
    const problem = getProblem("stable-softmax")!;
    expect(deriveShapes(problem, "array([1, 2], dtype=float32)")?.output).toBeUndefined();
    expect(deriveShapes(problem, "")?.output).toBeUndefined();
  });

  it("plots softmax against the input that produced it", () => {
    const problem = getProblem("stable-softmax")!;
    const plot = derivePlot(problem, "[0.09003057, 0.24472847, 0.66524096]");

    expect(plot?.output).toEqual([0.09003057, 0.24472847, 0.66524096]);
    // Point-for-point with the case's own first argument, so the two axes describe the
    // same three things.
    expect(plot?.input).toHaveLength(3);
  });

  it("draws nothing for a scalar result", () => {
    // Cross-entropy returns one number. A single point is not a curve, and a card-sized
    // chart of it would be decoration pretending to be data.
    const problem = getProblem("stable-softmax")!;
    expect(derivePlot(problem, "0.28990925")).toBeUndefined();
  });

  it("draws nothing for a shape tuple", () => {
    // `[256, 256, 3]` is numerically plottable and completely meaningless as a curve. All
    // integers is the tell: every problem here that computes a real quantity returns floats.
    const problem = getProblem("stable-softmax")!;
    expect(derivePlot(problem, "[256, 256, 3]")).toBeUndefined();
  });

  it("draws nothing for indices or strings", () => {
    const problem = getProblem("stable-softmax")!;
    expect(derivePlot(problem, "[0, 1, 2, 3]")).toBeUndefined();
    expect(derivePlot(problem, "['ab', 'ab', 'c']")).toBeUndefined();
  });

  it("omits the input when it does not line up with the output", () => {
    const problem = getProblem("stable-softmax")!;
    // Softmax's sample case has three inputs; a four-point output cannot share the axis.
    const plot = derivePlot(problem, "[0.1, 0.2, 0.3, 0.4]");

    expect(plot?.output).toHaveLength(4);
    expect(plot?.input).toBeUndefined();
  });

  it("refuses a series too short or too long to read", () => {
    const problem = getProblem("stable-softmax")!;
    expect(derivePlot(problem, "[0.5]")).toBeUndefined();
    const long = `[${Array.from({ length: 65 }, (_, i) => `${i}.5`).join(", ")}]`;
    expect(derivePlot(problem, long)).toBeUndefined();
  });

  it("never throws for any problem in the catalogue", () => {
    // The plot is optional everywhere, so the only hard requirement is that deriving it is
    // safe for every problem — including the ones that return strings, booleans and shapes.
    for (const listed of listProblems()) {
      const problem = getProblem(listed.id)!;
      expect(() => derivePlot(problem, "[0.1, 0.2, 0.3]")).not.toThrow();
      expect(() => derivePlot(problem, undefined)).not.toThrow();
    }
  });

  it("derives a shape for every problem in the catalogue", () => {
    // The rail is only worth building if it is present everywhere; a surface that appears on
    // some exercises and not others reads as broken.
    for (const listed of listProblems()) {
      const problem = getProblem(listed.id)!;
      const shapes = deriveShapes(problem);
      expect(shapes, `no shapes derived for "${listed.id}"`).toBeDefined();
      expect(shapes!.inputs.length, `no inputs for "${listed.id}"`).toBeGreaterThan(0);
    }
  });
});
