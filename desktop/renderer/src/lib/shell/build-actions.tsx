"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * What Build mode can do with files, offered to the shell.
 *
 * `openProject`, `closeFile` and the new save functions live in `BuildWorkspace`, which owns
 * the buffers. Following `open-files.tsx`, it publishes actions rather than the shell reaching
 * into it.
 *
 * This is also what finally makes `file.openFolder` work. It has been emitted by the File menu
 * since the beginning and handled by nobody — the shell binds a fallback that routes to
 * `/build`, and this binding replaces it while you are actually there.
 */

export interface BuildActions {
  openProject: () => void;
  closeProject: () => void;
  /** Show the search view in the left rail, opening the rail if it is closed. */
  findInFiles: () => void;
  /** Show project memory in the left rail. */
  openMemory: () => void;
  /**
   * "New Terminal", and it finally is one.
   *
   * It used to be identical to `focusTerminal` — both called `setPanel("bottom", true)` — so the
   * menu offered two items that did the same thing and neither made a terminal. Now: opens the
   * dock if it is closed, and adds a tab if it is already open, which is what the label says.
   *
   * `setPanel(true)` rather than a toggle, still: a "New Terminal" that closes the panel when it
   * happens to be open is the opposite of what the menu item says.
   */
  openTerminal: () => void;
  focusTerminal: () => void;
  closeTerminal: () => void;
  terminalOpen: boolean;
  /**
   * Clear the buffer of the terminal you are looking at, and no other.
   *
   * Bound now that the dock can hold eight of them. It was in `UNBOUND_BY_DESIGN` on the grounds
   * that "the terminal panel owns its buffer and binds nothing globally", which stopped being
   * true the moment there was more than one buffer to choose between.
   */
  clearTerminal: () => void;
  /** A project is open, so there is somewhere to save to. */
  hasProject: boolean;
  /** There is an open buffer at all. */
  hasActive: boolean;


  /**
   * Put the panels back where they started.
   *
   * Panes can be dragged to new slots and the arrangement is persisted, so without this a single
   * clumsy drop is permanent — reopening the app restores the mess faithfully. Every other
   * rearrangeable thing here has a way back; this is the layout's.
   */
  resetLayout: () => void;
  /** False when the layout is already the default, so the menu item does not offer a no-op. */
  layoutIsDefault: boolean;
}

interface BuildActionsStore {
  actions: BuildActions | undefined;
  publish: (actions: BuildActions | undefined) => void;
}

const BuildActionsContext = createContext<BuildActionsStore>({
  actions: undefined,
  publish: () => {},
});

export function BuildActionsProvider({ children }: { children: React.ReactNode }) {
  const [actions, setActions] = useState<BuildActions | undefined>(undefined);

  const publish = useCallback((next: BuildActions | undefined) => {
    // Field-compared before storing, like the other providers here: the workspace publishes
    // from an effect over changing state, and storing every object would loop.
    setActions((prev) => {
      if (prev === next) return prev;
      if (prev === undefined || next === undefined) return next;
      const same =
        prev.openProject === next.openProject &&
        prev.closeProject === next.closeProject &&
        prev.findInFiles === next.findInFiles &&
        prev.openTerminal === next.openTerminal &&
        prev.focusTerminal === next.focusTerminal &&
        prev.closeTerminal === next.closeTerminal &&
        prev.terminalOpen === next.terminalOpen &&
        prev.hasProject === next.hasProject &&
        prev.hasActive === next.hasActive &&
        prev.openMemory === next.openMemory &&
        prev.resetLayout === next.resetLayout &&
        prev.layoutIsDefault === next.layoutIsDefault;
      return same ? prev : next;
    });
  }, []);

  const store = useMemo<BuildActionsStore>(() => ({ actions, publish }), [actions, publish]);

  return <BuildActionsContext.Provider value={store}>{children}</BuildActionsContext.Provider>;
}

/** For the shell — the File menu reads this. */
export function useBuildActions(): BuildActions | undefined {
  return useContext(BuildActionsContext).actions;
}

/** For the workspace — publish from an effect, and `undefined` on unmount. */
export function usePublishBuildActions(): (actions: BuildActions | undefined) => void {
  return useContext(BuildActionsContext).publish;
}
