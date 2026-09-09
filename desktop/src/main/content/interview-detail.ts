/**
 * `GET /v1/interviews/{slug}/workspace` — everything the IDE needs to open a question, and
 * nothing that answers it.
 *
 * TEST CASES COME BACK WITHOUT `expected_output`, AND THAT IS THE FEATURE.
 *
 * The problems catalogue ships expected outputs so a learner can see what a passing run
 * looks like. An interview screen does not work that way: you write against the written
 * spec and find out whether you were right when you submit. That is enforced by never
 * putting the value in the payload rather than by hiding it in the UI — otherwise the
 * answer is one devtools tab away, which is the same mistake the staged reveal exists to
 * avoid.
 *
 * It is also why `examples` here are the authored ones rather than derived from executing
 * the reference, as `detail.ts` does for the curriculum. Deriving them would print the
 * answers to the test cases onto the page, which is the leak this route is shaped to
 * prevent.
 */
import { INTERVIEW_PROBLEMS } from "./interview-problems.js";
import { getQuestion, DOMAIN_LABELS } from "./interviews.js";
import { getAttempt } from "../store/interviews.js";

const BY_SLUG = new Map(INTERVIEW_PROBLEMS.map((ip) => [ip.questionSlug, ip]));

export interface InterviewWorkspacePayload {
  problem: {
    id: string;
    order_index: number;
    title: string;
    difficulty: string;
    description: string;
    examples: Array<{ input: string; output: string; explanation?: string }>;
    constraints: string[];
    hints: string[];
  };
  /** Visible cases only, and every `expected_output` is null. */
  testCases: Array<{
    id: string;
    label: string;
    inputs: Array<{ name: string; value: string }>;
    stdin: string;
    expected_output: null;
  }>;
  hidden_count: number;
  codeTemplates: Array<{
    id: string;
    language: string;
    template_code: string;
    driver_code: null;
  }>;
  elapsedSeconds: number;
  submittedAt: string | null;
  notes: string | null;
  companies: string[];
  domainLabel: string;
  difficulty: string;
  title: string;
}

export function hasInterviewWorkspace(slug: string): boolean {
  return BY_SLUG.has(slug);
}

export class NoWorkspaceForQuestionError extends Error {
  constructor(slug: string) {
    super(`interview question has no executable form: ${slug}`);
    this.name = "NoWorkspaceForQuestionError";
  }
}

/** The problem id the grader knows this question by. `undefined` if it has no workspace. */
export function problemIdForQuestion(slug: string): string | undefined {
  return BY_SLUG.get(slug)?.problem.id;
}

export function buildInterviewWorkspace(slug: string): InterviewWorkspacePayload {
  const entry = BY_SLUG.get(slug);
  if (entry === undefined) throw new NoWorkspaceForQuestionError(slug);

  // Throws on an unknown slug, which is the right order: a workspace for a question that
  // does not exist is a 404, not an empty editor.
  const question = getQuestion(slug);
  const attempt = getAttempt(slug);
  const { problem, statement } = entry;

  const visible = problem.cases.filter((c) => c.visible);

  return {
    problem: {
      // `iq-`-prefixed, and it has to be: this is what the editor sends back to
      // `POST /v1/submit`, so it must be the id the grader resolves.
      id: problem.id,
      order_index: statement.orderIndex,
      title: problem.title,
      /**
       * The question's, not the embedded problem's.
       *
       * `Problem` carries a `difficulty` because the curriculum route needs one, so the interview
       * workspace inherited a second copy — and they disagreed for **8 of 38** questions. Both
       * shipped in this payload: `payload.difficulty` below drives the catalogue filter and the
       * facet counts, this one drives the badge in the workspace. So a learner could filter for
       * "hard", open the result, and be told "Medium".
       *
       * Difficulty is a property of the question — what an interviewer asks — not of the harness
       * that grades it. So the question is authoritative here, the eight embedded values were
       * realigned to match, and `tests/interviews.test.ts` asserts they stay that way. Deciding
       * this at 38 items cost an afternoon; at 200 it would have been 40 judgement calls.
       */
      difficulty: question.difficulty,
      description: statement.description,
      examples: statement.examples,
      constraints: statement.constraints,
      hints: statement.hints,
    },
    testCases: visible.map((c) => ({
      id: c.id,
      label: c.label,
      // Named from the entry point's own parameters rather than `arg1`, `arg2`. The names
      // are what the prompt talks about — `y_true`, `y_score` — and positional indices
      // would make the reader do the mapping themselves.
      inputs: (c.args ?? []).map((value, i) => ({
        name: statement.params[i] ?? `arg${i + 1}`,
        value: JSON.stringify(value),
      })),
      stdin: (c.args ?? []).map((a) => JSON.stringify(a)).join("\n"),
      // Null, always. See the header.
      expected_output: null,
    })),
    // An honest count of what is not shown. "5 tests, 2 shown" is useful; pretending the
    // hidden ones do not exist is not.
    hidden_count: problem.cases.length - visible.length,
    codeTemplates: [
      {
        id: `${problem.id}-python`,
        // Capitalised: the workspace matches on `ct.language === "Python"`.
        language: "Python",
        // Judge0's Python 3 id. Execution is Pyodide and never reaches Judge0, but the
        // renderer's language mapping is keyed on this.
        template_code: problem.template,
        // No driver: main calls the entry point directly with the case arguments. What the
        // driver used to do to the *output* survives as the problem's `normalise`.
        driver_code: null,
      },
    ],
    elapsedSeconds: attempt?.elapsedSeconds ?? 0,
    submittedAt: attempt?.submittedAt ?? null,
    notes: attempt?.notes ?? null,
    companies: question.companies,
    domainLabel: DOMAIN_LABELS[question.domain] ?? question.domain,
    difficulty: question.difficulty,
    title: question.title,
  };
}
