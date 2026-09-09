/**
 * Test-only shim for `node:sqlite`.
 *
 * The production code imports `node:sqlite` directly, which is correct: Electron 43
 * ships Node 24, where it is a stable builtin. But vitest runs under the *system* Node,
 * and on 22.x `node:sqlite` is requireable while being absent from
 * `module.builtinModules` — Vite decides what to externalise from that list, so it
 * strips the prefix and looks for a file called `sqlite`.
 *
 * `createRequire` sidesteps the bundler's static analysis and hands back the real
 * module, so the store tests exercise genuine SQLite rather than a fake. Aliased in
 * `vitest.config.ts` only; nothing in the shipped app goes through this file.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export const { DatabaseSync } = sqlite;
export default sqlite;
