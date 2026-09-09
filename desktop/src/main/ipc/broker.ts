/**
 * The IPC broker — the one place a renderer request crosses into privilege.
 *
 * Every request passes three gates, in this order, before a handler sees it:
 *
 *   1. Origin      the sender must be a window we registered a mode for
 *   2. Mode        the channel must be callable from that window's mode (§2.2)
 *   3. Shape       the payload must satisfy the channel's zod schema (§2.3)
 *
 * Order matters. Mode is checked before shape so that a Study window probing
 * `fs:read` is denied on privilege grounds regardless of what it sends — the
 * refusal must not depend on the attacker getting the payload shape right, and
 * the error must not tell them what shape would have been accepted.
 *
 * This is the second of two independent barriers. The first is the preload,
 * which never exposes a Build-only namespace to a Study window at all (see
 * `preload/index.ts`). Defence in depth: the preload keeps honest code from
 * calling the wrong thing, the broker keeps compromised code from doing it.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { logError } from "../log.js";
import {
  CHANNELS,
  channelSpec,
  specAllowsMode,
  type ChannelName,
  type ChannelInput,
} from "./contract.js";
import { modeOf, type WindowMode } from "../modes.js";

export interface HandlerContext {
  mode: WindowMode;
  sender: WebContents;
}

export type ChannelHandler<C extends ChannelName> = (
  input: ChannelInput<C>,
  ctx: HandlerContext
) => Promise<unknown>;

/**
 * Error codes crossing to the renderer.
 *
 * Messages are deliberately terse and identical in structure for every denial.
 * A renderer learns *that* it was refused, never why in a way that maps out the
 * privilege table for it.
 */
export type IpcErrorCode =
  | "E_UNKNOWN_CHANNEL"
  | "E_NO_MODE"
  | "E_MODE_DENIED"
  | "E_BAD_INPUT"
  | "E_HANDLER_FAILED"
  /**
   * Domain outcomes, not privilege ones — safe to describe, and describing them is the
   * point.
   *
   * The rule above is about the privilege table: a renderer must not be able to map what it
   * is forbidden from doing. "There is no question with that slug" and "no model is
   * installed" give away nothing about privilege, and withholding them produces the worse
   * outcome — a 500 that sends someone looking for a bug instead of starting Ollama.
   *
   * These exist because the catch-all below replaces every handler message with
   * `${channel} failed`. An `IpcError` is rethrown untouched, so it is the only way a
   * handler can say anything specific. A seam route matching on the text of an ordinary
   * `Error` is matching on a string that never arrives.
   */
  | "E_NOT_FOUND"
  | "E_UNAVAILABLE"
  /**
   * The request was well-formed and the caller may act — but not through this door.
   *
   * Distinct from `E_BAD_INPUT` on purpose. An agent-proposed diff arriving at `fs:commitDiff`
   * carries a perfectly valid id; what is wrong is the route, and the correct one exists
   * (`agent:applyDiffs`, behind a native dialog). Reporting that as bad input would invite a
   * caller to "fix" its arguments and retry, and reporting it as a generic failure would make
   * a deliberate refusal look like a transient error worth retrying.
   *
   * Safe to describe for the same reason `E_NOT_FOUND` is: it reveals nothing about the
   * privilege table, only about which of two known channels to use.
   */
  | "E_WRONG_ROUTE";

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IpcError";
  }
}

const handlers = new Map<ChannelName, ChannelHandler<ChannelName>>();

/**
 * Attach the implementation for a channel.
 *
 * Registering an unknown channel throws, so a typo in a handler file fails at
 * startup rather than becoming a silently unreachable endpoint.
 */
export function setHandler<C extends ChannelName>(channel: C, handler: ChannelHandler<C>): void {
  if (!(channel in CHANNELS)) {
    throw new Error(`Cannot register handler for unknown channel "${channel}"`);
  }
  if (handlers.has(channel)) {
    throw new Error(`Handler for "${channel}" is already registered`);
  }
  handlers.set(channel, handler as ChannelHandler<ChannelName>);
}

/**
 * Run the three gates and dispatch. Exported for tests so the gate logic can be
 * exercised without an Electron window — the mode-gate test in `tests/` drives
 * this directly with a stub WebContents.
 */
export async function dispatch(
  channel: string,
  rawInput: unknown,
  sender: WebContents
): Promise<unknown> {
  // Gate 1 — is this even a channel?
  //
  // `channelSpec` rather than a lookup here, because the safe-lookup rule (own
  // properties only, since `CHANNELS["__proto__"]` is `Object.prototype` and not
  // undefined) is the gate's own logic and used to be written out twice. See the
  // block above `channelSpec` in `contract.ts` for why the duplicate was a hazard.
  const spec = channelSpec(channel);
  if (spec === undefined) {
    throw new IpcError("E_UNKNOWN_CHANNEL", `No such channel: ${channel}`);
  }

  // Gate 2 — does the calling window have a mode, and may that mode call this?
  const mode = modeOf(sender);
  if (mode === undefined) {
    // Either an unregistered window or a message that arrived after teardown.
    // Both are deny: a request with no provenance has no privilege.
    throw new IpcError("E_NO_MODE", `Sender has no registered mode; refusing ${channel}`);
  }
  if (!specAllowsMode(spec, mode)) {
    throw new IpcError("E_MODE_DENIED", `Channel ${channel} is not available in ${mode} mode`);
  }

  // Gate 3 — shape.
  const parsed = spec.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new IpcError("E_BAD_INPUT", `Invalid payload for ${channel}`);
  }

  const handler = handlers.get(channel as ChannelName);
  if (handler === undefined) {
    // A channel declared in the contract with no implementation. Distinct from
    // E_UNKNOWN_CHANNEL: this is our bug, not the caller's.
    throw new IpcError("E_HANDLER_FAILED", `Channel ${channel} has no handler`);
  }

  return handler(parsed.data, { mode, sender });
}

/**
 * Bind every contract channel to `ipcMain`.
 *
 * Note this installs handlers for *all* channels including Build-only ones. The
 * gate is per-request and keyed on the calling window, not per-registration —
 * one `ipcMain` registry is shared by every window, so a channel cannot be
 * registered "only for Build windows" at this layer. That is precisely why gate
 * 2 exists.
 */
export function installBroker(): void {
  for (const channel of Object.keys(CHANNELS)) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
      try {
        return await dispatch(channel, rawInput, event.sender);
      } catch (err) {
        if (err instanceof IpcError) throw err;
        /**
         * The stack stops here, and this is the only place it is kept.
         *
         * The renderer gets `${channel} failed` and nothing else — an internal stack trace
         * crossing the boundary is the leak this catch exists to prevent. But that generic
         * message is also useless to whoever has to fix it, so the real error goes to the
         * log with the channel that produced it. The two halves are deliberate: the renderer
         * learns that something failed, the file learns what.
         */
        logError("ipc", err, { channel });
        throw new IpcError("E_HANDLER_FAILED", `${channel} failed`);
      }
    });
  }
}

/** Test seam. */
export function __resetHandlers(): void {
  handlers.clear();
}
