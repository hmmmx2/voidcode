/**
 * The dashboard's derived fields.
 *
 * These exist to stop the list saying "Not solved" when the store knows you reached 3 of 4
 * cases. That is the most motivating thing the app records, and it was being discarded — so
 * the tests here are mostly about *which* attempt gets reported, since "best" and "latest"
 * disagree exactly when it matters.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const { recordSubmission } = await import("../src/main/store/submissions.js");
const { recordAssessment, saveAttempt } = await import("../src/main/store/interviews.js");
const { buildDashboard } = await import("../src/main/content/dashboard.js");

import type { Grade } from "../src/main/exec/grader.js";

/** A grade with `passed` of `total` visible cases passing. */
function grade(problemId: string, passed: number, total: number): Grade {
  return {
    problemId,
    solved: passed === total,
    outcome: "ran",
    verdicts: Array.from({ length: total }, (_, i) => ({
      id: `case-${i}`,
      label: `Case ${i}`,
      visible: true,
      passed: i < passed,
      elapsedMs: 0.1,
    })),
    stdout: "",
    measurements: {
      wallMs: 10,
      slowestCaseMs: 0.2,
      pythonPeakBytes: 1024,
      wasmHeapBytes: 0,
      wasmGrowthBytes: 0,
    },
    limits: { timeLimitMs: 200, memoryLimitMb: 64 },
  };
}

function rowFor(problemId: string) {
  return buildDashboard().problems.find((p) => p.id === problemId);
}

beforeEach(() => {
  __useInMemory();
});

describe("per-problem progress", () => {
  it("reports nothing for a problem never attempted", () => {
    const row = rowFor("sigmoid");

    expect(row?.attempt_count).toBe(0);
    // Absent, not zero. "Never run" and "ran and got 0 of 4" are different states and the
    // list renders them differently — a zeroed field would collapse them.
    expect(row?.best_passed).toBeUndefined();
    expect(row?.best_total).toBeUndefined();
  });

  it("reports the partial result of a failed attempt", () => {
    recordSubmission("code", grade("sigmoid", 2, 4));

    const row = rowFor("sigmoid");
    expect(row?.is_solved).toBe(false);
    expect(row?.best_passed).toBe(2);
    expect(row?.best_total).toBe(4);
    expect(row?.attempt_count).toBe(1);
  });

  it("keeps the best attempt, not the most recent", () => {
    // The case the whole function exists for: someone reaches 3/4, then breaks it while
    // refactoring. Showing the regression would be both discouraging and less informative —
    // they have demonstrated 3/4 and that does not stop being true.
    recordSubmission("good", grade("sigmoid", 3, 4));
    recordSubmission("worse", grade("sigmoid", 1, 4));

    const row = rowFor("sigmoid");
    expect(row?.best_passed).toBe(3);
    expect(row?.attempt_count).toBe(2);
  });

  it("counts every attempt, including solved ones", () => {
    recordSubmission("first", grade("sigmoid", 1, 4));
    recordSubmission("second", grade("sigmoid", 4, 4));

    const row = rowFor("sigmoid");
    expect(row?.is_solved).toBe(true);
    expect(row?.attempt_count).toBe(2);
    expect(row?.best_passed).toBe(4);
  });

  it("does not attribute one problem's attempts to another", () => {
    recordSubmission("code", grade("sigmoid", 2, 4));

    expect(rowFor("stable-softmax")?.attempt_count).toBe(0);
    expect(rowFor("stable-softmax")?.best_passed).toBeUndefined();
  });
});

describe("the stat strip", () => {
  it("is all zeros with nothing attempted, and offers no case rate", () => {
    const stats = buildDashboard().stats;

    expect(stats.solved).toBe(0);
    expect(stats.attempts).toBe(0);
    expect(stats.streak_days).toBe(0);
    // Absent, not 0%. "Nothing attempted" and "everything failed" are different states, and
    // a 0% on a fresh install would read as the second.
    expect(stats.case_rate).toBeUndefined();
  });

  it("counts every attempt, not every problem", () => {
    recordSubmission("a", grade("sigmoid", 1, 4));
    recordSubmission("b", grade("sigmoid", 2, 4));
    recordSubmission("c", grade("stable-softmax", 1, 3));

    expect(buildDashboard().stats.attempts).toBe(3);
  });

  it("rates cases against what was reached, not the whole catalogue", () => {
    // 2 of 4 on one problem, and nothing attempted anywhere else. The denominator is 4 —
    // dividing by every case in the catalogue would make the number meaningless early on.
    recordSubmission("code", grade("sigmoid", 2, 4));

    expect(buildDashboard().stats.case_rate).toBe(50);
  });

  it("counts a solved problem as complete", () => {
    recordSubmission("code", grade("sigmoid", 4, 4));

    expect(buildDashboard().stats.solved).toBe(1);
    expect(buildDashboard().stats.case_rate).toBe(100);
  });

  it("starts a streak the day something is solved", () => {
    recordSubmission("code", grade("sigmoid", 4, 4));

    expect(buildDashboard().stats.streak_days).toBe(1);
  });

  it("has no streak from a failed attempt alone", () => {
    // The strip counts days you *finished* something. An attempt that did not pass is
    // effort, but it is not a solve, and claiming otherwise would inflate the number.
    recordSubmission("code", grade("sigmoid", 2, 4));

    expect(buildDashboard().stats.attempts).toBe(1);
    expect(buildDashboard().stats.streak_days).toBe(0);
  });
});

describe("the activity strip", () => {
  it("always returns twelve weeks of days", () => {
    // The renderer length-checks this and falls back to zeros on a mismatch, so a short
    // array would silently render "you have only been here a week".
    expect(buildDashboard().activity).toHaveLength(84);
  });

  it("is all zeros with nothing solved", () => {
    expect(buildDashboard().activity.every((n) => n === 0)).toBe(true);
  });

  it("marks today when a problem is solved now", () => {
    recordSubmission("code", grade("sigmoid", 4, 4));

    const activity = buildDashboard().activity;
    // Last cell is today — the strip is oldest-first so the renderer draws it without
    // doing date arithmetic.
    expect(activity[activity.length - 1]).toBe(1);
    expect(activity.slice(0, -1).every((n) => n === 0)).toBe(true);
  });
});

describe("what to do next", () => {
  /**
   * `current_question` — the first unsolved problem in array order — had **no test at all**, which
   * is how the most user-visible field on the dashboard came to be the least examined. Replacing
   * it is the moment to fix that, so these cover the join rather than the ranking: `selection.ts`
   * is tested against hand-built states, and what can only go wrong here is the store being read
   * into the wrong shape.
   */
  it("suggests something on a cold start, and says why", () => {
    const next = buildDashboard().next_item;
    expect(next).not.toBeNull();
    expect(next?.why.length).toBeGreaterThan(20);
    expect(next?.reason).toBe("ready");
  });

  it("carries partial progress through from the store", () => {
    // The join that matters: `bestAttempt` is computed for the problem rows, and the recommender
    // needs the same numbers or it cannot see that anything was started.
    recordSubmission("code", grade("sigmoid", 2, 4));

    const next = buildDashboard().next_item;
    expect(next?.item_id).toBe("sigmoid");
    expect(next?.reason).toBe("finish");
    expect(next?.why).toBe("You passed 2 of 4 tests here last time.");
  });

  it("routes an interview question as a question", () => {
    /**
     * The reason `kind` is on the wire. The resume card builds its href from it, and 38 of the 52
     * things a learner can do live under `/interviews/`, not `/problems/`.
     */
    saveAttempt("why-scale-by-sqrt-dk", { selfRating: 1 });
    recordAssessment("why-scale-by-sqrt-dk", "incorrect", "qwen3:8b");

    const next = buildDashboard().next_item;
    expect(next?.item_id).toBe("why-scale-by-sqrt-dk");
    expect(next?.kind).toBe("question");
    expect(next?.order_index).toBeUndefined();
    expect(next?.description_preview.length).toBeGreaterThan(0);
  });

  it("gives a problem its catalogue position and a question none", () => {
    recordSubmission("code", grade("sigmoid", 2, 4));
    const next = buildDashboard().next_item;
    expect(next?.kind).toBe("problem");
    expect(next?.order_index).toBeGreaterThan(0);
  });

  it("reports per-concept progress alongside the overlapping category counts", () => {
    const dashboard = buildDashboard();
    expect(dashboard.concepts.length).toBeGreaterThan(0);
    // Both, not one instead of the other: they answer different questions and the header says so.
    expect(dashboard.categories.length).toBeGreaterThan(0);
    expect(dashboard.concepts.some((c) => c.ready)).toBe(true);
    expect(dashboard.concepts.every((c) => c.solid === 0)).toBe(true);
  });

  it("moves a concept to demonstrated once its problem is solved", () => {
    recordSubmission("code", grade("stable-softmax", 4, 4));
    const stability = buildDashboard().concepts.find((c) => c.id === "numerical-stability");
    expect(stability?.solid).toBe(1);
  });
});
