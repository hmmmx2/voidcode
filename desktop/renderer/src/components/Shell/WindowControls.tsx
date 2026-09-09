"use client";

import { useEffect, useState } from "react";

/**
 * Minimise, maximise and close, drawn by us.
 *
 * These used to be `titleBarOverlay` — the OS painting its own buttons over our bar in two
 * colours we nominate. That is a genuinely good trade and it is worth being clear about what
 * dropping it costs, because "just draw them yourself" is how apps end up with window controls
 * that feel subtly wrong:
 *
 *   **Metrics are not arbitrary.** 46×32 is the Windows 11 caption button, and the glyphs are
 *   1px strokes on a 10px box. Getting these wrong is the tell — a 16px icon in a 40px button
 *   reads as a web page pretending to be a title bar.
 *
 *   **Close is the only red one, and only on hover.** `#c42b1c` is the system accent for it.
 *   A control that is red at rest looks like an error state.
 *
 *   **Snap Layouts are lost.** Hovering the OS maximise button on Windows 11 opens the layout
 *   picker; a custom button cannot, because that menu is owned by the shell and is only offered
 *   for a real caption button. Users who rely on it keep Win+Z. This is the one real regression
 *   and it is worth stating rather than discovering.
 *
 * What is *not* lost: the window still has a frame, so edge-drag resizing, double-click-to-
 * maximise on the drag region, and Aero Snap all still work — `titleBarStyle: "hidden"` removes
 * the bar, not the frame. `frame: false` would have taken those too.
 *
 * macOS never reaches this component: it keeps its traffic lights, and overriding those breaks
 * muscle memory and the accessibility affordances attached to them.
 */

/** Windows 11 caption metrics. Not a guess — matching them is most of what makes this read right. */
const BUTTON = "flex h-9 w-[46px] items-center justify-center transition-colors";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  /**
   * Subscribed for the component's whole life.
   *
   * Main pushes on `maximize`/`unmaximize` and once after load, so a window restored maximised
   * draws the restore glyph immediately rather than after the user happens to toggle it.
   */
  useEffect(() => {
    const off = window.host?.onWindowState?.((state) => setMaximized(state.maximized));
    return off;
  }, []);

  const host = typeof window === "undefined" ? undefined : window.host;
  if (host?.window === undefined) return null;

  return (
    // `no-drag` on the container: every pixel here is a target, and a drag region overlapping a
    // caption button means the window slides instead of closing.
    <div
      className="flex items-center"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="Minimise"
        onClick={() => void host.window.minimize()}
        className={`${BUTTON} text-ink-2 hover:bg-ide-raised`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximise"}
        onClick={() => void host.window.toggleMaximize()}
        className={`${BUTTON} text-ink-2 hover:bg-ide-raised`}
      >
        {maximized ? (
          // Two offset rectangles — the standard "restore down" glyph.
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>

      <button
        type="button"
        aria-label="Close"
        onClick={() => void host.window.close()}
        // The only control that changes colour, and only on hover. `#c42b1c` is the system
        // accent for a destructive caption button; white-on-red is what makes it unmistakable.
        className={`${BUTTON} text-ink-2 hover:bg-[#c42b1c] hover:text-white`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
