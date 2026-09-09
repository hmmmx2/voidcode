"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { DestinationId } from "./destinations";

/**
 * Panel visibility, remembered per destination.
 *
 * Per destination and not globally, because the panels mean different things in each:
 * closing the terminal while writing code should not also close the test console in
 * Problems. Someone who tidies one workspace has not asked to tidy the other.
 *
 * Persisted to `localStorage` rather than through IPC. It is pure view state — losing it
 * costs a keystroke, and putting it in SQLite would mean an async read before the first
 * paint, which is how you get a visible layout shift on every launch.
 */

export type PanelId = "left" | "right" | "bottom";

export type PanelState = Record<PanelId, boolean>;

const STORAGE_KEY = "voidcode.panels.v1";

/**
 * The sides open, the terminal closed.
 *
 * `bottom` has now defaulted both ways, and the argument that opened it has been overtaken.
 * That argument was: the panel is never blank because it spawns a real shell on mount, and
 * every editor this one is measured against docks a terminal under the editor. The second
 * clause is the one that no longer holds — this is not an editor being measured against
 * editors. The centre is a conversation, and a terminal permanently occupying a third of it
 * is a third less room for the thing the product is about.
 *
 * It is a keystroke away and announces itself: `Cmd/Ctrl+J`, a Terminal button in the title
 * bar, and Terminal ▸ New Terminal, all of which open it rather than toggling blindly.
 *
 * `STORAGE_KEY` is unchanged deliberately, as it was last time: anyone who has already chosen
 * has that choice in localStorage, and this only moves the starting point for someone who has
 * not. Bumping the key would silently overrule people who deliberately keep a terminal open.
 */
const DEFAULTS: PanelState = { left: true, right: true, bottom: false };

type AllPanels = Partial<Record<DestinationId, Partial<PanelState>>>;

function read(): AllPanels {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? {} : (JSON.parse(raw) as AllPanels);
  } catch {
    // Corrupt or unavailable (private mode, cleared mid-session). Defaults are correct and
    // a thrown error here would take the whole shell down with it.
    return {};
  }
}

export function usePanels(destination: DestinationId): {
  panels: PanelState;
  toggle: (panel: PanelId) => void;
  /**
   * Set a panel explicitly.
   *
   * `toggle` alone cannot express "make sure the terminal is showing" — New Terminal would
   * close the panel if it happened to be open, which is the opposite of what the menu item
   * says. Every caller that means "open" now says so.
   */
  setPanel: (panel: PanelId, next: boolean) => void;
} {
  // Start from defaults on both server and first client render, then adopt the stored
  // values in an effect. Reading `localStorage` during render would make the server's HTML
  // and the client's first paint disagree, which React reports as a hydration error.
  const [all, setAll] = useState<AllPanels>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAll(read());
    setHydrated(true);
  }, []);

  const panels: PanelState = hydrated
    ? { ...DEFAULTS, ...all[destination] }
    : DEFAULTS;

  const setPanel = useCallback(
    (panel: PanelId, value: boolean) => {
      setAll((prev) => {
        const current = { ...DEFAULTS, ...prev[destination] };
        if (current[panel] === value) return prev;

        const next: AllPanels = {
          ...prev,
          [destination]: { ...current, [panel]: value },
        };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Storage full or blocked. The change still works for this session.
        }
        return next;
      });
    },
    [destination]
  );

  // Expressed in terms of `setPanel` so there is one writer and one place that persists.
  const toggle = useCallback(
    (panel: PanelId) => {
      setAll((prev) => {
        const current = { ...DEFAULTS, ...prev[destination] };
        const next: AllPanels = {
          ...prev,
          [destination]: { ...current, [panel]: !current[panel] },
        };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Storage full or blocked. The toggle still works for this session.
        }
        return next;
      });
    },
    [destination]
  );

  return { panels, toggle, setPanel };
}

/**
 * Panel state, shared between the shell and whatever renders inside the panels.
 *
 * `BuildWorkspace` needs to know whether the bottom dock is open, and the shell owns the
 * toggle. Calling `usePanels` in both would give each its own `useState`, and they would
 * desynchronise on the first toggle — the menu would say the panel is open while the
 * workspace still renders it closed.
 */
const PanelsContext = createContext<ReturnType<typeof usePanels> | undefined>(undefined);

export function PanelsProvider({
  destination,
  children,
}: {
  destination: DestinationId;
  children: React.ReactNode;
}) {
  const value = usePanels(destination);
  return <PanelsContext.Provider value={value}>{children}</PanelsContext.Provider>;
}

/**
 * Read the shared panel state.
 *
 * Falls back to a closed, inert state rather than throwing when there is no provider: the
 * same components render in the web build and on bare routes, where there is no workbench
 * at all.
 */
export function usePanelState(): ReturnType<typeof usePanels> {
  return (
    useContext(PanelsContext) ?? {
      panels: DEFAULTS,
      toggle: () => {},
      setPanel: () => {},
    }
  );
}
