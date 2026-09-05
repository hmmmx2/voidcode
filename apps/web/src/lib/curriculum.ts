/**
 * The problem order, in one place.
 *
 * This list was previously written out three separate times — a `SLUG_MAP` in
 * the workspace route, a `PROBLEMS` array inside `ProblemTabs`, and a
 * `totalProblems={5}` literal passed as a prop — and they drifted, because
 * nothing made them agree. Adding a problem meant remembering all three, and
 * `totalProblems` is what the prev/next chevrons clamp against, so getting it
 * wrong silently strands the last problem behind a disabled arrow.
 *
 * IT MIRRORS THE DATABASE AND IS NOT THE SOURCE OF TRUTH.
 *
 * `order_index` in `apps/api/scripts/problem_content.py` is authoritative. This
 * exists because the workspace route is a server component that resolves
 * `/problems/3` to a slug *before* any data is fetched, and paying a round trip
 * to learn that mapping would put an API call in front of the first paint of
 * the editor. `TOTAL_PROBLEMS` being derived rather than typed is what keeps
 * the two ends honest.
 *
 * When you add a problem: add it to `problem_content.py`, re-seed, then add the
 * slug here in the same position. If they disagree, `/problems/N` loads the
 * wrong problem — so the ordering is worth a glance at the seed output.
 */

export type CurriculumEntry = {
  slug: string;
  title: string;
  /**
   * Grouping for the Problem List tab.
   *
   * Was described as "course code, matching `courses.code`" — a leftover from
   * the course model, which no longer exists. It is now purely a display
   * grouping and owes nothing to any table.
   */
  track: "NN-CORE" | "LLM-SYS" | "GPU-FW";
};

export const CURRICULUM: readonly CurriculumEntry[] = [
  // Track 1 — Neural Network Internals
  { slug: "stable-softmax", title: "Numerically Stable Softmax", track: "NN-CORE" },
  { slug: "cross-entropy-loss", title: "Cross-Entropy Loss", track: "NN-CORE" },
  { slug: "layer-norm", title: "Layer Normalisation", track: "NN-CORE" },
  { slug: "sgd-momentum-step", title: "SGD Step with Momentum", track: "NN-CORE" },
  // Track 2 — LLM & VLM Systems
  { slug: "scaled-dot-product-attention", title: "Scaled Dot-Product Attention", track: "LLM-SYS" },
  { slug: "top-p-sampling", title: "Nucleus (Top-p) Filtering", track: "LLM-SYS" },
  { slug: "bpe-merge", title: "Byte-Pair Encoding Merge", track: "LLM-SYS" },
  { slug: "iou-nms", title: "IoU and Non-Max Suppression", track: "LLM-SYS" },
  // Track 3 — GPU & Frameworks.
  //
  // These four were seeded as order_index 9-12 but never added here, so
  // TOTAL_PROBLEMS read 8: the navigator showed "5/8", the next chevron
  // disabled at problem 8, and /problems/9 through /problems/12 fell through
  // `resolveProblemSlug` unchanged — hitting the API with the literal string
  // "9" and 404ing. They were reachable only from the catalogue.
  { slug: "parallel-reduction", title: "Parallel Reduction", track: "GPU-FW" },
  { slug: "thread-index-mapping", title: "Thread Index Mapping", track: "GPU-FW" },
  { slug: "broadcast-shapes", title: "Broadcasting Shapes", track: "GPU-FW" },
  { slug: "batchnorm-inference", title: "BatchNorm at Inference", track: "GPU-FW" },
] as const;

/** Derived, never typed — see the note above about the chevrons. */
export const TOTAL_PROBLEMS = CURRICULUM.length;

/**
 * Resolve a route id to a problem slug.
 *
 * Accepts a 1-based position (`/problems/3`) or a slug (`/problems/layer-norm`),
 * because the dashboard links by position and the course pages link by slug.
 * Returns the input unchanged when it matches neither, so an unknown value
 * surfaces as "problem not found" rather than silently loading problem 1.
 */
export function resolveProblemSlug(id: string): string {
  const position = Number(id);
  if (Number.isInteger(position) && position >= 1 && position <= CURRICULUM.length) {
    return CURRICULUM[position - 1].slug;
  }
  return id;
}

/**
 * 1-based position of a slug in the curriculum, or `null` if it has none.
 *
 * NULL IS NOT AN ERROR, AND IT USED TO BE 1.
 *
 * This list holds 12 problems; the catalogue holds 119 of `source_kind: problem`,
 * plus 38 interview problems seeded into the same table. Everything outside the
 * list is perfectly reachable — the catalogue links to it, and the homepage
 * recommendations link to it constantly, because they rank over the whole
 * catalog rather than this sequence.
 *
 * Returning 1 for those made the workspace claim "Question: 1/12" on a problem
 * that is not the first of anything, and pointed the next chevron at
 * `/problems/2` — a different problem in a different track, presented as the
 * one after this. The counter is only meaningful for a problem that genuinely
 * sits in the sequence, so a problem outside it now reports no position and the
 * navigator hides rather than inventing one.
 */
export function problemPosition(id: string): number | null {
  const position = Number(id);
  if (Number.isInteger(position) && position >= 1 && position <= CURRICULUM.length) {
    return position;
  }
  const index = CURRICULUM.findIndex((entry) => entry.slug === id);
  return index >= 0 ? index + 1 : null;
}
