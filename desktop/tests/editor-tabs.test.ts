/**
 * The centre pane's tab transitions.
 *
 * Pure, so they can be asserted without mounting a workspace — the same arrangement as
 * `dock.test.ts` and `useTerminals`' own tests, and the reason `editor-tabs.ts` is a module
 * rather than a handful of closures inside `BuildWorkspace`.
 *
 * The interesting behaviour is all in closing. Opening a tab is an append; closing one has to
 * decide where you end up, and getting that wrong moves the user for pressing a button that said
 * "close".
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_TAB,
  MAX_OPEN_TABS,
  atCapacity,
  closeTab,
  openTab,
  parseCentreTab,
  renameTab,
  serializeCentreTab,
  tabLabels,
} from "@/lib/build/editor-tabs";

describe("opening", () => {
  it("appends, and showing an already-open file changes nothing", () => {
    expect(openTab([], "a.ts")).toEqual(["a.ts"]);
    expect(openTab(["a.ts"], "b.ts")).toEqual(["a.ts", "b.ts"]);
    /**
     * Appends rather than inserting beside the active tab. Inserting reorders the strip under the
     * pointer, so a second click lands on a different file from the one being aimed at.
     */
    expect(openTab(["a.ts", "b.ts"], "a.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses the seventeenth rather than evicting the oldest", () => {
    /**
     * Evicting is the other obvious answer and it is wrong: it throws away a buffer without
     * asking, which is the bug a tab list exists to prevent. `BuildWorkspace` turns this into a
     * sentence naming the cap.
     */
    const full = Array.from({ length: MAX_OPEN_TABS }, (_, i) => `f${String(i)}.ts`);
    expect(atCapacity(full)).toBe(true);
    expect(openTab(full, "one-more.ts")).toEqual(full);
    expect(atCapacity(full.slice(1))).toBe(false);
  });
});

describe("closing the tab you are looking at", () => {
  it("moves right, then left, then to Chat", () => {
    /**
     * Right first because that is where a newly opened file went, so it is the one you were most
     * likely working through. Left only when there is no right. Neither when there is no file
     * left, and the caller reads `null` as "show Chat".
     */
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ paths: ["a", "c"], active: "c" });
    expect(closeTab(["a", "b", "c"], "c", "c")).toEqual({ paths: ["a", "b"], active: "b" });
    expect(closeTab(["a"], "a", "a")).toEqual({ paths: [], active: null });
  });

  it("leaves the selection alone when you close a different tab", () => {
    // A close that also navigated would move the user for pressing "close".
    expect(closeTab(["a", "b", "c"], "a", "c")).toEqual({ paths: ["a", "b"], active: "a" });
    expect(closeTab(["a", "b", "c"], "c", "a")).toEqual({ paths: ["b", "c"], active: "c" });
  });

  it("is a no-op for a tab that is not open", () => {
    expect(closeTab(["a", "b"], "a", "zzz")).toEqual({ paths: ["a", "b"], active: "a" });
  });

  it("copies rather than mutating, so React sees a new array", () => {
    const paths = ["a", "b"];
    const result = closeTab(paths, "a", "zzz");
    expect(result.paths).not.toBe(paths);
    expect(paths).toEqual(["a", "b"]);
  });
});

describe("following a rename", () => {
  it("keeps the tab in place and the selection on it", () => {
    expect(renameTab(["a", "b", "c"], "b", "b", "b2")).toEqual({
      paths: ["a", "b2", "c"],
      active: "b2",
    });
  });

  it("does not move the selection when a different tab is renamed", () => {
    expect(renameTab(["a", "b"], "a", "b", "b2")).toEqual({ paths: ["a", "b2"], active: "a" });
  });
});

describe("what the tabs are called", () => {
  it("uses the basename", () => {
    const labels = tabLabels(["src/app.py", "README.md"]);
    expect(labels.get("src/app.py")).toBe("app.py");
    expect(labels.get("README.md")).toBe("README.md");
  });

  it("disambiguates only the names that collide", () => {
    /**
     * Two tabs both reading "index.ts" makes the strip unreadable at exactly the moment you have
     * two similar files open, which is when you are most likely comparing them. Expanding *every*
     * tab instead would widen the whole strip because one pair collided.
     */
    const labels = tabLabels(["src/index.ts", "main/index.ts", "README.md"]);
    expect(labels.get("src/index.ts")).toBe("src/index.ts");
    expect(labels.get("main/index.ts")).toBe("main/index.ts");
    expect(labels.get("README.md")).toBe("README.md");
  });

  it("shows only the immediate parent, not the whole path", () => {
    const labels = tabLabels(["a/b/c/index.ts", "x/y/z/index.ts"]);
    expect(labels.get("a/b/c/index.ts")).toBe("c/index.ts");
    expect(labels.get("x/y/z/index.ts")).toBe("z/index.ts");
  });

  it("falls back to the basename for a collision at the root", () => {
    const labels = tabLabels(["index.ts", "src/index.ts"]);
    expect(labels.get("index.ts")).toBe("index.ts");
    expect(labels.get("src/index.ts")).toBe("src/index.ts");
  });
});

describe("restoring the tab from a persisted document", () => {
  it("honours a file tab only when that file actually came back", () => {
    /**
     * The path is checked against the files that were successfully reopened, not trusted. A file
     * can be deleted between sessions, and restoring a tab whose file is gone would open the
     * window onto an error — which is the first thing the user sees.
     */
    expect(parseCentreTab("file", ["a.ts"], "a.ts")).toEqual({ kind: "file", path: "a.ts" });
    expect(parseCentreTab("file", ["a.ts"], "gone.ts")).toEqual(CHAT_TAB);
    expect(parseCentreTab("file", [], null)).toEqual(CHAT_TAB);
  });

  it("is total, like every other parser in this workspace", () => {
    // The string comes off a document this window wrote, which guarantees nothing about its
    // contents: it survives downgrades, hand-editing, and a newer build that knows more.
    for (const hostile of [
      undefined,
      null,
      42,
      "chat",
      "editor",
      "__proto__",
      "constructor",
      {},
      ["file"],
    ]) {
      expect(parseCentreTab(hostile, ["a.ts"], "a.ts"), `accepted ${String(hostile)}`).toEqual(
        CHAT_TAB
      );
    }
  });

  it("round-trips through the value it writes", () => {
    // The reader and the writer have to agree, and "file"/"chat" is the only shape either uses.
    expect(serializeCentreTab(CHAT_TAB)).toBe("chat");
    expect(serializeCentreTab({ kind: "file", path: "a.ts" })).toBe("file");
    expect(
      parseCentreTab(serializeCentreTab({ kind: "file", path: "a.ts" }), ["a.ts"], "a.ts")
    ).toEqual({ kind: "file", path: "a.ts" });
  });
});
