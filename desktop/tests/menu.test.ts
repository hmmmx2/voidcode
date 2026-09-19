/**
 * The menu, as a pure function of the command table and what the renderer says is live.
 *
 * The property being protected: **a menu item that does nothing is not expressible.** Six of
 * them were, before the table existed — enabled, carrying accelerators, emitting intents no
 * renderer handled. The tests below are the ones that would have caught that.
 *
 * `submenuFor` is pure, so none of this needs Electron running. `Menu`, `app` and `shell` are
 * stubbed because importing `menu.ts` pulls them in.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
// Type-only, so it is erased and does not pull the module in before the electron mock.
import type { CommandId } from "../src/shared/commands.js";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  shell: { openExternal: () => {} },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
}));

const { submenuFor, EMPTY_MENU_STATE } = await import("../src/main/menu.js");
const {
  COMMAND_ACCELERATORS,
  COMMAND_IDS,
  COMMAND_LABELS,
  MENU_IDS,
  MENU_STRUCTURE,
  CHECKBOX_COMMANDS,
} = await import("../src/shared/commands.js");

/**
 * Commands main performs itself, so they are enabled with no renderer mounted.
 *
 * The Help links were here until it turned out there is no repository URL to open — no
 * `repository` field, no `homepage`, no git remote — so they are unbound and greyed rather
 * than pointing somewhere invented.
 *
 * `help.openLogs` is main-owned for a sharper reason than "main can call `shell`". Bound in
 * the renderer it would grey out whenever the renderer has not mounted or has crashed, which
 * is exactly when someone goes looking for the log. Always-enabled is the requirement; being
 * in this list is what enforces it.
 *
 * `help.openLicences` is here for the same reason plus one of its own: the directory it opens is
 * something the app is *obliged* to ship — Apache-2.0 §4(d) for its own NOTICE, MPL-2.0 §3.1 for
 * Pyodide — and an obligation that greys out is one a user cannot verify was met.
 */
const MAIN_OWNED: CommandId[] = ["file.newWindow", "help.openLogs", "help.openLicences"];

/**
 * Commands that reach the renderer as an intent but are never *bound* by it.
 *
 * `file.openRecent` is the Open Recent submenu: main builds it from its own list of folders,
 * each item carrying a path, and the renderer handles the intent when one is clicked. So the
 * id exists — the payload has to be a known command — but nothing registers it, and its
 * enablement comes from whether there are any recents rather than from the registry.
 */
const DYNAMIC: CommandId[] = ["file.openRecent"];

const stateWith = (...enabled: CommandId[]) => ({
  enabled: new Set(enabled),
  checked: new Set<CommandId>(),
});

describe("the command table", () => {
  it("gives every id a label and an accelerator entry", () => {
    for (const id of COMMAND_IDS) {
      expect(COMMAND_LABELS[id]).toBeTruthy();
      // `null` is a real value meaning "no shortcut" — what must not happen is a missing key,
      // which would read as `undefined` and render as the string "undefined" in a menu.
      expect(COMMAND_ACCELERATORS).toHaveProperty(id);
    }
  });

  it("only places real command ids in the menu structure", () => {
    const known = new Set<string>(COMMAND_IDS);
    for (const menu of MENU_IDS) {
      for (const entry of MENU_STRUCTURE[menu]) {
        if (entry === "-" || typeof entry === "object") continue;
        // A typo here would compile if the table were loosely typed, and would show as an
        // item that is greyed forever because nothing can ever bind it.
        expect(known.has(entry), `${menu} references unknown command ${entry}`).toBe(true);
      }
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length);
  });

  it("places every command in exactly one menu", () => {
    const placed = MENU_IDS.flatMap((menu) =>
      MENU_STRUCTURE[menu].filter((e): e is CommandId => typeof e === "string" && e !== "-")
    );
    expect(new Set(placed).size).toBe(placed.length);
    // An id nothing places is dead weight — it can never be invoked from the menu. The
    // dynamic ones are placed as a submenu rather than as a plain entry, so they are counted
    // separately rather than exempted silently.
    expect(new Set([...placed, ...DYNAMIC])).toEqual(new Set(COMMAND_IDS));
  });

  it("binds no accelerator that Electron roles already own", () => {
    // Undo/copy/paste and friends work today on Windows *because* Chromium handles their keys
    // natively, with no application menu. Binding them in the table would route a working
    // thing through a slower path that can break.
    const taken = Object.values(COMMAND_ACCELERATORS).filter((a): a is string => a !== null);
    for (const reserved of ["CmdOrCtrl+Z", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+X", "CmdOrCtrl+A"]) {
      expect(taken).not.toContain(reserved);
    }

    /**
     * `CmdOrCtrl+W` is the one that looks most available and is the most expensive to take.
     *
     * It belongs to the `platformClose` role in `MENU_STRUCTURE.file`, and on macOS that role is
     * registered in a real application menu, so the key is handled natively and fires before the
     * page ever sees it. Binding it to Close Editor would close the *window* — losing every other
     * open tab — while appearing to work on Windows, where there is no application menu and the
     * renderer's dispatcher gets the key.
     *
     * So `file.closeEditor` has no accelerator at all; the cross on the tab and middle-click are
     * the affordances. Asserted rather than commented, because "this shortcut is free" is exactly
     * what the next person will assume.
     */
    expect(
      taken,
      "CmdOrCtrl+W is owned by the platformClose role and closes the window on macOS"
    ).not.toContain("CmdOrCtrl+W");
  });

  it("gives every accelerator a modifier", () => {
    // The renderer's dispatcher deliberately has no is-this-a-text-input guard. That is only
    // safe while no binding is a bare key, so this is the assertion holding that up.
    for (const [id, accelerator] of Object.entries(COMMAND_ACCELERATORS)) {
      if (accelerator === null) continue;
      const modified = /CmdOrCtrl|Ctrl|Cmd|Alt|Shift|^F\d+$/.test(accelerator);
      expect(modified, `${id} has an unmodified accelerator: ${accelerator}`).toBe(true);
    }
  });
});

describe("submenuFor", () => {
  it("greys everything the renderer has not claimed", () => {
    const run = submenuFor("run", EMPTY_MENU_STATE);
    const commands = run.filter((item) => item.type !== "separator");

    expect(commands.length).toBeGreaterThan(0);
    // The honest default. A renderer that has not mounted — or has crashed — must not be
    // able to present a live menu.
    for (const item of commands) expect(item.enabled).toBe(false);
  });

  it("enables exactly what was claimed", () => {
    const run = submenuFor("run", stateWith("run.execute"));
    const byLabel = new Map(run.map((i) => [i.label, i.enabled]));

    expect(byLabel.get(COMMAND_LABELS["run.execute"])).toBe(true);
    expect(byLabel.get(COMMAND_LABELS["run.submit"])).toBe(false);
  });

  it("keeps main-owned commands enabled with no renderer at all", () => {
    const file = submenuFor("file", EMPTY_MENU_STATE);
    const newWindow = file.find((i) => i.label === COMMAND_LABELS["file.newWindow"]);
    // Creating a window is main's job; nothing in the page can do it, so it does not depend
    // on anything being mounted.
    expect(newWindow?.enabled).toBe(true);

    // A command the renderer binds only when a project is open: greyed with nothing mounted.
    const closeFolder = file.find((i) => i.label === COMMAND_LABELS["file.closeFolder"]);
    expect(closeFolder?.enabled).toBe(false);
  });

  it("never registers an accelerator, because the renderer dispatches", () => {
    for (const menu of MENU_IDS) {
      for (const item of submenuFor(menu, EMPTY_MENU_STATE)) {
        if (item.accelerator === undefined) continue;
        // Two dispatch paths that must agree is a bug waiting to happen. The label still
        // shows the shortcut, so the menu stays a discovery surface.
        expect(item.registerAccelerator, `${String(item.label)} registers its accelerator`).toBe(
          false
        );
      }
    }
  });

  it("renders panel toggles as checkboxes reflecting the panel state", () => {
    const view = submenuFor("view", {
      enabled: new Set(CHECKBOX_COMMANDS),
      checked: new Set<CommandId>(["view.togglePanel.left"]),
    });

    const left = view.find((i) => i.label === COMMAND_LABELS["view.togglePanel.left"]);
    const right = view.find((i) => i.label === COMMAND_LABELS["view.togglePanel.right"]);

    expect(left?.type).toBe("checkbox");
    expect(left?.checked).toBe(true);
    expect(right?.checked).toBe(false);
  });

  it("builds every menu without throwing", () => {
    for (const menu of MENU_IDS) {
      expect(submenuFor(menu, stateWith(...COMMAND_IDS)).length).toBeGreaterThan(0);
    }
  });

  it("enables everything the renderer claims, across all menus", () => {
    const everything = stateWith(...COMMAND_IDS);
    for (const menu of MENU_IDS) {
      for (const item of submenuFor(menu, everything)) {
        if (item.type === "separator" || item.role !== undefined) continue;
        // The version label is the one deliberately dead item.
        if (String(item.label).startsWith("Version ")) continue;
        // Open Recent is enabled by having recents, not by a claim from the renderer — and
        // this test runs against an empty database.
        if (item.submenu !== undefined) continue;
        expect(item.enabled, `${String(item.label)} stayed disabled`).toBe(true);
      }
    }
  });

  it("resolves the platform-dependent close role to something real", () => {
    const file = submenuFor("file", EMPTY_MENU_STATE);
    const roles = file.map((i) => i.role).filter(Boolean);
    expect(roles).toContain(process.platform === "darwin" ? "close" : "quit");
    // The placeholder must never reach Electron, which would silently drop an unknown role.
    expect(roles).not.toContain("platformClose");
  });

  it("shows the version rather than a placeholder role", () => {
    const help = submenuFor("help", EMPTY_MENU_STATE);
    const version = help.find((i) => String(i.label).startsWith("Version "));
    expect(version?.enabled).toBe(false);
    expect(help.map((i) => i.role)).not.toContain("version");
  });

  it("keeps main-owned commands out of the renderer's hands", () => {
    // Sanity on the fixture itself: if one of these stopped being main-owned the enablement
    // tests above would pass for the wrong reason.
    for (const id of MAIN_OWNED) expect(COMMAND_IDS).toContain(id);
  });
});

/**
 * Every menu item reaches something that runs.
 *
 * The tests above prove the *table* is coherent — ids exist, labels exist, nothing is in two
 * menus. None of them prove the other half: that a command in the menu is bound by a renderer
 * that will actually do something when it is clicked. That gap was demonstrated rather than
 * assumed — deleting the `go.account` binding left all 16 tests green while the menu item
 * became a dead click, which is precisely the class of bug the file header says is "not
 * expressible".
 *
 * Source text rather than imports, because the binding sites are `.tsx` under a different
 * tsconfig and mounting them would mean mounting Monaco. Comments are stripped first: the
 * word `go.account` appears in prose in `Workbench.tsx`, and matching that would let a
 * commented-out binding satisfy the test.
 */
describe("menu items are bound, not just declared", () => {
  const BINDING_SITES = [
    "renderer/src/components/Shell/Workbench.tsx",
    "renderer/src/lib/shell/editor-commands.ts",
  ];

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /** Ids bound as `{ id: "x.y", run: ... }` or as a `["x.y", "monaco.action"]` pair. */
  const boundIds = new Set<string>(
    BINDING_SITES.flatMap((file) => {
      const code = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
      return [
        ...code.matchAll(/\bid:\s*"([^"]+)"/g),
        ...code.matchAll(/\[\s*"([a-z]+\.[A-Za-z.]+)"\s*,\s*"/g),
      ].map((m) => m[1] as string);
    })
  );

  it("finds the binding sites at all", () => {
    // If a refactor moves these files, the test must fail loudly rather than pass on an
    // empty set — which would make every assertion below vacuous.
    expect(boundIds.size).toBeGreaterThan(20);
    expect(boundIds).toContain("view.commandPalette");
  });

  it("actually binds the commands it calls main-owned", () => {
    /**
     * `MAIN_OWNED` was an **exemption**, not a claim, and mutation testing found it: renaming the
     * `help.openLicences` key in `MAIN_ACTIONS` broke nothing, because listing an id here removes it
     * from the unbound check below without anything verifying main binds it. So a typo in a
     * `MAIN_ACTIONS` key produced a permanently dead menu item that no test could see — and dead
     * main-owned items are exactly the ones that matter, since they are the ones that stay enabled
     * when the renderer has crashed.
     *
     * Read from source rather than imported: `menu.ts` pulls in `electron`, `createWindow` and the
     * recents store, and the property is textual anyway — is there a handler under this key.
     */
    const source = stripComments(readFileSync(new URL("../src/main/menu.ts", import.meta.url), "utf8"));
    const bound = new Set([...source.matchAll(/^\s{2}"([a-z]+\.[A-Za-z]+)":/gm)].map((m) => m[1]));

    expect(bound.size, "found no MAIN_ACTIONS keys — the regex stopped matching").toBeGreaterThan(1);
    for (const id of MAIN_OWNED) expect(bound, `MAIN_ACTIONS has no ${id}`).toContain(id);
  });

  it("binds every command the menu offers", () => {
    const menuCommands = MENU_IDS.flatMap((menu) =>
      MENU_STRUCTURE[menu].filter(
        (entry): entry is CommandId => typeof entry === "string" && entry !== "-"
      )
    );

    const unbound = menuCommands.filter(
      (id) => !boundIds.has(id) && !MAIN_OWNED.includes(id) && !DYNAMIC.includes(id)
    );

    /**
     * The commands that reach no binding, each greyed rather than dead.
     *
     * `submenuFor` greys whatever the renderer has not claimed, so these show as unavailable
     * instead of doing nothing when clicked — the menu stays honest. They are listed rather
     * than tolerated so that a *new* unbound item cannot appear without someone deciding it
     * belongs here.
     *
     * - `go.toFile` — a fuzzy file finder; the picker does not exist yet.
     * - `help.documentation` / `help.reportIssue` — no URL to open. There is no `repository`
     *   field, no `homepage`, and no git remote, so these are greyed rather than pointed
     *   somewhere invented.
     *
     * `terminal.clear` used to be here, on the grounds that the terminal panel owned its buffer
     * and bound nothing globally. The dock can hold eight buffers now, so "the terminal panel"
     * stopped naming a single thing and the command had to choose one — which is a binding.
     */
    const UNBOUND_BY_DESIGN: CommandId[] = [
      "go.toFile",
      "help.documentation",
      "help.reportIssue",
    ];

    // Equality, not a subset: binding one of these has to shrink the list, or the exception
    // outlives the reason for it and starts excusing the next dead item by accident.
    // Named rather than counted, so the failure says which item does nothing.
    expect(unbound.sort()).toEqual([...UNBOUND_BY_DESIGN].sort());
  });

  it("binds the account command that took the profile out of Interview Prep", () => {
    // The regression this file gained the suite for. Account is platform-level now, so it has
    // to be reachable from the menu bar on every surface — not only where the prep rail is.
    expect(boundIds).toContain("go.account");
    expect(MENU_STRUCTURE.go).toContain("go.account");
  });
});
