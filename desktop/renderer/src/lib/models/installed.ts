/**
 * Deciding whether a catalogue entry is already on this machine.
 *
 * Not string equality, because the two sides name the same weights differently. Ollama reports
 * what it has as `qwen2.5-coder:7b`; the catalogue lists `qwen2.5-coder:7b-instruct-q4_K_M`.
 * Those are the same file — confirmed by digest: both manifests point at blob `60e05f210007`
 * — but exact matching calls them different, and the page offered a 4.7 GB download for a
 * model already on disk.
 *
 * That is the asymmetry this module is built around. Getting it wrong in one direction shows
 * "installed" for a model the user holds at some other quantisation, which is mildly wrong
 * and immediately visible. Getting it wrong in the other direction spends four gigabytes of
 * someone's connection re-fetching what they already have. The second is worse, so the bare
 * tag is matched to Q4_K_M rather than left unmatched.
 *
 * **The assumption is Ollama's default, not a guarantee.** If a family ever defaults to
 * something else, this reports that model as installed when a different quantisation of it is
 * — recoverable, and cheaper than the alternative.
 *
 * **A bare tag also drops the variant, and that one cannot be assumed.** Ollama's
 * `qwen2.5-coder:7b` is the *instruct* build at Q4_K_M; `deepseek-r1:7b` is the Qwen distill;
 * `gemma4:12b` is the `-it`. All verified by comparing manifest digests. But `olmo-3:7b` is
 * not the Instruct build and `qwen3-vl:8b` is not the Instruct build, so stripping the variant
 * unconditionally would be wrong — and worse, for a family shipping both Instruct and Think at
 * Q4_K_M it would match *two* catalogue rows to one installed file, lighting up two Remove
 * buttons for one thing on disk.
 *
 * So the variant is only dropped where the catalogue itself makes it unambiguous: exactly one
 * default-quantisation entry may claim a given `family:size`. Where two compete — Olmo 3's
 * Instruct and Think both being `olmo-3:7b-…-q4_K_M` — neither gets the alias, and the page
 * offers a download the user may not need. That is the recoverable direction.
 */

/** The quantisation an unsuffixed Ollama tag resolves to. */
const DEFAULT_QUANTISATION = "q4_K_M";

/** `qwen2.5-coder:7b-instruct-q4_K_M` → `qwen2.5-coder:7b`. Null when there is no size segment. */
function bareTag(catalogueId: string): string | null {
  const colon = catalogueId.indexOf(":");
  if (colon === -1) return null;
  const rest = catalogueId.slice(colon + 1);
  const dash = rest.indexOf("-");
  if (dash === -1) return null;
  return catalogueId.slice(0, colon + 1 + dash);
}

/**
 * The `family:size` tags that exactly one catalogue entry can claim.
 *
 * Computed rather than listed, so a family gaining a second Q4 variant removes the alias
 * automatically instead of silently starting to match two rows.
 */
function unambiguousBareTags(catalogue: readonly { id: string }[]): Map<string, string> {
  const suffix = `-${DEFAULT_QUANTISATION}`.toLowerCase();
  const claims = new Map<string, string[]>();
  for (const { id } of catalogue) {
    if (!id.toLowerCase().endsWith(suffix)) continue;
    const bare = bareTag(id);
    if (bare === null) continue;
    claims.set(bare.toLowerCase(), [...(claims.get(bare.toLowerCase()) ?? []), id]);
  }
  const out = new Map<string, string>();
  for (const [bare, ids] of claims) {
    if (ids.length === 1) out.set(ids[0]!, bare);
  }
  return out;
}

let bareByCatalogueId: Map<string, string> | null = null;

/**
 * Teach the alias rule which bare tags are unambiguous.
 *
 * Called once with the catalogue. Without it the module still works — it just never matches a
 * bare tag to a variant-suffixed entry, which costs a redundant download offer rather than a
 * wrong claim of ownership.
 */
export function registerCatalogue(catalogue: readonly { id: string }[]): void {
  bareByCatalogueId = unambiguousBareTags(catalogue);
}

/** Exported for the tests that pin the ambiguity rule. */
export { unambiguousBareTags };

/**
 * Every tag that means the same weights as `catalogueId`.
 *
 * The id itself; the id without its default quantisation; and, where the catalogue makes it
 * unambiguous, the bare `family:size` tag Ollama writes down.
 */
export function aliasesFor(catalogueId: string): string[] {
  const suffix = `-${DEFAULT_QUANTISATION}`;
  if (!catalogueId.toLowerCase().endsWith(suffix.toLowerCase())) return [catalogueId];

  const aliases = [catalogueId, catalogueId.slice(0, -suffix.length)];
  const bare = bareByCatalogueId?.get(catalogueId);
  if (bare !== undefined && !aliases.includes(bare)) aliases.push(bare);
  return aliases;
}

/**
 * Is this catalogue entry installed?
 *
 * Case-insensitive: Ollama preserves the case it was given, so `Q4_K_M` and `q4_K_M` both
 * occur in the wild and neither is wrong.
 */
export function isInstalled(catalogueId: string, installed: ReadonlySet<string>): boolean {
  const lowered = new Set([...installed].map((tag) => tag.toLowerCase()));
  return aliasesFor(catalogueId).some((alias) => lowered.has(alias.toLowerCase()));
}

/**
 * The tag to hand to `models:remove`.
 *
 * Deleting has to name what Ollama actually has, not what the catalogue calls it —
 * `DELETE /api/delete` on a tag that is not installed answers 404, which the provider
 * reports as "not installed, so there was nothing to remove". Falls back to the catalogue id
 * so the call still happens and fails visibly rather than silently doing nothing.
 */
export function installedTagFor(
  catalogueId: string,
  installed: ReadonlySet<string>
): string {
  const byLower = new Map([...installed].map((tag) => [tag.toLowerCase(), tag]));
  for (const alias of aliasesFor(catalogueId)) {
    const actual = byLower.get(alias.toLowerCase());
    if (actual !== undefined) return actual;
  }
  return catalogueId;
}
