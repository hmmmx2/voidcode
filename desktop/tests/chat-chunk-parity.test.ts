/**
 * `ChatChunk` is declared twice and checked by nothing.
 *
 * It crosses a MessagePort between two separate TypeScript projects, so there is no import
 * that would make the compiler compare them: `src/main/inference/types.ts` defines what main
 * sends, and the copy inside `sseFromPort` in `renderer/src/lib/api/client.ts` defines what the
 * renderer expects — see the note on `RENDERER` below, which is where that pointer went wrong
 * once already. Both
 * ends have to land together, and when they do not, streaming stops **silently** — which is
 * the exact failure `preload/index.ts` already records once, where a proxied port looked fine
 * until the first `.start()`.
 *
 * A structural type assertion is impossible across the projects, so this reads both files and
 * compares the variant tags. Crude, and it catches the thing that actually goes wrong: someone
 * adds a chunk kind to main and the renderer silently ignores it.
 *
 * It must point at the copy the app *runs*. See the note on `RENDERER` below — it did not,
 * for a while, and said nothing.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The `kind:` literals in the first `ChatChunk` union in a file.
 *
 * Deliberately strict about finding the declaration: if the shape of the source changes enough
 * that this cannot locate it, the test throws rather than quietly comparing two empty sets.
 */
function chunkKinds(relative: string): string[] {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  // `type ChatChunk =` rather than `export type` — the renderer's copy is module-private.
  const start = source.indexOf("type ChatChunk =");
  if (start === -1) throw new Error(`no ChatChunk declaration in ${relative}`);

  // Up to the first line that is not part of the union: a blank line followed by something
  // at column zero. The union itself is entirely indented or leading-`|`.
  const body = source.slice(start).split(/\n\s*\n/)[0] ?? "";
  const kinds = [...body.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
  if (kinds.length === 0) throw new Error(`no kinds parsed from ${relative}`);
  return kinds.sort();
}

const MAIN = "src/main/inference/types.ts";
/**
 * The renderer copy that is actually used.
 *
 * This pointed at `lib/build/chat-stream.ts` until the assistant panels were unified, which
 * removed that file's last importer. The test kept passing — over a copy nobody read — while
 * the live duplicate inside `sseFromPort` went unchecked, and `sseFromPort` was meanwhile
 * treating every unrecognised chunk as terminal. A parity test aimed at dead code is worse
 * than none: it reports coverage of the thing it is not looking at.
 */
const RENDERER = "renderer/src/lib/api/client.ts";

describe("the two ChatChunk declarations", () => {
  it("have the same variants", () => {
    // Add a kind to main and forget the renderer, and the renderer's `if/else` over `kind`
    // simply never matches it — no error, no log, a stream that appears to stall.
    expect(chunkKinds(RENDERER)).toEqual(chunkKinds(MAIN));
  });

  it("include the ones this phase added", () => {
    // Pinned by name rather than only by equality, so deleting a variant from *both* files
    // is also a failure rather than a pair that agrees about being wrong.
    expect(chunkKinds(MAIN)).toContain("tool_call");
    // `reasoning` carries a thinking model's chain of thought. Pinned because dropping it is
    // how an exhausted thinking budget became indistinguishable from a silent model — the
    // assessor stored an empty `unknown` verdict, which `verdict.ts` documents as benign.
    expect(chunkKinds(MAIN)).toContain("reasoning");
    expect(chunkKinds(MAIN)).toEqual(["done", "error", "reasoning", "token", "tool_call"]);
  });

  it("both carry finishReason on the done variant", () => {
    // The field an agent loop keys on. Present in one and not the other means the renderer
    // cannot tell "finished" from "waiting for tools".
    for (const file of [MAIN, RENDERER]) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).toContain("finishReason");
    }
  });

  it("never renders reasoning as the answer", () => {
    /**
     * The property that makes a separate kind worth having. A reasoning model states the
     * solution as a matter of course while thinking, and the tutor's reply is the one place
     * this product works to withhold it — so reasoning goes on its own `delta` field and the
     * panel, which reads `delta.content`, cannot show it by accident.
     */
    const source = fs.readFileSync(path.join(root, RENDERER), "utf8");
    const handler = source.slice(source.indexOf("chat.onChunk("));
    const branch = handler.slice(handler.indexOf('chunk.kind === "reasoning"'));
    const body = branch.slice(0, branch.indexOf("return;"));

    expect(body).toContain("reasoning: chunk.text");
    expect(body).not.toContain("content:");
  });

  it("does not treat an unrecognised chunk as the end of the stream", () => {
    /**
     * The bug this file exists beside.
     *
     * `sseFromPort` handled `token` and `error` and let *everything else* fall into the `done`
     * branch — so a `tool_call` would have emitted `[DONE]`, closed the port and ended the
     * conversation mid-thought, with nothing anywhere saying why. Harmless only because
     * `chat:open` is called with the tutor surface, which is given no tools; that is a fact
     * about today's callers, not about this function.
     *
     * Structural, because `sseFromPort` is module-private and builds a ReadableStream. It
     * asserts the shape that makes the class of bug impossible: the non-terminal kind returns
     * before anything closes.
     */
    const source = fs.readFileSync(path.join(root, RENDERER), "utf8");
    const handler = source.slice(source.indexOf("chat.onChunk("));
    const firstClose = handler.indexOf("chat.close()");
    expect(firstClose).toBeGreaterThan(-1);

    // Every non-terminal kind, not just the one that prompted this. A kind added later and
    // handled after the close is the same bug wearing a different name.
    for (const kind of ["tool_call", "reasoning"]) {
      const at = handler.indexOf(`chunk.kind === "${kind}"`);
      expect(at, kind).toBeGreaterThan(-1);
      expect(at, kind).toBeLessThan(firstClose);
    }
  });
});
