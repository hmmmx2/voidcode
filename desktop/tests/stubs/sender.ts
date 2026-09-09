/**
 * A stand-in for the `WebContents` that identifies a window.
 *
 * Since the project root became per-window, every path-resolving function takes the sender
 * whose grant it is resolving against. Tests need one, and they need *two* to say anything
 * interesting — one window's root must be unreachable from another.
 *
 * Standalone rather than part of `stubs/electron.ts` because the suites mock `electron`
 * differently (some import the stub module, some inline a `vi.mock` factory), and a sender is
 * useful in all of them.
 *
 * Only `id` and `once` are real, because that is all `workspace.ts` touches: it keys the map
 * by `id` and registers a `destroyed` listener. Anything else is deliberately absent so a test
 * that starts depending on real Electron behaviour fails loudly rather than passing against a
 * no-op — the same rule `stubs/electron.ts` states.
 */
import type { WebContents } from "electron";

export interface FakeSender {
  id: number;
  once(event: string, listener: () => void): void;
  /** Fire the `destroyed` listeners, so cleanup can be tested without a real window. */
  destroy(): void;
}

let nextId = 1;

export function fakeSender(): FakeSender & WebContents {
  const listeners: Array<() => void> = [];
  const sender = {
    // Monotonic and never reused, matching the property `modes.ts` and `workspace.ts` both
    // rely on: a late message from a dead window must resolve to nothing, not to whoever
    // occupies that slot next.
    id: nextId++,
    once(event: string, listener: () => void): void {
      if (event === "destroyed") listeners.push(listener);
    },
    destroy(): void {
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return sender as FakeSender & WebContents;
}
