/**
 * Checking that an image is the image it says it is.
 *
 * The contract validates that `mediaType` is one of three strings and that `data` is base64 of
 * a plausible length. Neither says the bytes match the label — a renderer can claim
 * `image/png` and send anything at all, and every layer downstream believes it: the provider
 * puts it in a `data:` URL, and a future disk write would put it in a file with a `.png` name.
 *
 * Fifteen lines of signature checking closes that, and does it at the boundary where the claim
 * is first made rather than wherever it eventually matters.
 *
 * Deliberately NOT a full image parse. The question is "is this label a lie", not "is this a
 * well-formed PNG" — decoding untrusted image data in the main process to answer a validation
 * question would be a larger attack surface than the one being closed.
 */
import type { ImageMediaType } from "./types.js";

/** How many leading bytes any of the checks below need. */
const HEADER_BYTES = 16;

export class ImageMismatchError extends Error {
  constructor(readonly declared: string) {
    super(`Image data does not match the declared type ${declared}`);
    this.name = "ImageMismatchError";
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** True when `data` (bare base64) really is an image of `mediaType`. */
export function matchesMediaType(data: string, mediaType: ImageMediaType): boolean {
  let header: Buffer;
  try {
    // Only the header is decoded. Decoding a 12 MB base64 string to inspect eight bytes is
    // pure waste, and this runs on the request path.
    header = Buffer.from(data.slice(0, 64), "base64").subarray(0, HEADER_BYTES);
  } catch {
    return false;
  }
  if (header.length < 8) return false;

  switch (mediaType) {
    case "image/png":
      // The 8-byte PNG signature, including the CRLF/EOF trap bytes that catch a file
      // mangled by a text-mode transfer.
      return startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      // SOI marker. The third byte is always another marker's 0xFF.
      return startsWith(header, [0xff, 0xd8, 0xff]);
    case "image/webp":
      // RIFF container with a WEBP fourcc at offset 8 — the four bytes between are the
      // file length, which is not fixed.
      return (
        startsWith(header, [0x52, 0x49, 0x46, 0x46]) &&
        header.length >= 12 &&
        startsWith(header.subarray(8), [0x57, 0x45, 0x42, 0x50])
      );
  }
}

/** Throws unless every image block's bytes match its declared type. */
export function assertImagesMatch(
  content: unknown
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image"
    ) {
      const { data, mediaType } = block as { data: string; mediaType: ImageMediaType };
      if (!matchesMediaType(data, mediaType)) throw new ImageMismatchError(mediaType);
    }
  }
}
