/**
 * Sending a folder, and saying what did not go.
 *
 * A folder reference is the one click in this app that can mean four hundred files, so something
 * has to stop — and the thing worth testing is not that it stops but what the user is told when
 * it does. Every other bounded thing here reports its bound; a folder that silently sent twelve
 * of four hundred would be the one place that did not.
 *
 * The load-bearing property: **the byte cap is a budget across the whole expansion, not a limit
 * per file.** Per-file capping passes a naive reading of "cap at 200 KB" and then sends twenty
 * files for a 4 MB prompt, which is the failure the cap exists to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_DROPPED_BYTES,
  candidatesFor,
  decodeRefDrag,
  droppedTextName,
  encodeRefDrag,
  expandRefs,
  looksBinaryByContent,
  looksBinaryByName,
  rejectionForDrop,
  summarise,
  type ContextRef,
  type RefTree,
} from "../renderer/src/lib/build/context-refs.js";

const file = (path: string) => ({ name: path.split("/").pop()!, path, kind: "file" as const });
const dir = (path: string, children: RefTree["entries"]) => ({
  name: path.split("/").pop()!,
  path,
  kind: "directory" as const,
  children,
});

const TREE: RefTree = {
  entries: [
    dir("src", [
      file("src/index.ts"),
      file("src/util.ts"),
      dir("src/img", [file("src/img/logo.png"), file("src/img/notes.md")]),
    ]),
    file("README.md"),
  ],
};

/** Every file the same size, so a byte budget divides cleanly. */
const reader = (size: number, over: Record<string, string> = {}) =>
  async (path: string): Promise<string> => {
    if (path in over) return over[path]!;
    return "x".repeat(size);
  };

const NUL = String.fromCharCode(0);

describe("what a reference names", () => {
  it("expands a folder to its files, depth first, in tree order", () => {
    expect(candidatesFor(TREE, [{ kind: "folder", path: "src" }])).toEqual([
      "src/index.ts",
      "src/util.ts",
      "src/img/logo.png",
      "src/img/notes.md",
    ]);
  });

  it("takes a single file as itself", () => {
    expect(candidatesFor(TREE, [{ kind: "file", path: "README.md" }])).toEqual(["README.md"]);
  });

  it("does not send the same file twice when refs overlap", () => {
    // Adding a folder and then a file inside it is a normal thing to do.
    const refs: ContextRef[] = [
      { kind: "folder", path: "src" },
      { kind: "file", path: "src/util.ts" },
    ];
    const paths = candidatesFor(TREE, refs);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("yields nothing for a path that is not in the tree", () => {
    expect(candidatesFor(TREE, [{ kind: "folder", path: "vendor" }])).toEqual([]);
  });
});

describe("the byte budget", () => {
  it("is spent across refs, not per file", async () => {
    /**
     * THE PROPERTY. Three 40-byte files against a 100-byte budget: two fit, the third does not.
     * A per-file cap would let all three through — each is under 100 on its own — and that is
     * exactly how a "capped" expansion becomes a megabyte.
     */
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], reader(40), {
      maxBytes: 100,
      maxFiles: 25,
    });

    const total = result.included.reduce((sum, f) => sum + f.contents.length, 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(result.included).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("says a file was left out for budget, by name", async () => {
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], reader(40), {
      maxBytes: 100,
      maxFiles: 25,
    });
    expect(result.skipped.map((s) => s.reason)).toContain("budget");
    expect(result.skipped.every((s) => s.path.length > 0)).toBe(true);
  });

  it("names a file too big for any budget separately from one that merely did not fit", async () => {
    // The user can act on "too large" — open it instead. "budget" only means "add fewer things".
    const read = reader(10, { "src/index.ts": "y".repeat(500) });
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], read, {
      maxBytes: 100,
      maxFiles: 25,
    });
    expect(result.skipped.find((s) => s.path === "src/index.ts")?.reason).toBe("too large");
    // And it did not stop the walk: the smaller files after it still went in.
    expect(result.included.map((f) => f.path)).toContain("src/util.ts");
  });

  it("caps the file count as well as the bytes", async () => {
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], reader(1), {
      maxBytes: 100_000,
      maxFiles: 2,
    });
    expect(result.included).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe("what is skipped and why", () => {
  it("skips a binary inside a folder, with a reason", async () => {
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], reader(10));
    expect(result.skipped).toContainEqual({ path: "src/img/logo.png", reason: "binary" });
    expect(result.included.map((f) => f.path)).not.toContain("src/img/logo.png");
  });

  it("skips a binary an extension did not give away", async () => {
    // A `.dat`, a file with no extension, a `.log` that is really a core dump.
    const read = reader(10, { "src/util.ts": `head${NUL}tail` });
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], read);
    expect(result.skipped).toContainEqual({ path: "src/util.ts", reason: "binary" });
  });

  it("skips a file that cannot be read rather than failing the whole expansion", async () => {
    // Deleted since the tree was walked, or unreadable. Normal, not exceptional.
    const read = async (path: string): Promise<string> => {
      if (path === "src/util.ts") throw new Error("ENOENT");
      return "ok";
    };
    const result = await expandRefs(TREE, [{ kind: "folder", path: "src" }], read);
    expect(result.skipped).toContainEqual({ path: "src/util.ts", reason: "unreadable" });
    expect(result.included.map((f) => f.path)).toContain("src/index.ts");
  });

  it("reports nothing skipped when nothing was", async () => {
    const result = await expandRefs(TREE, [{ kind: "file", path: "README.md" }], reader(10));
    expect(result.skipped).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.included).toHaveLength(1);
  });

  it("does not read a file it can reject by name", async () => {
    // A 40 MB video should not cross IPC to be thrown away.
    const seen: string[] = [];
    const read = async (path: string): Promise<string> => {
      seen.push(path);
      return "ok";
    };
    await expandRefs(TREE, [{ kind: "folder", path: "src" }], read);
    expect(seen).not.toContain("src/img/logo.png");
  });
});

describe("the binary heuristics", () => {
  it("knows the obvious extensions, case-insensitively", () => {
    expect(looksBinaryByName("a/b/logo.PNG")).toBe(true);
    expect(looksBinaryByName("dist/app.wasm")).toBe(true);
    expect(looksBinaryByName("src/index.ts")).toBe(false);
  });

  it("does not treat a dotfile's name as an extension", () => {
    /**
     * A leading dot separates nothing — `.gitignore` has no extension, it has a name that starts
     * with a dot.
     *
     * `.gitignore` alone cannot show the guard works, because "gitignore" is not a binary
     * extension either: the check passes whether or not the leading dot is handled. `.lock` can,
     * because "lock" *is* in the list — so a boundary that reads the leading dot as a separator
     * classifies the file as binary and drops it.
     */
    expect(looksBinaryByName(".gitignore")).toBe(false);
    expect(looksBinaryByName(".lock")).toBe(false);
    // And the same suffix after a real name still counts.
    expect(looksBinaryByName("yarn.lock")).toBe(true);
  });

  it("finds a NUL early in the content", () => {
    expect(looksBinaryByContent(`some text${NUL}more`)).toBe(true);
    expect(looksBinaryByContent("plain text, no nulls")).toBe(false);
  });

  it("only looks at the start, so a huge text file stays cheap", () => {
    expect(looksBinaryByContent("x".repeat(20_000) + NUL)).toBe(false);
  });
});

describe("the sentence above the composer", () => {
  it("counts what went in", () => {
    expect(summarise({ included: [{ path: "a", contents: "" }], skipped: [], truncated: false }))
      .toBe("1 file");
  });

  it("names the reasons things were skipped", () => {
    const line = summarise({
      included: [{ path: "a", contents: "" }, { path: "b", contents: "" }],
      skipped: [
        { path: "x.png", reason: "binary" },
        { path: "y.png", reason: "binary" },
        { path: "z.bin", reason: "too large" },
      ],
      truncated: false,
    });
    expect(line).toContain("2 files");
    expect(line).toContain("3 skipped");
    expect(line).toContain("2 binary");
    expect(line).toContain("1 too large");
  });

  it("distinguishes a cap from a skip", () => {
    // "3 skipped" and "there was more" are different facts and the user needs both.
    const line = summarise({ included: [], skipped: [], truncated: true });
    expect(line).toContain("more not included");
  });
});

/**
 * Dragging, and the one thing Electron will not give us.
 *
 * A drag from the file tree carries an exact project-relative path. A drop from the operating
 * system carries bytes and a filename and *no path at all* — `File.path` was removed in Electron
 * 32 and the replacement is deliberately not in the preload. The tests below exist to keep those
 * two apart, because conflating them means telling the model a file came from somewhere it did
 * not.
 */
describe("internal drags", () => {
  it("round-trips a reference", () => {
    for (const ref of [
      { kind: "file", path: "src/index.ts" },
      { kind: "folder", path: "src/components" },
    ] as ContextRef[]) {
      expect(decodeRefDrag(encodeRefDrag(ref))).toEqual(ref);
    }
  });

  it("refuses anything that is not one", () => {
    // `dataTransfer` is filled by whatever was dragged, including another page.
    for (const raw of [
      "",
      "not json",
      "null",
      "[]",
      '{"kind":"file"}',
      '{"path":"a.ts"}',
      '{"kind":"device","path":"a.ts"}',
      '{"kind":"file","path":""}',
      '{"kind":"file","path":123}',
    ]) {
      expect(decodeRefDrag(raw), raw).toBeNull();
    }
  });

  it("refuses a path the tree could not have produced", () => {
    // Absolute paths and traversals. `fs.read` confines to the root as well — this is the first
    // gate, not the only one.
    for (const path of ["/etc/passwd", "C:\Windows\system.ini", "../../secrets.env", "a/../../b"]) {
      expect(decodeRefDrag(JSON.stringify({ kind: "file", path })), path).toBeNull();
    }
  });
});

describe("drops from outside the app", () => {
  it("keeps a filename and never claims it is a path", () => {
    // The name is all Electron gives us. Presenting it as a path would be a lie about origin.
    expect(droppedTextName("notes.md")).toBe("notes.md");
    // `String.raw`, because the Windows case is the whole point and a single escaped backslash
    // turns `\notes` into a newline — which makes the test pass or fail for the wrong reason.
    expect(droppedTextName(String.raw`C:\Users\me\notes.md`)).toBe("notes.md");
    expect(droppedTextName("/home/me/notes.md")).toBe("notes.md");
  });

  it("falls back to something sayable when there is no name", () => {
    expect(droppedTextName("")).toBe("dropped file");
    expect(droppedTextName("/")).toBe("dropped file");
  });

  it("refuses a binary or an oversized file, with a reason", () => {
    expect(rejectionForDrop({ name: "logo.png", size: 10 })).toBe("binary");
    expect(rejectionForDrop({ name: "notes.md", size: MAX_DROPPED_BYTES + 1 })).toBe("too large");
    expect(rejectionForDrop({ name: "notes.md", size: 10 })).toBeNull();
  });
});
