"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Which terminals this window has open, and which one you are looking at.
 *
 * The transitions are pure functions with the hook as a thin wrapper, following
 * `editor-tabs.ts` and `assistant-view.ts` — a test for "closing the active tab picks a
 * sensible neighbour" should not have to mount 1245 lines of workspace to ask.
 *
 * **Nothing here spawns anything.** A `TerminalTab` is an id and a label; the pty behind it
 * belongs to the `TerminalPanel` that renders it, and dies with that component. Keeping the two
 * apart is what lets the panes stay mounted while the strip re-renders — see `BottomDock`.
 *
 * **Terminals are deliberately not persisted.** A pty dies with its window. Restoring two shells
 * the user did not open, in a meaningless order, without the scrollback that made the second one
 * worth having, is worse than restoring one.
 */

/**
 * Mirrors `MAX_TERMINALS_PER_WINDOW` in `src/main/terminal/pty.ts`.
 *
 * Duplicated rather than imported because that module is main-only and importing it here would
 * pull `node-pty` into the renderer bundle. The cost of the duplication is that the two can drift;
 * the benefit is that hitting the cap disables a button instead of throwing
 * `TerminalUnavailableError` out of a spawn the user already committed to.
 */
export const MAX_TERMINALS = 8;

export interface TerminalTab {
  /** Stable for the life of the tab. React key, and what `close` takes. */
  id: number;
  /**
   * What the tab says.
   *
   * The creation ordinal, not the position: closing the first of three must not renumber the
   * other two, because each is a running shell someone has a mental model of. It counts up and
   * never reuses, so a long session reaches "Terminal 9" with two open — which is what VS Code
   * does, and is less confusing than two tabs swapping names.
   *
   * Not the shell's name, which would be better: `pty:spawn`'s handler returns `{pid, shell}` but
   * the PORT_CHANNELS branch of the preload resolves with the port interface and discards it.
   * Inventing "bash" here would be a guess.
   */
  ordinal: number;
}

export interface TerminalState {
  terminals: TerminalTab[];
  /** Null only when there are none open. */
  activeId: number | null;
  nextId: number;
  nextOrdinal: number;
}

export function emptyTerminals(): TerminalState {
  return { terminals: [], activeId: null, nextId: 1, nextOrdinal: 1 };
}

export function atCapacity(state: TerminalState): boolean {
  return state.terminals.length >= MAX_TERMINALS;
}

/** A new terminal, focused. At the cap this returns the state unchanged. */
export function openTerminal(state: TerminalState): TerminalState {
  // The readable failure lands on a disabled button rather than as a rejected spawn, which is the
  // whole reason the cap is mirrored on this side.
  if (atCapacity(state)) return state;

  const tab: TerminalTab = { id: state.nextId, ordinal: state.nextOrdinal };
  return {
    terminals: [...state.terminals, tab],
    activeId: tab.id,
    nextId: state.nextId + 1,
    nextOrdinal: state.nextOrdinal + 1,
  };
}

/**
 * Close one, and never leave `activeId` pointing at a tab that is gone.
 *
 * Closing the focused tab moves focus to the one on its right, or its left when it was last —
 * where your eye already is. Closing an unfocused tab leaves focus alone.
 */
export function closeTerminal(state: TerminalState, id: number): TerminalState {
  const index = state.terminals.findIndex((t) => t.id === id);
  if (index === -1) return state;

  const terminals = state.terminals.filter((t) => t.id !== id);

  if (state.activeId !== id) return { ...state, terminals };
  const neighbour = terminals[index] ?? terminals[index - 1];
  return { ...state, terminals, activeId: neighbour?.id ?? null };
}

/** Focus an existing terminal. Unknown ids are ignored rather than clearing the selection. */
export function focusTerminal(state: TerminalState, id: number): TerminalState {
  return state.terminals.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}

export interface UseTerminals {
  terminals: TerminalTab[];
  activeId: number | null;
  atCapacity: boolean;
  open: () => void;
  close: (id: number) => void;
  focus: (id: number) => void;
  /** Bumped to ask the active pane to clear its buffer. See `TerminalPanel`'s `clearNonce`. */
  clearNonce: number;
  clearActive: () => void;
  /**
   * Forget every tab.
   *
   * Called when the dock collapses, because collapsing unmounts the panes and unmounting a pane
   * closes its port and kills its shell. Keeping the tabs would leave a strip of buttons for
   * processes that no longer exist.
   */
  reset: () => void;
}

export function useTerminals(): UseTerminals {
  const [state, setState] = useState<TerminalState>(emptyTerminals);
  const [clearNonce, setClearNonce] = useState(0);

  const open = useCallback(() => setState(openTerminal), []);
  const close = useCallback((id: number) => setState((s) => closeTerminal(s, id)), []);
  const focus = useCallback((id: number) => setState((s) => focusTerminal(s, id)), []);
  // A counter rather than a callback registry: the panel that is active reads it, the rest ignore
  // it, and nothing has to hold an imperative handle to a component it does not own.
  const clearActive = useCallback(() => setClearNonce((n) => n + 1), []);
  const reset = useCallback(() => setState(emptyTerminals), []);

  return useMemo(
    () => ({
      terminals: state.terminals,
      activeId: state.activeId,
      atCapacity: atCapacity(state),
      open,
      close,
      focus,
      clearNonce,
      clearActive,
      reset,
    }),
    [state, open, close, focus, clearNonce, clearActive, reset]
  );
}
