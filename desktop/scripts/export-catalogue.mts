/**
 * CLI wrapper for the catalogue export.
 *
 *   npm run export:catalogue -- <output.json>
 *
 * Everything worth reading is in `src/main/content/catalogue-export.ts`. This writes a file and
 * prints a summary; keeping it separate is what lets the builder be imported by a test without
 * writing anything.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { build, documentFor } from "../src/main/content/catalogue-export.js";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: npm run export:catalogue -- <output.json>");
  process.exit(2);
}

const document = documentFor(build());
const counts = document.counts as { problems: number; cases: number; hidden: number; visible: number };
const problems = document.problems as Array<{ source: string }>;

writeFileSync(path.resolve(out), `${JSON.stringify(document, null, 2)}
`, "utf8");

console.log(`wrote ${path.resolve(out)}`);
console.log(
  `  problems : ${counts.problems}  (${problems.filter((p) => p.source === "curriculum").length} curriculum, ` +
    `${problems.filter((p) => p.source === "interview").length} interview)`
);
console.log(`  cases    : ${counts.cases}  (${counts.visible} visible, ${counts.hidden} hidden)`);
console.log(`  specs    : ${(document.specs as unknown[]).length}`);
console.log(`  concepts : ${(document.concepts as unknown[]).length}`);
console.log(`  sha256   : ${document.contentHash as string}`);
