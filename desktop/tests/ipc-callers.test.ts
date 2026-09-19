/**
 * Which IPC channels nothing in the renderer calls, and why each one is allowed to.
 *
 * `ipc-handler-parity.test.ts` proves every declared channel has a handler. It cannot see the other
 * end: a channel can have a schema, a handler, a mode gate and a preload binding, and still be
 * something no product code ever invokes. A batch of them were in that state, and the problem was
 * not that they existed — it was that **a reader could not tell rot from unfinished work without
 * grepping**. (The count is not stated here on purpose: it was, and it went stale the first time
 * an entry left. `EXPECTED` is the list.)
 *
 * Some turned out to be genuinely superseded and are gone: `progress:list`, because `dashboard:get`
 * already returns per-problem progress, and `fs:recentProjects`, because the native menu builds its
 * recents submenu from the store directly (`menu.ts`) and never asks the renderer.
 *
 * FOUR LEFT BY BEING WIRED UP, which is the outcome this list was hoping for. `fs:save`,
 * `fs:saveAs` and `fs:confirmDiscard` were an editor surface designed, implemented to the IPC
 * layer and deliberately not shipped; the surface shipped, so they have callers and their entries
 * are gone. `lint:run` went the same way when the Problems pane came back. Deleting a line here to
 * record that something is now reachable is exactly the edit this file was built to invite.
 *
 * The rest are kept, and this file is where that is declared rather than discovered. The reasons
 * differ, and the difference is the whole point — three categories, only one of which was ever a
 * deletion candidate. See `EXPECTED` below.
 *
 * Two of them are the ones this file exists to stop anyone deleting. `fs:writeWithDiff` and
 * `fs:commitDiff` look like the most obviously dead things in the app — no renderer calls them, and
 * the component that would (`Build/DiffView.tsx`) is rendered `readOnly` by its only user. They are
 * in fact where the agent's central safety property is proved end to end, by the smoke. "Uncalled"
 * and "unexercised" are different claims, and only the parity test could tell them apart.
 *
 * **What this test is for:** the list is exact. A new uncalled channel fails here, so the state stays
 * declared and bounded instead of drifting. Wiring one up also fails here, which is the correct
 * amount of friction: deleting a line to record that something is now reachable is a good edit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

/**
 * Channels with a handler and no call site in `renderer/src`, each with the reason it is allowed.
 *
 * A reason is not a formality. "No caller" describes two different situations in what is left, and
 * neither is a deletion candidate: each remaining channel is exercised by the smoke as a live check
 * of something no unit test can reach.
 */
const EXPECTED: Record<string, string> = {
  /**
   * Exercised deliberately, by the smoke, as a *live* check that the channel agrees with argv.
   * `window.host.windowMode` is a static property injected at preload time; this is an IPC round
   * trip. Two independent sources agreeing is the assertion, and product code has no reason to ask
   * twice — so "no product caller" is the design rather than a gap.
   */
  "mode:get": "smoke-only by design: cross-checks the mode gate against argv",

  /**
   * The agent's write pair, and the two entries most likely to be mistaken for rot: no renderer calls
   * either, and `Build/DiffView.tsx` — the component whose `onApply` would reach `fs:commitDiff` — is
   * rendered `readOnly` by its only user, so that prop is never wired to anything live.
   *
   * They are not rot. They are where the property that makes an unrestricted assistant safe to point
   * at a real repository is asserted **through the channel** rather than against a function:
   *
   *   `fs:writeWithDiff` — `index.ts:2074` calls it with `../escape.txt` and no project open, and
   *   fails the smoke if it is accepted. Path confinement, over IPC, from a renderer.
   *
   *   `fs:commitDiff` — `index.ts:2773` proposes a diff as the agent and then tries to commit it
   *   through the channel, asserting the refusal. Its own comment at `:2587` is explicit that unit
   *   tests already assert this against `commitDiff` directly, and that the point of the smoke case
   *   is the channel. Approval is a batch decision in a native dialog (`agent/approve.ts`), which is
   *   why the renderer has no legitimate call site and per-file Apply would fail every time.
   *
   * Deleting these to tidy up the uncalled list would delete the only end-to-end evidence that the
   * agent cannot write without a human, while leaving every unit test green.
   */
  "fs:writeWithDiff": "smoke-only by design: proves path confinement holds over IPC",
  "fs:commitDiff": "smoke-only by design: proves the channel refuses agent-origin diffs",

  /*
    GONE FROM THIS LIST, AND THE REASON IS THE POINT.

    `fs:save`, `fs:saveAs` and `fs:confirmDiscard` sat here as "an editor surface designed,
    implemented to the IPC layer, and deliberately not shipped" — two of them kept only because
    other files cite them as precedent, which is the weakest reason a channel can have. The
    surface shipped: `BuildWorkspace` saves through `fs:save`, offers Save As, and asks before
    discarding a dirty tab through the native dialog. They have callers, so they have no entry.

    The smoke case for `fs:save` did NOT go with the entry. It is still the only end-to-end proof
    of the app's single optimistic-concurrency check — the write lands, a save against a stale
    baseline is refused, and `../escaped.py` is confined — and `build/watcher.ts` explains its
    own-write suppression in terms of that guard. The test below asserts it survives, under a name
    that says what it now protects.
  */

  /**
   * Still here, and it is the last of the family. `src/main/lint/` is a complete subsystem —
   * ruff, eslint and `tsc --noEmit`, chosen by extension, project-local binaries preferred — with
   * nothing to render into. It was stranded for the same reason the save channels were: the
   * surface that had a file open was gone. That surface is back and this one is next; deleting
   * the channel in the meantime would strand the subsystem, which is a larger decision than a
   * cleanup pass should make.
   */
  "lint:run": "the Problems pane is not wired up yet; deleting it would strand src/main/lint/",
};

/** Every channel the contract declares. */
function declaredChannels(): string[] {
  const contract = read("src/main/ipc/contract.ts");
  return [...contract.matchAll(/^ {2}"([a-z]+:[A-Za-z]+)":/gm)].map((m) => m[1] as string);
}

/**
 * Every channel reachable from renderer source, by the shape of its call site.
 *
 * This is a regex over source, not a resolved call graph, and the first version of it was wrong in a
 * way worth recording: it matched only `host.ns.method(`, so 43 channels looked uncalled when 13
 * were, and the assertion below was measuring the pattern rather than the code. Five shapes the
 * renderer actually uses were invisible to it — a non-null assertion between the parts
 * (`host.fs!.currentProject()`), an optional call (`host?.menu?.setState?.()`), the `host()` accessor
 * the transport seam uses for nearly everything, a formatter's line break mid-expression, and a
 * namespace bound to a local first (`const memory = window.host?.memory`, then `memory.index({})`).
 *
 * That last shape is why aliases are resolved per file rather than by matching a bare
 * `namespace.method(` anywhere. `memory:index` and `memory:search` would both be matched by
 * unrelated property reads that are in this tree — `sash.index` in `DockGrid.tsx` is one — and a
 * false "called" is the dangerous direction, because it hides a dead channel rather than reporting a
 * live one. (The second example here was `resolved.search` in `lib/auth/callbackUrl.ts`, a module
 * nothing imported and which the dead-code batch deleted. The hazard is unchanged; only the example
 * needed replacing.)
 */
function calledChannels(): Set<string> {
  const called = new Set<string>();

  /** `host.ns.method(` with `()`, `!`, `?.` and line breaks anywhere they can legally appear. */
  const DIRECT = /host(?:\(\))?\s*[!?]?\s*\.\s*([a-z]+)\s*[!?]?\s*\.\s*([A-Za-z]+)\s*(?:\?\.)?\s*\(/g;

  /** `const memory = window.host?.memory` — a namespace held in a local before being called. */
  const ALIAS = /(?:const|let)\s+(\w+)\s*=\s*(?:window\s*\.\s*)?host(?:\(\))?\s*[!?]?\s*\.\s*([a-z]+)\s*;/g;

  /**
   * `const fs = hostRef.current?.fs` — the same alias shape, reached through a ref.
   *
   * A sixth shape, and it exists for a reason rather than by accident. `BuildWorkspace`'s save
   * functions are built once and must keep a stable identity: they are published to the shell as
   * menu commands and called from the window-close handshake, and a callback rebuilt to pick up a
   * new `host` would be a different function by the time main asks. So they read the preload
   * surface out of a ref, which no `host.`-anchored pattern can see.
   *
   * Anchored on the literal `hostRef`, not on any `.current`, because a false *called* is the
   * dangerous direction here — it hides a dead channel — while a false *uncalled* only makes this
   * list noisy.
   */
  const REF_ALIAS =
    /(?:const|let)\s+(\w+)\s*=\s*hostRef\s*\.\s*current\s*[!?]?\s*\.\s*([a-z]+)\s*;/g;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;

      const text = fs.readFileSync(full, "utf8");

      for (const m of text.matchAll(DIRECT)) called.add(`${m[1]}:${m[2]}`);

      // Scoped to this file: a local named `memory` here says nothing about a local named `memory`
      // elsewhere, and not matching unrelated properties is the entire reason aliases are resolved.
      for (const alias of [...text.matchAll(ALIAS), ...text.matchAll(REF_ALIAS)]) {
        const local = alias[1] as string;
        const namespace = alias[2] as string;
        const call = new RegExp(
          "\\b" + local + "\\s*[!?]?\\s*\\.\\s*([A-Za-z]+)\\s*(?:\\?\\.)?\\s*\\(",
          "g"
        );
        for (const m of text.matchAll(call)) called.add(`${namespace}:${m[1] as string}`);
      }
    }
  };
  walk(path.join(root, "renderer/src"));

  return called;
}

describe("channels with no renderer caller", () => {
  const declared = declaredChannels();
  const called = calledChannels();
  const uncalled = declared.filter((channel) => !called.has(channel)).sort();

  it("finds the channels to check", () => {
    // Guards the three regexes above: if one stops matching, everything looks called or nothing
    // does, and the assertion below becomes meaningless in one direction or unbearable in the other.
    expect(declared.length).toBeGreaterThan(70);
    expect(called.size).toBeGreaterThan(60);
  });

  it("recognises every shape a renderer call site takes", () => {
    /**
     * The regexes are the part of this file most likely to rot, and when they rot they do it
     * silently — a shape that stops matching turns a live channel into a reported dead one, and the
     * fix looks like "delete the channel". Each of these is a real call site, named so that the
     * failure says which shape broke rather than just handing over a diff of channel names.
     */
    expect(called, "host().ns.method( — the transport seam").toContain("chat:listSessions");
    expect(called, "host.fs!.method( — non-null assertion").toContain("fs:currentProject");
    expect(called, "host?.ns?.method?.( — optional call").toContain("menu:setState");
    expect(called, "const ns = window.host?.ns — aliased").toContain("memory:index");
    expect(called, "const ns = hostRef.current?.ns — aliased through a ref").toContain(
      "fs:save"
    );
  });

  it("is exactly the declared set", () => {
    /**
     * Both directions matter.
     *
     * An **extra** entry is a new channel nobody calls — which may be fine, and must be declared
     * with its reason rather than discovered by a reader a year later.
     *
     * A **missing** entry means something here is now reachable, and the line should go. That is
     * the edit `fs:save`, `fs:saveAs` and `fs:confirmDiscard` got when the save surface shipped,
     * and the one `lint:run` is waiting for.
     */
    expect(uncalled).toEqual(Object.keys(EXPECTED).sort());
  });

  it("gives every one of them a reason", () => {
    // An empty reason is the same as no entry: it records that somebody noticed and nothing more.
    for (const [channel, reason] of Object.entries(EXPECTED)) {
      expect(reason.length, channel).toBeGreaterThan(20);
    }
  });

  it("no longer declares the two that were superseded", () => {
    /**
     * `progress:list` and `fs:recentProjects` were removed rather than documented, because something
     * else already does the job: `dashboard:get` returns per-problem progress, and the native menu
     * builds its recents submenu straight from the store. A channel with a working replacement is
     * rot; one waiting for a surface is not.
     */
    expect(declared).not.toContain("progress:list");
    expect(declared).not.toContain("fs:recentProjects");
  });

  it("still exercises the channels whose only proof is the smoke", () => {
    /**
     * "Smoke-only by design" is a claim about another file, so it has to be checked against that
     * file. Otherwise the reasoning goes circular the moment someone deletes a smoke case: the
     * channel stays because the smoke covers it, and the smoke no longer does.
     *
     * This asserts the call site exists, not that it passes — `npm run smoke` is what proves that,
     * and it is a separate CI step because it needs a real window. What this catches is the specific
     * sequence that would leave a genuinely dead channel documented as live: delete a smoke case,
     * see this suite go green, conclude nothing was lost.
     */
    const smoke = read("src/main/index.ts");
    expect(smoke, "mode:get").toContain("mode.get(");
    expect(smoke, "fs:writeWithDiff — path confinement").toContain("fs.writeWithDiff({ path: \"../escape.txt\"");
    expect(smoke, "fs:commitDiff — agent-origin refusal").toContain("fs.commitDiff({ diffId:");
    expect(smoke, "fs:save — write, baseline guard, confinement").toContain("fs.save(${JSON.stringify(payload)})");
  });

  it("keeps the references that cite these channels resolvable", () => {
    /**
     * These citations used to be the *reason* three channels were kept. They are not any more —
     * all three have renderer callers now — but the citations still have to resolve: deleting a
     * channel that another subsystem names as precedent replaces a quiet oddity with a comment
     * pointing at nothing, and D9 was mostly spent removing exactly that.
     *
     * `watcher.ts` is the load-bearing one. Its own-write suppression is written in terms of
     * `fs:save`'s baseline guard, and the renderer now has a second guard keyed on the same fact
     * (`isOwnWrite` in `lib/build/editor-save.ts`) for the case where the grace window is too
     * short. Two halves of one rule, and neither reads correctly without the other.
     */
    expect(read("src/main/build/watcher.ts")).toContain("fs:save");
    expect(read("src/main/inference/consent.ts")).toContain("fs:confirmDiscard");
    expect(read("src/main/agent/approve.ts")).toContain("fs:confirmDiscard");

    const contract = read("src/main/ipc/contract.ts");
    for (const channel of ["fs:save", "fs:confirmDiscard"]) {
      expect(contract, channel).toContain(`"${channel}"`);
    }
  });
});
