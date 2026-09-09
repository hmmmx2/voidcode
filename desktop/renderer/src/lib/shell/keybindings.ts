/**
 * Keyboard accelerators, dispatched in the renderer on every platform.
 *
 * WHY THE RENDERER OWNS THIS. `installApplicationMenu()` calls `Menu.setApplicationMenu(null)`
 * on Windows and Linux, so the native menus exist only while popped open and their
 * accelerators are never registered. Every shortcut the menu advertised was decorative on
 * those platforms — Ctrl+B, Ctrl+J, Ctrl+Enter, all of it. The single exception was ⌘K, which
 * had a hand-rolled `keydown` listener precisely because someone noticed.
 *
 * The alternatives were considered and rejected. Installing a real application menu on
 * Windows and Linux works, but the window is frameless with `titleBarOverlay`, so Alt would
 * pop an OS menu bar on top of the bar the renderer already draws; worse, native accelerators
 * fire before the page with no way to decline, which makes step 3 below impossible.
 * `before-input-event` in main cannot know what has focus. `globalShortcut` fires when the app
 * is not even focused.
 *
 * MATCHING IS ON `event.code`, NOT `event.key`. `code` is the physical key, so `Alt+Up` stays
 * `Alt+Up` regardless of what character the layout produces with Alt held — which matters
 * because this table binds `Alt+Up/Down` and `Shift+Alt+Left/Right`. On a Mac, Alt+letter
 * produces an entirely different character in `event.key`, and matching on that would make
 * those bindings silently dead.
 */
import {
  COMMAND_ACCELERATORS,
  COMMAND_IDS,
  type CommandId,
} from "@shared/commands";

export interface Binding {
  id: CommandId;
  /** `KeyboardEvent.code` this fires on, e.g. `KeyB`, `ArrowUp`, `Comma`. */
  code: string;
  /** `CmdOrCtrl` — meta on macOS, control everywhere else. */
  cmdOrCtrl: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Accelerator key names to `KeyboardEvent.code` values.
 *
 * Only the names this table actually uses, plus the obvious neighbours. An unmapped name
 * throws at parse time rather than producing a binding that never fires — a shortcut that
 * silently does nothing is the failure this whole phase exists to remove.
 */
const CODE_FOR: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
};

export class UnknownAcceleratorError extends Error {
  constructor(accelerator: string, part: string) {
    super(`cannot parse accelerator "${accelerator}": unknown key "${part}"`);
    this.name = "UnknownAcceleratorError";
  }
}

function codeFor(accelerator: string, part: string): string {
  const lower = part.toLowerCase();

  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();

  const mapped = CODE_FOR[lower];
  if (mapped === undefined) throw new UnknownAcceleratorError(accelerator, part);
  return mapped;
}

/** Parse one Electron accelerator. Throws rather than returning a binding that cannot fire. */
export function parseAccelerator(id: CommandId, accelerator: string): Binding {
  const parts = accelerator.split("+").filter((p) => p.length > 0);
  // `CmdOrCtrl++` would split to ["CmdOrCtrl", "", ""] — filtering empties then leaves no key.
  if (parts.length === 0) throw new UnknownAcceleratorError(accelerator, accelerator);

  const binding: Binding = {
    id,
    code: "",
    cmdOrCtrl: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };

  for (const [index, part] of parts.entries()) {
    const lower = part.toLowerCase();
    const isLast = index === parts.length - 1;

    // A modifier name in the final position is the key, not a modifier — but none of the
    // names below are keys, so reaching here with one last means the accelerator is malformed.
    if (!isLast) {
      switch (lower) {
        case "cmdorctrl":
        case "commandorcontrol":
          binding.cmdOrCtrl = true;
          continue;
        case "ctrl":
        case "control":
          binding.ctrl = true;
          continue;
        case "cmd":
        case "command":
        case "super":
        case "meta":
          binding.meta = true;
          continue;
        case "alt":
        case "option":
          binding.alt = true;
          continue;
        case "shift":
          binding.shift = true;
          continue;
        default:
          throw new UnknownAcceleratorError(accelerator, part);
      }
    }

    binding.code = codeFor(accelerator, part);
  }

  if (binding.code === "") throw new UnknownAcceleratorError(accelerator, accelerator);
  return binding;
}

/**
 * Every binding in the command table, parsed once.
 *
 * A malformed accelerator throws here — at module load, in every environment including the
 * unit tests — rather than becoming a shortcut nobody can explain.
 */
export function parseAllAccelerators(): readonly Binding[] {
  const bindings: Binding[] = [];
  for (const id of COMMAND_IDS) {
    const accelerator = COMMAND_ACCELERATORS[id];
    if (accelerator === null) continue;
    bindings.push(parseAccelerator(id, accelerator));
  }
  return bindings;
}

/**
 * Does this event match this binding?
 *
 * Modifiers are matched EXACTLY. Without that, `Ctrl+K` would also fire on `Ctrl+Shift+K`,
 * and every unshifted binding would swallow its shifted neighbour.
 */
export function matches(binding: Binding, event: KeyboardEvent, isMac: boolean): boolean {
  if (event.code !== binding.code) return false;

  const wantCtrl = binding.ctrl || (binding.cmdOrCtrl && !isMac);
  const wantMeta = binding.meta || (binding.cmdOrCtrl && isMac);

  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  );
}

/**
 * Auto-repeat is right for editing operations and wrong for actions.
 *
 * Holding Alt+Down should keep moving the line; holding Ctrl+Enter must not submit eleven
 * times. `selection.*` is exactly the set where repeating is the point.
 */
export function allowsRepeat(id: CommandId): boolean {
  return id.startsWith("selection.");
}

/**
 * An accelerator as the user's platform spells it.
 *
 * Electron's syntax is not what anyone wants to read: `CmdOrCtrl+Shift+Enter` should be
 * `⌘⇧Enter` on a Mac and `Ctrl+Shift+Enter` elsewhere. Shared by the palette and the
 * workspace toolbar so a shortcut is never spelled two ways in one app.
 */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const spelled = accelerator
    .replace("CmdOrCtrl", isMac ? "⌘" : "Ctrl")
    .replace("Cmd", isMac ? "⌘" : "Ctrl")
    .replace("Ctrl", isMac ? "⌃" : "Ctrl")
    .replace("Shift", isMac ? "⇧" : "Shift")
    .replace("Alt", isMac ? "⌥" : "Alt");

  // macOS writes chords without separators; everywhere else keeps the plus signs.
  return isMac ? spelled.replace(/\+/g, "") : spelled;
}

/**
 * Install the dispatcher.
 *
 * CAPTURE PHASE, deliberately. Monaco attaches its keyboard handling to its own DOM node, so
 * a capture-phase listener on `window` runs first — which is what lets `edit.find` be *our*
 * command that then forwards into Monaco, rather than Monaco winning the key before the
 * registry sees it. Same layering VS Code uses.
 *
 * The three-step resolution matters, and step 2 is the one that is easy to get wrong:
 *
 *   1. No binding matches → return untouched.
 *   2. Matches but the command is not enabled → return WITHOUT `preventDefault`, so the key
 *      falls through to Monaco or Chromium. This is what makes honest-disable work at the
 *      keyboard: Ctrl+F on a page with no editor stays browser-nothing, and Ctrl+F inside
 *      Monaco still opens Monaco's own find if we have not bound it.
 *   3. Matches and enabled → consume it and run.
 *
 * There is deliberately no is-this-a-text-input guard. Every accelerator in the table carries
 * a modifier (asserted in `tests/menu.test.ts`), so none can collide with ordinary typing —
 * and a guard would break the editor commands, whose focus target *is* a textarea.
 */
export function installKeybindings(options: {
  isEnabled: (id: CommandId) => boolean;
  run: (id: CommandId) => void;
  isMac: boolean;
}): () => void {
  const bindings = parseAllAccelerators();

  const onKeyDown = (event: KeyboardEvent): void => {
    // Mid-composition keystrokes belong to the IME, not to us.
    if (event.isComposing) return;

    for (const binding of bindings) {
      if (!matches(binding, event, options.isMac)) continue;
      if (event.repeat && !allowsRepeat(binding.id)) return;
      if (!options.isEnabled(binding.id)) return;

      event.preventDefault();
      event.stopPropagation();
      options.run(binding.id);
      return;
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
