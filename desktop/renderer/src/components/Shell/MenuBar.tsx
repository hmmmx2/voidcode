"use client";

import { useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { PanelId, PanelState } from "@/lib/shell/usePanels";
import NotificationBell from "@/components/Layout/NotificationBell";
import WindowControls from "./WindowControls";
import { Mark } from "@/components/brand/Mark";
import { IconAccount, IconTerminal } from "@/components/icons";

/**
 * The workbench's title bar.
 *
 * The window is frameless, so this bar *is* the title bar: it carries the drag region that
 * makes the window movable at all. `-webkit-app-region: drag` on the bar, `no-drag` on every
 * interactive child — miss the second half and the user's click lands on a drag surface and
 * the window slides instead of the menu opening. That failure is reported as "I can't click
 * the menu", which does not sound like a CSS property.
 *
 * The menus themselves are native (`menu:popup`). React dropdowns would mean reimplementing
 * `role: "copy"` — its accelerator, its enabled state, and clipboard behaviour in a sandboxed
 * renderer — and reimplementing it wrongly.
 */

/** The bar's height. Sized here alone now — main no longer needs to know it. */
export const MENU_BAR_HEIGHT = 36;

interface MenuBarProps {
  menus: { id: string; label: string }[];
  panels: PanelState;
  onTogglePanel: (panel: PanelId) => void;
  onOpenPalette: () => void;
  /** macOS keeps its menus in the system bar, so the bar indents to clear the traffic lights. */
  isMac: boolean;
}

export default function MenuBar({
  menus,
  panels,
  onTogglePanel,
  onOpenPalette,
  isMac,
}: MenuBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const popup = useCallback((menu: string, event: React.MouseEvent<HTMLButtonElement>) => {
    // Anchor to the label's bottom-left, so the menu hangs under the word that opened it.
    const rect = event.currentTarget.getBoundingClientRect();
    void window.host?.menu?.popup({
      menu,
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
  }, []);

  return (
    <header
      style={
        {
          height: MENU_BAR_HEIGHT,
          // Traffic lights on the left (macOS) or window controls on the right (everywhere
          // else). Drawing under either is the classic frameless-Electron tell.
          paddingLeft: isMac ? 78 : 8,
          // No right padding any more: `WindowControls` *is* the right edge, and it draws its
          // own buttons at Windows caption metrics. This used to reserve 140px for an OS
          // overlay painting on top of the bar — anything placed under it was visible and
          // unclickable, which is the worst combination.
          paddingRight: 0,
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
      /*
       * Glass, and this is the one place in the IDE where that is correct.
       *
       * `IdeFrame.tsx` documents why the tiling panels must NOT be glass: they cover the
       * viewport, so there is nothing behind a panel but the panel beside it, and a
       * `backdrop-filter` with nothing to sample renders a flat grey rectangle. The chrome
       * is the opposite case — it sits over `AppBackdrop`'s gradient and bloom, which is
       * exactly what glass needs. `.glass-edge` adds the hairline that is brighter along
       * the top, the detail that separates real glass from a translucent grey box.
       *
       * Opaque by default with the film added only under `@supports`, matching
       * `GlassSurface`: written the other way round, a browser without `backdrop-filter`
       * gets a white haze over the editor with no blur to separate them.
       */
      className="glass-edge relative flex shrink-0 select-none items-center gap-1 border-b border-line bg-ide-panel/95 supports-[backdrop-filter]:bg-white/[0.035] supports-[backdrop-filter]:backdrop-blur-xl supports-[backdrop-filter]:backdrop-saturate-150"
    >
      {/*
        The mark, first thing in the bar.

        Deliberately NOT `no-drag`: it is decoration, not a control, and leaving it draggable
        keeps the top-left corner — the part people reach for to move a window — grabbable. A
        logo that swallows drags there is a window that feels stuck.
      */}
      <Mark className="mr-2 h-4 w-4 shrink-0 text-ink-2" aria-hidden />

      {/* On macOS the menus live in the system bar at the top of the screen; drawing a second
          set inside the window is the classic Electron-app tell. */}
      {!isMac &&
        menus.map((menu) => (
          <button
            key={menu.id}
            type="button"
            onClick={(event) => popup(menu.id, event)}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="rounded px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            {menu.label}
          </button>
        ))}

      {/* The command field is centred against the window, not against the menus, so it does
          not drift as menu labels change length. */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <button
          type="button"
          onClick={onOpenPalette}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className="pointer-events-auto flex h-6 w-96 max-w-[40vw] items-center gap-2 rounded-md border border-line bg-ide-code px-2 text-xs text-ink-3 transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          <span aria-hidden>⌕</span>
          <span className="truncate">Search files and commands</span>
          <kbd className="ml-auto font-mono text-[10px] text-ink-3">⌘K</kbd>
        </button>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        {/*
          The bell lives here rather than in the status bar, for two reasons that are both
          about this shell rather than about convention.

          The dropdown opens downward — `Menu` is `top-full mt-2` — so from a 22px strip at
          the bottom of the window it would render below the viewport entirely. And the
          status bar is documented as the quietest strip on screen, with "nothing clickable
          that is not obviously a control"; a panel that opens on click is not that.

          `no-drag` on the wrapper is load-bearing. This bar is the window's drag region, so
          without it the click lands on a drag surface and the window slides instead of the
          menu opening — reported as "I can't click the bell", which does not sound like a
          CSS property.
        */}
        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="mr-1">
          <NotificationBell size="sm" />
        </div>

        {/*
          The account, in the title bar because it belongs to the application rather than to
          either product.
          
          It used to be a section of Interview Prep, so editing your name meant going into the
          study product and lit its icon in the rail — as though the account were part of the
          curriculum. It is the same account whichever surface you are on, and the title bar is
          the one strip that is.
          
          `no-drag` for the same reason as the bell: this bar is the window's drag region, so
          without it a click slides the window instead of navigating.
        */}
        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="mr-1">
          <button
            type="button"
            onClick={() => router.push("/profile")}
            title="Account"
            aria-label="Account"
            aria-current={pathname.startsWith("/profile") ? "page" : undefined}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
              pathname.startsWith("/profile") ? "text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            <IconAccount size={16} />
          </button>
        </div>

        {(["left", "bottom", "right"] as const).map((panel) => (
          <button
            key={panel}
            type="button"
            onClick={() => onTogglePanel(panel)}
            aria-pressed={panels[panel]}
            /*
              The bottom panel is named for what is in it.

              "Toggle bottom panel" describes a position, which is only a useful label while the
              panel holds several unrelated things. It holds the terminal, and the terminal now
              starts closed — so this button is how most people will ever open one, and a button
              nobody recognises is a feature nobody finds. The other two keep positional names
              because the explorer and the workspace are genuinely defined by which side they are on.
            */
            title={panel === "bottom" ? "Terminal (Ctrl+J)" : `Toggle ${panel} panel`}
            aria-label={panel === "bottom" ? "Terminal" : `Toggle ${panel} panel`}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className={`rounded p-1 transition-colors hover:bg-ide-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
              panels[panel] ? "text-ink" : "text-ink-3"
            }`}
          >
            {panel === "bottom" ? (
              <IconTerminal size={16} />
            ) : (
              <PanelIcon panel={panel} filled={panels[panel]} />
            )}
          </button>
        ))}
      </div>

      {/*
        Flush to the right edge, outside the icon cluster's padding and gap.

        Caption buttons run to the very corner of the window — a gap there is the detail that
        makes a custom title bar read as a web page. macOS renders nothing: it keeps its
        traffic lights on the left, and the 78px inset above is what clears them.
      */}
      {!isMac && <WindowControls />}
    </header>
  );
}

/**
 * A 16px window glyph with one region filled to show which panel the button controls.
 *
 * Drawn rather than lettered because three text labels at this size are unreadable, and the
 * shape maps directly onto the layout it toggles — the same idiom every editor uses, which
 * is exactly why it needs no legend.
 */
function PanelIcon({ panel, filled }: { panel: PanelId; filled: boolean }) {
  const region =
    panel === "left"
      ? { x: 1.5, y: 2.5, width: 4, height: 11 }
      : panel === "right"
        ? { x: 10.5, y: 2.5, width: 4, height: 11 }
        : { x: 1.5, y: 10, width: 13, height: 3.5 };

  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
      <rect {...region} fill="currentColor" opacity={filled ? 0.9 : 0.35} />
    </svg>
  );
}
