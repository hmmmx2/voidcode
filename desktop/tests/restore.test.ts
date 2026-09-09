/**
 * `restoreSession`, executed.
 *
 * `session.test.ts` proves the store round-trips; this proves the function that reads it
 * actually builds the right windows. That gap mattered: `restoreSession` runs on every launch
 * before anything else, so a throw in it means the app opens wrong or not at all — and the
 * one bug this phase shipped (a `destroyed` handler dereferencing its window) was in exactly
 * this neighbourhood and only surfaced when a human ran the app.
 *
 * `createWindow` is stubbed. Building real BrowserWindows would make this an Electron
 * integration test; what is under test is the *decisions* — which rows become windows, what
 * geometry they get, which grants are re-checked, and what happens to a row that cannot be
 * opened.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const createWindow = vi.fn();
const openRecentProject = vi.fn();
const getAllDisplays = vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  screen: { getAllDisplays: () => getAllDisplays() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../src/main/windows.js", () => ({
  createWindow: (options: unknown) => createWindow(options),
}));

vi.mock("../src/main/workspace.js", () => ({
  openRecentProject: (sender: unknown, path: string) => openRecentProject(sender, path),
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const { rememberWindow, restorableWindows } = await import("../src/main/store/session.js");
const { rememberProject } = await import("../src/main/store/recents.js");
const { restoreSession, projectFromArgv } = await import("../src/main/session/restore.js");

/** A stubbed window: only what `restoreSession` touches. */
function fakeWindow() {
  const listeners = new Map<string, () => void>();
  return {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      once: (event: string, cb: () => void) => listeners.set(event, cb),
      send: vi.fn(),
    },
    maximize: vi.fn(),
    setFullScreen: vi.fn(),
    /** Pretend the renderer finished loading, so deferred intents fire. */
    finishLoad: () => listeners.get("did-finish-load")?.(),
  };
}

beforeEach(() => {
  __useInMemory();
  createWindow.mockReset();
  createWindow.mockImplementation(() => fakeWindow());
  openRecentProject.mockReset();
  getAllDisplays.mockReturnValue([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);
});

function stored(id: string, over: Record<string, unknown> = {}) {
  rememberWindow({
    id,
    mode: "build",
    projectRoot: null,
    route: "/build",
    bounds: { x: 100, y: 100, width: 1440, height: 900 },
    maximised: false,
    fullScreen: false,
    ...over,
  } as Parameters<typeof rememberWindow>[0]);
}

describe("restoring", () => {
  it("opens nothing on a first run", () => {
    // The caller uses this to decide whether to create a fresh window instead.
    expect(restoreSession()).toBe(0);
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("reopens each remembered window with its own session id", () => {
    // Reusing the id is what lets a window reclaim its own arrangement rather than starting a
    // second row that leaks on every launch.
    stored("w1");
    stored("w2", { route: "/homepage" });

    expect(restoreSession()).toBe(2);
    expect(createWindow.mock.calls.map((c) => c[0].sessionId)).toEqual(["w1", "w2"]);
    expect(createWindow.mock.calls[1]?.[0].route).toBe("/homepage");
  });

  it("passes geometry through the clamp before the window is built", () => {
    // Clamped before construction, not after: a window created off-screen flashes there
    // first, and on some platforms cannot be moved back until it has been shown.
    stored("w1", { bounds: { x: 4000, y: 100, width: 1440, height: 900 } });

    restoreSession();
    expect(createWindow.mock.calls[0]?.[0].bounds.x).not.toBe(4000);
  });

  it("re-applies maximised and full-screen", () => {
    const window = fakeWindow();
    createWindow.mockReturnValue(window);
    stored("w1", { maximised: true, fullScreen: true });

    restoreSession();
    expect(window.maximize).toHaveBeenCalled();
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
  });
});

describe("re-granting a project", () => {
  it("goes through openRecentProject rather than assuming the grant", () => {
    // A session row is not a second, weaker source of consent. `openRecentProject` refuses
    // anything not in the recents table, which is the same rule File ▸ Open Recent follows.
    rememberProject("/home/alwin/known");
    stored("w1", { projectRoot: "/home/alwin/known" });

    restoreSession();
    expect(openRecentProject).toHaveBeenCalledWith(expect.anything(), "/home/alwin/known");
  });

  it("does NOT push the project at the renderer", () => {
    // The first version of this sent a `file.openRecent` intent on `did-finish-load`, and it
    // lost a race it cannot win: React attaches its shell-command listener in an effect that
    // runs after the page load event, so the message arrived before anything was listening.
    // The window came back with the root granted in main and an empty sidebar — and because
    // layout restore is gated on having a tree, the tabs never returned either.
    //
    // The renderer asks instead, via `fs:currentProject`, which has no ordering to get wrong.
    rememberProject("/home/alwin/known");
    stored("w1", { projectRoot: "/home/alwin/known" });
    openRecentProject.mockReturnValue("/home/alwin/known");

    const window = fakeWindow();
    createWindow.mockReturnValue(window);

    restoreSession();
    window.finishLoad();

    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("asks for nothing when the window had no project", () => {
    stored("w1", { projectRoot: null });

    restoreSession();
    expect(openRecentProject).not.toHaveBeenCalled();
  });
});

describe("a row that cannot be opened", () => {
  it("is dropped rather than retried on every launch", () => {
    // One bad row must not make the app unable to start, and must not make it fail the same
    // way tomorrow.
    stored("bad");
    stored("good");
    createWindow.mockImplementationOnce(() => {
      throw new Error("mode no longer exists");
    });

    expect(restoreSession()).toBe(1);
    expect(restorableWindows().map((w) => w.id)).toEqual(["good"]);
  });

  it("still opens the others", () => {
    stored("bad");
    stored("a");
    stored("b");
    createWindow.mockImplementationOnce(() => {
      throw new Error("nope");
    });

    expect(restoreSession()).toBe(2);
  });
});

describe("a folder named on a second instance's command line", () => {
  it("is honoured only when the user already granted it", () => {
    // `voidcode.exe C:\somewhere` from a shortcut is not the authorisation a folder dialog
    // is. Without this rule a second launch widens the sandbox with no prompt at all.
    rememberProject("/home/alwin/known");

    expect(projectFromArgv(["voidcode", "/home/alwin/known"])).toBe("/home/alwin/known");
    expect(projectFromArgv(["voidcode", "/etc"])).toBeUndefined();
  });

  it("ignores flags", () => {
    rememberProject("/home/alwin/known");
    expect(projectFromArgv(["voidcode", "--mode=study"])).toBeUndefined();
  });

  it("takes the last path, as a shell would", () => {
    rememberProject("/a");
    rememberProject("/b");
    expect(projectFromArgv(["voidcode", "/a", "/b"])).toBe("/b");
  });

  it("returns nothing for a bare launch", () => {
    rememberProject("/a");
    expect(projectFromArgv(["voidcode"])).toBeUndefined();
  });
});
