/**
 * Consent for Auto mode.
 *
 * Auto is the only mode that writes to disk with no per-batch dialog, so arming is the thing
 * standing between a model and someone's project. These pin the properties that make it a
 * control rather than a flag.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebContents } from "electron";

// Typed with its real parameter, so `mock.calls[0][0]` is indexable rather than a `[]` tuple.
const askApproval = vi.hoisted(() =>
  vi.fn<(request: { subject: { kind: string; projectRoot?: string } }) => Promise<boolean>>()
);
vi.mock("../src/main/agent/approval-window.js", () => ({ askApproval }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { on: () => {}, removeListener: () => {} },
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { armAuto, disarmAuto, isArmed, armedState, __resetArming } = await import(
  "../src/main/agent/arming.js"
);

/** Destroy handlers are captured so a teardown can be simulated. */
function fakeSender(id: number): WebContents & { destroy(): void } {
  const handlers: Array<() => void> = [];
  return {
    id,
    once: (event: string, cb: () => void) => {
      if (event === "destroyed") handlers.push(cb);
    },
    isDestroyed: () => false,
    destroy: () => handlers.forEach((h) => h()),
  } as unknown as WebContents & { destroy(): void };
}

beforeEach(() => {
  __resetArming();
  askApproval.mockReset();
});

describe("granting", () => {
  it("arms only when the user says yes", async () => {
    const sender = fakeSender(1);
    askApproval.mockResolvedValue(true);

    expect(await armAuto(sender, "/project")).toBe(true);
    expect(isArmed(sender, "/project")).toBe(true);
  });

  it("does not arm when the user says no", async () => {
    const sender = fakeSender(2);
    askApproval.mockResolvedValue(false);

    expect(await armAuto(sender, "/project")).toBe(false);
    expect(isArmed(sender, "/project")).toBe(false);
  });

  it("asks through the window main owns, naming the project", async () => {
    /**
     * The consent has to *say* what is being granted. Reusing the approval window is right —
     * it is the only surface main owns end to end — but reusing the diff copy would tell the
     * user they were approving a list of files.
     */
    const sender = fakeSender(3);
    askApproval.mockResolvedValue(true);

    await armAuto(sender, "/home/me/project");

    expect(askApproval).toHaveBeenCalledTimes(1);
    const request = askApproval.mock.calls[0]?.[0];
    expect(request?.subject.kind).toBe("armAuto");
    expect(request?.subject.projectRoot).toBe("/home/me/project");
  });
});

describe("scope", () => {
  it("is bound to the project, not just the window", async () => {
    /**
     * The grant named a folder. Opening a different project in the same window is a different
     * subject, and the user did not agree to it — so the arming does not carry over.
     */
    const sender = fakeSender(4);
    askApproval.mockResolvedValue(true);
    await armAuto(sender, "/project-a");

    expect(isArmed(sender, "/project-a")).toBe(true);
    expect(isArmed(sender, "/project-b")).toBe(false);
  });

  it("is bound to the window, not the application", async () => {
    const armedWindow = fakeSender(5);
    const otherWindow = fakeSender(6);
    askApproval.mockResolvedValue(true);
    await armAuto(armedWindow, "/project");

    expect(isArmed(armedWindow, "/project")).toBe(true);
    expect(isArmed(otherWindow, "/project")).toBe(false);
  });
});

describe("revoking", () => {
  it("disarms without asking", async () => {
    // Turning a capability off needs no ceremony, and a confirmation here would be a prompt
    // standing between someone and stopping something they no longer want running.
    const sender = fakeSender(7);
    askApproval.mockResolvedValue(true);
    await armAuto(sender, "/project");

    disarmAuto(sender);

    expect(isArmed(sender, "/project")).toBe(false);
    expect(askApproval).toHaveBeenCalledTimes(1);
  });

  it("forgets a window that goes away", async () => {
    /**
     * Two reasons. A `WebContents.id` is reused after the object is gone, so a stale entry
     * would arm a *different* future window. And an arming that outlived its window would be
     * a grant with nothing left to hold it.
     */
    const sender = fakeSender(8);
    askApproval.mockResolvedValue(true);
    await armAuto(sender, "/project");

    sender.destroy();

    expect(isArmed(sender, "/project")).toBe(false);
    expect(armedState(sender)).toBeNull();
  });
});

describe("what cannot arm a window", () => {
  it("has no path to armed without the approval window resolving true", async () => {
    /**
     * Asserted against the source, because the claim is about absent code.
     *
     * Every route into the map has to go through `askApproval`. An environment variable, a
     * stored preference, or a "remember this" checkbox would each be a standing grant nobody
     * remembers making — and each would be invisible to a behavioural test that only exercises
     * the routes that do exist.
     */
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "../src/main/agent/arming.ts"), "utf8");

    // The only production `armed.set` is the one after the approval resolves.
    const sets = source.match(/armed\.set\(/g) ?? [];
    expect(sets).toHaveLength(2); // one in armAuto, one in the clearly-named test seam
    expect(source).toContain("if (!approved) return false;");

    // Nothing reads the environment or the database.
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("openDatabase");
  });

  it("is never written to disk", async () => {
    // An armed state that survived a restart would be a standing grant nobody remembers
    // giving. The user would open the app tomorrow to an assistant that can already write.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "../src/main/agent/arming.ts"), "utf8");

    for (const persistence of ["writeFile", "localStorage", "INSERT INTO", "app.getPath"]) {
      expect(source).not.toContain(persistence);
    }
  });
});
