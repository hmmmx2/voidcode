/**
 * Project progress is measured, and the slugs it measures against exist.
 *
 * `Milestone.done` and `Project.state` were literals: two milestones of `transformer-from-scratch`
 * said `done: true` and the project said `state: "in-progress"`, so **a fresh install with nothing
 * solved rendered "In progress — 2/4"**. The same defect as the dashboard's retired "1/12 solved",
 * and the same fix — `dashboard:get` already reports `isSolved` per problem and the milestones
 * already name the problems they need; nothing joined them.
 *
 * The empty-store case is the one that was wrong, so it is the one asserted first.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { PROJECTS, getProject, milestoneDone, projectProgress, referencedSlugs } = await import(
  "../renderer/src/lib/projects.js"
);
const { listProblems } = await import("../src/main/content/problems.js");
const { QUESTIONS } = await import("../src/main/content/interview-bank.js");

const NOTHING_SOLVED: ReadonlySet<string> = new Set();

describe("a store with nothing solved", () => {
  it("reports every project not started, with zero of its milestones done", () => {
    // The exact false claim being fixed. Before this, one project reported 2/4 and "In progress".
    for (const project of PROJECTS) {
      const { done, total, state } = projectProgress(project, NOTHING_SOLVED);
      expect(done, project.slug).toBe(0);
      expect(total, project.slug).toBe(project.milestones.length);
      expect(state, project.slug).toBe("not-started");
    }
  });

  it("marks no milestone done", () => {
    for (const project of PROJECTS) {
      for (const milestone of project.milestones) {
        expect(milestoneDone(milestone, NOTHING_SOLVED), milestone.label).toBe(false);
      }
    }
  });
});

describe("progress derived from solved problems", () => {
  const project = getProject("transformer-from-scratch");

  it("counts a milestone once every problem it teaches is solved", () => {
    expect(project).toBeDefined();
    const partly = new Set(["scaled-dot-product-attention", "layer-norm"]);

    expect(projectProgress(project!, partly)).toMatchObject({ done: 2, state: "in-progress" });

    // A milestone naming two problems needs both. Solving one of them is not progress on it, which
    // is the case an `some`-instead-of-`every` bug would get wrong in the flattering direction.
    const half = new Set([...partly, "stable-softmax"]);
    expect(projectProgress(project!, half)).toMatchObject({ done: 2, state: "in-progress" });

    const whole = new Set([...half, "cross-entropy-loss"]);
    expect(projectProgress(project!, whole)).toMatchObject({ done: 3, state: "in-progress" });
  });

  it("reports complete only when every milestone is", () => {
    const all = new Set(project!.milestones.flatMap((m) => m.teaches));
    const { done, total, state } = projectProgress(project!, all);
    expect(done).toBe(total);
    expect(state).toBe("complete");
  });

  it("does not count a milestone that teaches nothing", () => {
    /**
     * `every` on an empty array is `true`, so a milestone with no `teaches` would be vacuously
     * complete — and it would read as *finished* rather than as unauthored, which is the direction
     * this whole change exists to stop.
     */
    expect(milestoneDone({ label: "Unauthored", teaches: [] }, NOTHING_SOLVED)).toBe(false);
    expect(milestoneDone({ label: "Unauthored", teaches: [] }, new Set(["anything"]))).toBe(false);
  });
});

describe("the slugs projects depend on", () => {
  it("all exist in the catalogue", () => {
    /**
     * `Milestone.teaches` says "Must exist in the problem store" and nothing checked it. That was
     * survivable while completion was authored; now that it is *derived*, a typo makes the milestone
     * permanently unachievable and the project permanently "in progress" — silently, because a slug
     * that matches nothing simply never appears in the solved set.
     */
    const known = new Set([...listProblems().map((p) => p.id), ...QUESTIONS.map((q) => q.slug)]);
    const unknown = referencedSlugs().filter((slug) => !known.has(slug));

    expect(unknown, "milestone slugs with no problem behind them").toEqual([]);
  });

  it("finds slugs to check at all", () => {
    // Guards the two assertions above against a refactor that empties `referencedSlugs`.
    expect(referencedSlugs().length).toBeGreaterThan(4);
  });
});

describe("the data carries no authored progress", () => {
  it("has no `done` or `state` literal left", async () => {
    /**
     * Structural, because the type system already forbids it and this is about the *next* edit: the
     * fields are gone from the interfaces, so re-adding one means re-adding it to the type too, and
     * at that point a reviewer needs a reason to object. This is that reason, in the diff.
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(root, "renderer/src/lib/projects.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(/done:\s*(true|false)/);
    expect(code).not.toMatch(/state:\s*"(not-started|in-progress|complete)"/);
  });
});
