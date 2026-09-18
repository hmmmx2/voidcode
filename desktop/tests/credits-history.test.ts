/**
 * Credit history: reading it, wording it, and waiting for a payment that is settling elsewhere.
 *
 * THREE THINGS HERE ARE NOT CHECKABLE ANYWHERE ELSE.
 *
 *   1. THE UNIT. Micro-credits are the storage unit and credits are the display unit, and the
 *      divisor lives in two languages. A client that disagreed with the server about it would be
 *      wrong by a factor of a million on every figure on the page while both suites stayed green.
 *      This is the same class as the pack table that sold RM56 of GPU time for RM20.
 *
 *   2. THE VOCABULARY. The ledger's entry types are a Postgres enum. A new member added on the
 *      server would render as a raw word like `chargeback` in a column headed "What", so the label
 *      map is held to the enum rather than to a list somebody remembered to update.
 *
 *   3. WHEN TO STOP WAITING. A purchase finishes in the buyer's browser and is credited by a
 *      webhook this application never sees, so the page watches its own wallet. Two properties of
 *      that watch matter and neither is visible in a component: the deadline cannot be pushed back,
 *      and "the money arrived" is not "the balance went up" — the banner invites the buyer to keep
 *      using VoidCode, and using it spends credit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerEntry } from "../src/shared/credits.js";

const { __useInMemory } = await import("../src/main/store/db.js");
const { __safeStorage } = await import("./stubs/electron.js");
const { setSecret, secretValue, __resetSessionSecrets } = await import("../src/main/inference/vault.js");
const { __setOverridesAllowed } = await import("../src/main/platform/config.js");
const session = await import("../src/main/account/session.js");
const hosted = await import("../src/main/inference/hosted.js");
const { CHANNELS } = await import("../src/main/ipc/contract.js");
const labels = await import("../renderer/src/lib/account/ledger-labels.js");
const watchModule = await import("../renderer/src/lib/account/purchase-watch.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = (relative: string): string =>
  fs.readFileSync(path.join(root, "..", "apps/api", relative), "utf8");

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
}

let calls: Call[] = [];

type Reply = { status: number; body?: unknown } | Error;

function stubFetch(respond: (url: string) => Reply): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        authorization: headers.authorization,
      });
      const reply = respond(String(input));
      if (reply instanceof Error) throw reply;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      });
    }),
  );
}

/** A ledger row as the API sends it. */
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 1,
    type: "charge",
    amountMicro: -20_000,
    balanceAfterMicro: 4_980_000,
    reservationId: null,
    createdAt: "2026-09-18T10:00:00+00:00",
    ...overrides,
  };
}

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
  calls = [];
  __setOverridesAllowed(true);
  process.env.VOIDCODE_API_URL = "http://127.0.0.1:59997/v1";
  session.__resetSessionMemory();
  session.setAccountBroadcaster(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setOverridesAllowed(undefined);
  delete process.env.VOIDCODE_API_URL;
  session.setAccountBroadcaster(() => {});
});

// ── Reading it ───────────────────────────────────────────────────────────────

describe("asking the server for the history", () => {
  it("makes no request at all with nobody signed in", async () => {
    stubFetch(() => ({ status: 200, body: { entries: [entry()] } }));

    const result = await hosted.ledger(50);

    expect(result).toEqual({ ok: false, message: "Sign in to see your history." });
    // The same rule as every other account read: signed out, the application does not contact our
    // server. `platform/http.ts` answers the 401 itself.
    expect(calls).toEqual([]);
  });

  it("asks for the number of rows it was given, with the session", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 200, body: { entries: [entry({ id: 7 })] } }));

    const result = await hosted.ledger(200);

    expect(result).toEqual({ ok: true, entries: [entry({ id: 7 })] });
    expect(calls[0]?.url).toBe("http://127.0.0.1:59997/v1/credits/ledger?limit=200");
    expect(calls[0]?.authorization).toBe("Bearer tok-1");
  });

  it("passes the rows through in the order the server sent them", async () => {
    /**
     * NOT RE-SORTED HERE, and that is the point. The server orders by the ledger's own BigInteger
     * id, newest first; a client that sorted by date would at best duplicate that and at worst
     * reverse it.
     *
     * DISTINCT, DESCENDING TIMESTAMPS, which the first version of this test did not have. It gave
     * all three rows the same instant to make a different point, and a stable sort by date is a
     * no-op on identical keys — so the assertion held while a `sort((a, b) => a.createdAt...)`
     * inserted into `ledger()` passed unnoticed. The tie case is the test below this one.
     */
    setSecret("voidcode", "tok-1");
    const rows = [
      entry({ id: 9, type: "charge", amountMicro: -2_000, createdAt: "2026-09-18T12:00:00+00:00" }),
      entry({ id: 8, type: "hold", amountMicro: 0, createdAt: "2026-09-18T11:00:00+00:00" }),
      entry({ id: 7, type: "grant", amountMicro: 1_200_000_000, createdAt: "2026-09-18T10:00:00+00:00" }),
    ];
    stubFetch(() => ({ status: 200, body: { entries: rows } }));

    const result = await hosted.ledger(50);
    expect(result.ok && result.entries.map((e) => e.id)).toEqual([9, 8, 7]);
  });

  it("keeps two rows written in the same transaction in the order the ledger gave them", async () => {
    /**
     * The reason the schema uses a BigInteger identity rather than a UUID: a settle writes its
     * release and its charge in one transaction, so both share a `created_at` to the microsecond
     * and only the id can order them. Any client-side sort on the date is free to swap them.
     */
    setSecret("voidcode", "tok-1");
    const sameInstant = "2026-09-18T10:00:00+00:00";
    const rows = [
      entry({ id: 51, type: "release", amountMicro: 0, createdAt: sameInstant }),
      entry({ id: 50, type: "charge", amountMicro: -2_000, createdAt: sameInstant }),
    ];
    stubFetch(() => ({ status: 200, body: { entries: rows } }));

    const result = await hosted.ledger(50);
    expect(result.ok && result.entries.map((e) => e.id)).toEqual([51, 50]);
  });

  it("ends the session when the server says the session is gone", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 401, body: { detail: "Not signed in." } }));

    const result = await hosted.ledger(50);

    expect(result.ok).toBe(false);
    // A 401 means "the session you sent is not valid", and it means that on every path.
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("answers an unreadable body with no rows rather than a crash", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 200, body: { entries: "surprise" } }));

    expect(await hosted.ledger(50)).toEqual({ ok: true, entries: [] });
  });

  it("says it could not reach VoidCode when it could not", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => new TypeError("fetch failed"));

    expect(await hosted.ledger(50)).toEqual({ ok: false, message: "Could not reach VoidCode." });
  });
});

describe("the channel the renderer calls", () => {
  const schema = CHANNELS["voidcode:ledger"].input;

  it("is callable with no argument, and bounded at the server's own ceiling", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ limit: 200 }).success).toBe(true);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 201 }).success).toBe(false);
    expect(schema.safeParse({ limit: 12.5 }).success).toBe(false);
  });

  it("agrees with the limit the API clamps to", () => {
    /**
     * Two numbers in two languages for one rule. If the API's ceiling moved, a renderer bounded at
     * the old one would either refuse a request the server would have served, or send a value the
     * server silently reinterprets — and a silently reinterpreted limit is a footer that lies about
     * how much history is on screen.
     */
    const clamp = /limit\(min\(max\(limit, 1\), (\d+)\)\)/.exec(apiSource("src/routers/credits.py"));
    expect(clamp, "the ledger endpoint no longer clamps its limit the way this test reads it").not.toBeNull();
    const ceiling = Number((clamp as RegExpExecArray)[1] ?? 0);
    expect(ceiling, "the clamp was matched but no number came out of it").toBeGreaterThan(0);
    expect(schema.safeParse({ limit: ceiling }).success).toBe(true);
    expect(schema.safeParse({ limit: ceiling + 1 }).success).toBe(false);
  });

  it("is readable in both window modes", () => {
    // A Study window is where somebody notices the VoidCode model has stopped answering, which is
    // the moment they want to look at the balance.
    expect(CHANNELS["voidcode:ledger"].modes).toEqual(["study", "build"]);
  });
});

// ── Wording it ───────────────────────────────────────────────────────────────

describe("what a row says", () => {
  it("uses the same credit as the server", () => {
    const declared = /MICRO_PER_CREDIT = ([0-9_]+)/.exec(apiSource("src/models/gpu_billing.py"));
    expect(declared, "MICRO_PER_CREDIT is gone from the API's billing model").not.toBeNull();
    expect(labels.MICRO_PER_CREDIT).toBe(
      Number(((declared as RegExpExecArray)[1] ?? "").replace(/_/g, "")),
    );
  });

  it("has a word for every entry type the ledger can hold", () => {
    /**
     * Read from the Postgres enum, not from a list kept here. A member added on the server renders
     * as its own raw name in a column headed "What" — which is better than a wrong label, and worse
     * than somebody being told to choose a word.
     */
    /**
     * Anchored to the enum's NAME, not to the first `SAEnum(` in the file. The first version
     * matched the reservation-state enum three declarations earlier and parsed its three members
     * instead of these six — and the only reason that showed up as a failure rather than as a pass
     * is the vacuity check below it.
     */
    const model = apiSource("src/models/gpu_billing.py");
    const named = model.indexOf('name="gpu_ledger_entry_type_enum"');
    expect(named, "the entry-type enum has been renamed or moved").toBeGreaterThan(-1);
    const declaration = model.slice(model.lastIndexOf("SAEnum(", named), named);
    const types = [...declaration.matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string);

    expect(types.length, "no entry types were parsed, so this assertion is vacuous").toBeGreaterThan(3);
    for (const type of types) {
      expect(labels.labelFor(type), `no word for a ${type} entry`).not.toBe(type);
    }
  });

  it("shows an unknown type as itself rather than inventing a word for it", () => {
    expect(labels.labelFor("chargeback")).toBe("chargeback");
  });

  it("counts only the entries that changed the balance as movements", () => {
    // A hold and a release move credit between available and reserved, so both are zero. Four rows
    // reading nothing for one answered question is what this filter exists to prevent.
    expect(labels.isMovement(entry({ type: "hold", amountMicro: 0 }))).toBe(false);
    expect(labels.isMovement(entry({ type: "release", amountMicro: 0 }))).toBe(false);
    expect(labels.isMovement(entry({ type: "charge", amountMicro: -1 }))).toBe(true);
    expect(labels.isMovement(entry({ type: "grant", amountMicro: 1 }))).toBe(true);
  });

  it("signs an amount and never rounds a real charge to nothing", () => {
    expect(labels.formatCredits(1_200_000_000)).toBe("+1,200");
    expect(labels.formatCredits(-20_000)).toBe("-0.02");
    // A question that cost a hundredth of a penny still cost something. "-0" would present
    // spending as free, which is the one thing a column of charges must not do.
    expect(labels.formatCredits(-1)).toBe("-0.01");
    expect(labels.formatCredits(0)).toBe("+0");
  });

  it("never prints Invalid Date", () => {
    expect(labels.formatWhen("not a date")).toBe("not a date");
    expect(labels.formatWhen("2026-09-18T10:00:00+00:00")).toContain("2026");
  });
});

// ── Waiting for a payment ────────────────────────────────────────────────────

describe("waiting for a payment to clear", () => {
  const { beginWatch, readWatch, GIVE_UP_AFTER_MS } = watchModule;
  const START = 1_700_000_000_000;

  const history = [entry({ id: 40, type: "charge", amountMicro: -2_000 })];
  const opened = beginWatch(START, { balanceMicro: 5_000_000, entries: history });

  it("keeps waiting while nothing has happened", () => {
    expect(readWatch(opened, START + 5_000, { balanceMicro: 5_000_000, entries: history })).toEqual({
      status: "waiting",
      secondsLeft: 595,
    });
  });

  it("cannot have its deadline pushed back by being checked", () => {
    /**
     * THE PROPERTY THIS MODULE EXISTS FOR. The deadline is derived from `startedAt` and nothing
     * writes `startedAt`, so a hundred checks along the way cannot move it. The equivalent effect
     * in the deleted web client needed a comment and an eslint suppression to keep its balance out
     * of a dependency array for exactly this reason; a value that cannot be recomputed needs
     * neither.
     */
    let latest = opened;
    for (let elapsed = 0; elapsed < GIVE_UP_AFTER_MS; elapsed += 5_000) {
      const verdict = readWatch(latest, START + elapsed, {
        balanceMicro: 5_000_000,
        entries: history,
      });
      expect(verdict.status).toBe("waiting");
      // `readWatch` returns a verdict, not a new watch: there is no value to carry forward, which
      // is what makes the loop above unable to extend anything.
      latest = opened;
    }

    expect(readWatch(opened, START + GIVE_UP_AFTER_MS, {
      balanceMicro: 5_000_000,
      entries: history,
    })).toEqual({ status: "gaveUp" });
  });

  it("notices the payment even though the buyer spent credit while waiting", () => {
    /**
     * THE OTHER PROPERTY. The banner says "you can keep using VoidCode", and doing so writes a
     * charge — so a balance compared against its starting value can be LOWER with the payment
     * already credited. Here the buyer spent three credits and bought twelve hundred, and the
     * balance is deliberately given as a number that has fallen below the baseline to prove the
     * verdict does not depend on it.
     */
    const after = [
      entry({ id: 42, type: "grant", amountMicro: 1_200_000_000 }),
      entry({ id: 41, type: "charge", amountMicro: -3_000_000 }),
      ...history,
    ];

    expect(readWatch(opened, START + 8_000, { balanceMicro: 2_000_000, entries: after })).toEqual({
      status: "arrived",
      addedMicro: 1_200_000_000,
    });
  });

  it("does not mistake history that was already there for an arrival", () => {
    const older = [entry({ id: 39, type: "grant", amountMicro: 500_000_000 }), ...history];
    expect(
      readWatch(opened, START + 5_000, { balanceMicro: 5_000_000, entries: older }).status,
    ).toBe("waiting");
  });

  it("falls back to the balance when the history could not be read at all", () => {
    const blindToHistory = beginWatch(START, { balanceMicro: 5_000_000, entries: [] });
    expect(blindToHistory.latestEntryId).toBeNull();

    expect(
      readWatch(blindToHistory, START + 5_000, { balanceMicro: 5_000_000, entries: [] }).status,
    ).toBe("waiting");
    expect(
      readWatch(blindToHistory, START + 5_000, { balanceMicro: 6_200_000, entries: [] }),
    ).toEqual({ status: "arrived", addedMicro: 1_200_000 });
  });

  it("never claims a payment arrived when it began with no baseline at all", () => {
    /**
     * An unreadable starting balance is stored as null, NOT as nought. Stored as nought, the very
     * next successful read — of an unchanged wallet that already had credit in it — reads as an
     * increase of the whole balance, and the page would announce a payment that has not happened.
     * With both signals unavailable the honest outcome is to wait and then say so, which is what
     * the "still no payment" notice is written for.
     */
    const blind = beginWatch(START, { balanceMicro: null, entries: [] });
    expect(blind.baselineMicro).toBeNull();

    expect(readWatch(blind, START + 5_000, { balanceMicro: 5_000_000, entries: [] }).status).toBe(
      "waiting",
    );
    expect(readWatch(blind, START + GIVE_UP_AFTER_MS, {
      balanceMicro: 5_000_000,
      entries: [],
    })).toEqual({ status: "gaveUp" });
  });

  it("reports a payment that landed after the deadline as having landed", () => {
    // Arrival is checked before the clock: money that arrived late still arrived, and "we gave up"
    // over the top of it would be wrong about the only fact the buyer cares about.
    const after = [entry({ id: 42, type: "grant", amountMicro: 1_200_000_000 }), ...history];
    expect(
      readWatch(opened, START + GIVE_UP_AFTER_MS + 1_000, {
        balanceMicro: 1_205_000_000,
        entries: after,
      }).status,
    ).toBe("arrived");
  });

  it("counts a refund as money arriving and anything that took credit away as not", () => {
    const refunded = [entry({ id: 42, type: "refund", amountMicro: 2_000_000 }), ...history];
    expect(readWatch(opened, START + 1_000, { balanceMicro: 7_000_000, entries: refunded }).status)
      .toBe("arrived");

    const spent = [entry({ id: 42, type: "charge", amountMicro: -2_000_000 }), ...history];
    expect(readWatch(opened, START + 1_000, { balanceMicro: 3_000_000, entries: spent }).status)
      .toBe("waiting");

    /**
     * A NEGATIVE `adjust`, which is the case the sign guard is actually for.
     *
     * `adjust` is in the crediting set because a human correction usually adds credit — but it is
     * the one entry type that can go either way, so the type alone does not settle it. Without the
     * `amountMicro > 0` test, a correction that took credit away would be announced as a payment
     * arriving. (A `charge` is negative by construction, which is why adding it to the set changes
     * no behaviour and is not a mutation worth applying.)
     */
    const corrected = [entry({ id: 42, type: "adjust", amountMicro: -1_000_000 }), ...history];
    expect(readWatch(opened, START + 1_000, { balanceMicro: 4_000_000, entries: corrected }).status)
      .toBe("waiting");
  });

  it("bounds how long an abandoned page can poll", () => {
    // The ceiling is what makes an abandoned page acceptable: at this interval, ten minutes is 120
    // requests for one indexed row, and then it stops on its own.
    const polls = GIVE_UP_AFTER_MS / watchModule.POLL_INTERVAL_MS;
    expect(polls).toBeLessThanOrEqual(120);
    expect(watchModule.GIVE_UP_AFTER_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
