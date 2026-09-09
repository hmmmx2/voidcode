/**
 * Terminal tabs, and the spawn queue standing in front of a preload bug.
 *
 * Both are pure modules on purpose. "Closing the active tab picks a sensible neighbour" and "two
 * spawns never overlap" are claims about arithmetic and ordering, and neither should need a
 * workspace mounted to ask.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_TERMINALS,
  atCapacity,
  closeTerminal,
  emptyTerminals,
  focusTerminal,
  openTerminal,
  type TerminalState,
} from "../renderer/src/lib/build/useTerminals.js";
import {
  __resetSpawnQueue,
  spawnSerialised,
} from "../renderer/src/lib/build/pty-spawn.js";

function withTerminals(n: number): TerminalState {
  let state = emptyTerminals();
  for (let i = 0; i < n; i += 1) state = openTerminal(state);
  return state;
}

describe("opening terminals", () => {
  it("focuses the one it just opened", () => {
    const state = openTerminal(openTerminal(emptyTerminals()));
    expect(state.terminals).toHaveLength(2);
    expect(state.activeId).toBe(state.terminals[1]!.id);
  });

  it("stops at the cap main enforces", () => {
    // Mirrored from `MAX_TERMINALS_PER_WINDOW`. Without this the eighth spawn would be a
    // rejected promise the user has already committed to, rather than a disabled button.
    const full = withTerminals(MAX_TERMINALS);
    expect(atCapacity(full)).toBe(true);

    const after = openTerminal(full);
    expect(after.terminals).toHaveLength(MAX_TERMINALS);
    // Identity, not just length: a no-op that returns a fresh object still re-renders every pane.
    expect(after).toBe(full);
  });

  it("numbers tabs by creation, not by position", () => {
    // Each tab is a running shell someone has a mental model of. Closing the first must not
    // renumber the other two into each other's names.
    const three = withTerminals(3);
    const afterClose = closeTerminal(three, three.terminals[0]!.id);
    expect(afterClose.terminals.map((t) => t.ordinal)).toEqual([2, 3]);
  });
});

describe("closing terminals", () => {
  it("never leaves activeId pointing at a tab that is gone", () => {
    // Exhaustive over which one is closed, because the interesting cases are the ends.
    for (let n = 1; n <= 4; n += 1) {
      for (let target = 0; target < n; target += 1) {
        for (let active = 0; active < n; active += 1) {
          const base = focusTerminal(withTerminals(n), withTerminals(n).terminals[active]!.id);
          const after = closeTerminal(base, base.terminals[target]!.id);
          if (after.activeId === null) {
            expect(after.terminals, `n=${n} target=${target}`).toHaveLength(0);
          } else {
            expect(
              after.terminals.some((t) => t.id === after.activeId),
              `n=${n} target=${target} active=${active} left a dangling activeId`
            ).toBe(true);
          }
        }
      }
    }
  });

  it("moves focus rightwards, and leftwards only at the end", () => {
    const three = withTerminals(3);
    const [first, second, third] = three.terminals;

    const closedMiddle = closeTerminal(focusTerminal(three, second!.id), second!.id);
    expect(closedMiddle.activeId).toBe(third!.id);

    const closedLast = closeTerminal(three, third!.id);
    expect(closedLast.activeId).toBe(second!.id);

    const closedFirst = closeTerminal(three, first!.id);
    expect(closedFirst.activeId).toBe(three.activeId);
  });

  it("leaves focus alone when the closed tab was not focused", () => {
    const three = withTerminals(3);
    const after = closeTerminal(three, three.terminals[0]!.id);
    expect(after.activeId).toBe(three.activeId);
  });

  it("ignores ids it does not have", () => {
    const two = withTerminals(2);
    expect(closeTerminal(two, 999)).toBe(two);
    expect(focusTerminal(two, 999)).toBe(two);
  });
});

describe("the spawn queue", () => {
  beforeEach(__resetSpawnQueue);

  it("never has two spawns in flight", async () => {
    /**
     * The guard, and the reason for it. `src/preload/index.ts` resolves port replies on a fixed
     * channel name with `ipcRenderer.once` and no correlation id, so two overlapping
     * `pty:spawn` calls can be handed each other's MessagePort — two tabs driving one shell.
     */
    let inFlight = 0;
    let overlapped = false;

    const spawn = () =>
      new Promise<void>((resolve) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        setTimeout(() => {
          inFlight -= 1;
          resolve();
        }, 5);
      });

    await Promise.all(Array.from({ length: 5 }, () => spawnSerialised(spawn)));
    expect(overlapped).toBe(false);
  });

  it("runs them in the order they were asked for", async () => {
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map((i) =>
        spawnSerialised(
          () =>
            new Promise<void>((resolve) => {
              order.push(i);
              setTimeout(resolve, 2);
            })
        )
      )
    );
    expect(order).toEqual([0, 1, 2]);
  });

  it("lets a later spawn run after an earlier one fails", async () => {
    // "Open a project first" arrives as a rejection. A chain that stalled on it would leave the
    // dock unable to open a terminal for the rest of the session.
    await expect(spawnSerialised(() => Promise.reject(new Error("no project")))).rejects.toThrow(
      "no project"
    );
    await expect(spawnSerialised(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("reports the failure to the caller that asked for it", async () => {
    const results = await Promise.allSettled([
      spawnSerialised(() => Promise.reject(new Error("first"))),
      spawnSerialised(() => Promise.resolve("second")),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "second" });
  });
});
