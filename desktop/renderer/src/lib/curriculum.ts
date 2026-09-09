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
 * IT MIRRORS `src/main/content/problems.ts` AND IS NOT THE SOURCE OF TRUTH.
 *
 * It used to say it mirrored `apps/api/scripts/problem_content.py`. D0 made the desktop content
 * the source of truth and retired that generator, so `listProblems()` is authoritative now.
 *
 * The mirror exists because the workspace resolves `/problems/3` to a slug during the first
 * render, and importing the real catalogue here would pull `problems.ts` into the renderer
 * bundle — **including the hidden test cases**, which the whole grading design depends on not
 * shipping to the client. Two copies is the lesser problem, so `tests/curriculum-parity.test.ts`
 * makes them fail loudly instead of quietly.
 *
 * They had already drifted, in both ways the header warned about. Two problems were missing, so
 * `TOTAL_PROBLEMS` read 12 and the last two were unreachable by position. Worse, entries 9 to 12
 * were in a different order, so `/problems/9` loaded Parallel Reduction while the dashboard that
 * linked there meant Broadcast Shapes — the wrong problem, opened successfully, with nothing to
 * say so.
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
  // Order and slugs mirror `listProblems()` exactly; the parity test asserts it. `track` is the
  // one field that is ours — it groups the Problem List tab and owes nothing to any table.
  { slug: "stable-softmax", title: "Numerically Stable Softmax", track: "NN-CORE" },
  { slug: "cross-entropy-loss", title: "Cross-Entropy Loss", track: "NN-CORE" },
  { slug: "layer-norm", title: "Layer Normalisation", track: "NN-CORE" },
  { slug: "sgd-momentum-step", title: "SGD Step with Momentum", track: "NN-CORE" },
  { slug: "scaled-dot-product-attention", title: "Scaled Dot-Product Attention", track: "LLM-SYS" },
  { slug: "top-p-sampling", title: "Top-p (Nucleus) Sampling", track: "LLM-SYS" },
  { slug: "bpe-merge", title: "BPE Merge Step", track: "LLM-SYS" },
  { slug: "iou-nms", title: "IoU and Non-Max Suppression", track: "LLM-SYS" },
  { slug: "broadcast-shapes", title: "Broadcast Shapes", track: "GPU-FW" },
  { slug: "batchnorm-inference", title: "BatchNorm at Inference", track: "GPU-FW" },
  { slug: "parallel-reduction", title: "Parallel Reduction", track: "GPU-FW" },
  { slug: "thread-index-mapping", title: "Thread Index Mapping", track: "GPU-FW" },
  // Missing entirely until now, which is why `TOTAL_PROBLEMS` read 12: the navigator showed
  // "n/12", the next chevron disabled at 12, and `/problems/13` fell through
  // `resolveProblemSlug` unchanged to hit the API with the literal string "13".
  { slug: "sigmoid", title: "Sigmoid activation", track: "NN-CORE" },
  { slug: "min-max-scale", title: "Min-max scaling", track: "NN-CORE" },
  // The two `hard` problems, appended in `listProblems()` order. `layer-norm-backward` sits in
  // NN-CORE beside the forward pass it differentiates; `online-softmax` is GPU-FW because the point
  // of it is memory traffic rather than the layer.
  { slug: "layer-norm-backward", title: "Layer Normalisation Backward", track: "NN-CORE" },
  { slug: "online-softmax", title: "Online Softmax", track: "GPU-FW" },
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
    // Read before the range claim is trusted. The bounds check above says this entry exists and
    // it is right, but this file is now reached from `tests/`, which is compiled with
    // `noUncheckedIndexedAccess` — and the renderer's own program is not. It went unchecked here
    // for as long as nothing outside the renderer imported it.
    return CURRICULUM[position - 1]?.slug ?? id;
  }
  return id;
}

/** 1-based position of a slug, or 1 if it is not in the curriculum. */
export function problemPosition(id: string): number {
  const position = Number(id);
  if (Number.isInteger(position) && position >= 1 && position <= CURRICULUM.length) {
    return position;
  }
  const index = CURRICULUM.findIndex((entry) => entry.slug === id);
  return index >= 0 ? index + 1 : 1;
}

/**
 * The slug at a 1-based position, or undefined past the ends.
 *
 * The inverse of `problemPosition`, and the reason both exist: **routes are addressed by slug, not
 * by position.** Position was the route id, so inserting a problem anywhere but the end renumbered
 * every later `/problems/{n}` — stored data survived (submissions key on the problem id) but every
 * link silently pointed one problem along. That is the "wrong page, rendered successfully" failure
 * this file already carries a note about, and at 150 items authored in topic order, inserting in the
 * middle is the normal case rather than the exception.
 *
 * Position is still what the prev/next chevrons count in, because "next" is an ordinal idea. So they
 * convert to a position, step, and convert back — which is what this is for.
 */
export function slugAtPosition(position: number): string | undefined {
  return CURRICULUM[position - 1]?.slug;
}
