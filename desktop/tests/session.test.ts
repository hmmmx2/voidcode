/**
 * Session restoration.
 *
 * Two things carry the weight here, and neither is the round trip.
 *
 * **`restorable` semantics.** The distinction between "the user closed this window" and "the
 * app stopped" is the entire design, and it is what lets a crash bring everything back while
 * a deliberate close stays closed — with no "was the last exit clean?" heuristic, which is
 * precisely the heuristic that gets it wrong after a crash.
 *
 * **`clampToDisplays`.** Undock a laptop, reopen the app, and a stored x=2400 puts the window
 * somewhere unreachable. It has focus, it takes keystrokes, and none of it is visible — which
 * reads to a user as a crash. It is pure and takes the display list, so it can be tested
 * without a screen.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const {
  rememberWindow,
  forgetWindow,
  restorableWindows,
  saveWorkspaceState,
  loadWorkspaceState,
  dropWindow,
  clampToDisplays,
} = await import("../src/main/store/session.js");

// A separate `import type`: a type cannot be pulled out of a runtime destructuring.
import type { SessionWindow } from "../src/main/store/session.js";

const BOUNDS = { x: 100, y: 100, width: 1440, height: 900 };

function win(id: string, over: Partial<SessionWindow> = {}): SessionWindow {
  return {
    id,
    mode: "build",
    projectRoot: `/home/alwin/${id}`,
    route: "/build",
    bounds: BOUNDS,
    maximised: false,
    fullScreen: false,
    ...over,
  };
}

beforeEach(() => __useInMemory());

describe("remembering a window", () => {
  it("round-trips everything main knows", () => {
    rememberWindow(win("w1", { maximised: true, route: "/problems/1" }));

    expect(restorableWindows()).toEqual([
      {
        id: "w1",
        mode: "build",
        projectRoot: "/home/alwin/w1",
        route: "/problems/1",
        bounds: BOUNDS,
        maximised: true,
        fullScreen: false,
      },
    ]);
  });

  it("updates in place rather than duplicating", () => {
    rememberWindow(win("w1"));
    rememberWindow(win("w1", { bounds: { x: 0, y: 0, width: 1000, height: 700 } }));

    const windows = restorableWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.bounds.width).toBe(1000);
  });

  it("keeps a window with no project open", () => {
    rememberWindow(win("w1", { projectRoot: null }));
    expect(restorableWindows()[0]?.projectRoot).toBeNull();
  });

  it("restores oldest first, so windows stack in creation order", () => {
    rememberWindow(win("w1"));
    rememberWindow(win("w2"));
    rememberWindow(win("w3"));
    // Touching w1 must not move it: `updated_seq` orders by last write, and the ordering
    // that matters is the one the user sees on screen.
    rememberWindow(win("w1"));

    expect(restorableWindows().map((w) => w.id)).toEqual(["w2", "w3", "w1"]);
  });
});

describe("restorable", () => {
  it("brings everything back when the app simply stopped", () => {
    // A crash writes no marker. Every row is still restorable, which is exactly right: the
    // user did not ask for any of these to go away.
    rememberWindow(win("w1"));
    rememberWindow(win("w2"));

    expect(restorableWindows().map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("keeps a deliberately closed window closed", () => {
    rememberWindow(win("w1"));
    rememberWindow(win("w2"));

    forgetWindow("w1");
    expect(restorableWindows().map((w) => w.id)).toEqual(["w2"]);
  });

  it("does not delete the row, so what it had is still inspectable", () => {
    rememberWindow(win("w1"));
    saveWorkspaceState("w1", { version: 1 });
    forgetWindow("w1");

    expect(loadWorkspaceState("w1")).toEqual({ version: 1 });
  });

  it("makes a closed window restorable again if it is reused", () => {
    rememberWindow(win("w1"));
    forgetWindow("w1");
    rememberWindow(win("w1"));

    expect(restorableWindows().map((w) => w.id)).toEqual(["w1"]);
  });
});

describe("workspace state", () => {
  it("round-trips an opaque document", () => {
    rememberWindow(win("w1"));
    const state = { version: 1, layout: { groups: [{ id: "g1", tabs: ["a.py"] }] } };
    saveWorkspaceState("w1", state);

    expect(loadWorkspaceState("w1")).toEqual(state);
  });

  it("overwrites rather than accumulating", () => {
    rememberWindow(win("w1"));
    saveWorkspaceState("w1", { version: 1, n: 1 });
    saveWorkspaceState("w1", { version: 1, n: 2 });

    expect(loadWorkspaceState("w1")).toEqual({ version: 1, n: 2 });
  });

  it("returns undefined for a window that never saved one", () => {
    rememberWindow(win("w1"));
    expect(loadWorkspaceState("w1")).toBeUndefined();
  });

  it("goes with the window when it is dropped", () => {
    rememberWindow(win("w1"));
    saveWorkspaceState("w1", { version: 1 });

    dropWindow("w1");
    expect(loadWorkspaceState("w1")).toBeUndefined();
    expect(restorableWindows()).toEqual([]);
  });
});

describe("keeping a restored window reachable", () => {
  const laptop = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const external = { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };

  it("leaves a window that is on a display alone", () => {
    const bounds = { x: 200, y: 150, width: 1440, height: 900 };
    expect(clampToDisplays(bounds, [laptop])).toEqual(bounds);
  });

  it("leaves a window on the second display alone while it exists", () => {
    const bounds = { x: 2400, y: 100, width: 1440, height: 900 };
    expect(clampToDisplays(bounds, [laptop, external])).toEqual(bounds);
  });

  it("recentres a window whose display has gone", () => {
    // THE UNDOCKED LAPTOP. Without this the window exists, has focus, takes keystrokes, and
    // is nowhere on screen — which reads to the user as a crash.
    const bounds = { x: 2400, y: 100, width: 1440, height: 900 };
    const clamped = clampToDisplays(bounds, [laptop]);

    expect(clamped).toEqual({ x: 240, y: 90, width: 1440, height: 900 });
  });

  it("allows a window that deliberately hangs off an edge", () => {
    // Full containment is the wrong test — arranging a window half off the right edge is a
    // normal thing to have done on purpose.
    const bounds = { x: 1700, y: 100, width: 1440, height: 900 };
    expect(clampToDisplays(bounds, [laptop])).toEqual(bounds);
  });

  it("rescues a window that is only just off-screen", () => {
    // Twenty pixels of overlap is not something you can grab.
    const bounds = { x: 1900, y: 100, width: 1440, height: 900 };
    expect(clampToDisplays(bounds, [laptop]).x).not.toBe(1900);
  });

  it("enforces a minimum size", () => {
    const clamped = clampToDisplays({ x: 0, y: 0, width: 100, height: 50 }, [laptop]);
    expect(clamped.width).toBeGreaterThanOrEqual(900);
    expect(clamped.height).toBeGreaterThanOrEqual(600);
  });

  it("shrinks a window bigger than the only display left", () => {
    const clamped = clampToDisplays({ x: 5000, y: 0, width: 3000, height: 2000 }, [laptop]);
    expect(clamped.width).toBeLessThanOrEqual(1920);
    expect(clamped.height).toBeLessThanOrEqual(1080);
  });

  it("survives having no displays at all", () => {
    // `screen` can report nothing during a display change. Returning something is better than
    // throwing on the launch path.
    expect(clampToDisplays(BOUNDS, [])).toMatchObject({ x: 0, y: 0 });
  });
});

describe("a row that cannot be read", () => {
  it("is skipped rather than aborting the whole restore", async () => {
    // One corrupt window must not cost the user the other two.
    rememberWindow(win("w1"));
    rememberWindow(win("w2"));
    const { openDatabase } = await import("../src/main/store/db.js");
    openDatabase().prepare("UPDATE windows SET bounds = 'not json' WHERE id = ?").run("w1");

    expect(restorableWindows().map((w) => w.id)).toEqual(["w2"]);
  });
});
