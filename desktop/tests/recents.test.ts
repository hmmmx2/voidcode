/**
 * Recently opened projects.
 *
 * The interesting property is not the list — it is that `openRecentProject` refuses a path it
 * has not seen. `openProjectViaDialog` takes no argument because the dialog *is* the
 * authorisation; Open Recent takes a path, so it needs its own answer, and "it must already be
 * in the table" is that answer. Without the check, the renderer could name any directory on
 * the machine and widen its own sandbox with no prompt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const { rememberProject, recentProjects, forgetProject } = await import(
  "../src/main/store/recents.js"
);
const { openRecentProject, currentProjectRoot, __setProjectRoot } = await import(
  "../src/main/workspace.js"
);

import { fakeSender } from "./stubs/sender.js";

/** One window's grant. Path resolution is per window now, so every call names one. */
const sender = fakeSender();

beforeEach(() => {
  __useInMemory();
  __setProjectRoot(sender, undefined);
});

describe("remembering", () => {
  it("keeps the folder name for display", () => {
    rememberProject("/home/alwin/projects/transformer");
    expect(recentProjects()[0]).toMatchObject({
      path: "/home/alwin/projects/transformer",
      name: "transformer",
    });
  });

  it("handles Windows separators", () => {
    // A database written on Windows and read anywhere else would otherwise show the whole
    // path as the name.
    rememberProject("C:\\Users\\alwin\\voidcode");
    expect(recentProjects()[0]?.name).toBe("voidcode");
  });

  it("moves a reopened project to the top rather than duplicating it", () => {
    rememberProject("/a");
    rememberProject("/b");
    rememberProject("/a");

    const paths = recentProjects().map((p) => p.path);
    expect(paths).toEqual(["/a", "/b"]);
  });

  it("keeps at most ten, dropping the oldest", () => {
    for (let i = 0; i < 15; i += 1) rememberProject(`/project-${i}`);

    const paths = recentProjects().map((p) => p.path);
    expect(paths).toHaveLength(10);
    expect(paths[0]).toBe("/project-14");
    // A submenu is scanned rather than searched; past ten it stops beating the folder picker.
    expect(paths).not.toContain("/project-0");
  });

  it("forgets on request, for a folder that has moved", () => {
    rememberProject("/gone");
    forgetProject("/gone");
    expect(recentProjects()).toHaveLength(0);
  });
});

describe("opening a recent project", () => {
  it("opens one the user chose before", () => {
    rememberProject("/home/alwin/known");
    expect(openRecentProject(sender, "/home/alwin/known")).toBe("/home/alwin/known");
    expect(currentProjectRoot(sender)).toBe("/home/alwin/known");
  });

  it("REFUSES a path it has never seen", () => {
    // The whole point. Without this, Open Recent is "set the project root to anything",
    // reachable from the renderer, with no dialog and no consent.
    expect(openRecentProject(sender, "/etc")).toBeUndefined();
    expect(currentProjectRoot(sender)).toBeUndefined();
  });

  it("refuses a forgotten path", () => {
    rememberProject("/was-known");
    forgetProject("/was-known");
    expect(openRecentProject(sender, "/was-known")).toBeUndefined();
  });

  it("leaves the current project untouched when it refuses", () => {
    rememberProject("/real");
    openRecentProject(sender, "/real");
    expect(openRecentProject(sender, "/../../etc")).toBeUndefined();
    // A refusal must not clear the root either — that would make a rejected click log you out
    // of the project you had open.
    expect(currentProjectRoot(sender)).toBe("/real");
  });

  it("moves the project back to the top when reopened", () => {
    rememberProject("/a");
    rememberProject("/b");
    openRecentProject(sender, "/a");
    expect(recentProjects().map((p) => p.path)).toEqual(["/a", "/b"]);
  });
});
