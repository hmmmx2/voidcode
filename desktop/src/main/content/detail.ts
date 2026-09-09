/**
 * `GET /v1/problems/{slug}` — the payload the workspace loads.
 *
 * Snake_case on the wire because `renderer/src/lib/api/problems.ts` parses it that way;
 * the transport swap is meant to be invisible to the UI.
 *
 * Two things this does differently from the FastAPI version it replaces:
 *
 *   **Hidden cases are not sent at all.** The web payload included every case with its
 *   expected output. Grading now happens in main, so the renderer never needs a hidden
 *   case's expectation — and sending one would hand over the answer key to a client the
 *   user can read. What it does send is an honest count, so "4 tests, 3 shown" still
 *   holds.
 *
 *   **Expected outputs are derived, not stored.** They come from executing the reference,
 *   the same key the grader marks against, so the console cannot display one thing while
 *   the grader checks another.
 */
import { derivedKeyFor } from "../exec/grader.js";
import { getProblem, type Problem } from "./problems.js";
import { deriveShapes, derivePlot } from "./shapes.js";

export interface ProblemDetailPayload {
  id: string;
  slug: string;
  order_index: number;
  title: string;
  difficulty: string;
  description: string;
  examples: Array<{ input: string; output: string; explanation?: string }>;
  constraints: string[];
  hints: string[];
  /** Visible cases only. `hidden_count` reports the rest. */
  test_cases: Array<{
    id: string;
    label: string;
    inputs: Array<{ name: string; value: string }>;
    stdin: string;
    expected_output: string;
  }>;
  hidden_count: number;
  /**
   * What goes in and what comes out, derived from the same execution that produces the
   * expectations. Absent when the reference is broken — the UI shows no rail rather than a
   * shape it made up.
   */
  shapes?: {
    inputs: Array<{ name: string; shape: string }>;
    output?: string;
  };
  /**
   * The curve this exercise computes, from the reference's real output.
   *
   * Absent for most problems, and that is correct — a scalar loss, a shape tuple or a list
   * of token strings is not a function anyone would plot.
   */
  plot?: { input?: number[]; output: number[] };
  /** The definition, as LaTeX. Absent for exercises that are procedures rather than formulas. */
  math?: string;
  code_templates: Array<{
    id: string;
    language: string;
    template_code: string;
    driver_code: string | null;
  }>;
}

/** How a case's arguments are shown. Positional, so the names are positional too. */
function inputsOf(problem: Problem, args: unknown[]): Array<{ name: string; value: string }> {
  return args.map((value, i) => ({
    name: `arg${i + 1}`,
    value: JSON.stringify(value),
  }));
}

export async function buildProblemDetail(
  slug: string,
  orderIndex: number
): Promise<ProblemDetailPayload | undefined> {
  const problem = getProblem(slug);
  if (problem === undefined) return undefined;

  // Executing the reference is what produces the expectations. Cached per problem by the
  // grader, so opening a problem twice does not pay for it twice.
  const key = await derivedKeyFor(problem);

  const visible = problem.cases
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.visible);

  // The first visible case is the one the learner is reading while they look at the rail,
  // and its index into `key` is where that case's reference output landed.
  const sampleIndex = visible[0]?.index;
  const sampleRepr = sampleIndex === undefined ? undefined : key?.[sampleIndex];
  const shapes = deriveShapes(problem, sampleRepr);
  const plot = derivePlot(problem, sampleRepr);

  return {
    id: problem.id,
    slug: problem.id,
    ...(shapes !== undefined ? { shapes } : {}),
    ...(plot !== undefined ? { plot } : {}),
    ...(problem.math !== undefined ? { math: problem.math } : {}),
    order_index: orderIndex,
    title: problem.title,
    difficulty: problem.difficulty,
    description: problem.summary,
    examples: visible.map(({ c, index }) => ({
      input: c.args.map((a) => JSON.stringify(a)).join(", "),
      output: key?.[index] ?? "",
      explanation: c.label,
    })),
    constraints: [
      problem.allowedImports.length > 0
        ? `${problem.allowedImports.join(", ")} only`
        : "Standard library only",
      `Time limit: ${problem.timeLimitMs} ms`,
      `Memory: ${problem.memoryLimitMb} MB`,
    ],
    // Deliberately empty. The web content had a static hint ladder; adaptive hints are the
    // tutor's job (spec §1.6), and shipping the old ones would reintroduce the "Hint 2 is
    // the answer" problem the audit found.
    hints: [],
    test_cases: visible.map(({ c, index }) => ({
      id: c.id,
      label: c.label,
      inputs: inputsOf(problem, c.args),
      stdin: c.args.map((a) => JSON.stringify(a)).join("\n"),
      expected_output: key?.[index] ?? "",
    })),
    hidden_count: problem.cases.length - visible.length,
    code_templates: [
      {
        id: `${problem.id}-python`,
        // Capitalised: WorkspaceClient matches on `ct.language === "Python"`, and the
        // LANGUAGE_MAP the toolbar filters against is keyed the same way.
        language: "Python",
        template_code: problem.template,
        // No driver: main calls the entry point directly with the case arguments, rather
        // than concatenating a stdin-reading harness onto the learner's source.
        driver_code: null,
      },
    ],
  };
}
