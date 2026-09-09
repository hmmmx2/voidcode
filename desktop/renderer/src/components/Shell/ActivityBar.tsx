"use client";

import { DESTINATIONS, type DestinationId } from "@/lib/shell/destinations";
import { IconModel, IconSettings } from "@/components/icons";

/**
 * The icon rail. Two products and a settings anchor.
 *
 * Selected state is a 2px left rule in the accent plus a full-opacity icon — never a filled
 * background. The rail is the quietest surface in the app and it is on screen every second
 * you are not looking at it; a filled pill there competes with the editor permanently.
 */

interface ActivityBarProps {
  /**
   * The lit destination, or `null` for a route that belongs to no product.
   *
   * Account is the case: it is platform-level, so lighting a product icon there would claim
   * you are somewhere you are not. Before this it fell through to the first destination and
   * the rail said Code while you were editing your name.
   */
  active: DestinationId | null;
  /**
   * Whether the destination's section list is currently showing.
   *
   * Only used for the tooltip. Clicking the destination you are already in toggles that panel
   * instead of re-navigating, and a rail icon that silently does two different things
   * depending on where you are needs to say which one it will do.
   */
  sidebarOpen: boolean;
  onSelect: (destination: DestinationId) => void;
  onOpenSettings: () => void;
  /** Platform route, so it is passed separately from `onSelect`'s destinations. */
  onOpenModels: () => void;
  /** Whether `/models` is the current route, so the rail can mark it. */
  onModelsRoute: boolean;
}

export const ACTIVITY_BAR_WIDTH = 48;

export default function ActivityBar({
  active,
  sidebarOpen,
  onSelect,
  onOpenSettings,
  onOpenModels,
  onModelsRoute,
}: ActivityBarProps) {
  return (
    <nav
      style={{ width: ACTIVITY_BAR_WIDTH }}
      aria-label="Destinations"
      // Same reasoning as the menu bar: chrome over the backdrop, so glass has something to
      // sample. The panels it borders stay opaque.
      className="glass-edge relative flex shrink-0 flex-col items-center border-r border-line bg-ide-panel/95 py-2 supports-[backdrop-filter]:bg-white/[0.02] supports-[backdrop-filter]:backdrop-blur-xl"
    >
      {DESTINATIONS.map((destination) => (
        <button
          key={destination.id}
          type="button"
          onClick={() => onSelect(destination.id)}
          aria-current={active === destination.id ? "page" : undefined}
          title={
            // The IDE has no section list — its left panel is the file tree, which it owns —
            // so clicking its icon while you are in it navigates rather than toggling, and
            // promising "Hide" there would be a lie.
            active === destination.id && destination.sections.length > 0
              ? `${destination.label} — ${sidebarOpen ? "Hide" : "Show"} sidebar`
              : destination.label
          }
          className={`relative flex h-12 w-12 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink ${
            active === destination.id ? "text-ink" : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {active === destination.id && (
            <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 bg-ink" />
          )}
          <DestinationIcon id={destination.id} />
        </button>
      ))}

      {/*
        Models, above Settings and below the destinations.
        
        A platform button, not a destination. `/models` belongs to neither product — the same
        weights serve the IDE and the study app — so it lights no destination rule and does not
        join `DestinationId`, which stays a closed two-member union that `PanelsProvider` and
        `destinationForPath` are built on. The gear beside it has worked this way since the
        rail existed; this is the second of its kind rather than a new idea.
        
        `aria-current` because unlike the gear, this rail item has a route you can be *on*.
      */}
      <button
        type="button"
        onClick={onOpenModels}
        aria-current={onModelsRoute ? "page" : undefined}
        title="Models"
        className={`relative mt-auto flex h-12 w-12 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink ${
          onModelsRoute ? "text-ink" : "text-ink-3 hover:text-ink-2"
        }`}
      >
        {onModelsRoute && (
          <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 bg-ink" />
        )}
        <IconModel size={20} />
      </button>

      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings"
        className="flex h-12 w-12 items-center justify-center text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
      >
        <IconSettings size={20} />
      </button>
    </nav>
  );
}

/**
 * The two destination glyphs, drawn inline.
 *
 * These stay local because they are this component's own vocabulary — layers for the
 * curriculum, angle brackets for the editor — and nothing else draws them. The gear moved to
 * `components/icons` because two different gears had appeared in two files, which is the
 * problem a shared set exists to prevent. The SVG assets in `public/icons` remain unusable
 * either way: compound files with embedded text paths, sized for buttons rather than a rail.
 */
function DestinationIcon({ id }: { id: DestinationId }) {
  if (id === "prep") {
    // Stacked layers: the curriculum.
    return (
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
        <path
          d="M11 3 3 7l8 4 8-4-8-4Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="m3 11 8 4 8-4M3 15l8 4 8-4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Angle brackets: the editor.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path
        d="m8 7-4 4 4 4M14 7l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
