/**
 * `AgentEvent` is declared twice and checked by nothing.
 *
 * Same problem as `ChatChunk`, same reason, same crude solution: the type crosses a MessagePort
 * between two separate TypeScript projects, so no import exists that would let the compiler
 * compare them. `src/main/agent/stream.ts` defines what main sends;
 * `renderer/src/lib/build/agent-stream.ts` defines what the renderer expects.
 *
 * The failure mode is worth stating because it is not "a crash". Add a variant to main and
 * forget the renderer, and the renderer's handler falls through to its terminal branch — the
 * turn ends early, mid-sentence, with no error anywhere. That is precisely the bug the chat
 * client shipped with: it treated everything that was not a token as terminal, so the first
 * tool call would have silently ended the conversation.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function eventKinds(relative: string): string[] {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const start = source.indexOf("export type AgentEvent =");
  if (start === -1) throw new Error(`no AgentEvent declaration in ${relative}`);

  // Up to the first blank line followed by something at column zero — the union itself is
  // entirely indented or leading-`|`.
  const body = source.slice(start).split(/\n\s*\n/)[0] ?? "";
  const kinds = [...body.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
  if (kinds.length === 0) throw new Error(`no kinds parsed from ${relative}`);
  return kinds.sort();
}

const MAIN = "src/main/agent/stream.ts";
const RENDERER = "renderer/src/lib/build/agent-stream.ts";

describe("the two AgentEvent declarations", () => {
  it("have the same variants", () => {
    expect(eventKinds(RENDERER)).toEqual(eventKinds(MAIN));
  });

  it("carry the four the unified surface needs", () => {
    /**
     * Pinned by name as well as by equality, so deleting a variant from *both* files fails
     * too rather than producing a pair that agrees about being wrong.
     *
     * `token` and `step` together are the whole point of unifying: prose as it is written, and
     * tool activity in the same ordered stream.
     */
    expect(eventKinds(MAIN)).toEqual(["done", "error", "step", "token"]);
  });

  it("both carry the ids a turn ends with", () => {
    // `proposedDiffIds` is what the apply bar is built from. Present in one and not the other
    // means a turn proposes edits the user is never offered.
    for (const file of [MAIN, RENDERER]) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source).toContain("proposedDiffIds");
      expect(source).toContain("finishReason");
    }
  });

  it("treats only done and error as terminal in the renderer", () => {
    /**
     * The chat client's bug, asserted against directly.
     *
     * `chat-stream.ts` closes the stream for anything that is not a token, which would have
     * ended a turn on its first tool call. This client must enumerate its terminal cases
     * instead, so a new variant is ignored rather than fatal.
     */
    const source = fs.readFileSync(path.join(root, RENDERER), "utf8");
    // `lastIndexOf`, not `indexOf`: the first `opened.close()` is the cancelled-before-open
    // branch near the top of the function, which sits above everything and made this assert
    // the opposite of what it meant to.
    const closeAt = source.lastIndexOf("opened.close()");
    expect(closeAt).toBeGreaterThan(-1);
    // Both non-terminal kinds return before reaching the close.
    for (const kind of ['"token"', '"step"']) {
      const handled = source.indexOf(`event.kind === ${kind}`);
      expect(handled).toBeGreaterThan(-1);
      expect(handled).toBeLessThan(closeAt);
    }
  });
});
