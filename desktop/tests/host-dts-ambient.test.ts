/**
 * `host.d.ts` must stay an ambient script, not become a module.
 *
 * It declares `interface Window` to augment the global one, and that only works while the file
 * has no top-level `import` or `export`. Add one — the obvious thing to do when a channel's
 * return type starts referring to a shared type — and TypeScript reclassifies the file as a
 * module: `interface Window` becomes a local declaration, and `window.host` loses its type
 * everywhere at once.
 *
 * **The reason this needs a test rather than a comment is that the comment was already there
 * and the typecheck stays green.** Nothing in the renderer's compiled set touches `window.host`
 * directly enough for `tsc` to notice, so the whole surface degrades to `any`-by-absence
 * silently, and the next real mistake against it goes uncaught. This was hit while adding
 * `plan` to `agent.steps`, and found by probing with a throwaway file rather than by the suite.
 *
 * The fix, and the idiom the file already uses elsewhere, is an inline `import("...").Type`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DTS = path.join(HERE, "..", "renderer", "src", "types", "host.d.ts");

describe("host.d.ts", () => {
  const source = fs.readFileSync(DTS, "utf8");

  it("declares the global Window it exists to augment", () => {
    // If this ever stops being true the test below is guarding nothing, so it is asserted
    // rather than assumed.
    expect(source).toMatch(/^interface Window\b/m);
  });

  it("has no top-level import or export", () => {
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      // Top-level only: an `import(...)` type is indented inside a member, and the word also
      // appears in prose. Anchoring to column zero is what separates the two.
      .filter(({ line }) => /^\s*(import|export)\s/.test(line) && /^(import|export)\s/.test(line))
      .map(({ line, n }) => `${String(n)}: ${line}`);

    expect(
      offenders,
      "host.d.ts became a module — `window.host` is now untyped everywhere. Use an inline " +
        '`import("@shared/x").T` instead.'
    ).toEqual([]);
  });
});
