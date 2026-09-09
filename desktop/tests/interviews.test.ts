/**
 * The interviews router, migrated from FastAPI into main.
 *
 * Two things are covered here, and they fail differently.
 *
 * The store: the absent-versus-null distinction that the server got with Pydantic's
 * `exclude_unset` and that has to be built by hand here. Getting it wrong does not throw —
 * it silently blanks a rating when you save a note, which is the kind of bug a user
 * discovers weeks later and cannot reproduce.
 *
 * The content: that no projection leaking out of main carries an answer. That property is
 * the entire reason the staged reveal exists, and it is one careless spread away from
 * being false.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const { getAttempt, allAttempts, saveAttempt, markRevealed, markSubmitted, InvalidRatingError } =
  await import("../src/main/store/interviews.js");
const {
  QUESTIONS,
  getQuestion,
  toSummary,
  toDetail,
  facets,
  progress,
  preview,
  UnknownQuestionError,
  DOMAIN_LABELS,
  KIND_LABELS,
} = await import("../src/main/content/interviews.js");
const {
  buildInterviewWorkspace,
  hasInterviewWorkspace,
  problemIdForQuestion,
  NoWorkspaceForQuestionError,
} = await import("../src/main/content/interview-detail.js");
const { INTERVIEW_PROBLEMS } = await import("../src/main/content/interview-problems.js");
const { getProblem } = await import("../src/main/content/problems.js");

const SLUG = QUESTIONS[0]!.slug;

beforeEach(() => {
  __useInMemory();
});

describe("interview attempts", () => {
  it("has no row until something is written", () => {
    expect(getAttempt(SLUG)).toBeUndefined();
    expect(allAttempts().size).toBe(0);
  });

  it("treats an empty patch as 'opened this', creating the row", () => {
    // This is what makes `attempted` true without claiming a rating. If it inserted
    // nothing, opening a question would never be recorded; if it inserted a rating,
    // progress would count questions nobody answered.
    const attempt = saveAttempt(SLUG, {});
    expect(attempt.selfRating).toBeNull();
    expect(attempt.notes).toBeNull();
    expect(attempt.revealedAnswer).toBe(false);
  });

  it("leaves an omitted field alone but clears an explicit null", () => {
    saveAttempt(SLUG, { selfRating: 3, notes: "derived it twice" });

    // Omitted: the rating survives a notes-only save. This is the bug the server avoided
    // with `exclude_unset`, and the one this store rebuilds by hand.
    const afterNotes = saveAttempt(SLUG, { notes: "reread before Meta onsite" });
    expect(afterNotes.selfRating).toBe(3);
    expect(afterNotes.notes).toBe("reread before Meta onsite");

    // Explicit null: clearing has to remain possible, which is why this is not COALESCE.
    const cleared = saveAttempt(SLUG, { selfRating: null });
    expect(cleared.selfRating).toBeNull();
    expect(cleared.notes).toBe("reread before Meta onsite");
  });

  it("rejects a rating outside 1..3", () => {
    expect(() => saveAttempt(SLUG, { selfRating: 0 })).toThrow(InvalidRatingError);
    expect(() => saveAttempt(SLUG, { selfRating: 4 })).toThrow(InvalidRatingError);
    expect(() => saveAttempt(SLUG, { selfRating: 2.5 })).toThrow(InvalidRatingError);
    expect(getAttempt(SLUG)).toBeUndefined();
  });

  it("clamps elapsed seconds rather than storing a nonsense number", () => {
    expect(saveAttempt(SLUG, { elapsedSeconds: -5 }).elapsedSeconds).toBe(0);
    expect(saveAttempt(SLUG, { elapsedSeconds: 999_999 }).elapsedSeconds).toBe(86_400);
    expect(saveAttempt(SLUG, { elapsedSeconds: 90 }).elapsedSeconds).toBe(90);
  });

  it("keeps revealedAnswer set once it is set", () => {
    markRevealed(SLUG);
    expect(getAttempt(SLUG)?.revealedAnswer).toBe(true);

    // The signal this surface exists to preserve: "rated solid, but read the answer first".
    // A later save that says nothing about revealing must not clear it.
    saveAttempt(SLUG, { selfRating: 3 });
    expect(getAttempt(SLUG)?.revealedAnswer).toBe(true);
  });

  it("creates a row when revealing, so looking at the answer counts as having attempted", () => {
    markRevealed(SLUG);
    expect(allAttempts().size).toBe(1);
  });

  it("never overwrites the first submit time", () => {
    const first = markSubmitted(SLUG).submittedAt;
    expect(first).not.toBeNull();
    expect(markSubmitted(SLUG).submittedAt).toBe(first);
  });
});

describe("progress", () => {
  it("counts rated questions, and only 3s as solid", () => {
    saveAttempt(QUESTIONS[0]!.slug, { selfRating: 3 });
    saveAttempt(QUESTIONS[1]!.slug, { selfRating: 2 });
    // Revealed but never rated: attempted in the catalogue sense, but not progress.
    markRevealed(QUESTIONS[2]!.slug);

    expect(progress(allAttempts())).toEqual({
      total: QUESTIONS.length,
      attempted: 2,
      solid: 1,
    });
  });
});

describe("the answer never leaves main", () => {
  it("omits approach and modelAnswer from both projections", () => {
    const question = getQuestion(SLUG);
    const summary = toSummary(question, undefined, true);
    const detail = toDetail(question, undefined, true);

    // Serialised, because that is how it actually crosses to the renderer — a field
    // present but undefined would pass a key check and still ship over IPC.
    for (const payload of [summary, detail]) {
      const wire = JSON.stringify(payload);
      expect(wire).not.toContain(question.approach.slice(0, 40));
      expect(wire).not.toContain(question.modelAnswer.slice(0, 40));
      for (const flag of question.redFlags) expect(wire).not.toContain(flag.slice(0, 40));
      for (const followUp of question.followUps) expect(wire).not.toContain(followUp.slice(0, 40));
    }
  });

  it("holds for every question in the bank, not just the first", () => {
    for (const question of QUESTIONS) {
      const wire = JSON.stringify(toDetail(question, undefined, true));
      expect(wire).not.toContain(question.modelAnswer.slice(0, 60));
    }
  });

  it("still sends the prompt, which is the question rather than the answer", () => {
    const question = getQuestion(SLUG);
    expect(toDetail(question, undefined, true).prompt).toBe(question.prompt);
  });
});

describe("summaries", () => {
  it("reports attempted from the existence of a row, not from any field", () => {
    const question = getQuestion(SLUG);
    expect(toSummary(question, undefined, true).attempted).toBe(false);

    saveAttempt(SLUG, {});
    expect(toSummary(question, getAttempt(SLUG), true).attempted).toBe(true);
  });

  it("reports solved from submittedAt", () => {
    const question = getQuestion(SLUG);
    saveAttempt(SLUG, { selfRating: 1 });
    expect(toSummary(question, getAttempt(SLUG), true).solved).toBe(false);

    markSubmitted(SLUG);
    expect(toSummary(question, getAttempt(SLUG), true).solved).toBe(true);
  });

  it("labels every domain and kind it emits", () => {
    for (const question of QUESTIONS) {
      const summary = toSummary(question, undefined, true);
      // The fallback in `toSummary` is `?? question.domain`, so an unlabelled domain would
      // render as a raw key like "vlm" rather than failing — which is exactly the kind of
      // thing that ships.
      expect(DOMAIN_LABELS[question.domain]).toBeDefined();
      expect(KIND_LABELS[question.kind]).toBeDefined();
      expect(summary.domainLabel).not.toBe(question.domain);
      expect(summary.kindLabel).not.toBe(question.kind);
    }
  });
});

describe("preview", () => {
  it("leaves a short prompt alone", () => {
    expect(preview("Short enough.", 150)).toBe("Short enough.");
  });

  it("cuts on a word boundary and marks the truncation", () => {
    const cut = preview("alpha beta gamma delta epsilon", 12);
    expect(cut).toBe("alpha beta…");
    // A card ending mid-word reads as a rendering bug rather than as truncation.
    expect(cut.replace("…", "").endsWith(" ")).toBe(false);
  });

  it("collapses whitespace so a multi-line prompt does not become a multi-line card", () => {
    expect(preview("one\n\ntwo   three")).toBe("one two three");
  });

  it("never carries the answer, because it is built from the prompt", () => {
    for (const question of QUESTIONS) {
      expect(question.prompt).toContain(preview(question.prompt, 40).replace("…", "").trim());
    }
  });
});

describe("facets", () => {
  it("counts over the whole bank and keeps empty buckets visible", () => {
    const f = facets();

    // Every question is `kind: "code"`. `derivation` and `computation` must still appear at
    // zero: a filter that vanishes cannot tell you the bank has none of that.
    const kinds = Object.fromEntries(f.kinds.map((k) => [k.key, k.total]));
    expect(kinds.code).toBe(QUESTIONS.length);
    expect(kinds.derivation).toBe(0);
    expect(kinds.computation).toBe(0);

    expect(f.domains.reduce((n, d) => n + d.total, 0)).toBe(QUESTIONS.length);
    expect(f.difficulties.reduce((n, d) => n + d.total, 0)).toBe(QUESTIONS.length);
  });

  it("lets a question count once per company, so company totals exceed the bank size", () => {
    const f = facets();
    const byCompany = f.companies.reduce((n, c) => n + c.total, 0);
    const withCompanies = QUESTIONS.reduce((n, q) => n + q.companies.length, 0);
    expect(byCompany).toBe(withCompanies);
    expect(byCompany).toBeGreaterThan(QUESTIONS.length);
  });
});

describe("the bank itself", () => {
  it("has unique slugs and a contiguous order", () => {
    const slugs = QUESTIONS.map((q) => q.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(QUESTIONS.map((q) => q.orderIndex)).toEqual(
      QUESTIONS.map((_, i) => i + 1)
    );
  });

  it("gives every question a prompt, an approach and an answer", () => {
    for (const question of QUESTIONS) {
      expect(question.prompt.trim().length).toBeGreaterThan(0);
      expect(question.approach.trim().length).toBeGreaterThan(0);
      expect(question.modelAnswer.trim().length).toBeGreaterThan(0);
      // Red flags are the highest-value field here and the one most often missing from
      // study material, so an empty list is a content bug rather than an option.
      expect(question.redFlags.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown slug rather than returning a blank question", () => {
    expect(() => getQuestion("no-such-question")).toThrow(UnknownQuestionError);
  });

  it("has an executable form for every question", () => {
    for (const question of QUESTIONS) {
      expect(hasInterviewWorkspace(question.slug)).toBe(true);
      expect(problemIdForQuestion(question.slug)).toBe(`iq-${question.slug}`);
    }
  });
});

describe("the executable form", () => {
  it("is reachable by the grader but absent from the curriculum", async () => {
    const { listProblems } = await import("../src/main/content/problems.js");
    const catalogue = listProblems().map((p) => p.id);

    for (const { problem } of INTERVIEW_PROBLEMS) {
      // Gradable: `POST /v1/submit` resolves the id the workspace sends.
      expect(getProblem(problem.id)).toBeDefined();
      // But not part of the syllabus. Folding these in would multiply the course several times over
      // and double-count them on the dashboard.
      expect(catalogue).not.toContain(problem.id);
    }
    // No count here. `curriculum-parity.test.ts` derives it from `listProblems()` and checks the
    // renderer mirror against it, and `content-census.test.ts` records the total in the one place
    // an authoring batch edits. A third copy was only a third place to remember.
  });

  it("prefixes ids so an interview problem cannot collide with a curriculum one", () => {
    for (const { problem, questionSlug } of INTERVIEW_PROBLEMS) {
      expect(problem.id).toBe(`iq-${questionSlug}`);
    }
  });

  it("carries a normaliser and a reference for every problem", () => {
    for (const { problem } of INTERVIEW_PROBLEMS) {
      // The driver's output transform. Without it the sandbox compares raw returns and
      // the problem's own definition of "equal" — rounding, int coercion, sorting — is
      // silently discarded.
      expect(problem.normalise).toBeTruthy();
      expect(problem.reference).toContain(`def ${problem.entry}`);
      expect(problem.template).toContain(`def ${problem.entry}`);
      // The conversion from `class Solution`. A surviving `self` compiles fine and then
      // raises NameError on the first call, which is how it got through once.
      expect(problem.reference).not.toContain("self");
      expect(problem.template).not.toContain("self");
      expect(problem.cases.length).toBeGreaterThan(0);
    }
  });
});

describe("the workspace payload", () => {
  const SLUG = INTERVIEW_PROBLEMS[0]!.questionSlug;

  it("never carries an expected output", () => {
    const payload = buildInterviewWorkspace(SLUG);

    // The feature, not an omission. On the web this was enforced by the server nulling the
    // column; here it is enforced by never putting it in the payload. Asserted on the
    // serialised form, since that is what actually crosses to the renderer.
    for (const testCase of payload.testCases) {
      expect(testCase.expected_output).toBeNull();
    }
    expect(JSON.stringify(payload)).not.toContain("expectedOutput");
  });

  it("sends visible cases only, and counts the rest honestly", () => {
    const payload = buildInterviewWorkspace(SLUG);
    const problem = INTERVIEW_PROBLEMS[0]!.problem;
    const hidden = problem.cases.filter((c) => !c.visible);

    expect(payload.testCases).toHaveLength(problem.cases.length - hidden.length);
    expect(payload.hidden_count).toBe(hidden.length);
    expect(payload.hidden_count).toBeGreaterThan(0);

    // A hidden case's arguments must not appear anywhere in the payload — knowing one
    // exists is honest, being handed what it checks is not.
    const wire = JSON.stringify(payload);
    for (const c of hidden) {
      expect(wire).not.toContain(JSON.stringify(c.args));
    }
  });

  it("never carries the reference solution", () => {
    for (const { questionSlug, problem } of INTERVIEW_PROBLEMS) {
      const wire = JSON.stringify(buildInterviewWorkspace(questionSlug));

      // Pairs of consecutive lines, not single lines. A single line of the reference can
      // legitimately appear in the payload because the *statement* explains the maths —
      // `bayes-optimal-threshold` prints `t = c_fp / (c_fn + c_fp)` in its own description,
      // which is the problem being explained, not the solution being leaked. Two adjacent
      // lines with their exact indentation is code, and prose does not reproduce it.
      const stub = new Set(problem.template.split("\n").map((l) => l.trim()));
      const lines = problem.reference.split("\n");
      let checked = 0;

      for (let i = 0; i + 1 < lines.length; i += 1) {
        const pair = [lines[i]!, lines[i + 1]!];
        if (pair.some((l) => l.trim().length < 6 || stub.has(l.trim()))) continue;
        checked += 1;
        expect(wire).not.toContain(JSON.stringify(pair.join("\n")).slice(1, -1));
      }

      expect(checked).toBeGreaterThan(0);
    }
  });

  it("labels inputs with the entry point's parameter names", () => {
    const payload = buildInterviewWorkspace(SLUG);
    const params = INTERVIEW_PROBLEMS[0]!.statement.params;

    for (const testCase of payload.testCases) {
      expect(testCase.inputs.map((i) => i.name)).toEqual(params);
    }
  });

  it("sends the problem id the grader resolves, so submit works", () => {
    const payload = buildInterviewWorkspace(SLUG);
    expect(getProblem(payload.problem.id)).toBeDefined();
  });

  it("uses authored examples rather than deriving them from the reference", () => {
    const payload = buildInterviewWorkspace(SLUG);
    // Deriving them, as the curriculum route does, would print the answers to the test
    // cases onto the page — the leak this whole route is shaped to prevent.
    expect(payload.problem.examples).toEqual(INTERVIEW_PROBLEMS[0]!.statement.examples);
  });

  it("reflects the user's own state", () => {
    saveAttempt(SLUG, { notes: "come back to this", elapsedSeconds: 42 });
    const payload = buildInterviewWorkspace(SLUG);

    expect(payload.notes).toBe("come back to this");
    expect(payload.elapsedSeconds).toBe(42);
    expect(payload.submittedAt).toBeNull();
  });

  it("refuses a question with no executable form", () => {
    expect(() => buildInterviewWorkspace("no-such-question")).toThrow(
      NoWorkspaceForQuestionError
    );
  });
});

describe("difficulty has one source", () => {
  /**
   * `Problem` carries a `difficulty` because the curriculum route needs one, so every interview
   * workspace inherited a second copy of the question's — and they disagreed for **8 of 38**.
   *
   * Both shipped in the same payload: `payload.difficulty` drives the catalogue filter and the
   * facet counts, `payload.problem.difficulty` drove the badge in the workspace. A learner could
   * filter for "hard", open the result, and read "Medium". Nothing compared them.
   *
   * The question is authoritative — difficulty describes what an interviewer asks, not the harness
   * that grades it. The eight were realigned rather than the field removed, because `Problem`
   * genuinely needs one.
   */
  it("agrees between the bank and the embedded problem", () => {
    const byslug = new Map(QUESTIONS.map((q) => [q.slug, q.difficulty]));
    const disagreements = INTERVIEW_PROBLEMS.filter(
      ({ questionSlug, problem }) => byslug.get(questionSlug) !== problem.difficulty
    ).map(
      ({ questionSlug, problem }) =>
        `${problem.id}: question=${String(byslug.get(questionSlug))} problem=${problem.difficulty}`
    );
    expect(disagreements).toEqual([]);
  });

  it("ships the question's value to the workspace", () => {
    // Structural, because realigning the data fixes today and does not stop tomorrow: an author
    // who edits one copy should not be able to reintroduce the split at the boundary.
    const source = fs.readFileSync(
      path.join(root, "src/main/content/interview-detail.ts"),
      "utf8"
    );
    expect(source).toContain("difficulty: question.difficulty");
    expect(source).not.toContain("difficulty: problem.difficulty");
  });
});

/**
 * Split on a line ending, built from character codes.
 *
 * Not a regex literal, and not a string containing escapes either. An escaped newline written into
 * a pattern in this repo has been reflowed into a real line break several times — which either
 * unterminates the literal outright or, worse, silently produces a pattern that happens to work for
 * the wrong reason. The smoke's own probes carry the same note.
 *
 * `\r` is 13 and `\n` is 10, so this is "an optional carriage return followed by a newline" with
 * nothing left to mangle.
 */
const SPLIT_LINES = new RegExp(`${String.fromCharCode(13)}?${String.fromCharCode(10)}`);

describe("references are readable", () => {
  /**
   * Every reference and template in `interview-problems.ts` was one long double-quoted string with
   * escaped newlines — `"def roc_auc(y_true, y_score):\n    n = len(y_true)\n..."`. That is code,
   * and stored that way it cannot be reviewed: a diff shows one changed line however much of the
   * function moved, and indentation errors are invisible.
   *
   * It is also exactly where the four silent failures this file's own header records happened — a
   * dedented class, `self` surviving into a free function, a missing import. Every one of them
   * "failed silently first", in code nobody could read.
   *
   * D8 adds a reference and a template per item, so this is the form they arrive in. Converting the
   * 76 existing values changed nothing semantically, which the frozen answer key proves: all 204
   * cases still re-derive.
   */
  it("uses template literals, not escaped one-liners", () => {
    const source = fs.readFileSync(
      path.join(root, "src/main/content/interview-problems.ts"),
      "utf8"
    );

    const offenders = source
      .split(SPLIT_LINES)
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /^\s*(reference|template): "/.test(line))
      .map(({ number, line }) => `${String(number)}: ${line.trim().slice(0, 60)}…`);

    expect(offenders).toEqual([]);
  });

  it("has a reference and a template for every problem", () => {
    // The count that makes the check above non-vacuous: an empty file would also have no offenders.
    for (const { problem } of INTERVIEW_PROBLEMS) {
      expect(problem.reference, problem.id).toContain(`def ${problem.entry}`);
      expect(problem.template, problem.id).toContain(`def ${problem.entry}`);
    }
    expect(INTERVIEW_PROBLEMS.length).toBeGreaterThan(0);
  });
});
