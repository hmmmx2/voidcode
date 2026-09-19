/**
 * Can a person actually register, sign in, and get back in after forgetting their password?
 *
 * NOTHING ELSE ASKS THIS, and one specific thing makes the gap dangerous rather than untidy.
 * `npm run smoke` sets `VOIDCODE_DEV_SESSION_TOKEN` against a loopback stub with no session route,
 * so `sessionToken()` short-circuits on line one and `storeSession` -- the call that puts the token
 * in `safeStorage` -- never runs. The *rejection* path is genuinely exercised there. The successful
 * one has never run end to end in this repository.
 *
 * It matters now because Google and Microsoft sign-in are being removed. After that, "Forgot
 * password?" is the ONLY route back in for an account that has no password, and those accounts are
 * real: the API issues a reset code to exactly them on purpose, because receiving the code proves
 * control of the mailbox and that is the proof setting a first password needs. A bug in that flow
 * is not a regression, it is a person locked out. This script is the gate on the removal.
 *
 * Opt-in, and NOT part of `npm run smoke`:
 *   VOIDCODE_E2E_DATABASE_URL=postgresql://user:pass@127.0.0.1:5433/db npm run smoke:account
 *
 * `desktop.yml`'s `verify` job is npm-only on three operating systems with no Python and no
 * Postgres. A CI-gating smoke that always skips is worse than no test, because the skip is green.
 * The precedent is `smoke:vision`, which spawns Electron over CDP with an isolated `--user-data-dir`
 * and exits 0 with a printed SKIP when its dependency is absent. `verify-accounts` runs this one and
 * fails on SKIP, so "skipped" cannot quietly become permanent.
 *
 * -- FOUR REFUSALS, and each is what makes a green run mean something ----------------------------
 *
 * 1. `VOIDCODE_DEV_SESSION_TOKEN` must be UNSET. With it set, every assertion below passes without
 *    `storeSession` ever running -- which is precisely the hole this script exists to close. So it
 *    is a hard failure, not a skip: a green run with that variable set is a lie.
 * 2. `VOIDCODE_E2E_DATABASE_URL` must be set EXPLICITLY, with no default. A default pointing at the
 *    development database is a script that deletes rows from a database its caller did not name.
 * 3. NOTHING MAY ALREADY BE LISTENING on either port. This one was learned the hard way: a uvicorn
 *    leaked from an earlier run kept serving 8031, the new one failed to bind, `/health` went green
 *    against the stale process, and every assertion below passed against an API whose configuration
 *    and log this script did not own. The reset code was being written to a file nobody was reading.
 *    A run that cannot bind its own ports is not a run.
 * 4. It spawns `src.main:app` -- the real application -- never a hand-rolled mini-app. A second app
 *    definition is a second answer to "what is the API", and the one under test would be the wrong
 *    one on the day they diverge.
 *
 * The first three are checked before any dependency is probed, so they refuse identically whether or
 * not this machine has Postgres -- which is what lets `account-e2e-guards.test.ts` check them by
 * running this script for real rather than by reading it.
 *
 * -- WHAT IS DELIBERATELY NOT ASSERTED ----------------------------------------------------------
 *
 * The next person will be tempted, so it is written down rather than left to judgement:
 *
 *   * NO COUNT OF ANYTHING. Not `count(*) FROM users`, not "one `user_identities` row", not "28
 *     accounts have no password". Those are facts about a live database at one moment. Asserting
 *     them turns a real person signing up into a red build.
 *   * NOTHING about the other accounts in that database, or their sessions.
 *   * NO `DELETE` without the `desktop-e2e-%` predicate, no `TRUNCATE`, no `drop_all`.
 *   * NOTHING about rate limiting. `REDIS_URL` is pointed at a port nothing listens on, so the
 *     limiter fails open (it logs, records a metric, and allows) and consecutive runs cannot go red
 *     on `LOGIN`'s 10-per-300s. Rate limiting has its own suite, which is where it belongs. A live
 *     Redis here would enforce the limits and make roughly the fifth run of an hour fail for a
 *     reason that has nothing to do with the code under test.
 *   * NEVER log a code for an address that is not this run's throwaway.
 *
 * The throwaway prefix is `desktop-e2e-`, deliberately different from
 * `test_desktop_accounts_postgres.py`'s `acct-test-`, so the two cleanups cannot race. Addresses are
 * `@example.com`: a `.test` TLD is rejected by `EmailStr`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import WebSocket from "ws";

const API_PORT = Number(process.env.VOIDCODE_E2E_API_PORT ?? 8031);
const CDP_PORT = Number(process.env.VOIDCODE_E2E_CDP_PORT ?? 9335);
const ORIGIN = "app://bundle";
const PYTHON = process.env.VOIDCODE_E2E_PYTHON ?? "python";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const skip = (why) => {
  console.log(`[account] SKIP: ${why}`);
  process.exit(0);
};

// -- Refusal 1 ----------------------------------------------------------------------------------
const devToken = process.env.VOIDCODE_DEV_SESSION_TOKEN;
if (devToken !== undefined && devToken !== "") {
  console.log(
    "[account] FAIL: VOIDCODE_DEV_SESSION_TOKEN is set. `sessionToken()` returns it before " +
      "reading the vault, so storeSession would never run and every assertion below would pass " +
      "without proving anything. Unset it and run again."
  );
  process.exit(1);
}

// -- Refusal 2 ----------------------------------------------------------------------------------
const DATABASE_URL = process.env.VOIDCODE_E2E_DATABASE_URL;
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  skip(
    "VOIDCODE_E2E_DATABASE_URL is not set. It has no default ON PURPOSE -- this script deletes " +
      "the rows it creates, and a default would aim that at a database the caller did not name."
  );
}

/**
 * Is this port ours to take?
 *
 * Binding is the only honest answer. "Can I connect to it" says nothing about a port that is free,
 * and a `/health` that answers 200 says nothing about WHICH process answered.
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

// -- Refusal 3 ----------------------------------------------------------------------------------
for (const [what, port] of [
  ["the API", API_PORT],
  ["the app's remote debugger", CDP_PORT],
]) {
  if (await portIsFree(port)) continue;
  console.log(
    `[account] FAIL: something is already listening on 127.0.0.1:${port}, which this run needs for ` +
      `${what}. That is almost always a process leaked by an earlier run: the new one fails to bind, ` +
      "the health check goes green against the old one, and every assertion afterwards is about an " +
      "API this script neither configured nor can read the log of. Stop it and run again, or set " +
      "VOIDCODE_E2E_API_PORT / VOIDCODE_E2E_CDP_PORT."
  );
  process.exit(1);
}

const ADDRESS = `desktop-e2e-${randomUUID().slice(0, 8)}@example.com`;
const NAME = "Desktop E2E";
const FIRST_PASSWORD = "quiet-harbour-lantern-41";
const SECOND_PASSWORD = "amber-thicket-window-58";

/**
 * Every row this run creates, and nothing else.
 *
 * `users.id` is referenced with `ON DELETE CASCADE` from auth_tokens, notifications, submissions and
 * the rest, so one predicated DELETE is enough. THE `LIKE` IS THE WHOLE SAFETY PROPERTY: without it
 * this statement empties the users table of whatever database it was pointed at.
 */
const CLEANUP_SQL = "DELETE FROM users WHERE email LIKE 'desktop-e2e-%'";

function runPython(code) {
  return spawnSync(PYTHON, ["-c", code], { encoding: "utf-8" });
}

/*
 * ONE ADDRESS IN, TWO URLs OUT, and this is not tidying -- each half refuses the other's spelling.
 *
 * SQLAlchemy's async engine raises `InvalidRequestError: The asyncio extension requires an async
 * driver` at IMPORT TIME if the app is handed a bare `postgresql://`, so the API dies during
 * `import_from_string` with a stack that never mentions this script. psycopg2, given
 * `postgresql+asyncpg://`, does not recognise the scheme. So the caller names the database once,
 * in whichever spelling they have to hand, and both forms are derived here.
 */
const SYNC_URL = DATABASE_URL.replace(/^postgresql\+\w+:/, "postgresql:");
const ASYNC_URL = DATABASE_URL.replace(/^postgresql(\+\w+)?:/, "postgresql+asyncpg:");
const quoted = (value) => JSON.stringify(value);

const reachable = runPython(
  [
    "import psycopg2, sys",
    `try: psycopg2.connect(${quoted(SYNC_URL)}, connect_timeout=5).close()`,
    "except Exception as e: print(type(e).__name__ + ': ' + str(e).strip()[:200]); sys.exit(1)",
  ].join("\n")
);
if (reachable.error !== undefined) skip(`could not run ${PYTHON}: ${reachable.error.message}`);
if (reachable.status !== 0) {
  skip(`Postgres is not reachable: ${String(reachable.stdout || reachable.stderr).trim()}`);
}

if (!existsSync(join("out", "main", "index.js"))) {
  skip("out/main/index.js is missing -- `npm run smoke:account` builds it first; run that.");
}

const apiRoot = join("..", "apps", "api");
if (!existsSync(join(apiRoot, "src", "main.py"))) skip(`no API source at ${apiRoot}`);

// -- The API, as the application defines it -----------------------------------------------------
//
// `USE_SGLANG=true` so no model is loaded in this process; the backend it then polls is absent,
// which costs about a minute of warmup retries at startup and nothing afterwards. `EMAIL_PROVIDER`
// is `console`, which is how the reset code becomes readable at all -- `assert_production_config()`
// refuses that setting in production, so this is a development-only mechanism by construction.
const api = spawn(
  PYTHON,
  ["-m", "uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", String(API_PORT), "--log-level", "info"],
  {
    cwd: apiRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      USE_SGLANG: "true",
      EMAIL_PROVIDER: "console",
      DATABASE_URL: ASYNC_URL,
      DATABASE_URL_SYNC: SYNC_URL,
      REDIS_URL: "redis://127.0.0.1:6399/0",
    },
  }
);
let apiLog = "";
api.stdout.on("data", (d) => (apiLog += d));
api.stderr.on("data", (d) => (apiLog += d));

let electron;
let cleanedUp = false;

function stopEverything() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of [electron, api]) {
    if (child === undefined || child.pid === undefined || child.killed) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }
  const deleted = runPython(
    [
      "import psycopg2",
      `c = psycopg2.connect(${quoted(SYNC_URL)}, connect_timeout=10)`,
      `cur = c.cursor(); cur.execute(${quoted(CLEANUP_SQL)})`,
      "print(cur.rowcount); c.commit(); c.close()",
    ].join("\n")
  );
  console.log(
    deleted.status === 0
      ? `[account] cleaned up ${String(deleted.stdout).trim()} desktop-e2e- row(s)`
      : `[account] WARNING: cleanup failed: ${String(deleted.stderr || "").trim().slice(-300)}`
  );
}

const die = (why) => {
  console.log("[account] FAIL:", why);
  console.log("--- api log (tail) ---");
  console.log(apiLog.slice(-2500));
  stopEverything();
  process.exit(1);
};

process.on("SIGINT", () => {
  stopEverything();
  process.exit(130);
});

/*
 * EIGHT MINUTES, and the number is measured rather than padded.
 *
 * `main.py`'s lifespan polls the inference backend's `/v1/models` THIRTY TIMES AT TEN SECONDS before
 * it will accept a connection, and the count is hardcoded with no environment knob. With
 * `USE_SGLANG=true` and no backend running -- which is the whole point here, since it is what stops
 * a model being loaded into this process -- that is a flat five minutes, followed by the warmup's
 * own six prefixes and the knowledge corpus. Measured cold on this machine: about five and a half
 * minutes to "Application startup complete".
 *
 * So the wait is long by arithmetic, not by superstition. It also says so out loud every minute,
 * because a silent eight-minute wait is indistinguishable from a hang and the first instinct is to
 * kill it -- which is exactly how a uvicorn gets leaked and refusal 3 gets earned.
 */
const STARTUP_BUDGET_S = 480;

/*
 * `/v1/auth/me`, NOT `/health`, and both halves of that are deliberate.
 *
 * `/health` is the wrong question twice over. It reports on the INFERENCE BACKEND, which this run
 * removes on purpose -- so its considered answer here is "unhealthy", forever, which is correct of
 * it and useless as a readiness signal. And it reaches Judge0, Redis and the database before
 * answering, so it routinely outlives a short client timeout and looks like a closed port.
 *
 * Signed out, `/v1/auth/me` answers 401 immediately. That is a better signal than either: it proves
 * the process is serving AND that the router this script exercises is mounted, which is the only
 * part of the API it cares about.
 */
const READY_URL = `http://127.0.0.1:${API_PORT}/v1/auth/me`;
let apiUp = false;
for (let i = 0; i < STARTUP_BUDGET_S / 2 && !apiUp; i++) {
  await sleep(2000);
  if (api.exitCode !== null) die(`the API exited during startup with code ${api.exitCode}`);
  if (i > 0 && i % 30 === 0) {
    console.log(
      `[account] api: still starting (${i * 2}s of ${STARTUP_BUDGET_S}s) -- it polls for an ` +
        "inference backend for five minutes before accepting connections"
    );
  }
  try {
    const response = await fetch(READY_URL, { signal: AbortSignal.timeout(5000) });
    apiUp = response.status < 500;
  } catch {
    // not listening yet
  }
}
if (!apiUp) die(`the API never answered ${READY_URL} within ${STARTUP_BUDGET_S}s`);
console.log(`[account] api: up on ${API_PORT}`);

// -- The real app, against the real API ---------------------------------------------------------
//
// An isolated --user-data-dir, so this writes into no one's conversations, settings or vault. That
// also makes the safeStorage assertion meaningful: the profile starts with nothing in it, so a
// token read back can only be one this run stored.
const profile = mkdtempSync(join(tmpdir(), "voidcode-account-"));
const binary = process.platform === "win32" ? "electron.exe" : "electron";
const childEnv = { ...process.env, VOIDCODE_API_URL: `http://127.0.0.1:${API_PORT}/v1` };
delete childEnv.VOIDCODE_DEV_SESSION_TOKEN;

electron = spawn(
  join("node_modules", "electron", "dist", binary),
  ["out/main/index.js", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`],
  { stdio: ["ignore", "pipe", "pipe"], env: childEnv }
);
electron.stdout.on("data", (d) => (apiLog += `[app] ${d}`));
electron.stderr.on("data", (d) => (apiLog += `[app] ${d}`));

let target;
for (let i = 0; i < 60 && target === undefined; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && String(t.url).startsWith(ORIGIN));
  } catch {
    // not listening yet
  }
}
if (target === undefined) die("no app:// window appeared within 60s");

const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
let nextId = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send("Runtime.enable");

/** Call one `window.host.account` method in the renderer and bring its answer back. */
async function account(method, input) {
  const argument = input === undefined ? "" : JSON.stringify(input);
  const reply = await send("Runtime.evaluate", {
    expression: `window.host.account.${method}(${argument})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (reply.result?.exceptionDetails !== undefined) {
    die(`${method} threw in the renderer: ${JSON.stringify(reply.result.exceptionDetails).slice(0, 400)}`);
  }
  return reply.result?.result?.value;
}

let checks = 0;
function check(what, condition, detail) {
  checks += 1;
  if (condition !== true) die(`${what}${detail === undefined ? "" : ` -- ${detail}`}`);
}

// -- The legs -----------------------------------------------------------------------------------

// A negative control first. If this is already signed in, the profile is not isolated and every
// assertion after it is about somebody else's session.
let state = await account("session");
check("a fresh profile starts signed out", state?.signedIn === false, JSON.stringify(state));

const registered = await account("register", {
  name: NAME,
  email: ADDRESS,
  password: FIRST_PASSWORD,
  acceptTerms: true,
});
check("register succeeds", registered?.ok === true, JSON.stringify(registered));
check("register reports it created the account", registered?.created === true, JSON.stringify(registered));

/*
 * THE safeStorage PROOF, and the reason refusal 1 is a failure rather than a warning.
 *
 * With no dev token in the environment, `sessionToken()` has exactly one source: `secretValue`
 * reading the vault. So a `session()` that says "signed in" after a fresh profile can only be
 * answering from a token that `storeSession` actually wrote.
 */
state = await account("session");
check("the session survives into the vault", state?.signedIn === true, JSON.stringify(state));

state = await account("refresh");
check("the server agrees who it is", state?.user?.email === ADDRESS, JSON.stringify(state?.user));
check("the new account has a password", state?.user?.hasPassword === true, JSON.stringify(state?.user));

/*
 * `durable` is asserted only off Linux, and that is a real platform difference rather than a
 * tolerated flake. On headless Linux there is no keyring, so `safeStorage` selects `basic_text`,
 * `backendIsDurable()` returns false and the session is kept for this launch only -- while
 * `isEncryptionAvailable()` stays true, so signing in still works. Asserting it everywhere is a
 * check that is green on Windows and red on CI for a reason that is not a defect.
 */
if (process.platform === "linux") {
  console.log("[account] durable: not asserted on linux (no keyring; safeStorage falls back to basic_text)");
} else {
  check("the session is stored durably", state?.durable === true, JSON.stringify(state));
}

await account("signOut");
state = await account("session");
check("signing out clears the vault", state?.signedIn === false, JSON.stringify(state));

const signedIn = await account("signInPassword", { email: ADDRESS, password: FIRST_PASSWORD });
check("the password signs in", signedIn?.ok === true, JSON.stringify(signedIn));
check(
  "signing in does not claim to have created an account",
  signedIn?.created === false,
  JSON.stringify(signedIn)
);
await account("signOut");

// -- The migration path: forgotten password, by code --------------------------------------------
const requested = await account("requestPasswordCode", { email: ADDRESS });
check("a reset code is issued", requested?.ok === true, JSON.stringify(requested));

/**
 * The six digits, out of the console provider's own log block.
 *
 * Matched against THIS RUN'S address, not "the last code in the log": the API may be serving other
 * requests, and a code belonging to somebody else must never be read, let alone printed.
 */
function codeFor(address) {
  const blocks = apiLog.split("EMAIL (console provider, not sent)").slice(1);
  for (const block of blocks.reverse()) {
    if (/^\s*to:\s*(\S+)/m.exec(block)?.[1] !== address) continue;
    const digits = /Your code is:\s*(\d{6})/.exec(block)?.[1];
    if (digits !== undefined) return digits;
  }
  return undefined;
}

let code;
for (let i = 0; i < 20 && code === undefined; i++) {
  code = codeFor(ADDRESS);
  if (code === undefined) await sleep(500);
}
if (code === undefined) {
  /*
   * The tail alone is useless here: the SGLang warmup polls every ten seconds and floods the last
   * few thousand characters, so the one line that says what happened is long gone by the time this
   * runs. These four are the API's own words for each outcome, and NONE of them carries the code --
   * the digits live further down the body, and this must not print them.
   */
  const said = apiLog
    .split("\n")
    .filter((line) => /Issued a password reset code|no eligible account|EMAIL NOT SENT|EMAIL \(console/.test(line))
    .slice(-6);
  die(
    "no reset code appeared in the API log for this run's address. What the API said about it: " +
      (said.length === 0 ? "nothing at all" : `\n  ${said.join("\n  ")}`)
  );
}
console.log("[account] forgot: a six-digit code was logged for this run's address");

const wrong = await account("resetPassword", {
  email: ADDRESS,
  code: "000000",
  newPassword: SECOND_PASSWORD,
});
check("a wrong code is refused", wrong?.ok === false, JSON.stringify(wrong));

const reset = await account("resetPassword", { email: ADDRESS, code, newPassword: SECOND_PASSWORD });
check("the right code sets the password", reset?.ok === true, JSON.stringify(reset));

state = await account("refresh");
check(
  "redeeming the code marks the address verified",
  state?.user?.emailVerified === true,
  JSON.stringify(state?.user)
);

await account("signOut");
const stale = await account("signInPassword", { email: ADDRESS, password: FIRST_PASSWORD });
check("the old password stops working", stale?.ok === false, JSON.stringify(stale));

const fresh = await account("signInPassword", { email: ADDRESS, password: SECOND_PASSWORD });
check("the new password works", fresh?.ok === true, JSON.stringify(fresh));

await account("signOut");

console.log(
  `[account] PASS -- ${checks} checks: registered, signed in from the vault, reset by code, ` +
    "old password dead, new password live"
);
stopEverything();
process.exit(0);
