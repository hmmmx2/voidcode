/**
 * Every authored equation must actually typeset.
 *
 * This is the counterpart to `verify-curriculum`: expected outputs are derived by executing a
 * reference, so they cannot be wrong in a way nobody notices — but the equations are
 * *authored*, because a definition has nothing to derive from. That makes them the one part
 * of a problem that can be silently malformed.
 *
 * `Math.tsx` renders with `throwOnError: false`, which is right for the UI — a broken
 * expression should show as a visibly wrong equation rather than take the problem page down.
 * The cost is that a typo ships as a red fragment nobody sees until a learner does. So it is
 * checked here, where it fails loudly instead.
 */
import { describe, it, expect } from "vitest";
import katex from "katex";
import { listProblems, getProblem } from "../src/main/content/problems.js";

/** Problems deliberately without an equation, and why. */
const PROCEDURAL = new Set(["bpe-merge", "broadcast-shapes"]);

describe("authored equations", () => {
  it("parses every one in the catalogue", () => {
    for (const listed of listProblems()) {
      const math = getProblem(listed.id)?.math;
      if (math === undefined) continue;

      // `throwOnError: true` here, deliberately opposite to the renderer: this is the place
      // to find out, and a thrown error names the position in the expression.
      expect(
        () => katex.renderToString(math, { throwOnError: true, output: "htmlAndMathml" }),
        `"${listed.id}" has an equation KaTeX cannot parse`
      ).not.toThrow();
    }
  });

  it("renders something for every one, not an empty string", () => {
    // A expression that parses but produces nothing would pass the check above and show as a
    // blank panel — worse than a visible error, because it looks intentional.
    for (const listed of listProblems()) {
      const math = getProblem(listed.id)?.math;
      if (math === undefined) continue;

      const html = katex.renderToString(math, { throwOnError: false });
      expect(html.length, `"${listed.id}" rendered nothing`).toBeGreaterThan(40);
      // KaTeX marks unparseable fragments with this class when it does not throw.
      expect(html, `"${listed.id}" rendered an error fragment`).not.toContain("katex-error");
    }
  });

  it("covers every problem that has a definition", () => {
    // The two omissions are principled — BPE merging and broadcast compatibility are rules
    // you apply, not formulas — so they are named rather than left as a silent gap. Anything
    // else missing an equation is an oversight, and this is what catches it.
    const missing = listProblems()
      .map((p) => p.id)
      .filter((id) => getProblem(id)?.math === undefined && !PROCEDURAL.has(id));

    expect(missing, `no equation authored for: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the equation out of nothing it should be out of", () => {
    // `math` rides in the public projection, unlike `reference`. Worth pinning: the
    // distinction is that a definition is the question and the reference is the answer.
    for (const listed of listProblems()) {
      const full = getProblem(listed.id)!;
      if (full.math === undefined) continue;
      expect(listed.math, `"${listed.id}" lost its equation in toPublic`).toBe(full.math);
      expect(JSON.stringify(listed)).not.toContain(full.reference.slice(0, 40));
    }
  });
});
