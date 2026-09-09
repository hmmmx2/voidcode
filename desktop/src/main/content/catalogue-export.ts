/**
 * Export the graded catalogue for the Python reward harness.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 *
 * The training repository needs a verifiable reward for GRPO, and this app already is one: 60
 * problems, 320 cases, 182 of them hidden, every expectation derived by executing a reference rather
 * than typed by hand. What it is *not* is reachable from Python — the grader runs in Pyodide inside
 * an Electron `utilityProcess`.
 *
 * So this dumps the data and lets the training repo build a second grader against it. The point of a
 * second grader is not convenience; it is that two independent implementations agreeing is evidence
 * neither is wrong, which is the same argument `verify-spec.ts` makes for `correct` variants.
 *
 * ── WHAT IT DELIBERATELY INCLUDES ─────────────────────────────────────────────────────────────
 *
 * **The reference solutions, the `normalise` expressions, and the hidden cases' arguments.** All
 * three are withheld from the renderer on purpose — `toPublic()` strips them, and `contract.ts` says
 * plainly that in an app the user can patch, the client must not hold the answer key. This file is
 * not the renderer. It writes to disk for a training pipeline, and a reward function without hidden
 * cases is a reward function the policy can trivially satisfy.
 *
 * The consequence is that the output is **the answer key in plain text**. It belongs in the training
 * repository, not in a shipped build, and not in `desktop/`'s packaged resources.
 *
 * ── WHY A MODULE AND NOT THE SCRIPT ───────────────────────────────────────────────────────────
 *
 * `scripts/export-catalogue.mts` is the CLI; this is the part with no side effects, so a test can
 * import it. The first attempt kept both in the script behind an entry-point guard copied from
 * `collect-licences.mjs` — and that guard silently disabled the CLI, because under `vite-node`
 * `process.argv[1]` is the vite-node binary rather than the script, so the comparison was never true
 * and `main()` never ran. Separating the two removes the need for the guard at all.
 *
 * The four content modules import nothing from Electron (`interview-problems.ts` takes only
 * `import type { Problem }`, deliberately, so there is no cycle), which is why this needs no mock and
 * no second Electron entry point the way `npm run derive` does.
 */
import { createHash } from "node:crypto";

import { listProblems, getProblem } from "./problems.js";
import { INTERVIEW_PROBLEMS } from "./interview-problems.js";
import { QUESTIONS } from "./interview-bank.js";
import { CONCEPTS } from "./concepts.js";
import { CURRICULUM_SPECS } from "./verify-curriculum-specs.js";
import { INTERVIEW_SPECS } from "./verify-interview-specs.js";
import { WEB_ANSWER_KEY, KNOWN_DIVERGENCES } from "./interview-answer-key.js";
import type { Problem } from "./problems.js";

/** The shape the Python side consumes. Flat on purpose: one record per gradeable problem. */
interface ExportedCase {
  id: string;
  label: string;
  visible: boolean;
  args: unknown[];
}

interface ExportedProblem {
  id: string;
  title: string;
  entry: string;
  difficulty: string;
  categories: string[];
  /** Import roots the sandbox permits. A pedagogical constraint here; a real one in the harness. */
  allowedImports: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  /** Python expression in `_r`, applied identically to reference and submission. May be absent. */
  normalise: string | null;
  reference: string;
  template: string;
  cases: ExportedCase[];
  /** Which catalogue it came from — the two are graded identically but presented differently. */
  source: "curriculum" | "interview";
}

function exportProblem(problem: Problem, source: ExportedProblem["source"]): ExportedProblem {
  return {
    id: problem.id,
    title: problem.title,
    entry: problem.entry,
    difficulty: problem.difficulty,
    categories: [...problem.categories],
    allowedImports: [...problem.allowedImports],
    timeLimitMs: problem.timeLimitMs,
    memoryLimitMb: problem.memoryLimitMb,
    normalise: problem.normalise ?? null,
    reference: problem.reference,
    template: problem.template,
    // Hidden cases keep their arguments. See the header — this is the whole point.
    cases: problem.cases.map((c) => ({ id: c.id, label: c.label, visible: c.visible, args: c.args })),
    source,
  };
}

export function build(): Record<string, unknown> {
  const curriculum = listProblems().map((summary) => {
    const problem = getProblem(summary.id);
    if (problem === undefined) throw new Error(`listProblems named ${summary.id} and getProblem does not have it`);
    return exportProblem(problem, "curriculum");
  });

  const interview = INTERVIEW_PROBLEMS.map((item) => exportProblem(item.problem, "interview"));

  /**
   * The specs, which are the differential test's fixtures rather than training data.
   *
   * Each carries a correct solution written independently of the reference and one or more mutants
   * paired with the case id that must reject them. A second grader that agrees on references but
   * disagrees on a mutant has found a real difference, which is exactly what the test is for.
   */
  const specs = Object.entries({ ...CURRICULUM_SPECS, ...INTERVIEW_SPECS }).map(([id, spec]) => ({
    problemId: id,
    correct: spec.correct,
    mutants: spec.mutants.map(([label, source, caseId]) => ({ label, source, caseId })),
  }));

  return {
    problems: [...curriculum, ...interview],
    /** Prose only — no executable content. Carried for prompt construction, not for grading. */
    questions: QUESTIONS.map((q) => ({
      slug: q.slug,
      title: q.title,
      domain: q.domain,
      kind: q.kind,
      difficulty: q.difficulty,
      categories: [...q.categories],
      prompt: q.prompt,
    })),
    /** The prerequisite DAG, for curriculum-ordered sampling during RL. */
    concepts: CONCEPTS.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      prerequisites: [...c.prerequisites],
      teaches: [...c.teaches],
    })),
    specs,
    /**
     * The frozen Judge0 oracle, and the two cases where it legitimately disagrees.
     *
     * Carried because it is the strongest check available to a second grader and it costs nothing to
     * ship. These expectations were produced by a **different interpreter** on a retired platform —
     * not by this codebase — so a CPython grader that reproduces them has agreed with Judge0, and this
     * app's Pyodide grader has already agreed with both. Three implementations, one answer.
     *
     * The count is in `counts.oracle` rather than written here; it is the kind of number that has gone
     * stale in this repository before, and it moves whenever a legacy case is renamed.
     *
     * `divergences` are the two cases where the old driver rounded to 9 decimal places and the
     * global normalisation rounds to 8. Listed individually rather than tolerated by a rule, so a
     * third divergence fails a verifier instead of quietly joining a category.
     */
    oracle: { key: { ...WEB_ANSWER_KEY }, divergences: { ...KNOWN_DIVERGENCES } },
  };
}

/**
 * Wrap the payload with its counts and content hash.
 *
 * Hashes the content, not the file. The training repo pins this so a reward function cannot silently
 * start grading against a different catalogue than the one a run was reported on — computed over the
 * payload rather than the serialised bytes, so reformatting does not change it.
 */
export function documentFor(payload: Record<string, unknown>): Record<string, unknown> {
  const problems = payload.problems as ExportedProblem[];
  const cases = problems.reduce((n, p) => n + p.cases.length, 0);
  const hidden = problems.reduce((n, p) => n + p.cases.filter((c) => !c.visible).length, 0);

  return {
    // No timestamp: two exports of the same commit must be byte-identical, for the same reason
    // `artifactName` in electron-builder.yml carries none.
    schema: 1,
    contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    counts: {
      problems: problems.length,
      cases,
      hidden,
      visible: cases - hidden,
      oracle: Object.keys((payload.oracle as { key: Record<string, string> }).key).length,
    },
    ...payload,
  };
}
