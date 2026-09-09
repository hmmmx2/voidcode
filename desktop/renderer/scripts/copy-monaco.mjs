/**
 * Copy Monaco's `vs/` into the static export.
 *
 * `@monaco-editor/react` would otherwise fetch it from jsDelivr at runtime. Next knows
 * nothing about `node_modules/monaco-editor`, so nothing copies it for us — and the
 * failure is silent until someone opens the editor with no network.
 */
import { cp, stat } from "node:fs/promises";
import path from "node:path";

const from = path.resolve("node_modules/monaco-editor/min/vs");
const to = path.resolve("out/vs");

await cp(from, to, { recursive: true });

const { size } = await stat(path.join(to, "loader.js"));
if (size === 0) throw new Error("monaco loader.js is empty");
console.log(`copied monaco vs/ -> out/vs (loader.js ${size} bytes)`);
