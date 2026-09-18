/**
 * The renderer's copy of the problem order, against the real one.
 *
 * `renderer/src/lib/curriculum.ts` is a hand-maintained mirror of `listProblems()`. It exists
 * because the workspace resolves `/problems/3` to a slug during its first render, and importing
 * the real catalogue would pull `problems.ts` into the renderer bundle — **including the hidden
 * test cases**, which the entire grading design depends on not shipping to the client
 * (`problems.ts` strips args, `detail.ts` omits cases, `grader.ts` withholds expected values).
 *
 * So the duplication is deliberate and the drift is the cost. Both failure modes it warns about
 * had already happened, and neither announced itself:
 *
 *   **Missing entries.** `sigmoid` and `min-max-scale` were absent, so `TOTAL_PROBLEMS` read 12,
 *   the prev/next chevrons clamped at 12, and `/problems/13` fell through `resolveProblemSlug`
 *   unchanged to hit the API with the literal string "13".
 *
 *   **Wrong order.** Entries 9 to 12 were permuted, so `/problems/9` opened Parallel Reduction
 *   while the dashboard linking there meant Broadcast Shapes. The wrong problem, opened
 *   successfully — the worst kind, because nothing looks broken.
 *
 * This is the same arrangement `agent-event-parity.test.ts` polices elsewhere: two copies that
 * have to agree, and a test that is the only thing making them.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { listProblems } = await import("../src/main/content/problems.js");
const { CURRICULUM, TOTAL_PROBLEMS, resolveProblemSlug, problemPosition, slugAtPosition } =
  await import("../renderer/src/lib/curriculum.js");

const authoritative = listProblems();

describe("the mirror matches the catalogue", () => {
  it("has the same problems in the same order", () => {
    // One assertion on the whole sequence rather than a length check plus a loop: a diff of two
    // ordered lists names the position that moved, which is what a permutation needs.
    expect(CURRICULUM.map((entry) => entry.slug)).toEqual(authoritative.map((problem) => problem.id));
  });

  it("uses the same titles", () => {
    // Displayed in the Problem List tab beside titles that come from main, so a divergence shows
    // up as the same problem under two names.
    expect(CURRICULUM.map((entry) => entry.title)).toEqual(
      authoritative.map((problem) => problem.title)
    );
  });

  it("derives the total rather than declaring one", () => {
    // `TOTAL_PROBLEMS` is what the chevrons clamp against. Typed literally, it strands whatever
    // sits past it — which is exactly how the last two became unreachable.
    expect(TOTAL_PROBLEMS).toBe(authoritative.length);
  });

  it("gives every problem a track", () => {
    // The one field that is genuinely the renderer's. A new problem copied in without one would
    // fall out of the Problem List grouping.
    for (const entry of CURRICULUM) {
      expect(["NN-CORE", "LLM-SYS", "GPU-FW"], entry.slug).toContain(entry.track);
    }
  });
});

describe("resolving a route id", () => {
  it("maps every catalogue position to the problem the dashboard means by it", () => {
    /**
     * The property that actually broke. The dashboard links `/problems/{orderIndex}` where the
     * index is `listProblems()` position, and the renderer resolves it through its own list.
     * Checked across the whole range rather than at a sample, because the drift was a
     * permutation in the middle.
     */
    authoritative.forEach((problem, index) => {
      expect(resolveProblemSlug(String(index + 1)), `position ${String(index + 1)}`).toBe(problem.id);
    });
  });

  it("round-trips a position through the slug and back", () => {
    authoritative.forEach((problem, index) => {
      expect(problemPosition(problem.id)).toBe(index + 1);
    });
  });

  it("accepts a slug directly, so a caller need not know positions at all", () => {
    // The resume card links this way. It cannot be off by one because it never counts.
    expect(resolveProblemSlug("sigmoid")).toBe("sigmoid");
    expect(resolveProblemSlug("min-max-scale")).toBe("min-max-scale");
  });

  it("passes an unknown id through rather than loading problem one", () => {
    // Surfaces as "problem not found" instead of silently opening something else — the same
    // principle the permutation violated.
    expect(resolveProblemSlug("not-a-problem")).toBe("not-a-problem");
    expect(resolveProblemSlug(String(authoritative.length + 1))).toBe(
      String(authoritative.length + 1)
    );
    expect(resolveProblemSlug("0")).toBe("0");
  });
});

describe("routes are addressed by slug", () => {
  /**
   * Position was the route id, so inserting a problem anywhere but the end renumbered every later
   * `/problems/{n}`. Stored data survived — submissions key on the problem id — but every link
   * pointed one problem along, opening the wrong problem successfully. At 150 items authored in
   * topic order, inserting in the middle is the normal case.
   *
   * These assert the property that makes insertion safe: an id addresses a problem, and a position
   * is only ever a step in an ordinal walk.
   */
  it("round-trips every position through a slug and back", () => {
    for (let position = 1; position <= CURRICULUM.length; position++) {
      const slug = slugAtPosition(position);
      expect(slug, `position ${String(position)}`).toBeDefined();
      expect(problemPosition(slug as string)).toBe(position);
    }
  });

  it("has nothing past either end", () => {
    // The chevrons rely on this: `enabled` bounds the step, and a slug for position 0 or N+1 would
    // make an out-of-range push possible if that guard were ever wrong.
    expect(slugAtPosition(0)).toBeUndefined();
    expect(slugAtPosition(-1)).toBeUndefined();
    expect(slugAtPosition(CURRICULUM.length + 1)).toBeUndefined();
  });

  it("survives an insertion in the middle, which numeric routes do not", () => {
    /**
     * The whole argument, as a test. A slug addresses the same problem before and after; a position
     * addresses a different one.
     */
    const inserted = [
      ...CURRICULUM.slice(0, 3),
      { slug: "brand-new", title: "Brand new", track: "NN-CORE" as const },
      ...CURRICULUM.slice(3),
    ];
    const target = CURRICULUM[5];
    expect(target).toBeDefined();

    const positionBefore = CURRICULUM.findIndex((e) => e.slug === target?.slug) + 1;
    const positionAfter = inserted.findIndex((e) => e.slug === target?.slug) + 1;

    // The slug still names it; the position no longer does.
    expect(positionAfter).not.toBe(positionBefore);
    expect(inserted[positionBefore - 1]?.slug).not.toBe(target?.slug);
  });

  /**
   * Whether an interpolated path segment NAMES THE PROBLEM rather than counting to it.
   *
   * AN ALLOWLIST, AND IT HAS TO BE. This began as a deny-list of position-shaped names —
   * `orderIndex`, `index +`, `position`, and a bare `n` — and two mutations walked straight past
   * it. The first was written `\bn\b` and reached the file as `\x08n\x08`, because whatever emitted it
   * resolved `\b` as an ASCII backspace instead of a regex word boundary, so that alternative had
   * never matched anything. The second was `String(CURRICULUM.indexOf(entry) + 1)`, which is a
   * position by any reasonable reading and matches none of those four names.
   *
   * A deny-list of ways to spell "a number" cannot be completed. What CAN be stated is the rule:
   * a problem route is addressed by the thing that names a problem. So an interpolation has to
   * mention a slug or an id, and anything else fails until somebody either renames the variable or
   * comes here and argues for it.
   */
  const namesTheProblem = (expression: string): boolean =>
    // "slug" anywhere, case-insensitively, so `paperSlug` counts; or an identifier that ENDS in an
    // id, so `problem.id` and `problemId` count while `orderIndex` does not.
    /slug/i.test(expression) || /(^|\.)id$|Id$/.test(expression);

  /** Every `/problems/${...}` in a renderer component, with comments stripped. */
  const interpolatedProblemLinks = (): { file: string; expression: string }[] => {
    const componentDir = path.join(root, "renderer/src/components");
    const found: { file: string; expression: string }[] = [];

    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(item.name)) continue;
        /**
         * COMMENTS STRIPPED FIRST, because this repository has already learned that a
         * source-scanning guard trips on the prose explaining the thing it bans.
         * `WorkspaceClient.tsx` says "Was the literal `/problems/${n}` in two places", which is a
         * note about a defect that was FIXED — and fixing the escape above turns that sentence
         * into a failure unless the scan reads code only.
         */
        const source = fs
          .readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*/g, "");
        for (const match of source.matchAll(/\/problems\/\$\{([^}]+)\}/g)) {
          found.push({ file: path.relative(root, full), expression: match[1] ?? "" });
        }
      }
    };
    walk(componentDir);
    return found;
  };

  it("tells a name from a count", () => {
    /**
     * The positive control, and the reason it exists is written above `namesTheProblem`: the
     * predicate this replaced had a dead alternative and a blind spot, and nothing said so for as
     * long as no component happened to use either shape.
     */
    for (const named of ["slug", "problem.slug", "entry.slug", "problem.id", "paperSlug", "problemId"]) {
      expect(namesTheProblem(named), named).toBe(true);
    }
    for (const counted of [
      "n",
      "orderIndex",
      "index + 1",
      "position",
      "String(position)",
      "CURRICULUM.indexOf(entry) + 1",
      "String(CURRICULUM.indexOf(entry) + 1)",
      "i + 1",
    ]) {
      expect(namesTheProblem(counted), counted).toBe(false);
    }
  });

  it("no renderer component links a problem by position", () => {
    /**
     * Structural, because a single reintroduced `/problems/${orderIndex}` is exactly the bug and
     * would look perfectly reasonable in review. `Workbench` still *computes* a position for the
     * chevrons — that is fine and intended — so what is banned is interpolating one into a path.
     */
    const links = interpolatedProblemLinks();

    // Vacuity: a walk that stopped finding links would pass this test for the wrong reason, which
    // is how a source-scanning guard rots without anybody noticing.
    expect(links.length, "no interpolated problem links were found at all").toBeGreaterThanOrEqual(4);

    const offenders = links
      .filter((link) => !namesTheProblem(link.expression))
      .map((link) => `${link.file}: /problems/\${${link.expression}}`);

    expect(offenders).toEqual([]);
  });
});
