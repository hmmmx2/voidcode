/**
 * Notifications.
 *
 * The interesting behaviour is not "does a row round-trip" — it is the counting. A badge
 * that says 3 when there are 2 is worse than no badge, and every way of getting that wrong
 * here is silent: counting the filtered set as the total, counting already-read rows as
 * newly changed, or firing the welcome message at someone with fifty submissions behind them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const {
  createNotification,
  listNotifications,
  unreadCount,
  markRead,
  onNotificationCreated,
  seedWelcomeNotification,
} = await import("../src/main/store/notifications.js");
const { recordSubmission } = await import("../src/main/store/submissions.js");

beforeEach(() => {
  __useInMemory();
});

function make(n: number): void {
  for (let i = 0; i < n; i += 1) {
    createNotification({
      type: "submission_failed",
      title: `Attempt ${i}`,
      message: "Some cases failed.",
      referenceId: "sigmoid",
    });
  }
}

describe("creating", () => {
  it("stores what it was given and reads the timestamp back from the row", () => {
    const created = createNotification({
      type: "submission_accepted",
      title: "All tests passed",
      message: "Your submission passed all 4 test cases.",
      referenceId: "sigmoid",
    });

    expect(created.type).toBe("submission_accepted");
    expect(created.isRead).toBe(false);
    expect(created.referenceId).toBe("sigmoid");
    // Read back rather than constructed: `created_at` is a column default, so building the
    // object in JS would invent a timestamp a millisecond off from the stored one — and the
    // list is sorted by exactly that column.
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("leaves referenceId null when there is nothing to reference", () => {
    const created = createNotification({
      type: "welcome",
      title: "Welcome",
      message: "Start with a problem.",
    });
    expect(created.referenceId).toBeNull();
  });

  it("rejects a type outside the vocabulary", () => {
    expect(() =>
      createNotification({
        // Deliberately outside the CHECK constraint — a typo here would otherwise become a
        // notification the UI has no icon or copy for.
        type: "reminder" as never,
        title: "x",
        message: "y",
      })
    ).toThrow();
  });

  it("tells live listeners, which is the whole of the SSE mechanism here", () => {
    const seen: string[] = [];
    const stop = onNotificationCreated((n) => seen.push(n.title));

    createNotification({ type: "system", title: "First", message: "..." });
    expect(seen).toEqual(["First"]);

    stop();
    createNotification({ type: "system", title: "Second", message: "..." });
    // Unsubscribing has to work, or a remounted bell receives every notification twice.
    expect(seen).toEqual(["First"]);
  });

  it("still stores the row when a listener throws", () => {
    const stop = onNotificationCreated(() => {
      throw new Error("this window is gone");
    });

    expect(() =>
      createNotification({ type: "system", title: "Kept", message: "..." })
    ).not.toThrow();
    expect(unreadCount()).toBe(1);
    stop();
  });
});

describe("listing", () => {
  it("returns newest first", () => {
    createNotification({ type: "system", title: "older", message: "..." });
    createNotification({ type: "system", title: "newer", message: "..." });

    const { notifications } = listNotifications();
    expect(notifications.map((n) => n.title)).toEqual(["newer", "older"]);
  });

  it("counts the whole table as total, not the page or the filter", () => {
    make(60);
    markRead([listNotifications().notifications[0]!.id]);

    const page = listNotifications({ limit: 10 });
    expect(page.notifications).toHaveLength(10);
    // "Showing 10 of 60" is the sentence this supports. A total that shrank with the limit
    // could not say it.
    expect(page.total).toBe(60);
    expect(page.unreadCount).toBe(59);

    const unread = listNotifications({ unreadOnly: true, limit: 100 });
    expect(unread.notifications).toHaveLength(59);
    // Still the whole table, even though the query was filtered.
    expect(unread.total).toBe(60);
  });

  it("clamps the limit rather than trusting it", () => {
    make(120);
    // A bound accepted from the caller is not a bound.
    expect(listNotifications({ limit: 5_000 }).notifications).toHaveLength(100);
    expect(listNotifications({ limit: 0 }).notifications).toHaveLength(1);
  });
});

describe("marking read", () => {
  it("marks everything when given nothing", () => {
    make(3);
    expect(markRead()).toBe(3);
    expect(unreadCount()).toBe(0);
  });

  it("treats an empty list as everything, which is what the bell sends", () => {
    make(3);
    expect(markRead([])).toBe(3);
    expect(unreadCount()).toBe(0);
  });

  it("marks only the named ones", () => {
    make(3);
    const ids = listNotifications().notifications.map((n) => n.id);
    expect(markRead([ids[0]!])).toBe(1);
    expect(unreadCount()).toBe(2);
  });

  it("reports what changed, not what matched", () => {
    make(2);
    const ids = listNotifications().notifications.map((n) => n.id);
    markRead(ids);

    // Re-marking a read notification is not a change. Reporting it as one would make the
    // badge appear to update when nothing did.
    expect(markRead(ids)).toBe(0);
  });

  it("ignores an id that is not there rather than failing the batch", () => {
    make(1);
    const ids = listNotifications().notifications.map((n) => n.id);
    expect(markRead([...ids, "not-a-real-id"])).toBe(1);
  });
});

describe("first solve", () => {
  function grade(problemId: string, solved: boolean) {
    return {
      problemId,
      solved,
      outcome: "ran" as const,
      verdicts: [
        { id: "a", label: "Case 1", visible: true, passed: solved, elapsedMs: 1 },
        { id: "b", label: "Case 2", visible: false, passed: solved, elapsedMs: 1 },
      ],
      stdout: "",
      measurements: { wallMs: 5, slowestCaseMs: 1, pythonPeakBytes: 1024, wasmGrowthBytes: 0 },
      limits: { timeLimitMs: 200, memoryLimitMb: 64 },
    };
  }

  it("is true only for the run that solves it", () => {
    // Failing first: an attempt that does not pass is never a first solve.
    expect(recordSubmission("x", grade("sigmoid", false) as never).firstSolve).toBe(false);

    // The one that lands.
    expect(recordSubmission("x", grade("sigmoid", true) as never).firstSolve).toBe(true);

    // A re-solve is not a first solve. This is the whole point: without it the bell fills
    // with "Solved: …" every time someone reruns a problem they finished weeks ago.
    expect(recordSubmission("x", grade("sigmoid", true) as never).firstSolve).toBe(false);

    // And a later failure does not re-arm it, because `first_solved_at` is never cleared.
    recordSubmission("x", grade("sigmoid", false) as never);
    expect(recordSubmission("x", grade("sigmoid", true) as never).firstSolve).toBe(false);
  });

  it("is per problem", () => {
    expect(recordSubmission("x", grade("sigmoid", true) as never).firstSolve).toBe(true);
    expect(recordSubmission("x", grade("layer-norm", true) as never).firstSolve).toBe(true);
  });
});

describe("the welcome notification", () => {
  it("appears once on a genuinely empty database", () => {
    expect(seedWelcomeNotification()?.type).toBe("welcome");
    expect(seedWelcomeNotification()).toBeUndefined();
    expect(listNotifications().total).toBe(1);
  });

  it("does not greet someone who already has submissions", () => {
    // Someone upgrading from a build that predates this table: no notifications, but plenty
    // of history. Checking only for an empty notifications table would welcome them.
    openDatabase()
      .prepare(
        `INSERT INTO submissions
           (problem_id, source, solved, outcome, passed_count, total_count, slowest_ms, python_peak)
         VALUES ('sigmoid', 'x', 1, 'ran', 4, 4, 1.0, 1024)`
      )
      .run();

    expect(seedWelcomeNotification()).toBeUndefined();
    expect(listNotifications().total).toBe(0);
  });
});
