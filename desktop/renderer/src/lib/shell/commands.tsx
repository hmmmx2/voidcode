"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  CHECKBOX_COMMANDS,
  COMMAND_ACCELERATORS,
  COMMAND_IDS,
  COMMAND_LABELS,
  type CommandId,
} from "@shared/commands";
import { installKeybindings } from "./keybindings";

/**
 * The command registry: what the menu, the palette and the keyboard all read.
 *
 * Before this, those were three unrelated systems. The menu was built in main and emitted
 * string intents; the palette was assembled inline inside `Workbench`'s closure; exactly one
 * keybinding existed, hardcoded. Six menu items emitted intents nobody handled, and looked
 * perfectly live while doing nothing.
 *
 * ENABLEMENT IS DERIVED FROM WHAT IS MOUNTED, and that is the whole design. A command is
 * enabled if and only if some mounted component bound it. `run.execute` is dead on the
 * dashboard because `WorkspaceClient` is not mounted there — there is no route matching
 * anywhere in this file, no `when`-clause language, no context keys. VS Code needs those
 * because extensions cannot mount React components; here they can.
 *
 * The consequence worth stating: a menu item that does nothing is not expressible. To make one
 * appear live you have to bind it, and binding it means providing the function that runs.
 *
 * Follows `open-files.tsx` — the existing precedent for lifting component state to the shell —
 * with one deliberate difference: bindings are a STACK per id, because two surfaces may
 * legitimately bind the same command. `file.openFolder` is bound by the shell (route to
 * `/build`) and by `BuildWorkspace` (open the real dialog); the workspace mounts later and
 * wins, so the item works everywhere and does the right thing in both places, with no
 * coordination between them.
 */

export interface CommandBinding {
  id: CommandId;
  run: () => void | Promise<void>;
  /**
   * Bound but not currently usable — a run already in flight, a buffer with no changes.
   * Omit for enabled. Distinct from not binding at all, which means "this surface has no
   * opinion about this command".
   */
  enabled?: boolean;
}

export interface ResolvedCommand {
  id: CommandId;
  label: string;
  /** Electron accelerator syntax, for display. `null` when the command has no shortcut. */
  accelerator: string | null;
  enabled: boolean;
  checked: boolean;
}

interface CommandStore {
  bindings: ReadonlyMap<CommandId, readonly CommandBinding[]>;
  register: (bindings: readonly CommandBinding[]) => () => void;
  setChecked: (id: CommandId, value: boolean) => void;
  checked: ReadonlySet<CommandId>;
}

const CommandContext = createContext<CommandStore>({
  bindings: new Map(),
  register: () => () => {},
  setChecked: () => {},
  checked: new Set(),
});

export function CommandRegistryProvider({ children }: { children: React.ReactNode }) {
  const [bindings, setBindings] = useState<ReadonlyMap<CommandId, readonly CommandBinding[]>>(
    new Map()
  );
  const [checked, setCheckedSet] = useState<ReadonlySet<CommandId>>(new Set());

  const register = useCallback((incoming: readonly CommandBinding[]) => {
    setBindings((prev) => {
      const next = new Map(prev);
      for (const binding of incoming) {
        next.set(binding.id, [...(next.get(binding.id) ?? []), binding]);
      }
      return next;
    });

    return () => {
      setBindings((prev) => {
        const next = new Map(prev);
        for (const binding of incoming) {
          // Remove this exact object, not "the last one". Two surfaces unmounting in an
          // order React does not promise must not be able to pop each other's binding.
          const remaining = (next.get(binding.id) ?? []).filter((b) => b !== binding);
          if (remaining.length === 0) next.delete(binding.id);
          else next.set(binding.id, remaining);
        }
        return next;
      });
    };
  }, []);

  const setChecked = useCallback((id: CommandId, value: boolean) => {
    setCheckedSet((prev) => {
      if (prev.has(id) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const store = useMemo<CommandStore>(
    () => ({ bindings, register, setChecked, checked }),
    [bindings, register, setChecked, checked]
  );

  return (
    <CommandContext.Provider value={store}>
      <MenuStatePublisher />
      <KeyboardDispatcher />
      {children}
    </CommandContext.Provider>
  );
}

/**
 * Producer. Bindings MUST be memoised by the caller.
 *
 * An inline array literal is a new object every render, so the effect below would unregister
 * and re-register on every render — which is the same publish loop `open-files.tsx` documents,
 * arriving by a different route.
 */
export function useRegisterCommands(bindings: readonly CommandBinding[]): void {
  const { register } = useContext(CommandContext);
  useEffect(() => register(bindings), [register, bindings]);
}

/** Consumer — the palette, the keyboard dispatcher, the menu publisher. */
export function useCommands(): {
  list: readonly ResolvedCommand[];
  isEnabled: (id: CommandId) => boolean;
  run: (id: CommandId) => void;
} {
  const { bindings, checked } = useContext(CommandContext);

  const list = useMemo<readonly ResolvedCommand[]>(
    () =>
      COMMAND_IDS.map((id) => ({
        id,
        label: COMMAND_LABELS[id],
        accelerator: COMMAND_ACCELERATORS[id],
        enabled: resolve(bindings, id) !== undefined,
        checked: checked.has(id),
      })),
    [bindings, checked]
  );

  const isEnabled = useCallback(
    (id: CommandId) => resolve(bindings, id) !== undefined,
    [bindings]
  );

  const run = useCallback(
    (id: CommandId) => {
      // Silently ignoring a disabled command is deliberate: the menu greys it, the palette
      // omits it, and the keyboard dispatcher checks first. Anything reaching here anyway is
      // a race against an unmount, not a case worth throwing over.
      void resolve(bindings, id)?.run();
    },
    [bindings]
  );

  return { list, isEnabled, run };
}

/** Sets a checkbox item's state — panel toggles use this so the menu shows what is open. */
export function useSetCommandChecked(): (id: CommandId, value: boolean) => void {
  return useContext(CommandContext).setChecked;
}

/** The last binding that did not opt out. Undefined means the command is unavailable. */
function resolve(
  bindings: ReadonlyMap<CommandId, readonly CommandBinding[]>,
  id: CommandId
): CommandBinding | undefined {
  const stack = bindings.get(id);
  if (stack === undefined) return undefined;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const binding = stack[i];
    if (binding !== undefined && binding.enabled !== false) return binding;
  }
  return undefined;
}

/**
 * The keyboard half of the registry.
 *
 * Installed here rather than in `Workbench` so that every accelerator arrives by the same
 * path as every menu click — one dispatcher, one enablement check, no chance of the two
 * disagreeing about whether a command is live.
 *
 * Re-installed whenever the bindings change, because `installKeybindings` closes over
 * `isEnabled` and `run`. That is a listener swap on a mount or unmount, not per keystroke.
 */
function KeyboardDispatcher() {
  const { isEnabled, run } = useCommands();

  useEffect(() => {
    // `userAgent` rather than the deprecated `platform`, matching how the shell already
    // decides where to draw menus. Only affects which modifier `CmdOrCtrl` means.
    const isMac = /Mac/i.test(window.navigator.userAgent);
    return installKeybindings({ isEnabled, run, isMac });
  }, [isEnabled, run]);

  return null;
}

/**
 * Tells main which commands are live, so the native menu can grey out the rest.
 *
 * Its own component so the effect re-runs on binding changes without re-rendering every
 * consumer of the context.
 */
function MenuStatePublisher() {
  const { bindings, checked } = useContext(CommandContext);

  useEffect(() => {
    const enabled = COMMAND_IDS.filter((id) => resolve(bindings, id) !== undefined);
    const checkedIds = CHECKBOX_COMMANDS.filter((id) => checked.has(id));
    void window.host?.menu?.setState?.({ enabled, checked: checkedIds });
  }, [bindings, checked]);

  return null;
}
