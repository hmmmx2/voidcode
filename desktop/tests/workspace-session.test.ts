/**
 * The document a Build window writes and reads back.
 *
 * WHY THIS FILE EXISTS RATHER THAN MORE INLINE PARSING. Every other persisted rule in this
 * workspace is a pure function with a test — `parseDockTab`, `parseWorkspaceTab`,
 * `deserializeWorkspace`, `fromLegacy` — and the one that was not was the block in
 * `BuildWorkspace`'s restore effect. Version 6 added a list of open files to it, and adding a
 * versioned field to the only branch nobody could test was the wrong place to start.
 *
 * THE RULE THIS FILE IS REALLY GUARDING is that an old document still opens. A gate that dropped
 * one would look fine in a fresh window and silently reset the arrangement of every existing one
 * — the kind of regression nobody reports, they just put it back and assume they misremembered.
 * `workspace-layout.ts` records that exact failure happening once already, when a version check
 * was written as a literal.
 */
import { describe, it, expect } from "vitest";
import {
  TABS_SINCE_VERSION,
  parseWorkspaceDocument,
  serializeWorkspaceDocument,
} from "@/lib/build/workspace-session";
import {
  GRID_SINCE_VERSION,
  WORKSPACE_LAYOUT_VERSION,
} from "@/lib/build/workspace-layout";

/** A v6 document with whatever fields a case cares about. */
const document = (fields: Record<string, unknown>): string =>
  JSON.stringify({ version: WORKSPACE_LAYOUT_VERSION, ...fields });

describe("versions", () => {
  it("refuses a document from the future rather than half-applying it", () => {
    /**
     * A newer build may describe panes or tabs this one has no surface for. Opening fresh is
     * better than opening wrong, and the check is against the constant rather than a literal:
     * `workspace-layout.ts` records what happened the one time it was hard-coded.
     */
    expect(parseWorkspaceDocument(document({}))).not.toBeNull();
    expect(
      parseWorkspaceDocument(JSON.stringify({ version: WORKSPACE_LAYOUT_VERSION + 1 }))
    ).toBeNull();
  });

  it("refuses a document with no usable version", () => {
    for (const bad of ["{}", '{"version":0}', '{"version":"6"}', "not json", "[]", "null"]) {
      expect(parseWorkspaceDocument(bad), `accepted ${bad}`).toBeNull();
    }
  });

  it("says when tabs arrived, and that it is a version this build can read", () => {
    expect(TABS_SINCE_VERSION).toBeGreaterThan(GRID_SINCE_VERSION);
    expect(WORKSPACE_LAYOUT_VERSION).toBeGreaterThanOrEqual(TABS_SINCE_VERSION);
  });
});

describe("the open files", () => {
  it("restores the strip in order from a current document", () => {
    const parsed = parseWorkspaceDocument(
      document({ open: ["a.ts", "b.ts", "c.ts"], active: "b.ts", centreTab: "file" })
    );
    expect(parsed?.openPaths).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(parsed?.active).toBe("b.ts");
    expect(parsed?.centre).toBe("file");
  });

  it("turns a version 5 document's single active file into a one-tab strip", () => {
    /**
     * THE COMPATIBILITY CASE. Version 5 windows held one file at a time and wrote only `active`.
     * Converting is not a courtesy — it *is* what those windows did, so refusing would lose a
     * file the user had open and look like the feature having broken it.
     */
    const parsed = parseWorkspaceDocument(
      JSON.stringify({ version: 5, active: "src/app.py", grid: null })
    );
    expect(parsed?.openPaths).toEqual(["src/app.py"]);
    expect(parsed?.active).toBe("src/app.py");
    // v5 predates the tab strip, so it restores to Chat — the only surface it ever had.
    expect(parsed?.centre).toBe("chat");
  });

  it("gives an old document with no active file an empty strip", () => {
    const parsed = parseWorkspaceDocument(JSON.stringify({ version: 5, grid: null }));
    expect(parsed?.openPaths).toEqual([]);
    expect(parsed?.active).toBeNull();
  });

  it("never reads a version 1 document's centre sizes as file paths", () => {
    /**
     * `centre` was taken: versions 1 to 3 use it for the centre column's *sizes*, and `fromLegacy`
     * still reads it as such. Naming the tab list `centre` would have made a v1 document restore
     * a pair of pixel widths as paths — which the string filter would then drop silently, so the
     * symptom would have been "my tabs never come back" with nothing to see.
     */
    const parsed = parseWorkspaceDocument(
      JSON.stringify({ version: 1, centre: [640, 320], panes: {}, active: "kept.ts" })
    );
    expect(parsed?.openPaths).toEqual(["kept.ts"]);
    expect(parsed?.openPaths).not.toContain(640);
    expect(parsed?.grid).not.toBeNull();
  });

  it("drops entries that are not strings, and duplicates", () => {
    const parsed = parseWorkspaceDocument(
      document({ open: ["a.ts", 42, null, "a.ts", "b.ts"], active: "a.ts" })
    );
    expect(parsed?.openPaths).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores `open` from a document too old to have written it", () => {
    /**
     * A v5 document containing an `open` key did not come from a v5 window. Reading it anyway
     * would mean trusting a field the version says does not exist, which is the whole point of
     * having a version.
     */
    const parsed = parseWorkspaceDocument(
      JSON.stringify({ version: 5, open: ["a.ts", "b.ts"], active: "c.ts", grid: null })
    );
    expect(parsed?.openPaths).toEqual(["c.ts"]);
  });
});

describe("what it writes", () => {
  it("round-trips through its own reader", () => {
    const state = serializeWorkspaceDocument({
      grid: null,
      dock: "output",
      workspace: "steps",
      openPaths: ["a.ts", "b.ts"],
      active: "b.ts",
      centre: "file",
    });
    const parsed = parseWorkspaceDocument(state);

    expect(parsed?.openPaths).toEqual(["a.ts", "b.ts"]);
    expect(parsed?.active).toBe("b.ts");
    expect(parsed?.centre).toBe("file");
    expect(parsed?.dock).toBe("output");
    expect(parsed?.workspace).toBe("steps");
  });

  it("stamps the current version, so a downgrade can recognise it", () => {
    const written = JSON.parse(
      serializeWorkspaceDocument({
        grid: null,
        dock: "terminal",
        workspace: "plan",
        openPaths: ["a.ts"],
        active: "a.ts",
        centre: "file",
      })
    ) as Record<string, unknown>;

    expect(written["version"]).toBe(WORKSPACE_LAYOUT_VERSION);
    // The field names are the format. Renaming one needs a version bump, so they are asserted.
    expect(Object.keys(written).sort()).toEqual(
      ["active", "centreTab", "dock", "grid", "open", "version", "workspace"].sort()
    );
  });

  it("omits `active` entirely when there is no open file, and reads that back as none", () => {
    /**
     * `JSON.stringify` drops an `undefined` value rather than writing `null`, so a window with
     * nothing open writes a document with no `active` key at all. That is fine and is asserted
     * rather than left implicit: the reader has to treat absent and null the same way, and a
     * future change that started writing `null` would be a format change nobody noticed.
     */
    const state = serializeWorkspaceDocument({
      grid: null,
      dock: "terminal",
      workspace: "plan",
      openPaths: [],
      active: undefined,
      centre: "chat",
    });

    expect(Object.keys(JSON.parse(state) as object)).not.toContain("active");
    expect(parseWorkspaceDocument(state)?.active).toBeNull();
    expect(parseWorkspaceDocument(state)?.openPaths).toEqual([]);
  });
});

describe("the other fields", () => {
  it("falls an unknown dock or workspace tab back to the default", () => {
    const parsed = parseWorkspaceDocument(
      document({ dock: "ports", workspace: "code", open: [] })
    );
    expect(parsed?.dock).toBe("terminal");
    expect(parsed?.workspace).toBe("plan");
  });

  it("always produces a grid, even with nothing to go on", () => {
    // The caller sets this straight into state; `null` would blank the window.
    const parsed = parseWorkspaceDocument(document({}));
    expect(parsed?.grid).toBeTruthy();
  });
});
