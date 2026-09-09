/**
 * Reading a file as text, and saying so when it is not.
 *
 * `fs.readFile(path, "utf8")` never fails. Handed a PNG it returns a string of replacement
 * characters, and every layer above treats that as the file's contents — a viewer showing
 * mojibake, and an agent spending a large slice of its budget reading `????` out of a binary and
 * then reasoning about what it "saw".
 *
 * So the tests below are mostly about what is refused, and they use the real leading bytes of
 * real formats rather than invented ones.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { looksBinary, readTextFile } from "../src/main/build/text-file.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-text-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Write bytes and read them back through the real path. */
async function roundTrip(name: string, bytes: Buffer | string) {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return await readTextFile(file);
}

describe("looksBinary", () => {
  it("says no to text", () => {
    for (const text of [
      "",
      "hello",
      "const x = 1;\n",
      "# Heading\n\nSome prose.\n",
      "emoji 🎉 and accents café naïve\n",
      "tabs\tand\r\nwindows newlines\r\n",
    ]) {
      expect(looksBinary(Buffer.from(text, "utf8")), JSON.stringify(text)).toBe(false);
    }
  });

  it("says yes to a NUL byte, which is the signal git uses", () => {
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]))).toBe(true);
  });

  it("recognises the real leading bytes of common formats", () => {
    // Not invented headers — these are what the files actually start with.
    const headers: Array<[string, number[]]> = [
      ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["GZIP", [0x1f, 0x8b, 0x08, 0x00]],
      ["PDF-with-binary", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00]],
      ["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]],
      ["ZIP", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]],
      ["JPEG", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]],
    ];
    for (const [label, bytes] of headers) {
      expect(looksBinary(Buffer.from(bytes)), label).toBe(true);
    }
  });

  it("catches a file with no NUL that is still not text", () => {
    // The second signal earning its place. JPEG's header has a NUL, but plenty of compressed
    // payloads do not — and latin-1 text has none at all.
    expect(looksBinary(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a, 0x46]))).toBe(true);
    // `café` in latin-1: the 0xe9 is not a valid UTF-8 lead byte on its own.
    expect(looksBinary(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe(true);
  });

  it("catches UTF-16, whose ASCII range is half NUL bytes", () => {
    expect(looksBinary(Buffer.from("hello world", "utf16le"))).toBe(true);
  });

  it("does not reject a multi-byte character cut in half at the boundary", () => {
    /**
     * The reason the decode is streaming.
     *
     * A prefix almost always ends mid-character on a file with any non-ASCII in it. Without
     * `stream: true` the truncation reads as invalid UTF-8, and every such file over 8KB would
     * be reported as binary — which is a far worse failure than the one this guard prevents.
     */
    const emoji = Buffer.from("🎉", "utf8");
    for (let cut = 1; cut < emoji.length; cut++) {
      const truncated = Buffer.concat([Buffer.from("ok "), emoji.subarray(0, cut)]);
      expect(looksBinary(truncated), `cut at ${String(cut)}`).toBe(false);
    }
  });
});

describe("readTextFile", () => {
  it("returns the contents of a text file", async () => {
    const result = await roundTrip("a.ts", "export const x = 1;\n");
    expect(result).toEqual({ kind: "text", contents: "export const x = 1;\n" });
  });

  it("reads an empty file as empty text, not as binary", async () => {
    expect(await roundTrip("empty.txt", "")).toEqual({ kind: "text", contents: "" });
  });

  it("refuses a binary and reports its real size", async () => {
    // The size is what lets the UI say "3 bytes" rather than just "binary", and it is the
    // file's own size rather than the prefix that was inspected.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(50_000),
    ]);
    expect(await roundTrip("logo.png", png)).toEqual({ kind: "binary", bytes: 50_008 });
  });

  it("looks far enough in to catch a file that starts out looking like text", async () => {
    /**
     * What the 8KB prefix is for, and a four-byte one would not catch.
     *
     * A PDF opens `%PDF-1.4` — plain ASCII — and turns binary immediately after. So does a
     * WAV (`RIFF`), a Java class file's constant pool, and most container formats: they lead
     * with a readable magic string. A check that looked only at the first few bytes would call
     * every one of them text and hand back a screenful of replacement characters.
     */
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1"),
      Buffer.alloc(2_000),
      Buffer.from("stream\n"),
    ]);
    expect((await roundTrip("doc.pdf", pdf)).kind).toBe("binary");

    // And a WAV, which has no NUL at all in its first bytes — the UTF-8 check is what catches it.
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x24, 0x08, 0x10, 0x11]),
      Buffer.from("WAVEfmt "),
      Buffer.from([0xff, 0xfe, 0xfd, 0xfc]),
    ]);
    expect((await roundTrip("sound.wav", wav)).kind).toBe("binary");
  });

  it("does not decide from the extension", async () => {
    // A `.png` holding text is text, and a `.ts` holding a binary is not. The bytes decide,
    // because a name is a claim and the contents are the fact.
    expect(await roundTrip("actually-text.png", "not really a png\n")).toEqual({
      kind: "text",
      contents: "not really a png\n",
    });
    expect((await roundTrip("actually-binary.ts", Buffer.from([0x00, 0x01, 0x02]))).kind).toBe(
      "binary"
    );
  });

  it("reads a file larger than the prefix it inspects", async () => {
    // The check looks at 8KB; the read must still return everything.
    const big = "x".repeat(40_000);
    const result = await roundTrip("big.txt", big);
    expect(result.kind).toBe("text");
    expect(result.kind === "text" && result.contents.length).toBe(40_000);
  });

  it("keeps text intact past the prefix boundary", async () => {
    // A file whose non-ASCII lands near 8192 is exactly where a naive prefix check corrupts or
    // misclassifies. The contents must come back byte-identical.
    const contents = `${"a".repeat(8_190)}🎉${"b".repeat(100)}`;
    const result = await roundTrip("boundary.md", contents);
    expect(result).toEqual({ kind: "text", contents });
  });

  it("honours an abort signal", async () => {
    // Threaded through for the same reason it always was: a large file on a slow disk is where
    // Stop has to mean something.
    const file = path.join(dir, "slow.txt");
    await fs.writeFile(file, "x".repeat(100_000));
    const controller = new AbortController();
    controller.abort();
    await expect(readTextFile(file, { signal: controller.signal })).rejects.toThrow();
  });

  it("propagates a missing file rather than calling it binary", async () => {
    // "Not there" and "not text" are different answers, and a caller acts differently on each.
    await expect(readTextFile(path.join(dir, "nope.txt"))).rejects.toThrow();
  });
});
