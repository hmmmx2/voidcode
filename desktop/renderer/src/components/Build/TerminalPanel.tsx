"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { spawnSerialised } from "@/lib/build/pty-spawn";
import { TERMINAL_THEME } from "@/lib/build/terminal-theme";
// Static, not dynamic: a CSS import has no runtime value to await, and Next resolves it at
// build time into the stylesheet rather than a module.
import "@xterm/xterm/css/xterm.css";

/**
 * A real shell, in the bottom dock.
 *
 * `pty:spawn` was declared in the contract with no handler, and the Terminal menu carried two
 * hardcoded `enabled: false` placeholders admitting it. This is the other end of the handler
 * that replaced them.
 *
 * xterm is loaded dynamically, for the same reason Monaco is: it touches `document` at import
 * time, and this file is prerendered in Node by the static export. A static import turns the
 * build into a "document is not defined" failure. The two `import type`s above are erased.
 *
 * THE DOM RENDERER, NOT WEBGL. The canvas and WebGL addons are faster at sizes far beyond a
 * dock panel, and both would raise questions about `blob:` workers under the app's CSP. The
 * DOM renderer needs nothing the policy does not already allow.
 *
 * **ONE PANEL PER SHELL, AND IT MUST NOT UNMOUNT.** Cleanup calls `handle.close()`, which closes
 * the MessagePort, which is what main watches to kill the child — closing the port and the shell
 * going with it *is* the lifecycle. So the dock keeps every pane mounted and hides the inactive
 * ones with `hidden`; a tab control that unmounts its inactive children, which is what Radix
 * `TabsContent` does, would kill every terminal you were not looking at.
 *
 * That is also why `term`, `fit` and `handle` are refs. They used to be locals inside the async
 * IIFE below, reachable from cleanup only through the `dispose` closure, which was fine when the
 * panel had nothing to say to itself after mounting. Refitting on activation and clearing on
 * command both need to reach the live terminal from a different effect.
 */

interface TerminalHandle {
  send(message: unknown): void;
  onChunk(callback: (chunk: unknown) => void): void;
  close(): void;
}

type Incoming =
  | { t: "data"; d: string }
  | { t: "exit"; code: number; signal: number | null };

export default function TerminalPanel({
  active,
  clearNonce,
  onClosed,
  onExit,
  onFlush,
}: {
  /** Is this the pane on screen? Hidden panes keep running; they just stop being measured. */
  active: boolean;
  /**
   * Bumped by `terminal.clear`. A counter rather than an imperative handle, so the dock does not
   * have to hold a ref into a component it only renders.
   */
  clearNonce: number;
  onClosed?: () => void;
  /**
   * The shell ended, and why.
   *
   * Already known here — `setExited` renders it in the pane — but a pane you have switched away
   * from is `hidden`, so a build that failed in a background terminal left no trace anywhere.
   * This is what puts it in Output.
   */
  onExit?: (code: number, signal: number | null) => void;
  /** Write any unsaved buffers before this terminal sees input. See `onData` below. */
  onFlush?: () => void;
}) {
  // See the dependency note on the spawning effect below.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const handleRef = useRef<TerminalHandle | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [exited, setExited] = useState<number>();

  /**
   * `active`, readable from the spawn effect without being a dependency of it.
   *
   * Putting `active` in those deps would tear down the pty and spawn a new one every time you
   * switched tabs, which is the exact failure this component is arranged to avoid.
   */
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;

    void (async () => {
      const host = window.host;
      if (host?.pty === undefined) {
        setError("Terminals are not available in this window.");
        return;
      }

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || mountRef.current === null) return;

      const term = new Terminal({
        fontSize: 13,
        fontFamily: "var(--font-jetbrains-mono), monospace",
        theme: { ...TERMINAL_THEME },
        cursorBlink: true,
        // The scrollback a real session needs; xterm's default of 1000 loses a build log.
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mountRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      let handle: TerminalHandle;
      try {
        // Serialised: the preload matches port replies by channel name alone, so two spawns in
        // flight can be handed each other's port. See `pty-spawn.ts`.
        handle = (await spawnSerialised(() =>
          host.pty!.spawn({ cols: term.cols, rows: term.rows })
        )) as unknown as TerminalHandle;
      } catch (err) {
        // "open a project first" arrives here, named, because main throws it as an IpcError.
        setError(err instanceof Error ? err.message : String(err));
        term.dispose();
        termRef.current = undefined;
        fitRef.current = undefined;
        return;
      }

      if (disposed) {
        handle.close();
        term.dispose();
        termRef.current = undefined;
        fitRef.current = undefined;
        return;
      }
      handleRef.current = handle;

      handle.onChunk((raw) => {
        const message = raw as Incoming;
        if (message.t === "data") term.write(message.d);
        else if (message.t === "exit") {
          setExited(message.code);
          onExitRef.current?.(message.code, message.signal);
          onClosed?.();
        }
      });

      term.onData((data) => {
        // The first keystroke into a terminal is almost always the start of a command that
        // reads the file you were just editing. Flushing here — not only when the panel opens
        // — covers a terminal that was already open when you switched back to it.
        //
        // Fire-and-forget rather than awaited: blocking the keystroke on a disk write would
        // make typing feel like it stutters, and the write is fast enough to land well before
        // Enter. `onFlush` is optional so this component stays usable without a coordinator.
        onFlush?.();
        handle.send({ t: "data", d: data });
      });

      // Refit on resize, and tell the pty — otherwise the shell keeps wrapping at the old
      // width and every long line looks corrupted.
      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
          handle.send({ t: "resize", cols: term.cols, rows: term.rows });
        } catch {
          // Fires while the panel is collapsing to zero height; nothing to do.
        }
      });
      observer.observe(mountRef.current);

      if (activeRef.current) term.focus();

      dispose = () => {
        observer.disconnect();
        handle.close();
        term.dispose();
        termRef.current = undefined;
        fitRef.current = undefined;
        handleRef.current = undefined;
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
    // `onExit` is deliberately absent from these deps and read through a ref instead.
    //
    // The dock passes it as an inline arrow so it can name the tab — a new function identity on
    // every render. In the dependency array that re-runs this effect constantly, and this effect
    // spawns the pty: the shell was being killed and respawned on almost every render, which
    // looked exactly like "the terminal does not survive collapsing the dock". `onClosed` and
    // `onFlush` are stable `useCallback`s, which is why they can stay.
  }, [onClosed, onFlush]);

  /**
   * Re-measure when this pane becomes the visible one.
   *
   * `ResizeObserver` does not fire for `display: none → block`: the element had no box, so as far
   * as the observer is concerned nothing resized. Without this, a terminal opened while hidden
   * keeps the 80x24 it was constructed with and wraps every line in the wrong place.
   *
   * In a frame callback because the pane is still `hidden` when the effect runs — measuring now
   * gives zero, and `fit()` on a zero box throws.
   */
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (term === undefined || fit === undefined) return;
      try {
        fit.fit();
        handleRef.current?.send({ t: "resize", cols: term.cols, rows: term.rows });
        term.focus();
      } catch {
        // Same zero-height case the observer guards against.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  /**
   * `terminal.clear`, applied to the pane you are looking at and no other.
   *
   * The nonce is consumed whether or not this pane is active. Without that, switching to a
   * background terminal later would re-run this effect with a nonce it had never seen and clear a
   * buffer the command was never aimed at.
   */
  const seenClear = useRef(clearNonce);
  useEffect(() => {
    if (clearNonce === seenClear.current) return;
    seenClear.current = clearNonce;
    if (active) termRef.current?.clear();
  }, [clearNonce, active]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ide-code">
      {error !== undefined && (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <span className="text-xs text-ink-3">{error}</span>
        </div>
      )}

      {exited !== undefined && (
        <div className="border-b border-line px-3 py-1 text-[11px] text-ink-3">
          Shell exited with code {exited}. Open a new terminal to continue.
        </div>
      )}

      {/* Kept mounted even on error, so xterm always has the node it was handed. */}
      <div
        ref={mountRef}
        className={error !== undefined ? "hidden" : "min-h-0 flex-1 px-2 py-1"}
      />
    </div>
  );
}
