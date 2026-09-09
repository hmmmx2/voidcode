/**
 * The command table: every action the menu, the palette and the keyboard can invoke.
 *
 * THREE SYSTEMS HAD TO AGREE AND HAD NO WAY TO. The native menu was built in main, the
 * command palette was assembled inline inside a React closure, and exactly one keybinding
 * (⌘K) was hardcoded in a `keydown` listener. Six menu items emitted intents nobody handled,
 * `MENU_LABELS` was duplicated in the renderer as `MENUS`, and no accelerator fired at all on
 * Windows or Linux. This file is the single source those three now read.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. Ids, labels, accelerators and menu structure are static
 * data both processes render, so they live here. The `run` closures capture React state and
 * can only exist in the renderer (`lib/shell/commands.tsx`). Enablement is derived from what
 * is mounted and is pushed to main over `menu:setState`.
 *
 * IMPORT-FREE, like `menu-ids.ts` before it. `contract.ts` imports this for its zod enums,
 * and `contract.ts` is itself imported by `windows.ts`, which `menu.ts` imports. Any import
 * added here risks that cycle.
 *
 * NO OPTIONAL PROPERTIES — `string | null`, never `string?`. `desktop/tsconfig.json` has
 * `exactOptionalPropertyTypes` and `renderer/tsconfig.json` does not, so the two compilers
 * disagree about what an absent property means. `null` means the same thing to both.
 */

export const MENU_IDS = [
  "file",
  "edit",
  "selection",
  "view",
  "go",
  "run",
  "terminal",
  "help",
] as const;

export type MenuId = (typeof MENU_IDS)[number];

export const MENU_LABELS: Record<MenuId, string> = {
  file: "File",
  edit: "Edit",
  selection: "Selection",
  view: "View",
  go: "Go",
  run: "Run",
  terminal: "Terminal",
  help: "Help",
};

/**
 * Every command id, in menu order.
 *
 * Adding one here does not make it appear anywhere — it must also be placed in
 * `MENU_STRUCTURE` and bound by a renderer component. An id in this list that nothing binds
 * is greyed out in the menu and absent from the palette, which is the honest default rather
 * than a bug.
 */
export const COMMAND_IDS = [
  // File
  "file.newWindow",
  "file.openFolder",
  "file.openRecent",
  "file.closeFolder",
  "file.preferences",

  // Edit
  "edit.find",
  "edit.replace",
  "edit.findInFiles",
  "edit.projectMemory",
  "edit.toggleComment",
  "edit.formatDocument",
  "edit.rename",

  // Selection
  "selection.expand",
  "selection.shrink",
  "selection.copyLineUp",
  "selection.copyLineDown",
  "selection.moveLineUp",
  "selection.moveLineDown",
  "selection.addCursorAbove",
  "selection.addCursorBelow",
  "selection.selectAllOccurrences",

  // View
  "view.commandPalette",
  "view.togglePanel.left",
  "view.togglePanel.right",
  "view.togglePanel.bottom",
  "view.resetLayout",

  // Go
  "go.back",
  "go.forward",
  "go.toFile",
  "go.toLine",
  "go.definition",
  "go.references",
  "go.prep",
  "go.code",
  "go.dashboard",
  "go.problems",
  "go.interviews",
  "go.projects",
  "go.account",
  "go.models",
  "go.previousProblem",
  "go.nextProblem",

  // Run
  "run.execute",
  "run.submit",
  "run.stop",
  "run.reset",

  // Terminal
  "terminal.new",
  "terminal.focus",
  "terminal.clear",
  "terminal.kill",

  // Help
  "help.documentation",
  "help.keyboardShortcuts",
  "help.openLicences",
  "help.openLogs",
  "help.reportIssue",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export const COMMAND_LABELS: Record<CommandId, string> = {
  "file.newWindow": "New Window",
  "file.openFolder": "Open Folder…",
  "file.openRecent": "Open Recent",
  "file.closeFolder": "Close Folder",
  "file.preferences": "Preferences",

  "edit.find": "Find…",
  "edit.replace": "Replace…",
  "edit.findInFiles": "Find in Files…",
  "edit.projectMemory": "Project Memory…",
  "edit.toggleComment": "Toggle Line Comment",
  "edit.formatDocument": "Format Document",
  "edit.rename": "Rename Symbol",

  "selection.expand": "Expand Selection",
  "selection.shrink": "Shrink Selection",
  "selection.copyLineUp": "Copy Line Up",
  "selection.copyLineDown": "Copy Line Down",
  "selection.moveLineUp": "Move Line Up",
  "selection.moveLineDown": "Move Line Down",
  "selection.addCursorAbove": "Add Cursor Above",
  "selection.addCursorBelow": "Add Cursor Below",
  "selection.selectAllOccurrences": "Select All Occurrences",

  "view.commandPalette": "Command Palette…",
  "view.togglePanel.left": "Primary Side Bar",
  "view.togglePanel.right": "Secondary Side Bar",
  "view.togglePanel.bottom": "Panel",
  "view.resetLayout": "Reset Panel Layout",

  "go.back": "Back",
  "go.forward": "Forward",
  "go.toFile": "Go to File…",
  "go.toLine": "Go to Line/Column…",
  "go.definition": "Go to Definition",
  "go.references": "Go to References",
  "go.prep": "Interview Prep",
  "go.code": "Code",
  "go.dashboard": "Dashboard",
  "go.problems": "Problems",
  "go.interviews": "Interviews",
  "go.projects": "Projects",
  "go.account": "Account",
  "go.models": "Models",
  "go.previousProblem": "Previous Problem",
  "go.nextProblem": "Next Problem",

  "run.execute": "Run Code",
  "run.submit": "Submit Solution",
  "run.stop": "Stop",
  "run.reset": "Reset to Template",

  "terminal.new": "New Terminal",
  "terminal.focus": "Focus Terminal",
  "terminal.clear": "Clear Terminal",
  "terminal.kill": "Kill Terminal",

  "help.documentation": "Documentation",
  "help.keyboardShortcuts": "Keyboard Shortcuts",
  "help.openLicences": "Open Licences",
  "help.openLogs": "Open Logs Folder",
  "help.reportIssue": "Report Issue",
};

/**
 * Electron accelerator syntax, parsed by both the menu builder and the renderer dispatcher.
 *
 * `null` means "no default binding" — not "unbound by accident". Every binding here carries
 * `CmdOrCtrl` or a function key, which is why the renderer dispatcher needs no is-this-a-
 * text-input guard: none of these can collide with ordinary typing.
 *
 * Deliberately absent: undo, redo, cut, copy, paste, select-all and zoom. Those stay Electron
 * `role:` items, whose keys Chromium handles natively in the renderer whether or not an
 * application menu exists — which is why they work today on Windows despite
 * `setApplicationMenu(null)`. Binding them here would take a working thing and route it
 * through a slower path that can break.
 */
export const COMMAND_ACCELERATORS: Record<CommandId, string | null> = {
  "file.newWindow": "CmdOrCtrl+Shift+N",
  "file.openFolder": "CmdOrCtrl+O",
  // No accelerator: it is a submenu, and the items inside it carry the paths.
  "file.openRecent": null,
  "file.closeFolder": null,
  "file.preferences": "CmdOrCtrl+,",

  "edit.find": "CmdOrCtrl+F",
  "edit.replace": "CmdOrCtrl+H",
  "edit.findInFiles": "CmdOrCtrl+Shift+F",
  // No default binding: it is a panel you open occasionally, not a reflex.
  "edit.projectMemory": null,
  "edit.toggleComment": "CmdOrCtrl+/",
  "edit.formatDocument": "Shift+Alt+F",
  "edit.rename": "F2",

  "selection.expand": "Shift+Alt+Right",
  "selection.shrink": "Shift+Alt+Left",
  "selection.copyLineUp": "Shift+Alt+Up",
  "selection.copyLineDown": "Shift+Alt+Down",
  "selection.moveLineUp": "Alt+Up",
  "selection.moveLineDown": "Alt+Down",
  "selection.addCursorAbove": "CmdOrCtrl+Alt+Up",
  "selection.addCursorBelow": "CmdOrCtrl+Alt+Down",
  "selection.selectAllOccurrences": "CmdOrCtrl+Shift+L",

  "view.commandPalette": "CmdOrCtrl+K",
  "view.togglePanel.left": "CmdOrCtrl+B",
  "view.togglePanel.right": "CmdOrCtrl+Alt+B",
  "view.togglePanel.bottom": "CmdOrCtrl+J",
  // Not Ctrl+Space: that is the completion *trigger* on Windows and Linux, and binding the
  // on/off switch to it would mean asking for a suggestion turns them off.
  // Backslash is what every editor uses for split, and the shifted form for the other axis.
  // Not Ctrl+1/2: those are already Interview Prep and Code, and a destination beats a pane
  // for the top-level digits.
  // Deliberately unbound. Resetting the layout throws away an arrangement someone built by hand,
  // and a stray chord that does that is worse than one more trip to the menu.
  "view.resetLayout": null,

  "go.back": "Alt+Left",
  "go.forward": "Alt+Right",
  "go.toFile": "CmdOrCtrl+P",
  "go.toLine": "CmdOrCtrl+G",
  "go.definition": "F12",
  "go.references": "Shift+F12",
  "go.prep": "CmdOrCtrl+1",
  "go.code": "CmdOrCtrl+2",
  "go.dashboard": null,
  "go.problems": null,
  "go.interviews": null,
  "go.projects": null,
  "go.account": null,
  "go.models": null,
  "go.previousProblem": "CmdOrCtrl+PageUp",
  "go.nextProblem": "CmdOrCtrl+PageDown",

  "run.execute": "CmdOrCtrl+Enter",
  "run.submit": "CmdOrCtrl+Shift+Enter",
  "run.stop": "CmdOrCtrl+.",
  "run.reset": null,

  "terminal.new": "CmdOrCtrl+Shift+`",
  "terminal.focus": "CmdOrCtrl+`",
  "terminal.clear": null,
  "terminal.kill": null,

  "help.documentation": null,
  "help.keyboardShortcuts": null,
  "help.openLicences": null,
  "help.openLogs": null,
  "help.reportIssue": null,
};

/**
 * Panel toggles render as checkboxes rather than plain items, so the menu shows whether the
 * panel is open. `menu:setState` carries a `checked` set alongside `enabled` for these.
 */
export const CHECKBOX_COMMANDS: readonly CommandId[] = [
  "view.togglePanel.left",
  "view.togglePanel.right",
  "view.togglePanel.bottom",
];

/**
 * One entry in a menu: a command, a separator, or a native Electron role.
 *
 * Roles are passed through untouched because they carry their accelerator, their enabled
 * state and the OS-level edit behaviour with them. Reimplementing `role: "copy"` in a
 * sandboxed renderer means reimplementing it wrongly.
 */
export type MenuEntry =
  | CommandId
  | "-"
  | { readonly role: string }
  /**
   * A submenu main fills in at popup time.
   *
   * The only entry whose *contents* are not static. Recent projects live in main's database,
   * change as you open folders, and carry a path per item — none of which a compile-time
   * table can express. `submenuFor` builds it.
   */
  | { readonly dynamic: "recentProjects" };

/**
 * The menus, in order.
 *
 * This is the only place the shape of the menu is written down. `submenuFor` in
 * `main/menu.ts` is a pure function of this table and the enablement state, so a menu item
 * cannot exist without an id, and an id here that is not in `COMMAND_IDS` is a type error.
 */
export const MENU_STRUCTURE: Record<MenuId, readonly MenuEntry[]> = {
  file: [
    "file.newWindow",
    "-",
    "file.openFolder",
    { dynamic: "recentProjects" },
    "file.closeFolder",
    "-",
    "-",
    "file.preferences",
    "-",
    // `close` on macOS (the app stays running), `quit` elsewhere — filled in by the builder,
    // which is the one place that may branch on platform.
    { role: "platformClose" },
  ],
  edit: [
    { role: "undo" },
    { role: "redo" },
    "-",
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    "-",
    "edit.find",
    "edit.replace",
    "edit.findInFiles",
    "edit.projectMemory",
    "-",
    "edit.toggleComment",
    "edit.formatDocument",
    "edit.rename",
  ],
  selection: [
    { role: "selectAll" },
    "-",
    "selection.expand",
    "selection.shrink",
    "-",
    "selection.copyLineUp",
    "selection.copyLineDown",
    "selection.moveLineUp",
    "selection.moveLineDown",
    "-",
    "selection.addCursorAbove",
    "selection.addCursorBelow",
    "selection.selectAllOccurrences",
  ],
  view: [
    "view.commandPalette",
    "-",
    "view.togglePanel.left",
    "view.togglePanel.right",
    "view.togglePanel.bottom",
    "-",
    "-",
    "-",
    "view.resetLayout",
    "-",
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    "-",
    { role: "togglefullscreen" },
    { role: "toggleDevTools" },
  ],
  go: [
    "go.back",
    "go.forward",
    "-",
    "go.toFile",
    "go.toLine",
    "-",
    "go.definition",
    "go.references",
    "-",
    "go.prep",
    "go.code",
    "-",
    "go.dashboard",
    "go.problems",
    "go.interviews",
    "go.projects",
    "-",
    "go.account",
    "go.models",
    "-",
    "go.previousProblem",
    "go.nextProblem",
  ],
  run: ["run.execute", "run.submit", "run.stop", "-", "run.reset"],
  terminal: ["terminal.new", "terminal.focus", "-", "terminal.clear", "terminal.kill"],
  help: [
    "help.documentation",
    "help.keyboardShortcuts",
    "help.openLicences",
    "help.openLogs",
    "help.reportIssue",
    "-",
    // The version label is built by the menu builder — it needs `app.getVersion()`, which
    // this import-free module cannot reach.
    { role: "version" },
  ],
};
