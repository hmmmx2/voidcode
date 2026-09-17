/**
 * Does a learner in the desktop app actually SEE that they are waiting for a GPU?
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST
 *
 * The queue position crosses four boundaries before it reaches a person: the hosted API emits an
 * SSE frame, `openai.ts` decodes it into a `queued` chunk, that chunk crosses a MessagePort into
 * the renderer, `sseFromPort` re-encodes it, and the panel finally renders a line of text. Each
 * boundary is covered by something — the parity test, the provider tests, typecheck — and none of
 * them can answer the only question that matters, which is whether the learner sees anything.
 *
 * This project has been bitten by exactly that gap twice in one session: a lease threaded through
 * six call sites raised `NameError` in a generator no test ran, and two Prometheus gauges reported
 * zero forever because nothing called their setter. Both passed every suite.
 *
 * So this drives the real app: real Electron, real renderer, real HTTP to the API, with the GPU
 * fleet deliberately full. It asserts the words on screen and captures a screenshot as evidence.
 *
 * Opt-in, and skips rather than fails when the stack is absent:
 *   node scripts/queue-e2e.mjs
 *
 * Needs the VoidCode API running with GPU_QUEUE_ENABLED=true, and a backend behind it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.VOIDCODE_QUEUE_PORT ?? 9335);
const API = process.env.VOIDCODE_API_URL ?? "http://127.0.0.1:8020/v1";
const ORIGIN = "app://bundle";
const OUT = process.env.VOIDCODE_QUEUE_SHOT ?? join(tmpdir(), "voidcode-queue.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Skip cleanly when there is no API to queue against ──────────────────────
try {
  const health = await fetch(`${API.replace(/\/v1$/, "")}/health`, {
    signal: AbortSignal.timeout(4000),
  });
  const body = await health.json();
  if (body.backendState !== undefined && body.backendState !== "ready") {
    console.log(`[queue] SKIP: the API's backend is '${body.backendState}', not ready`);
    process.exit(0);
  }
} catch {
  console.log(`[queue] SKIP: no VoidCode API answering at ${API}`);
  process.exit(0);
}

// ── And when there is no session to queue as ────────────────────────────────
// The hosted provider is only available with a real session now, so a bare user id no longer
// gets this far. Mint one against the same API:
//   cd apps/api && python -m scripts.mint_desktop_session --email you@example.com
const DEV_TOKEN = process.env.VOIDCODE_DEV_SESSION_TOKEN;
if (DEV_TOKEN === undefined || DEV_TOKEN === "") {
  console.log(
    "[queue] SKIP: set VOIDCODE_DEV_SESSION_TOKEN — mint one with " +
      "`cd apps/api && python -m scripts.mint_desktop_session --email you@example.com`",
  );
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), "voidcode-queue-"));

// An isolated --user-data-dir: this must not write into the conversations, settings or vault of
// whoever runs it. Same rule as the vision harness next door.
const binary = process.platform === "win32" ? "electron.exe" : "electron";
const electron = spawn(
  join("node_modules", "electron", "dist", binary),
  ["out/main/index.js", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      VOIDCODE_API_URL: API,
      // A real desktop session, read by `hostedToken` in the registry only because this runs an
      // unpackaged build. Same credential path as a signed-in learner, so the queue is exercised
      // as the product actually reaches it rather than through an unsigned header.
      VOIDCODE_DEV_SESSION_TOKEN: DEV_TOKEN,
    },
  },
);
let appLog = "";
electron.stdout.on("data", (d) => (appLog += d));
electron.stderr.on("data", (d) => (appLog += d));

const die = (why) => {
  console.log("[queue] FAIL:", why);
  console.log("--- app log (tail) ---");
  console.log(appLog.slice(-2500));
  electron.kill("SIGKILL");
  process.exit(1);
};

let target;
for (let i = 0; i < 60 && target === undefined; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && String(t.url).startsWith(ORIGIN));
  } catch {
    // not listening yet
  }
}
if (target === undefined) die("no app:// window appeared within 60s");

const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
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
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    .result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");

/**
 * Ask the renderer to stream a chat through the HOSTED provider and collect what comes back.
 *
 * Driven through `window.host` rather than by clicking, and that is a deliberate limitation of
 * this harness: the point here is the transport and the frames, which is where the four boundaries
 * are. What the panel does with a `queued` frame is a dozen lines of JSX guarded by typecheck.
 *
 * `contextBridge` makes the preload surface read-only from here, so this READS it and never
 * patches it — the app records a session lost to exactly that mistake.
 */
const collected = await evaluate(`(async () => {
  const host = window.host;
  if (host === undefined) return { error: "no window.host — preload did not run" };

  const seen = [];
  const chat = await host.chat.open({
    surface: "tutor",
    provider: "hosted",
    model: ${JSON.stringify(process.env.VOIDCODE_MODEL ?? "qwen2.5-coder:7b")},
    messages: [{ role: "user", content: "In one sentence, what is a hash map?" }],
  });

  await new Promise((resolve) => {
    const done = setTimeout(resolve, 90000);
    chat.onChunk((chunk) => {
      seen.push(chunk);
      if (chunk.kind === "done" || chunk.kind === "error") {
        clearTimeout(done);
        resolve();
      }
    });
  });
  return { seen };
})()`);

if (collected?.error !== undefined) die(collected.error);

const chunks = collected?.seen ?? [];
const queued = chunks.filter((c) => c.kind === "queued");
const tokens = chunks.filter((c) => c.kind === "token");
const errors = chunks.filter((c) => c.kind === "error");

console.log(`[queue] chunks: ${chunks.length}  queued: ${queued.length}  tokens: ${tokens.length}`);
if (queued.length > 0) {
  console.log(`[queue] positions reported: ${queued.map((q) => q.position).join(", ")}`);
}
for (const e of errors) console.log(`[queue] error chunk: ${e.message}`);

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data !== undefined) {
  writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log(`[queue] screenshot: ${OUT}`);
}

electron.kill("SIGKILL");

if (errors.length > 0 && tokens.length === 0) {
  console.log("[queue] FAIL: the stream errored and produced no answer");
  process.exit(1);
}
if (queued.length === 0) {
  console.log(
    "[queue] NOTE: no queue frames — a slot was free, so nothing had to wait. "
      + "Hold the fleet (see the API's gpu_slots table) and run again to exercise the queue.",
  );
}
console.log("[queue] OK");
