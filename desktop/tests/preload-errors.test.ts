/**
 * What a failed channel call says to the user.
 *
 * Main takes real trouble over these messages — `IpcError` exists so a handler can say
 * something specific instead of `${channel} failed` — and every one of them was arriving
 * wrapped in Electron's transport noise:
 *
 *   Error invoking remote method 'agent:run': IpcError: No project is open
 *
 * That is what the agent panel rendered, in red, to someone whose only mistake was not having
 * opened a folder.
 */
import { describe, it, expect } from "vitest";
import { unwrapIpcMessage, cleanError } from "../src/preload/errors.js";

describe("unwrapping", () => {
  it("recovers the sentence main wrote", () => {
    expect(
      unwrapIpcMessage("Error invoking remote method 'agent:run': IpcError: No project is open")
    ).toBe("No project is open");
  });

  it("strips a plain Error the same way", () => {
    expect(
      unwrapIpcMessage("Error invoking remote method 'fs:read': Error: ENOENT: no such file")
    ).toBe("ENOENT: no such file");
  });

  it("leaves a message that was never wrapped alone", () => {
    // Errors raised inside the preload itself never go through the transport.
    expect(unwrapIpcMessage("pty:spawn: main did not transfer a port")).toBe(
      "pty:spawn: main did not transfer a port"
    );
  });

  it("keeps the name of an error that is not ours", () => {
    /**
     * A `TypeError` reaching a user is a bug of ours, and the class name is the most useful
     * part of the report. Stripping it would make our own crashes harder to read in exchange
     * for tidiness nobody asked for.
     */
    expect(
      unwrapIpcMessage("Error invoking remote method 'x:y': TypeError: z is not a function")
    ).toBe("TypeError: z is not a function");
  });

  it("does not eat the wrapper's own leading Error", () => {
    // The wrapper text begins with "Error invoking", so stripping class names first would
    // leave "remote method 'x': …" behind.
    expect(unwrapIpcMessage("Error invoking remote method 'a:b': IpcError: gone")).not.toContain(
      "remote method"
    );
  });

  it("never returns an empty string", () => {
    // A blank red line reads as a broken UI rather than as a failure with no detail.
    expect(unwrapIpcMessage("Error invoking remote method 'a:b': Error: ")).not.toBe("");
    expect(unwrapIpcMessage("   ")).not.toBe("");
  });

  it("handles a channel name containing a colon, which all of them do", () => {
    expect(
      unwrapIpcMessage("Error invoking remote method 'agent:applyDiffs': IpcError: nope")
    ).toBe("nope");
  });
});

describe("cleanError", () => {
  it("returns an Error carrying the readable message", () => {
    const cleaned = cleanError(
      new Error("Error invoking remote method 'agent:run': IpcError: No project is open")
    );
    expect(cleaned.message).toBe("No project is open");
  });

  it("keeps the original on cause, so the transport is still debuggable", () => {
    const original = new Error("Error invoking remote method 'x:y': IpcError: boom");
    expect(cleanError(original).cause).toBe(original);
  });

  it("survives a rejection that is not an Error at all", () => {
    expect(cleanError("just a string").message).toBe("just a string");
    expect(cleanError(undefined).message).toBe("undefined");
  });
});
