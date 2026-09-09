/**
 * Turn a logged stack back into files and line numbers.
 *
 * The error log records what V8 reports, and V8 reports the shipped bundle: sixty-nine frames
 * of `at t (03b639d8b5540eb2.js:1:155)`. Enabling `productionBrowserSourceMaps` does not change
 * that — it emits the `.map` files that make those coordinates resolvable after the fact. This
 * script is the "after the fact".
 *
 * No dependency: Node's own `SourceMap` from `node:module` consumes a v3 map directly.
 *
 * The one thing worth knowing, because guessing it wrong makes this look broken: **Next hashes
 * the map filename independently of the chunk filename.** `03b639d8b5540eb2.js` is described by
 * `f881e26fc0e61f83.js.map`, not by `03b639d8b5540eb2.js.map`. The link lives in the
 * `//# sourceMappingURL=` comment at the end of the chunk, which is why this reads it rather
 * than deriving the name — a derived name matches roughly one chunk in thirty-six and reports
 * every other frame as unmapped.
 *
 *   node scripts/resolve-log.mjs            # the most recent entry
 *   node scripts/resolve-log.mjs 5          # the last 5 entries
 *   node scripts/resolve-log.mjs 1 --all    # framework frames too
 *
 * Resolving a log from a released build needs that build's maps:
 *
 *   VOIDCODE_MAPS=/path/to/archived/chunks node scripts/resolve-log.mjs
 *
 * ── WHAT THE LINE NUMBER ACTUALLY MEANS ───────────────────────────────────────────────────────
 *
 * **Trust the filename. Treat the line number as approximate.** Measured, not assumed: a real
 * failure at `MenuBar.tsx:48` resolves to `MenuBar.tsx:223`, and the map is not wrong.
 *
 * The build runs the React Compiler, and Next's production map composes *minified → compiler
 * output*, not *minified → your file*. So `sources` names the real path while the coordinates
 * belong to the compiler's rewrite of it: the embedded `sourcesContent` for that file starts with
 * `import { c as _c } from "react/compiler-runtime"` and has hoisted the inline handler into a
 * `function _temp(menu, event)` 175 lines further down. Of 183 sources embedded in one build's
 * maps, 96 have a different length from the file on disk and 87 are untouched — the split is
 * exactly which files the compiler rewrote.
 *
 * This is worth knowing before it looks like a bug in this script or a stale archive, which is how
 * it presented for half an hour. The file, the function name in the frame, and the surrounding
 * code are all still correct and are most of the value; the number is a position in a derived form
 * of the file. Composing the compiler's own map into the chain would fix it and is not attempted
 * here.
 */
import { SourceMap } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Where the chunks and their maps live.
 *
 * The build output, always — because the maps deliberately do not ship. `electron-builder.yml`
 * filters `.map` out of the packaged renderer, so an installed app has the chunks and none of
 * the mappings, and there is nothing there to resolve against.
 *
 * The consequence is a habit rather than a setting: **keep `renderer/out` for any build you
 * release.** A stack from a user's install is resolvable only against the maps from the build
 * that produced it. `VOIDCODE_MAPS` points at an archived one.
 *
 * Do not cross builds. Chunk hashes change every time, so a hash that happens to collide
 * resolves to a confident wrong answer rather than an error, which is worse than no answer.
 */
const CHUNKS =
  process.env.VOIDCODE_MAPS !== undefined
    ? process.env.VOIDCODE_MAPS
    : path.join(root, "renderer/out/_next/static/chunks");

function logPath() {
  const appData = process.env.APPDATA;
  if (appData !== undefined) return path.join(appData, "@voidcode/desktop/logs/voidcode.log");
  const home = process.env.HOME ?? "";
  return process.platform === "darwin"
    ? path.join(home, "Library/Logs/@voidcode/desktop/voidcode.log")
    : path.join(home, ".config/@voidcode/desktop/logs/voidcode.log");
}

const cache = new Map();

/** Follow the chunk's own `sourceMappingURL`, rather than guessing the filename. */
function mapFor(chunk) {
  if (cache.has(chunk)) return cache.get(chunk);

  let consumer = null;
  const js = path.join(CHUNKS, chunk);
  if (existsSync(js)) {
    const tail = readFileSync(js, "utf8").slice(-500);
    const named = /sourceMappingURL=(\S+)/.exec(tail);
    if (named !== null) {
      const mapFile = path.join(CHUNKS, named[1]);
      if (existsSync(mapFile)) {
        try {
          consumer = new SourceMap(JSON.parse(readFileSync(mapFile, "utf8")));
        } catch {
          consumer = null;
        }
      }
    }
  }
  cache.set(chunk, consumer);
  return consumer;
}

function resolveFrame(frame) {
  const m = /chunks\/([^/:]+):(\d+):(\d+)/.exec(frame);
  if (m === null) return null;
  const [, chunk, line, column] = m;

  const consumer = mapFor(chunk);
  if (consumer === null) return { location: `${chunk} — no map`, ours: false, unresolved: true };

  // V8 reports 1-based; source maps are 0-based.
  const found = consumer.findEntry(Number(line) - 1, Number(column) - 1);
  if (found === undefined || found.originalSource === undefined) {
    return { location: `${chunk} — unmapped`, ours: false, unresolved: true };
  }

  /**
   * Sources arrive as `turbopack:///[project]/<absolute path>`, which is mostly the machine
   * the build ran on. Cut back to the repo-relative path — that is the part you can open.
   */
  const file = found.originalSource
    .replace(/^\w+:\/{2,3}/, "")
    .replace(/^\[project\]\//, "")
    .replace(/^.*?(?=(?:desktop|renderer|src)\/)/, "")
    .replace(/^\.\//, "");

  return {
    location: `${file}:${found.originalLine + 1}:${found.originalColumn + 1}`,
    // Your code or somebody else's. Only the first kind is worth reading first.
    ours: !file.includes("node_modules"),
    unresolved: false,
  };
}

const count = Number(process.argv[2] ?? 1);
const entries = readFileSync(logPath(), "utf8")
  .split("\n")
  .filter(Boolean)
  .slice(-count)
  .map((l) => JSON.parse(l));

for (const entry of entries) {
  console.log(`\n${entry.ts}  [${entry.level}] ${entry.source}`);
  console.log(`  ${entry.message}`);
  if (entry.context?.route !== undefined) console.log(`  route: ${entry.context.route}`);

  const frames = [
    ...String(entry.stack ?? "").split("\n"),
    ...String(entry.context?.componentStack ?? "").split("\n"),
  ].filter((f) => f.includes("chunks/"));

  if (frames.length === 0) {
    console.log("  (no bundle frames)");
    continue;
  }

  const resolved = frames.map(resolveFrame).filter((r) => r !== null);

  /**
   * Your files first, then everything else collapsed to a count.
   *
   * A resolved React stack is nearly all `next/dist` and `react-dom` — twenty-odd frames of
   * framework between the throw and the boundary. Printing them in full buries the two lines
   * that name your own code, which is the reason to run this at all.
   */
  const ours = resolved.filter((r) => r.ours);
  const theirs = resolved.length - ours.length;

  /**
   * "Nothing resolved" and "nothing of yours in the stack" are different problems.
   *
   * The first almost always means the log came from a different build than the maps on disk:
   * chunk hashes change every build, so none of the filenames match and every frame reports
   * `no map`. Reporting that as "no frames in your own source" sends you looking for a bug in
   * framework code instead of at the build you are resolving against.
   */
  for (const frame of ours) console.log(`    ${frame.location}`);
  if (resolved.every((r) => r.unresolved)) {
    console.log("    (nothing resolved — these maps are from a different build)");
    console.log("     point VOIDCODE_MAPS at the chunks directory of the build that logged it");
  } else if (ours.length === 0) {
    console.log("    (no frames in your own source)");
  }
  if (theirs > 0) console.log(`    … ${theirs} framework frames (run with --all to see them)`);

  if (process.argv.includes("--all")) {
    for (const frame of resolved.filter((r) => !r.ours)) console.log(`      ${frame.location}`);
  }
}
