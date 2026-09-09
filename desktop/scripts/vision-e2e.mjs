/**
 * Does an attached image actually reach the model?
 *
 * NOTHING ELSE ASKS THIS. `npm run smoke` touches the image path twice and neither check would
 * catch the failure this script exists for: the consent gate runs against a *scripted* provider,
 * and `assertImagesMatch` only proves the bytes match their declared type. Both pass while the
 * model answers about a picture it never read.
 *
 * That is not hypothetical. Shipped code bundled the image into the same turn as
 * `enrichedContent` -- several hundred characters of problem context, mode reasoning and test
 * output -- and qwen2.5vl called a solid red image "white" three times out of three, with the
 * bytes verified byte-identical on the wire. The image was delivered and not attended to, which
 * is worse than a refusal: the learner gets a fluent, confident description of their screenshot
 * with nothing to indicate it was never seen.
 *
 * So the assertion is a COLOUR, not a length or a schema. A red square is the one thing a model
 * cannot get right by guessing from the surrounding text.
 *
 * Opt-in, and skips rather than fails when the inference stack is absent:
 *   npm run smoke:vision
 * Needs Ollama running with a vision model pulled (e.g. qwen2.5vl:7b).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import WebSocket from "ws";

const PORT = Number(process.env.VOIDCODE_VISION_PORT ?? 9334);
const ORIGIN = "app://bundle";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A 224x224 solid red PNG, built here so the check carries no binary fixture. */
function redPng() {
  const W = 224;
  const H = 224;
  const pixelRow = [];
  for (let x = 0; x < W; x++) pixelRow.push(220, 30, 30);
  const rows = [];
  for (let y = 0; y < H; y++) rows.push(Buffer.from([0, ...pixelRow]));
  const raw = Buffer.concat(rows);

  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Skip cleanly when there is no vision model to ask ───────────────────────
let models = [];
try {
  const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(4000) });
  models = ((await response.json()).models ?? []).map((m) => m.name);
} catch {
  console.log("[vision] SKIP: Ollama is not reachable on 127.0.0.1:11434");
  process.exit(0);
}
if (!models.some((m) => /vl|vision|llava/i.test(m))) {
  console.log(`[vision] SKIP: no vision model pulled (have: ${models.join(", ") || "none"})`);
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), "voidcode-vision-"));
const imagePath = join(profile, "red.png");
writeFileSync(imagePath, redPng());

// An isolated --user-data-dir: this must not write into the conversations, settings or vault of
// whoever runs it.
const binary = process.platform === "win32" ? "electron.exe" : "electron";
const electron = spawn(
  join("node_modules", "electron", "dist", binary),
  ["out/main/index.js", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  { stdio: ["ignore", "pipe", "pipe"] }
);
let appLog = "";
electron.stdout.on("data", (d) => (appLog += d));
electron.stderr.on("data", (d) => (appLog += d));

const die = (why) => {
  console.log("[vision] FAIL:", why);
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
await send("DOM.enable");
await send("Page.navigate", { url: `${ORIGIN}/problems/1` });
await sleep(4000);

const COMPOSER = 'document.querySelector(\'textarea[placeholder="Ask Anything..."]\')';
let composerReady = false;
for (let i = 0; i < 80 && !composerReady; i++) {
  composerReady = (await evaluate(`${COMPOSER} !== null`)) === true;
  if (!composerReady) await sleep(500);
}
if (!composerReady) die("the composer never appeared");

/*
 * The COMPOSER's own file input, not merely the first one in the document. Taking the first is
 * what a first attempt does, and a green run would then mean "the file went to some other picker".
 */
const found = await evaluate(`
  (() => {
    const ta = ${COMPOSER};
    const composer = ta ? ta.closest("div").parentElement : null;
    const el = composer && composer.querySelector('input[type=file]');
    if (el) el.setAttribute("data-e2e", "composer-file");
    return el !== null && el !== undefined;
  })()
`);
if (found !== true) die("could not find the composer's own file input");

const doc = await send("DOM.getDocument", { depth: -1 });
const node = await send("DOM.querySelector", {
  nodeId: doc.result.root.nodeId,
  selector: '[data-e2e="composer-file"]',
});
// Set for real rather than faking a DataTransfer: the panel reads `e.target.files`, and a
// synthetic FileList is not the object the browser builds.
await send("DOM.setFileInputFiles", { nodeId: node.result.nodeId, files: [imagePath] });
await sleep(3000);

// Prove the APP took the file before judging the MODEL. Without this a dropped attachment is
// indistinguishable from a model that cannot see, and the run blames the wrong layer.
const previews = await evaluate(`
  (() => {
    const ta = ${COMPOSER};
    const composer = ta ? ta.closest("div").parentElement : document.body;
    return composer.querySelectorAll("img").length;
  })()
`);
if (previews === 0) die("the app did not accept the file: no attachment preview appeared");

const QUESTION = "What is the dominant colour of the image I attached? Answer with one word.";
await evaluate(`
  (() => {
    const ta = ${COMPOSER};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(QUESTION)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()
`);

/*
 * Settle, rather than wait for a length. The transcript grows while tokens arrive and stops when
 * the turn ends. A length threshold reported success once on
 * "Auto-submitting your code to evaluate test results..." -- panel furniture, with the model still
 * mid-sentence.
 */
const READ = `((() => {
  const text = (document.querySelector("main") ?? document.body).innerText;
  return text.split(${JSON.stringify(QUESTION)}).slice(1).join(" ").trim();
})())`;
let reply = "";
let previous = null;
let stable = 0;
const deadline = Date.now() + 300000;
while (Date.now() < deadline && stable < 4) {
  reply = (await evaluate(READ)) ?? "";
  stable = reply === previous && reply.trim().length > 0 ? stable + 1 : 0;
  previous = reply;
  if (stable < 4) await sleep(2000);
}

electron.kill("SIGKILL");
console.log("[vision] reply:", reply.replace(/\s+/g, " ").slice(0, 300));
if (!/red|crimson|scarlet/i.test(reply)) {
  console.log("[vision] FAIL: the model answered without reading the image.");
  console.log("  The attached image is solid red. Check that it rides its own turn rather than");
  console.log("  being bundled into the enriched-context message -- see the send path in");
  console.log("  renderer/src/components/VoidCodeAI/VoidCodeAIPanel.tsx.");
  process.exit(1);
}
console.log("[vision] PASS: the attached image reached the model and it named the colour");
