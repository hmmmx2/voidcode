"use client";

import Link from "next/link";
import type { Destination } from "@/lib/shell/destinations";

/**
 * The secondary sidebar: the views inside the selected destination.
 *
 * This is where Dashboard, Problems, Interviews and Projects live now. They were peer items
 * in a top nav beside Code, which put three views of one product on the same row as an
 * entire second product — so the nav said they were four equivalent things when they are
 * not.
 */

export const SECTION_SIDEBAR_WIDTH = 240;

interface SectionSidebarProps {
  destination: Destination;
  pathname: string;
  counts: Partial<Record<"problems" | "interviews" | "projects", number>>;
  /** Hide the whole panel. Owned by the shell, because the width is not this component's. */
  onCollapse: () => void;
}

export default function SectionSidebar({
  destination,
  pathname,
  counts,
  onCollapse,
}: SectionSidebarProps) {
  return (
    <aside
      style={{ width: SECTION_SIDEBAR_WIDTH }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-ide-panel"
    >
      {/*
        The header is the collapse control, not a label above one.

        A disclosure triangle beside a title invites a hunt for the hit area; the whole row
        being the button means there is nothing to aim at.

        It hides the panel outright rather than just the list. Hiding only the list left a
        240px empty column between the rail and the editor — the space the gesture was asking
        for was still being held, which reads as a rendering fault rather than a choice. So
        this is not a disclosure and deliberately carries no `aria-expanded`: nothing stays
        behind to expand. The way back is the rail icon for this destination, which is always
        on screen, plus the title bar toggle and its shortcut — all three the same state.
      */}
      <div className="border-b border-line">
        <button
          type="button"
          onClick={onCollapse}
          title={`Hide ${destination.label}`}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-ide-bar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
        >
          {/* Pointing at the rail it collapses toward, rather than a disclosure chevron that
              would promise the list is still there under a twisty. */}
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0 text-ink-3">
            <path
              d="M7 1L3 5l4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h2 className="truncate text-xs font-medium uppercase tracking-wide text-ink-3">
            {destination.label}
          </h2>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-1">
        {destination.sections.map((section) => {
          // `startsWith` on everything but the dashboard, so `/problems/3` keeps Problems lit
          // while you are inside an exercise. An exact match there because `/homepage` is a
          // leaf and would otherwise never deactivate.
          const active =
            section.href === "/homepage"
              ? pathname === section.href
              : pathname.startsWith(section.href);
          const count = section.countKey === undefined ? undefined : counts[section.countKey];

          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink ${
                active ? "bg-ide-raised text-ink" : "text-ink-2 hover:bg-ide-bar"
              }`}
            >
              <span className="truncate">{section.label}</span>
              {count !== undefined && (
                // The only numbers in the rail. They do real work: they say there is
                // something in there without your having to click.
                <span className="ml-auto font-mono text-xs text-ink-3">{count}</span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
