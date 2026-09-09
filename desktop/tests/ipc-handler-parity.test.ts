/**
 * Every channel in the contract has a handler.
 *
 * `broker.ts` already knows this can go wrong — the miss is caught at dispatch time with a
 * message that says outright *"this is our bug, not the caller's"*. But that is runtime, and the
 * moment it runs is when a user clicks the thing. Between adding a channel and someone pressing
 * the button, nothing objects: the contract typechecks, the preload generates a namespace for it,
 * and the whole suite stays green.
 *
 * **That is not hypothetical. Four `preview:*` channels were added with no handlers and 1490
 * tests passed**, which is what this test exists because of. The failure it prevents is a button
 * that throws `E_HANDLER_FAILED` in a feature that otherwise looks finished.
 *
 * Parsed from source rather than imported, for the same reason `agent-event-parity.test.ts` is:
 * `handlers/index.ts` reaches Electron, SQLite and the model registry at import time, and
 * standing all of that up to learn which strings appear in it would be a far heavier test that
 * could fail for reasons having nothing to do with the property.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../src/main/ipc/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.join(HERE, "..", relative), "utf8");

const CONTRACT = "src/main/ipc/contract.ts";
const HANDLERS = "src/main/ipc/handlers/index.ts";

/**
 * The channel names, taken from the table's own keys.
 *
 * Anchored to two-space indentation so the keys of the *table* are matched and not every quoted
 * `namespace:method` string that appears in a comment — and this file has many, because the
 * comments explain what each channel does.
 */
function declaredChannels(): string[] {
  const source = read(CONTRACT);
  return [...source.matchAll(/^ {2}"([a-z]+:[a-zA-Z]+)":/gm)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined);
}

function handledChannels(): string[] {
  const source = read(HANDLERS);
  return [...source.matchAll(/setHandler\(\s*"([a-z]+:[a-zA-Z]+)"/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined);
}

describe("the IPC contract and its handlers", () => {
  it("finds channels to check at all", () => {
    // If either matcher silently stops matching, every assertion below passes vacuously —
    // which is the failure mode of a test that parses source.
    expect(declaredChannels().length).toBeGreaterThan(50);
    expect(handledChannels().length).toBeGreaterThan(50);
  });

  it("implements every channel it declares", () => {
    const handled = new Set(handledChannels());
    const missing = declaredChannels().filter((channel) => !handled.has(channel));

    expect(
      missing,
      `declared in ${CONTRACT} with no setHandler in ${HANDLERS}: these throw ` +
        "E_HANDLER_FAILED the first time a user clicks them"
    ).toEqual([]);
  });

  it("declares every channel it implements", () => {
    /**
     * The other direction, which fails differently and worse.
     *
     * `dispatch` rejects an undeclared channel with `E_UNKNOWN_CHANNEL` before it ever looks
     * for a handler, so a handler registered for a channel the contract does not list is dead
     * code that *looks* live — and, being absent from the contract, it also has no mode gate
     * and no input schema. It cannot be reached, but the thing to fix is the contract, not the
     * handler.
     */
    const declared = new Set(declaredChannels());
    const orphans = handledChannels().filter((channel) => !declared.has(channel));

    expect(orphans, `handled but not declared in ${CONTRACT}`).toEqual([]);
  });

  it("registers each channel exactly once", () => {
    // `setHandler` overwrites, so a duplicate silently wins and the other implementation is
    // dead — with no error at either registration.
    const seen = new Map<string, number>();
    for (const channel of handledChannels()) seen.set(channel, (seen.get(channel) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);

    expect(duplicates, "registered more than once; the later one silently wins").toEqual([]);
  });

  it("lets an argument-less channel be called with no argument", () => {
    /**
     * The preload's generated method is `(arg?: unknown) => ipcRenderer.invoke(channel, arg)`,
     * so `host.preview.detect()` sends `undefined`. A schema of `z.object({}).strict()` accepts
     * `{}` and rejects that — the call fails with "Invalid payload" before any handler runs, and
     * nothing in the unit tests notices because they call `dispatch` directly with a payload of
     * their own choosing. Five `preview:*` channels shipped that way and it took driving the
     * real app to find.
     *
     * **Narrowed to schemas that declare no keys at all**, which is the precise defect. A first
     * version flagged anything accepting `{}`, and caught five working channels —
     * `notifications:list` and friends declare *optional* fields, so passing `{}` is the natural
     * call and every one of their callers does. A channel with an empty shape declares no input
     * whatsoever, so `channel()` is the only call anyone would write.
     */
    const offenders = Object.entries(CHANNELS)
      .filter(([, spec]) => {
        const shape = (spec.input as { _def?: { shape?: unknown } })._def?.shape;
        // A ZodObject exposes its keys as a thunk in older zod and an object in newer; both
        // resolve to the declared shape, and anything that is not an object schema has none.
        const resolved = typeof shape === "function" ? (shape as () => object)() : shape;
        return typeof resolved === "object" && resolved !== null && Object.keys(resolved).length === 0;
      })
      .filter(([, spec]) => !spec.input.safeParse(undefined).success)
      .map(([name]) => name);

    expect(
      offenders,
      "these need no arguments but reject a call made without one — use z.undefined()"
    ).toEqual([]);
  });
});
