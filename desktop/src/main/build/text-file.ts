/**
 * Reading a file as text, and saying so when it is not.
 *
 * `fs.readFile(path, "utf8")` never fails. Hand it a PNG and it returns a string of replacement
 * characters — and every layer above treats that string as the file's contents, because nothing
 * in the type says otherwise. What that produced: a viewer showing mojibake, and, worse, an agent
 * spending a large part of its budget reading 64KB of `????` out of a binary and then reasoning
 * about what it "saw".
 *
 * **The detection is a prefix check, which is what every tool that does this uses.** git reads
 * the first 8000 bytes and calls the file binary if it finds a NUL; ripgrep does the same. The
 * known limitation is the same too: a file that is text for eight kilobytes and binary after is
 * read as text. That is accepted here rather than papered over, because the alternative — scanning
 * a 500MB file to answer "should I show this?" — costs more than the case is worth.
 *
 * **Two signals, not one.** A NUL byte catches the vast majority, including UTF-16, whose ASCII
 * range is full of them. Invalid UTF-8 catches the rest: a latin-1 file with an accented
 * character, or a compressed blob that happens to contain no zero byte. Checking only for NUL
 * would let those through as text, and they are exactly the files that render as mojibake rather
 * than as something obviously wrong.
 */
import fs from "node:fs/promises";

/**
 * How much to look at.
 *
 * 8KB, matching git. Large enough that a real source file's first bytes are representative,
 * small enough that the check costs one disk read on a file that may be enormous.
 */
const PREFIX_BYTES = 8_192;

export type TextFileRead =
  | { kind: "text"; contents: string }
  /** Not text. `bytes` is the file's real size, so a caller can say how big the thing it refused is. */
  | { kind: "binary"; bytes: number };

/**
 * Does this look like something other than text?
 *
 * Exported for its own tests: it is the whole judgement, and it is worth being able to state what
 * it does and does not catch without going near a filesystem.
 */
export function looksBinary(prefix: Buffer): boolean {
  // An empty file is text, and needs no special case to be: it holds no NUL, and decoding no
  // bytes succeeds. An early return here was removed once mutation testing showed nothing could
  // observe it.
  //
  // The classic signal, and the one git uses. UTF-16 is caught here: its ASCII range is
  // every-other-byte NUL.
  if (prefix.includes(0)) return true;

  try {
    /**
     * `stream: true` is load-bearing.
     *
     * The prefix almost always cuts a multi-byte character in half, and a non-streaming decode
     * treats that truncation as invalid — which would report every UTF-8 file over 8KB with an
     * accent near the boundary as binary. Streaming mode holds the partial sequence instead of
     * rejecting it, which is exactly the semantics wanted for a prefix.
     */
    new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true });
    return false;
  } catch {
    // Not valid UTF-8. A latin-1 file lands here, which is the intended outcome: decoding it as
    // UTF-8 would produce mojibake rather than its actual text.
    return true;
  }
}

/**
 * Read a file, or report that it is not one that can be read.
 *
 * Opens once and reads the prefix before committing to the whole file, so refusing a 500MB
 * binary costs one 8KB read rather than half a gigabyte of memory and a decode.
 */
export async function readTextFile(
  absolute: string,
  options: { signal?: AbortSignal } = {}
): Promise<TextFileRead> {
  const handle = await fs.open(absolute, "r");
  try {
    const { size } = await handle.stat();
    const prefix = Buffer.alloc(Math.min(PREFIX_BYTES, size));
    if (prefix.length > 0) await handle.read(prefix, 0, prefix.length, 0);
    if (looksBinary(prefix)) return { kind: "binary", bytes: size };

    /**
     * Re-read from the handle rather than from the path.
     *
     * Reading the path again would be a second resolution of a name that could have become a
     * different file in between — the classic time-of-check to time-of-use gap, and this
     * function exists precisely to check something and then act on it. The handle is the file
     * that was checked.
     */
    const whole = await handle.readFile({
      encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { kind: "text", contents: whole };
  } finally {
    await handle.close();
  }
}
