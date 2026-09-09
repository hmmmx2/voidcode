/**
 * The catalogue export, which hands this app's answer key to a training pipeline.
 *
 * ── WHAT MAKES THIS WORTH A TEST FILE ─────────────────────────────────────────────────────────
 *
 * Everything else in this repository works to keep the reference solutions, the `normalise`
 * expressions and the hidden cases' arguments *away* from a consumer. `toPublic()` strips them,
 * `contract.ts` refuses to put them on a channel, and `honest-copy.test.ts` and the packaging tests
 * exist partly to keep that true.
 *
 * This export deliberately does the opposite, because a reward function without hidden cases is one
 * a policy can satisfy without solving anything. So the risk profile inverts: the failure to guard
 * against is no longer *leaking* the key, it is **silently exporting less than the reward needs** —
 * an export that drops hidden arguments still looks like a valid file, still hashes, still loads, and
 * produces a reward signal that is quietly worthless.
 *
 * Every assertion below is therefore about completeness, not redaction.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { build, documentFor } = await import("../src/main/content/catalogue-export.js");
const { listProblems, getProblem } = await import("../src/main/content/problems.js");
const { INTERVIEW_PROBLEMS } = await import("../src/main/content/interview-problems.js");
const { CONCEPTS } = await import("../src/main/content/concepts.js");

interface ExportedCase {
  id: string;
  visible: boolean;
  args: unknown[];
}
interface ExportedProblem {
  id: string;
  entry: string;
  reference: string;
  normalise: string | null;
  allowedImports: string[];
  cases: ExportedCase[];
  source: string;
}

const payload = build();
const problems = payload.problems as ExportedProblem[];
const document = documentFor(payload);

describe("what the export carries", () => {
  it("covers every gradeable problem in both catalogues", () => {
    // Derived, not pinned: `content-census.test.ts` owns the numbers, and a second hardcoded total
    // here would be one more place to edit when content is authored.
    expect(problems).toHaveLength(listProblems().length + INTERVIEW_PROBLEMS.length);

    const exported = new Set(problems.map((p) => p.id));
    const missing = [...listProblems().map((p) => p.id), ...INTERVIEW_PROBLEMS.map((i) => i.problem.id)].filter(
      (id) => !exported.has(id)
    );
    expect(missing, "problems the reward function would never see").toEqual([]);
  });

  it("carries every hidden case, with its arguments", () => {
    /**
     * The assertion this file exists for. Hidden cases are 182 of 320, and they are the entire reason
     * the reward cannot be gamed — a policy that only ever sees the visible cases can hardcode them.
     *
     * Checked against the source rather than a constant, so authoring a new hidden case cannot leave
     * the export behind.
     */
    for (const exported of problems) {
      const original = getProblem(exported.id);
      expect(original, `${exported.id} is exported but not in the store`).toBeDefined();

      const source = original as { cases: Array<{ id: string; args: unknown[] }> };

      expect(exported.cases.map((c) => c.id), `${exported.id} case ids`).toEqual(
        source.cases.map((c) => c.id)
      );

      /**
       * Deep equality against the store, not `Array.isArray`.
       *
       * The first version of this asserted only that `args` was an array, and mutation testing walked
       * straight through it: emptying the arguments of every hidden case while keeping its id left a
       * file that has the right shape, the right case count, a valid hash — and a reward signal that
       * grades nothing. That is the precise failure this file exists to catch, and the weaker
       * assertion could not see it.
       */
      expect(exported.cases.map((c) => c.args), `${exported.id} case arguments`).toEqual(
        source.cases.map((c) => c.args)
      );
    }

    const hidden = problems.reduce((n, p) => n + p.cases.filter((c) => !c.visible).length, 0);
    expect(hidden, "no hidden cases exported — the reward would be trivially satisfiable").toBeGreaterThan(150);
  });

  it("carries the reference and the normalise expression", () => {
    /**
     * Both halves of the comparison rule. The reference is what the expectation is derived *from*, and
     * `normalise` is applied to reference and submission identically — exporting one without the other
     * gives a grader that disagrees with this app on 44 of 60 problems and looks fine on the rest.
     */
    for (const p of problems) {
      expect(p.reference.length, `${p.id} has no reference`).toBeGreaterThan(0);
      expect(p.entry.length, `${p.id} has no entry point`).toBeGreaterThan(0);
      expect(p.reference, `${p.id}'s reference does not define its entry point`).toContain(p.entry);
    }

    const withNormalise = problems.filter((p) => p.normalise !== null);
    // Every interview problem carries one; no curriculum problem does. Asserted as a property so a
    // dropped field shows up as a count, not as a silent behaviour change in the Python grader.
    expect(withNormalise.length).toBe(problems.filter((p) => p.source === "interview").length);
  });

  it("carries the specs, which are the differential test's fixtures", () => {
    /**
     * Each spec is a correct solution written independently of the reference, plus mutants paired with
     * the case id that must reject them. Two graders agreeing on references proves less than two
     * graders agreeing on a *wrong* answer being wrong.
     */
    const specs = payload.specs as Array<{ problemId: string; correct: string; mutants: unknown[] }>;
    expect(specs.length).toBeGreaterThan(10);

    const known = new Set(problems.map((p) => p.id));
    for (const spec of specs) {
      expect(known.has(spec.problemId), `spec names ${spec.problemId}, which is not exported`).toBe(true);
      expect(spec.correct.length).toBeGreaterThan(0);
      expect(spec.mutants.length).toBeGreaterThan(0);
    }
  });

  it("carries the concept graph for curriculum-ordered sampling", () => {
    const concepts = payload.concepts as Array<{ id: string; teaches: string[] }>;
    expect(concepts).toHaveLength(CONCEPTS.length);
  });
});

describe("the document wrapper", () => {
  it("hashes the content and states the counts", () => {
    expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/);
    /**
     * Exhaustive on purpose — `toEqual` rather than `toMatchObject`, so a field added to `counts`
     * fails here and has to be acknowledged. It did exactly that when `oracle` was added, which is
     * the behaviour wanted: the counts block is what a training run quotes, and a number appearing
     * in it unnoticed is how the rest of this repository's counts went stale.
     */
    expect(document.counts).toEqual({
      problems: problems.length,
      cases: problems.reduce((n, p) => n + p.cases.length, 0),
      hidden: problems.reduce((n, p) => n + p.cases.filter((c) => !c.visible).length, 0),
      visible: problems.reduce((n, p) => n + p.cases.filter((c) => c.visible).length, 0),
      oracle: Object.keys((payload.oracle as { key: Record<string, string> }).key).length,
    });
  });

  it("carries the frozen oracle, which is the second grader's strongest check", () => {
    /**
     * Not used for grading here and never should be — every expectation in this app is derived by
     * executing the reference. It travels because those values came from a different interpreter on a
     * retired platform, so a CPython port reproducing them agrees with Judge0, and this app already
     * does. Three implementations, one set of values.
     */
    const oracle = payload.oracle as {
      key: Record<string, string>;
      divergences: Record<string, string>;
    };
    expect(Object.keys(oracle.key).length).toBeGreaterThan(100);

    // Divergences are named individually so a third fails rather than joining a category.
    for (const id of Object.keys(oracle.divergences)) {
      expect(Object.keys(oracle.key)).toContain(id);
    }
  });

  it("is deterministic, so a rerun cannot look like a content change", () => {
    /**
     * The training repo pins this hash to prove a run was reported against the catalogue it actually
     * graded. That is only worth anything if the hash moves when the content moves and not otherwise —
     * hence no timestamp in the document, the same reasoning as `artifactName` in electron-builder.yml.
     */
    expect(documentFor(build()).contentHash).toBe(document.contentHash);
    expect(JSON.stringify(document)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
