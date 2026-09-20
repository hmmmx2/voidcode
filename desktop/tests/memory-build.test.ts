/**
 * Building an index against a real filesystem, with the model stubbed.
 *
 * The behaviour under test is **what gets re-embedded**, and it is worth its own file because
 * it is the difference between a refresh that takes two seconds and one that takes two minutes
 * — or, in the other direction, an index that quietly describes code that no longer exists.
 *
 * mtime and size are the cheap gate. The hash is the truth. A checkout restores files with new
 * mtimes and identical contents, so a gate-only check re-embeds a whole project because git
 * touched it; a hash-only check stats nothing and reads every file to find that out.
 *
 * The embedder is stubbed rather than run. What a real one adds is proof that Ollama works,
 * which is not this file's claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const embedAll = vi.fn();
const embeddingsAvailable = vi.fn(async () => true);
const showMessageBox = vi.fn(async () => ({ response: 1 }));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: () => showMessageBox() },
}));

vi.mock("../src/main/memory/embed.js", async () => {
  const actual = await vi.importActual<typeof import("../src/main/memory/embed.js")>(
    "../src/main/memory/embed.js"
  );
  return {
    ...actual,
    EMBED_MODEL: "test-embed",
    embedAll: (texts: string[]) => embedAll(texts),
    embeddingsAvailable: () => embeddingsAvailable(),
  };
});

const { __useInMemory } = await import("../src/main/store/db.js");
const { buildIndex, memoryStatus } = await import("../src/main/memory/index.js");
const { __scriptMemoryConsent, consentFor } = await import("../src/main/memory/consent.js");
const { readIndex, EMBED_DIM } = await import("../src/main/memory/store.js");

const sender = { id: 1, isDestroyed: () => false } as unknown as Electron.WebContents;

let root: string;

/** One distinct unit vector per text, so ranking is deterministic without a model. */
function fakeVectors(texts: string[]): number[][] {
  return texts.map((_, i) => {
    const v = new Array<number>(EMBED_DIM).fill(0);
    v[i % EMBED_DIM] = 1;
    return v;
  });
}

beforeEach(async () => {
  __useInMemory();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-build-"));
  embedAll.mockReset();
  embedAll.mockImplementation(async (texts: string[]) => fakeVectors(texts));
  embeddingsAvailable.mockResolvedValue(true);
  __scriptMemoryConsent(() => true);
});

afterEach(async () => {
  __scriptMemoryConsent(undefined);
  await fs.rm(root, { recursive: true, force: true });
});

const write = (relative: string, contents: string): Promise<void> =>
  fs
    .mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    .then(() => fs.writeFile(path.join(root, relative), contents, "utf8"));

describe("a first index", () => {
  it("embeds the project and records what it saw", async () => {
    await write("a.py", "def one():\n    return 1\n");
    await write("b.py", "def two():\n    return 2\n");

    const result = await buildIndex({ sender, projectRoot: root });

    expect(result.indexed).toBe(2);
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);

    const state = await readIndex(root);
    expect(Object.keys(state?.files ?? {}).sort()).toEqual(["a.py", "b.py"]);
  });

  it("writes into .voidcode/index inside the project", async () => {
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });

    // Where the consent prompt said it would go. Anywhere else would make the prompt a lie.
    await expect(fs.stat(path.join(root, ".voidcode", "index", "manifest.json"))).resolves.toBeDefined();
  });

  it("skips what .gitignore excludes", async () => {
    await write(".gitignore", "generated/\n");
    await write("src/main.py", "x = 1\n");
    await write("generated/huge.py", "y = 2\n");

    await buildIndex({ sender, projectRoot: root });
    expect(Object.keys((await readIndex(root))?.files ?? {})).toEqual(["src/main.py"]);
  });

  it("skips directories nobody means by 'my project'", async () => {
    await write("src/main.py", "x = 1\n");
    await write("node_modules/pkg/index.js", "module.exports = 1\n");

    await buildIndex({ sender, projectRoot: root });
    expect(Object.keys((await readIndex(root))?.files ?? {})).toEqual(["src/main.py"]);
  });

  it("never indexes its own index", async () => {
    // Otherwise a second run embeds the first run's output, which grows without bound.
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });
    await buildIndex({ sender, projectRoot: root });

    const paths = Object.keys((await readIndex(root))?.files ?? {});
    expect(paths.some((p) => p.startsWith(".voidcode"))).toBe(false);
  });
});

describe("re-indexing", () => {
  it("embeds nothing when nothing changed", async () => {
    await write("a.py", "def one():\n    return 1\n");
    await buildIndex({ sender, projectRoot: root });

    embedAll.mockClear();
    const result = await buildIndex({ sender, projectRoot: root });

    expect(embedAll).not.toHaveBeenCalled();
    expect(result.indexed).toBe(1);
  });

  it("re-embeds a file whose contents changed", async () => {
    await write("a.py", "def one():\n    return 1\n");
    await buildIndex({ sender, projectRoot: root });

    embedAll.mockClear();
    await write("a.py", "def one():\n    return 99\n");
    await buildIndex({ sender, projectRoot: root });

    expect(embedAll).toHaveBeenCalled();
  });

  it("does NOT re-embed a file git merely touched", async () => {
    // THE CASE THE HASH EXISTS FOR. A checkout restores identical contents with a fresh
    // mtime; a gate-only check would re-embed the whole project every branch switch.
    await write("a.py", "def one():\n    return 1\n");
    await buildIndex({ sender, projectRoot: root });

    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(root, "a.py"), future, future);

    embedAll.mockClear();
    await buildIndex({ sender, projectRoot: root });

    expect(embedAll).not.toHaveBeenCalled();
  });

  it("notices a change that kept the same size", async () => {
    // Same byte count, different bytes — which mtime alone would catch but a size-only gate
    // would not, and which is exactly what a one-character fix looks like.
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });

    embedAll.mockClear();
    await write("a.py", "x = 2\n");

    // THE MTIME IS BUMPED EXPLICITLY, and the race it removes is why. `index.ts`'s cheap gate
    // skips a file whose mtime AND size both match, WITHOUT hashing it — and these two writes are
    // the same six bytes, so the whole test rests on them landing on different mtimes. Nothing
    // guarantees that: two writes milliseconds apart can share a timestamp, and then the file is
    // skipped, `embedAll` is never called, and this fails with "expected spy to be called at least
    // once" — which names the symptom and not one word of the cause. It failed exactly that way on
    // the Linux runner, having passed on the previous commit and on every developer machine.
    //
    // Not reproduced locally: the window is a fraction of a millisecond and depends on the
    // filesystem's timestamp granularity. So it is removed by construction rather than chased.
    //
    // The assertion still means what it meant. Getting past the gate is not what is under test —
    // the HASH deciding to re-embed is, and a size-only gate would still skip this file and still
    // fail. `does NOT re-embed a file git merely touched` above covers the other half of the
    // matrix: mtime differs, hash identical, no re-embed.
    const later = new Date(Date.now() + 2_000);
    await fs.utimes(path.join(root, "a.py"), later, later);

    await buildIndex({ sender, projectRoot: root });

    expect(embedAll).toHaveBeenCalled();
  });
});

describe("consent", () => {
  it("asks before writing anything into the project", async () => {
    await write("a.py", "x = 1\n");
    __scriptMemoryConsent(() => false);

    await expect(buildIndex({ sender, projectRoot: root })).rejects.toThrow(/declined/);
    // And wrote nothing. A refusal that still left files behind would be worse than no prompt.
    await expect(fs.stat(path.join(root, ".voidcode"))).rejects.toThrow();
  });

  it("remembers a decline, so it does not become a prompt again", async () => {
    await write("a.py", "x = 1\n");
    __scriptMemoryConsent(() => false);
    await buildIndex({ sender, projectRoot: root }).catch(() => {});

    expect(consentFor(root)).toBe("declined");
  });

  it("does not ask twice once granted", async () => {
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });

    let askedAgain = false;
    __scriptMemoryConsent(() => {
      askedAgain = true;
      return true;
    });
    await write("b.py", "y = 2\n");
    await buildIndex({ sender, projectRoot: root });

    expect(askedAgain).toBe(false);
  });

  it("stores the answer outside the project", async () => {
    // A repository must not be able to grant its own permission: clone something with a
    // "consented" file in it and the index would build with no prompt.
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });

    const inside = await fs.readdir(path.join(root, ".voidcode", "index"));
    expect(inside.some((name) => /consent/i.test(name))).toBe(false);
    expect(consentFor(root)).toBe("granted");
  });
});

describe("when the model is missing", () => {
  it("says what to install rather than failing obscurely", async () => {
    embeddingsAvailable.mockResolvedValue(false);
    await write("a.py", "x = 1\n");

    await expect(buildIndex({ sender, projectRoot: root })).rejects.toThrow(/not installed/);
  });

  it("does not prompt for consent it cannot act on", async () => {
    // Agreeing to an index that then cannot be built is a prompt that cost the user a decision
    // for nothing.
    embeddingsAvailable.mockResolvedValue(false);
    await write("a.py", "x = 1\n");
    let asked = false;
    __scriptMemoryConsent(() => {
      asked = true;
      return true;
    });

    await buildIndex({ sender, projectRoot: root }).catch(() => {});
    expect(asked).toBe(false);
  });
});

describe("status", () => {
  it("reports an unindexed project honestly", async () => {
    const status = await memoryStatus(root);
    expect(status.indexed).toBe(false);
    expect(status.chunkCount).toBe(0);
    expect(status.consent).toBe("unasked");
  });

  it("names where the index lives, rather than describing it", async () => {
    await write("a.py", "x = 1\n");
    await buildIndex({ sender, projectRoot: root });

    const status = await memoryStatus(root);
    expect(status.indexed).toBe(true);
    expect(status.fileCount).toBe(1);
    expect(status.location).toContain(".voidcode");
  });
});
