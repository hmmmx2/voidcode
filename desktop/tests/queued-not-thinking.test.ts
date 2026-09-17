/**
 * A queued request must not claim the tutor is thinking.
 *
 * `ChatMessage` renders `ThinkingBlock` whenever `isStreaming` is true, and `isStreaming` goes true
 * the moment the response opens — which, for a request waiting on a GPU slot, is before any model
 * has seen the question. The panel showed "Thinking..." directly above "Waiting for a free GPU
 * slot...", so the app told the learner their tutor was reasoning about their problem while it sat
 * in a queue behind somebody else's.
 *
 * That is a lie of the same family as the "messages remaining" count the credits screen refuses to
 * show, and it is worth a guard rather than a fix and a hope: the condition is one clause in a JSX
 * prop, exactly the sort of thing a later refactor tidies away without knowing what it was for.
 *
 * SOURCE-SCANNED, BECAUSE THERE IS NO RENDERER TEST ENVIRONMENT. `vitest.config.ts` runs
 * `environment: "node"` over `tests/**\/*.test.ts`; there is no jsdom and no testing-library, so
 * rendering the component is not available without adding a whole harness for one conditional.
 *
 * BOTH COPIES ARE CHECKED, and that is the uncomfortable part. This panel exists twice — once in
 * the desktop renderer and once in `apps/web` — as hand-maintained near-duplicates of about two
 * thousand lines each. Three separate changes have now had to be applied to both. The duplication
 * is the real defect here; until it is addressed, a guard that only watched one copy would let the
 * other drift, so this reads both.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(desktopRoot, "..");

const PANELS: Array<[string, string]> = [
  ["desktop", path.join(desktopRoot, "renderer/src/components/VoidCodeAI/VoidCodeAIPanel.tsx")],
  // The website's copy is gone with its logged-in UI: apps/web is a landing page and two legal
  // documents now. The list stays a list, because the duplication it guards against is the kind
  // that comes back.
];

/** Strip comments, so a note *about* the invariant is never mistaken for the invariant. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("a queued request is not shown as thinking", () => {
  it("finds both copies of the panel", () => {
    // Guards the paths: if the web app moves, this must fail loudly rather than silently check one.
    for (const [label, file] of PANELS) {
      expect(fs.existsSync(file), `${label} panel not found at ${file}`).toBe(true);
    }
  });

  it.each(PANELS)("suppresses the thinking block while queued (%s)", (label, file) => {
    const source = code(fs.readFileSync(file, "utf8"));

    const streamingProp = source.match(/isStreaming=\{[\s\S]{0,260}?\}/);
    expect(streamingProp, `${label}: no isStreaming prop passed to a message`).not.toBeNull();

    expect(
      streamingProp![0],
      `${label}: a message is marked streaming without checking the queue, so "Thinking..." will `
        + "render while the request is still waiting for a GPU slot",
    ).toContain("queuePosition === null");
  });

  it.each(PANELS)("still renders the queue line itself (%s)", (label, file) => {
    const source = code(fs.readFileSync(file, "utf8"));
    expect(source, `${label}: the queue position is no longer rendered at all`).toContain(
      "Waiting for a free GPU slot",
    );
  });
});
