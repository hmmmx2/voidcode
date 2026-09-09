/**
 * One `pty:spawn` in flight at a time.
 *
 * **This is a guard around a real bug in the preload, not a performance measure.**
 *
 * `src/preload/index.ts` resolves every streaming channel by listening on a single fixed reply
 * channel — `` `${channel}:port` `` — with `ipcRenderer.once`. There is no correlation id, so the
 * first reply to arrive is handed to whichever call is listening, not to the call it belongs to.
 *
 * With one terminal per window that is invisible: there is only ever one listener. A dock that
 * opens up to eight makes it reachable — double-click "+" and two `pty.spawn()` calls race on
 * `pty:spawn:port`, and one of them can be handed the other's MessagePort. The symptom would be
 * two tabs driving one shell while a second shell runs with nothing attached to it.
 *
 * Serialising here fixes it for terminals without touching the security boundary. The same latent
 * bug exists for `chat:open` and `agent:open`, which open one at a time and so
 * cannot currently reach it; the correlation-id fix in the preload is its own change, because that
 * file is generated from the contract and is the boundary the whole mode gate rests on.
 *
 * **Failures do not break the chain.** A spawn that rejects — "open a project first" arrives that
 * way — must not leave every later spawn queued behind a rejected promise, so the chain is
 * advanced by a caught copy while the original rejection still reaches the caller.
 */

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `spawn` once every earlier call has settled.
 *
 * Takes a thunk rather than a promise: a promise passed in has already started, which is the
 * thing being prevented.
 */
export function spawnSerialised<T>(spawn: () => Promise<T>): Promise<T> {
  const result = chain.then(spawn);

  // The chain advances on a *neutralised* copy, and that is the load-bearing line. Assigning
  // `result` directly would leave a rejected promise as the tail, so every later spawn would
  // wait on something already broken — one "open a project first" and the dock could not open a
  // terminal again for the life of the window. The original rejection still reaches its own
  // caller through `result`; only the queue forgets it.
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Exported for tests, which would otherwise leak a chain from one case into the next. */
export function __resetSpawnQueue(): void {
  chain = Promise.resolve();
}
