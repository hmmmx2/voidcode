/**
 * Projects — the bridge between the two halves of the app.
 *
 * Interview prep stops at exercises today. A project is the thing that gets someone hired,
 * and it is the natural join: **a project is studied in Interview Prep and built in Code.**
 *
 * Authored content for now, in the same shape the problem store uses, so moving it into main
 * later is a move rather than a rewrite. Deliberately not in `mock-data.ts` — that file is
 * placeholder data for surfaces that have no backend; these are real curriculum items whose
 * milestones point at problems that exist.
 */

export type ProjectState = "not-started" | "in-progress" | "complete";

export interface Milestone {
  label: string;
  /**
   * Problem slugs that teach what this milestone needs.
   *
   * Must exist in the problem store, and `tests/projects.test.ts` now checks that rather than
   * trusting this sentence — a slug with a typo would silently make the milestone unachievable,
   * because completion is derived from these.
   */
  teaches: string[];
}

export interface Project {
  slug: string;
  title: string;
  /** One line. If it needs two, the project is not scoped yet. */
  premise: string;
  stack: string[];
  brief: string;
  /** Where the method comes from. A project without a source is a tutorial, not a project. */
  source?: { label: string; arxiv?: string };
  milestones: Milestone[];
}

export const PROJECTS: Project[] = [
  {
    slug: "transformer-from-scratch",
    title: "Transformer from scratch",
    premise: "Build a working decoder-only transformer in NumPy, then train it on tiny text.",
    stack: ["Python", "NumPy"],
    brief:
      "Implement every component of a decoder-only transformer without a deep learning framework — attention, layer norm, the feed-forward block, and the training loop. The point is not to produce a competitive model. It is that once you have written the backward pass by hand, no interview question about attention can surprise you.",
    source: { label: "Vaswani et al., Attention Is All You Need", arxiv: "1706.03762" },
    milestones: [
      { label: "Scaled dot-product attention", teaches: ["scaled-dot-product-attention"] },
      { label: "Layer normalisation", teaches: ["layer-norm"] },
      {
        label: "Softmax and cross-entropy that do not overflow",
        teaches: ["stable-softmax", "cross-entropy-loss"],
      },
      { label: "Training loop with momentum", teaches: ["sgd-momentum-step"] },
    ],
  },
  {
    slug: "tokenizer-and-sampler",
    title: "Tokeniser and sampler",
    premise: "Write a BPE tokeniser and the sampling loop that turns logits into text.",
    stack: ["Python"],
    brief:
      "The two ends of a language model that nobody teaches: how text becomes tokens, and how logits become the next word. Both are small enough to write in an afternoon and both come up constantly, because they are where the surprising behaviour lives — merge order, boundary bugs, and why temperature and top-p interact the way they do.",
    milestones: [
      { label: "BPE merge step", teaches: ["bpe-merge"] },
      { label: "Top-p sampling", teaches: ["top-p-sampling"] },
    ],
  },
];

export function getProject(slug: string): Project | undefined {
  return PROJECTS.find((project) => project.slug === slug);
}

/**
 * ── PROGRESS IS MEASURED, NOT AUTHORED ────────────────────────────────────────────────────────
 *
 * `Milestone.done` and `Project.state` used to be literals in the data above: two milestones of
 * `transformer-from-scratch` said `done: true` and the project said `state: "in-progress"`. So a
 * fresh install, with nothing solved, rendered **"In progress — 2/4"** on the projects list.
 *
 * That is the same defect as the "1/12 solved" the dashboard used to show, and the same fix: the
 * store already knows. `dashboard:get` returns `isSolved` per problem, the milestones already name
 * the problems they need, and nothing was joining the two.
 *
 * Kept pure and taking the solved set as an argument, rather than reaching for the host itself:
 * these run inside a render, and a function that fetches cannot be unit-tested against an empty
 * store — which is the one case that was wrong.
 */

/**
 * A milestone is done when every problem it teaches is solved.
 *
 * `length > 0` matters: a milestone naming no problems would otherwise be vacuously complete, and
 * `every` on an empty array is `true`. That would make an unfinished milestone read as finished,
 * which is the direction this whole change exists to stop.
 */
export function milestoneDone(milestone: Milestone, solved: ReadonlySet<string>): boolean {
  return milestone.teaches.length > 0 && milestone.teaches.every((slug) => solved.has(slug));
}

export interface ProjectProgress {
  done: number;
  total: number;
  state: ProjectState;
}

export function projectProgress(project: Project, solved: ReadonlySet<string>): ProjectProgress {
  const total = project.milestones.length;
  const done = project.milestones.filter((milestone) => milestoneDone(milestone, solved)).length;
  // Three states from one number, so the label and the count can never disagree — they did before,
  // because each was authored separately.
  const state: ProjectState = done === 0 ? "not-started" : done === total ? "complete" : "in-progress";
  return { done, total, state };
}

/** Every problem slug the projects depend on, for the test that checks they all exist. */
export function referencedSlugs(): string[] {
  return [...new Set(PROJECTS.flatMap((p) => p.milestones.flatMap((m) => m.teaches)))];
}

export const STATE_LABELS: Record<ProjectState, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  complete: "Complete",
};
