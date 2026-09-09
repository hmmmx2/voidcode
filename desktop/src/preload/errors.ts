/**
 * Recovering the message main actually wrote.
 *
 * `ipcMain.handle` serialises a thrown error by stringifying it and prefixing the channel, so a
 * renderer receives:
 *
 *   Error invoking remote method 'agent:run': IpcError: No project is open
 *
 * Every panel that displays `err.message` was therefore showing exactly that to the user — a
 * channel name, an internal class name, and the actual sentence buried at the end. Main goes to
 * real trouble to produce messages worth reading; `IpcError` exists solely so that a handler can
 * say something specific rather than `${channel} failed`. All of it arrived wearing this.
 *
 * Split out of `index.ts` so it can be tested without executing the preload, which calls
 * `contextBridge` on import and cannot run under vitest.
 */

/** The wrapper Electron adds. The channel name is not something a user can act on. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;

/**
 * The class names that are ours and mean nothing outside this codebase.
 *
 * Deliberately only these two. A `TypeError` or `RangeError` reaching a user is a bug of ours,
 * and its name is the most useful part of the report — stripping it would make our own crashes
 * harder to read in exchange for tidiness nobody asked for.
 */
const INTERNAL_NAMES = /^(?:IpcError|Error):\s*/;

/**
 * What to say when there is genuinely nothing to say.
 *
 * A blank red line reads as a broken UI rather than as a failure, so an empty message is
 * replaced rather than passed along. Rare — it takes a handler throwing `new Error("")` — but
 * the fallback costs a line and the alternative is a panel that looks broken.
 */
const NO_DETAIL = "The request failed, with no further detail.";

export function unwrapIpcMessage(raw: string): string {
  // Channel prefix first: the wrapper itself begins with "Error invoking", so stripping names
  // first would eat the wrong half and leave "remote method 'x': …" behind.
  const withoutChannel = raw.replace(IPC_WRAPPER, "");
  const cleaned = withoutChannel.replace(INTERNAL_NAMES, "").trim();
  if (cleaned !== "") return cleaned;
  // Stripping produced nothing, so prefer whatever the original held before falling back.
  const original = raw.trim();
  return original === "" ? NO_DETAIL : original;
}

/**
 * Rethrow a rejected invoke carrying the message main meant.
 *
 * The original stays on `cause`, so anything debugging the transport still has the full string.
 * Custom properties — including `IpcError.code` — do not survive Electron's boundary, so the
 * text is all there is to work with.
 */
export function cleanError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const cleaned = new Error(unwrapIpcMessage(err.message), { cause: err });
  cleaned.name = "HostError";
  return cleaned;
}
