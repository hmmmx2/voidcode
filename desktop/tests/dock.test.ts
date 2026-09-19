/**
 * The dock's persisted tab, and why the parser is total.
 *
 * The value comes off `host.session.load()` — a string this window wrote, which is not a
 * guarantee about its contents. It survives downgrades, hand-editing, and a future build that
 * knows tabs this one does not.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DOCK_TAB,
  DOCK_TABS,
  parseDockTab,
} from "../renderer/src/lib/build/dock.js";

describe("the dock tab a session restores", () => {
  it("keeps a tab this build has", () => {
    for (const tab of DOCK_TABS) {
      expect(parseDockTab(tab)).toBe(tab);
    }
  });

  it("resolves a stored problems tab again, now that it has a producer", () => {
    /**
     * THE PARSER'S OWN CASE, RUNNING THE OTHER WAY. Problems was removed when the workspace
     * stopped saving — the tab was fed by a lint run on a successful save, so it had no producer
     * left and a stored "problems" fell back to Terminal. The workspace saves again and the pane
     * is back, so the same stored value now resolves. That is what a total parser buys: a
     * downgrade and an upgrade both open somewhere sensible, and neither needed code beyond the
     * list.
     */
    expect(parseDockTab("problems")).toBe("problems");
    expect(DOCK_TABS).toContain("problems");
  });

  it("falls back for a tab this build does not have", () => {
    // What a downgrade looks like: a build that shipped a Ports tab wrote it here, and this one
    // deliberately has no such pane. Opening at the default is the right answer, not an error.
    expect(parseDockTab("ports")).toBe(DEFAULT_DOCK_TAB);
    expect(parseDockTab("debug")).toBe(DEFAULT_DOCK_TAB);
    expect(parseDockTab("")).toBe(DEFAULT_DOCK_TAB);
  });

  it("falls back for anything that is not a string", () => {
    for (const value of [undefined, null, 3, {}, [], true, () => "terminal"]) {
      expect(parseDockTab(value)).toBe(DEFAULT_DOCK_TAB);
    }
  });

  it("does not accept inherited property names", () => {
    /**
     * The reason membership is tested against an array rather than an object.
     *
     * `"__proto__" in {}` and `({}).toString` are both truthy, so a lookup-table parser would
     * accept these as tab names and fail somewhere far away — a `TAB_LABELS[tab]` returning a
     * function, most likely, rendered into the strip.
     */
    for (const value of ["__proto__", "toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(parseDockTab(value), `${value} was accepted as a tab`).toBe(DEFAULT_DOCK_TAB);
    }
  });

  it("names a default that is one of the tabs", () => {
    // Guards the widening in Phase 5: adding tabs and changing the default in the same edit
    // should not be able to leave the default naming a pane that was removed.
    expect(DOCK_TABS).toContain(DEFAULT_DOCK_TAB);
  });
});
