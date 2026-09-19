/**
 * The three things `scripts/account-e2e.mjs` cannot be allowed to lose.
 *
 * That script is the gate on removing provider sign-in, and a gate is only worth the properties that
 * make its green mean something. Each of these has a specific way of being quietly removed by
 * someone making the script "work on my machine", and each would leave it still passing:
 *
 *   * DELETE THE DEV-TOKEN REFUSAL and the script runs, passes, and proves nothing — `sessionToken()`
 *     answers from the environment before it ever reads the vault, so `storeSession` never runs.
 *   * BROADEN THE CLEANUP and one predicated DELETE becomes a script that empties the users table of
 *     whichever database it was pointed at.
 *   * REFORMAT THE CONSOLE EMAIL LOG and the scraper silently finds no code. That one spans two
 *     languages: the format is written in Python and read in JavaScript, and nothing else in the
 *     repository holds the two ends together.
 *
 * WHERE THIS RUNS THE SCRIPT RATHER THAN READING IT, it is because a behavioural check cannot be
 * fooled by a comment that merely mentions the guard. The first three refusals are all checked
 * before any dependency is probed, so they answer the same way on a machine with no Postgres, no
 * Python and no built app — which is what makes running them here cheap and portable.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "scripts", "account-e2e.mjs");
const EMAIL_SERVICE = resolve(__dirname, "..", "..", "apps", "api", "src", "services", "email_service.py");
const source = readFileSync(SCRIPT, "utf-8");

/**
 * The script with its prose removed, so a guard cannot be satisfied by the sentence describing it.
 *
 * Line comments are stripped only when `//` opens the line. A blunter rule would eat the `//` in
 * `redis://127.0.0.1:6399/0` and `http://127.0.0.1` and change what the remaining text says, which
 * is the opposite of what this is for.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** Run the script far enough to hit a refusal. No dependency of the real run is touched. */
function runScript(env: Record<string, string | undefined>) {
  const child = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf-8",
    env: { ...process.env, VOIDCODE_DEV_SESSION_TOKEN: undefined, VOIDCODE_E2E_DATABASE_URL: undefined, ...env },
    timeout: 60_000,
  });
  return { status: child.status, out: `${child.stdout ?? ""}${child.stderr ?? ""}` };
}

describe("the account E2E refuses to run where a pass would mean nothing", () => {
  it("fails, rather than skipping, when a dev session token is set", () => {
    const { status, out } = runScript({ VOIDCODE_DEV_SESSION_TOKEN: "not-a-real-token" });

    // Exit 1, not 0. A skip here would be the worst answer of the three: CI would go green on a run
    // that never touched safeStorage, which is the precise hole the script was written to close.
    expect(status).toBe(1);
    expect(out).toContain("VOIDCODE_DEV_SESSION_TOKEN");
    expect(out).toMatch(/\[account\] FAIL/);
  });

  it("skips, rather than guessing a database, when none is named", () => {
    const { status, out } = runScript({});

    expect(status).toBe(0);
    expect(out).toMatch(/\[account\] SKIP/);
    expect(out).toContain("VOIDCODE_E2E_DATABASE_URL");
  });

  it("refuses a port something else already holds", async () => {
    const squatter = createServer();
    const port = await new Promise<number>((done) => {
      squatter.listen(0, "127.0.0.1", () => done((squatter.address() as { port: number }).port));
    });
    try {
      const { status, out } = runScript({
        // Named, so the refusal under test is reached rather than the one above it. Nothing connects
        // to it: the port refusal is checked before any dependency is probed.
        VOIDCODE_E2E_DATABASE_URL: "postgresql://nobody@127.0.0.1:1/never-opened",
        VOIDCODE_E2E_API_PORT: String(port),
      });
      expect(status).toBe(1);
      expect(out).toContain(String(port));
      expect(out).toMatch(/already listening/);
    } finally {
      await new Promise((done) => squatter.close(done));
    }
  });
});

describe("the cleanup cannot be broadened", () => {
  it("predicates every DELETE on the throwaway prefix", () => {
    // To end of line, not "up to the next quote": the predicate this is checking for is itself
    // quoted (`LIKE 'desktop-e2e-%'`), so a quote-terminated match ends one character before the
    // thing it exists to find and reports every statement as unpredicated.
    const deletes = code.match(/DELETE FROM.*/gi) ?? [];

    // A positive control on the matcher itself: if this is zero the regex has stopped finding the
    // statement and every assertion below is vacuously true.
    expect(deletes.length).toBeGreaterThan(0);
    for (const statement of deletes) {
      expect(statement).toContain("WHERE email LIKE 'desktop-e2e-%'");
    }
  });

  it("carries no statement that could empty a table", () => {
    expect(code).not.toMatch(/TRUNCATE/i);
    expect(code).not.toMatch(/DROP\s+(TABLE|DATABASE|SCHEMA)/i);
  });

  it("uses a prefix the other Postgres suite does not, so two cleanups cannot race", () => {
    // `test_desktop_accounts_postgres.py` owns `acct-test-`. Sharing one prefix would mean either
    // suite could delete rows the other is mid-way through asserting on.
    expect(code).toContain("desktop-e2e-");
    expect(code).not.toContain("acct-test-");
  });
});

describe("the console email format is one format, written in Python and read in JavaScript", () => {
  const python = readFileSync(EMAIL_SERVICE, "utf-8");

  it("logs the header the scraper splits on", () => {
    const header = "EMAIL (console provider, not sent)";
    expect(python).toContain(header);
    expect(code).toContain(header);
  });

  it("labels the recipient the way the scraper reads it", () => {
    // The scraper picks the block belonging to THIS RUN's address out of a log that may hold others,
    // and it does that by matching the `to:` line. A relabelled field means it reads someone else's
    // code or none at all.
    expect(python).toContain("to: %s");
    expect(code).toMatch(/to:/);
  });

  it("puts the six digits behind the sentence the scraper matches", () => {
    expect(python).toContain("Your code is: {code}");
    expect(code).toContain("Your code is:");
    // Six, spelled as six. The API issues six digits and the app's own field refuses anything else.
    expect(code).toMatch(/\\d\{6\}/);
  });
});

describe("the API under test is the application", () => {
  it("spawns src.main:app rather than defining a second app", () => {
    expect(code).toContain("src.main:app");
    // A second app definition is a second answer to "what is the API", and this script would be
    // testing the wrong one from the day they diverge.
    expect(code).not.toMatch(/FastAPI\s*\(/);
  });

  it("keeps a model out of the API process", () => {
    // Without this the lifespan loads weights into the uvicorn process. That is minutes of startup
    // and gigabytes of memory for a test that never sends a prompt.
    expect(code).toContain('USE_SGLANG: "true"');
  });
});
