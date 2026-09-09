/**
 * Application menus, built from the shared command table.
 *
 * The window is frameless, so on Windows and Linux there is no OS menu bar to hang these on —
 * the renderer draws the bar and asks main to pop the real menu open under the clicked label
 * (`menu:popup`). macOS keeps its native menu bar at the top of the screen, because moving it
 * into the window would be wrong on that platform in a way users notice immediately.
 *
 * Why native popups rather than React dropdowns: `role`-based items. `role: "copy"` wires the
 * accelerator, the enabled/disabled state and the OS-level edit behaviour for free, and gets
 * clipboard interaction right in a sandboxed renderer. Reimplementing that in the page means
 * reimplementing it wrongly.
 *
 * THIS FILE NO LONGER DECIDES WHAT IS IN A MENU. `MENU_STRUCTURE` in `shared/commands.ts`
 * does, and `submenuFor` is a pure function of it and the calling window's enablement state.
 * That is what makes the menu honest: an item is enabled only if a mounted renderer component
 * bound its command, so a menu item that does nothing is no longer expressible. Before this,
 * six items emitted intents nobody handled and looked perfectly live.
 *
 * ACCELERATORS ARE DISPLAY ONLY HERE — `registerAccelerator: false` on every command item.
 * The renderer owns dispatch (`lib/shell/keybindings.ts`), because it is the only side that
 * knows what has focus and whether a command is currently enabled. Two dispatch paths that
 * must agree is a bug waiting to happen; the label still shows the shortcut, so the menu
 * remains the discovery surface it should be.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { logDir } from "./log.js";
import { PACKAGED_LICENSES_DIR } from "./protocol.js";
import { createWindow } from "./windows.js";
import { recentProjects } from "./store/recents.js";
import {
  CHECKBOX_COMMANDS,
  COMMAND_ACCELERATORS,
  COMMAND_LABELS,
  MENU_IDS,
  MENU_LABELS,
  MENU_STRUCTURE,
  type CommandId,
  type MenuEntry,
  type MenuId,
} from "../shared/commands.js";

/**
 * What the focused window says it can currently do.
 *
 * Empty means everything is greyed, and that is the correct default rather than a degraded
 * one: a renderer that has not published yet — or has crashed — must not present a fully live
 * menu. `menu:setState` fills this in.
 */
export interface MenuState {
  enabled: ReadonlySet<CommandId>;
  checked: ReadonlySet<CommandId>;
}

export const EMPTY_MENU_STATE: MenuState = { enabled: new Set(), checked: new Set() };

const stateByWindow = new WeakMap<Electron.WebContents, MenuState>();

/**
 * Tests only, in the spirit of `__setProjectRoot` and `__clearKeyCache`.
 *
 * Menu state is a stream of pushes, not a value that can be read back later. Polling
 * `menuStateFor` cannot see a state that has been superseded, and a run here finishes in
 * single-digit milliseconds — so the whole busy window can open and close between two reads.
 * The smoke needs the transitions, and this is the only place they exist.
 *
 * Cost is one undefined check on a path that runs a few times a second.
 */
let observer: ((sender: Electron.WebContents, state: MenuState) => void) | undefined;

export function __observeMenuState(
  fn: ((sender: Electron.WebContents, state: MenuState) => void) | undefined
): void {
  observer = fn;
}

/** Called by the `menu:setState` handler. */
export function setMenuState(sender: Electron.WebContents, state: MenuState): void {
  stateByWindow.set(sender, state);
  observer?.(sender, state);
  // macOS holds one application menu for the whole app, so it has to be rebuilt when the
  // window it reflects changes what it can do. Elsewhere the menu is built on demand at popup
  // time and there is nothing to refresh.
  if (process.platform === "darwin" && BrowserWindow.getFocusedWindow()?.webContents === sender) {
    installApplicationMenu();
  }
}

export function menuStateFor(sender: Electron.WebContents | undefined): MenuState {
  return (sender !== undefined ? stateByWindow.get(sender) : undefined) ?? EMPTY_MENU_STATE;
}

/**
 * Send a command to the focused window rather than acting in main.
 *
 * Most menu items are really renderer intentions — toggle a panel, go to a destination — and
 * the renderer owns that state. Main's job is to deliver the intent, not to model the UI.
 */
function emit(command: CommandId, extra?: Record<string, unknown>): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (target !== undefined && !target.webContents.isDestroyed()) {
    target.webContents.send("shell:command", { command, ...extra });
  }
}

/**
 * The few items main performs itself.
 *
 * `file.newWindow` is here rather than in the renderer because creating a window is main's job
 * and nothing in the page can do it. These are always enabled — they need no renderer
 * component to be mounted.
 */
const MAIN_ACTIONS: Partial<Record<CommandId, () => void>> = {
  "file.newWindow": () => void createWindow({ mode: "build" }),

  /**
   * The log, opened in the file manager. Main-owned for a reason that is easy to get wrong.
   *
   * Binding this in the renderer would look tidier and would grey the item out whenever the
   * renderer has not mounted or has crashed — which is precisely when someone is reaching for
   * the log. A diagnostic that disappears during the fault it diagnoses is worse than none,
   * because the user concludes the app has no logging at all.
   *
   * Opens the folder rather than the file: `.log` has no default handler on a clean Windows
   * install, so opening it directly can produce a "choose an app" dialog instead of the
   * contents. The folder always opens, and the file is the only thing in it.
   */
  "help.openLogs": () => void shell.openPath(logDir()),

  /**
   * The bundled licence text, opened in the file manager.
   *
   * Main-owned for the same reason as the log above, and worth having at all for a simpler one: the
   * app is obliged to ship this text — Apache-2.0 §4(d) for its own NOTICE, MPL-2.0 §3.1 for Pyodide
   * — and a directory nobody can find satisfies the letter of that while defeating its point. Fifteen
   * lines turns it into something a user can reach.
   *
   * Unpackaged, the gathered directory only exists once `npm run collect:licences` has run, so this
   * opens `build/` instead of a path that may not be there. Opening a missing directory does nothing
   * visible, which is the one outcome worse than opening the wrong one.
   */
  "help.openLicences": () => {
    const packaged = path.join(process.resourcesPath, PACKAGED_LICENSES_DIR);
    const target = app.isPackaged ? packaged : path.join(__dirname, "..", "..", "build");
    void shell.openPath(target);
  },

  /**
   * NO `help.documentation` OR `help.reportIssue` HERE, DELIBERATELY.
   *
   * They pointed at `https://github.com/` — the bare homepage, an obvious placeholder. Those
   * were briefly replaced with `github.com/voidcode-ai/voidcode`, which was worse: an invented
   * URL that *looks* real, so nobody would think to check it. This project has no `repository`
   * field, no `homepage`, and no git remote — there is no public URL to open.
   *
   * So both stay unbound, which greys them. To light them up, add a `homepage` and a `bugs`
   * url to `package.json` and read them here; the items need no other change.
   */
};

function isEnabled(id: CommandId, state: MenuState): boolean {
  return MAIN_ACTIONS[id] !== undefined || state.enabled.has(id);
}

function itemFor(id: CommandId, state: MenuState): MenuItemConstructorOptions {
  const accelerator = COMMAND_ACCELERATORS[id];
  const mainAction = MAIN_ACTIONS[id];

  return {
    label: COMMAND_LABELS[id],
    enabled: isEnabled(id, state),
    // Conditional spread rather than assigning `undefined`: `exactOptionalPropertyTypes` is
    // on, so `accelerator: undefined` is a type error rather than an omission.
    ...(accelerator !== null ? { accelerator, registerAccelerator: false } : {}),
    ...(CHECKBOX_COMMANDS.includes(id)
      ? { type: "checkbox" as const, checked: state.checked.has(id) }
      : {}),
    click: mainAction ?? ((): void => emit(id)),
  };
}

/**
 * Two roles cannot live in the shared table because they depend on things only main can see:
 * which platform this is, and what version is running.
 */
function roleItem(role: string): MenuItemConstructorOptions {
  if (role === "platformClose") {
    // macOS keeps the app running with no windows, so Close is the right verb there; on
    // Windows and Linux closing the last window quits, so say that instead.
    return process.platform === "darwin" ? { role: "close" } : { role: "quit" };
  }
  if (role === "version") {
    return { label: `Version ${app.getVersion()}`, enabled: false };
  }
  return { role: role as NonNullable<MenuItemConstructorOptions["role"]> };
}

/**
 * Open Recent, built from main's own record of folders the user has picked.
 *
 * Main reads the list directly rather than asking the renderer, because it is main's database
 * and main is the thing rendering the menu. Clicking sends the path along with the intent —
 * the only menu item that carries a payload — and the renderer turns it into `fs:openRecent`,
 * which refuses anything not already in that list.
 */
function recentProjectsSubmenu(): MenuItemConstructorOptions {
  let projects: Array<{ path: string; name: string }> = [];
  try {
    projects = recentProjects();
  } catch {
    // The database is not open yet, or could not be read. An empty, disabled submenu is the
    // right answer; failing here would take the whole File menu with it.
  }

  return {
    label: "Open Recent",
    // Disabled rather than hidden when empty, so the item does not appear and disappear as
    // you use the app.
    enabled: projects.length > 0,
    submenu: projects.map((project) => ({
      label: project.name,
      // The full path as a tooltip: two folders called `src` are otherwise indistinguishable.
      toolTip: project.path,
      click: (): void => emit("file.openRecent", { path: project.path }),
    })),
  };
}

function entryFor(entry: MenuEntry, state: MenuState): MenuItemConstructorOptions {
  if (entry === "-") return { type: "separator" };
  if (typeof entry === "object") {
    return "dynamic" in entry ? recentProjectsSubmenu() : roleItem(entry.role);
  }
  return itemFor(entry, state);
}

export function submenuFor(id: MenuId, state: MenuState): MenuItemConstructorOptions[] {
  return MENU_STRUCTURE[id].map((entry) => entryFor(entry, state));
}

/**
 * Pop a menu open at a point in the window.
 *
 * Coordinates arrive from the renderer in CSS pixels relative to the viewport; `popup` wants
 * window coordinates. They coincide here because the page fills the window and there is no
 * frame — which is only true *because* the window is frameless, so this breaks quietly if that
 * ever changes.
 */
export function popupMenu(window: BrowserWindow, id: MenuId, x: number, y: number): void {
  Menu.buildFromTemplate(submenuFor(id, menuStateFor(window.webContents))).popup({
    window,
    x: Math.round(x),
    y: Math.round(y),
  });
}

/**
 * macOS keeps a real menu bar; Windows and Linux get `null` so the frameless window does not
 * reserve space for one the renderer is already drawing.
 *
 * On Windows and Linux that means no accelerator in this template ever fires — which was true
 * before this rewrite too. The difference is that it is now deliberate: the renderer's
 * dispatcher is the single path on every platform, so the two cannot disagree.
 */
export function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const state = menuStateFor(BrowserWindow.getFocusedWindow()?.webContents);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      ...MENU_IDS.filter((id) => id !== "help").map((id) => ({
        label: MENU_LABELS[id],
        submenu: submenuFor(id, state),
      })),
      { role: "windowMenu" },
      { label: MENU_LABELS.help, submenu: submenuFor("help", state) },
    ])
  );
}
