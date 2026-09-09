/**
 * Turning a pasted or dropped image into something sendable.
 *
 * Pure apart from `FileReader`, and separated from the panel for that reason: the rules about
 * what is accepted are the interesting part, and they should be testable without rendering a
 * chat.
 *
 * **Moved out of `lib/build/` when the tutor gained image input.** Nothing here was ever
 * Build-specific — the bounds come from the IPC contract, which both surfaces share — and a
 * Study component importing from a `build/` path would have been a false claim about ownership
 * in the one place a reader looks to find out who a module belongs to.
 *
 * The bounds mirror the contract's, deliberately. Main is the authority — a renderer check is
 * a courtesy, not a control — but failing at the boundary produces "Invalid payload for
 * chat:open", which tells the user nothing about which image was too big or what to do next.
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface Attachment {
  /** Stable across renders, so a thumbnail list can key on it and removal is unambiguous. */
  id: string;
  /** Bare base64, no `data:` prefix — the form main and Ollama both want. */
  data: string;
  mediaType: ImageMediaType;
  /** For the thumbnail. Rebuilt from `data` rather than stored twice. */
  previewUrl: string;
  bytes: number;
  name: string;
}

/** What a vision model will take, and what the contract's enum allows. */
const ACCEPTED: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** Matches the contract's per-request cap. Four screenshots is already a lot of context. */
export const MAX_ATTACHMENTS = 4;

/**
 * Per image, decoded.
 *
 * ~4 MB decodes to ~5.3 MB of base64, so four of them sit under the contract's 16 MB string
 * cap with room to spare. A screenshot is well under this; a photograph from a phone is not,
 * which is the case worth rejecting early with a readable reason.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class AttachmentRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentRejected";
  }
}

/** Why a file cannot be attached, or `null` if it can. */
export function rejectionFor(file: { type: string; size: number }, existing: number): string | null {
  if (!ACCEPTED.includes(file.type)) {
    // Named, because "unsupported file" leaves the user guessing which of the three it wanted.
    return `Only PNG, JPEG and WebP images can be attached (this is ${file.type || "unknown"}).`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
      MAX_IMAGE_BYTES / 1024 / 1024
    } MB.`;
  }
  if (existing >= MAX_ATTACHMENTS) {
    return `You can attach ${MAX_ATTACHMENTS} images at a time.`;
  }
  return null;
}

/** Strip the `data:...;base64,` prefix a FileReader result carries. */
export function bareBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Read one file into an attachment.
 *
 * `readAsDataURL` rather than `readAsArrayBuffer` + manual base64: the browser's encoder is
 * faster than anything written here, and the same string doubles as the thumbnail `src` — so
 * the bytes are held once rather than in two encodings.
 */
export async function toAttachment(file: File, existing: number): Promise<Attachment> {
  const rejection = rejectionFor(file, existing);
  if (rejection !== null) throw new AttachmentRejected(rejection);

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AttachmentRejected("That image could not be read."));
    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    data: bareBase64(dataUrl),
    mediaType: file.type as ImageMediaType,
    previewUrl: dataUrl,
    bytes: file.size,
    // Pasted images have no name. "Pasted image" is more useful than an empty label.
    name: file.name === "" ? "Pasted image" : file.name,
  };
}

/** Every image on a clipboard or drop event, in order. */
export function imageFilesFrom(items: DataTransferItemList | null | undefined): File[] {
  if (items === null || items === undefined) return [];

  // `Array.from` over the indices rather than spreading. Chromium does give
  // `DataTransferItemList` a `Symbol.iterator`, so a spread happens to work there — but the
  // interface is defined as array-like, the iterator is not guaranteed, and a throw inside a
  // paste handler would mean the paste silently does nothing with nothing logged anywhere.
  // Cheap insurance against a behaviour this code should not be relying on.
  const list = Array.from({ length: items.length }, (_, index) => items[index]);

  return list
    .filter((item): item is DataTransferItem => item !== undefined && item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && ACCEPTED.includes(file.type));
}

/**
 * Is there anything to send?
 *
 * One predicate, because the answer is needed in two places — whether the button is enabled and
 * whether the handler proceeds — and those two drifting apart is not hypothetical. Enabling the
 * button for an image with no caption while the handler still required text is precisely the bug
 * this replaced: the button lit up and clicking it did nothing at all, silently.
 *
 * An image on its own counts. "What is wrong with this loss curve" is often the whole question,
 * and the picture is it.
 */
export function canSend(text: string, attachmentCount: number): boolean {
  return text.trim() !== "" || attachmentCount > 0;
}

/** As much of a catalogue entry as the notice below needs. */
export interface ModelCapability {
  id: string;
  vision?: boolean;
}

/**
 * The model family an Ollama tag names — everything before the colon.
 *
 * The catalogue lists fully-qualified tags with a quantisation suffix (`qwen3:8b-q4_K_M`), and
 * what people actually have installed is usually the plain default (`qwen3:8b`). Matching ids
 * exactly finds nothing in the common case, which is how the first version of the notice below
 * managed to be correct and completely silent at the same time.
 *
 * Family is the right key because **vision is a property of the family, not the quantisation** —
 * verified across all 126 catalogue entries, no family disagrees with itself — and because the
 * families that can see are named apart from the ones that cannot: `qwen3-vl` and `qwen2.5vl` are
 * distinct families from `qwen3`, so this cannot confuse one for the other.
 *
 * Splitting on `-` instead survives mutation testing, and that is honest rather than a gap: on
 * this catalogue the first hyphen-or-colon segment happens to be unique per family, so the two
 * agree on every entry. `:` is still the right separator — it is the one Ollama defines as
 * name-versus-tag — and the equivalence is a property of today's model names, not of the rule.
 */
function familyOf(modelId: string): string {
  return modelId.split(":")[0] ?? "";
}

/**
 * Warn when the model that will answer cannot see.
 *
 * Found by driving the real app: attaching a diagram while Qwen3 8B was the installed model
 * produced "I currently cannot view or access attached images." Everything worked — the block was
 * built, validated and delivered — and the learner still got nothing. The picture is usually the
 * whole question, so a turn that drops it is a wasted turn plus a confusing answer.
 *
 * **Silent when the model is unknown, and a notice rather than a block when it is not.** OpenRouter
 * ids and custom Ollama tags are not in the catalogue, and refusing an attachment for a model that
 * can in fact see would break the feature to prevent a bad answer. Absence of evidence is not
 * evidence of blindness, so the unknown case says nothing; the known-text-only case says so plainly
 * and still lets the turn go.
 */
export function visionNoticeFor(
  modelId: string | null | undefined,
  catalogue: readonly ModelCapability[]
): string | null {
  // No explicit guard for null, undefined or "". Each of them simply fails to match a family and
  // falls into the unknown case below, which is the answer they want anyway: say nothing until
  // there is something to say. A guard here mutation-tested as dead, so it is not here — the
  // tests for those inputs stay, because the behaviour is load-bearing even though the branch
  // was not.
  const family = familyOf(modelId ?? "");
  const kin = catalogue.filter((m) => familyOf(m.id) === family);

  // Unknown family, or one that can see. `some` rather than `every` so a family that somehow
  // disagreed with itself would stay quiet rather than warn — silence is the safe direction.
  if (family === "" || kin.length === 0 || kin.some((m) => m.vision === true)) return null;

  return `${modelId} cannot see images — it will answer from your text alone. Install a vision model from the model manager to use attachments.`;
}
