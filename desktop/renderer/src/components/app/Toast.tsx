"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Transient confirmation for things that otherwise leave no trace.
 *
 * The bar for adding one is deliberately high, and most candidates do not clear it. Autosave
 * already reports itself in the editor toolbar and fires on every pause in typing, so a toast
 * there would be a notification every few seconds. Opening a project visibly fills the file
 * tree. Neither needs telling twice.
 *
 * What does clear the bar is a change with no visible consequence — applying a diff writes a
 * file on disk and the card that proposed it simply disappears — and a silent substitution,
 * like inline completion quietly using a different model than the one configured. A toast
 * system that fires for everything is worse than no toast system, because it trains you to
 * ignore it.
 */

export interface ToastMessage {
  id: number;
  text: string;
  /** Secondary line, for a detail that would crowd the message. */
  detail?: string;
  tone: "info" | "warn";
}

type Notify = (text: string, options?: { detail?: string; tone?: ToastMessage["tone"] }) => void;

const ToastContext = createContext<Notify>(() => {});

/** Long enough to read a sentence, short enough not to sit over the editor. */
const DISMISS_MS = 4200;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined);

  const notify = useCallback<Notify>((text, options) => {
    // One at a time, newest wins. A stack invites the thing above — many toasts — and the
    // messages here are confirmations, not a log; the older one has already been read or
    // was never going to be.
    setToast({
      id: Date.now(),
      text,
      ...(options?.detail !== undefined ? { detail: options.detail } : {}),
      tone: options?.tone ?? "info",
    });
  }, []);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), DISMISS_MS);
    // Keyed on the id so a replacement restarts the clock rather than inheriting the
    // remainder of the previous one's.
    return () => clearTimeout(timer);
  }, [toast]);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast !== undefined && (
        <div
          // `status` rather than `alert`: these confirm, they do not interrupt. `alert`
          // would preempt whatever a screen reader is currently saying for a message that
          // is, by design, not urgent.
          role="status"
          aria-live="polite"
          key={toast.id}
          className="glass-edge pointer-events-none fixed bottom-8 right-6 z-50 max-w-sm rounded-xl border border-line-strong bg-ide-panel/95 px-4 py-3 shadow-[var(--shadow-lift)] motion-safe:animate-toast-in supports-[backdrop-filter]:bg-white/[0.045] supports-[backdrop-filter]:backdrop-blur-xl"
        >
          <p
            className={`text-[13px] ${
              toast.tone === "warn" ? "text-diff-remove-ink" : "text-ink"
            }`}
          >
            {toast.text}
          </p>
          {toast.detail !== undefined && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-3">{toast.detail}</p>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
