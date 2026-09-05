/**
 * Problems API Client
 *
 * Fetches problem data from the FastAPI backend at /v1/problems.
 * Replaces hardcoded mock data with database-driven content.
 */

import type { Problem, TestCase } from "@/lib/mock-data";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ── Types from API ────────────────────────────────────────────

export interface APICodeTemplate {
  id: string;
  language: string;
  judge0LanguageId: number;
  templateCode: string;
  driverCode: string | null;
}

export interface ProblemSummary {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  orderIndex: number;
}

export interface ProblemDetail {
  problem: Problem;
  testCases: TestCase[];
  codeTemplates: APICodeTemplate[];
}

// ── API Functions ─────────────────────────────────────────────

export async function fetchProblemList(): Promise<ProblemSummary[]> {
  const response = await fetch(`${API_BASE}/v1/problems`);
  if (!response.ok) {
    throw new Error(`Failed to load problems (${response.status})`);
  }
  const data = await response.json();
  return (data.problems as Record<string, unknown>[]).map((p) => ({
    id: p.id as string,
    slug: p.slug as string,
    title: p.title as string,
    difficulty: p.difficulty as string,
    orderIndex: p.order_index as number,
  }));
}

export async function fetchProblem(slug: string): Promise<ProblemDetail> {
  const response = await fetch(`${API_BASE}/v1/problems/${slug}`);
  if (!response.ok) {
    throw new Error(`Failed to load problem (${response.status})`);
  }
  const data = await response.json();

  // Map to frontend Problem type
  const problem: Problem = {
    id: data.id,
    orderIndex: data.order_index as number,
    title: data.title,
    difficulty: capitalize(data.difficulty) as "Easy" | "Medium" | "Hard",
    description: data.description,
    examples: data.examples,
    constraints: data.constraints,
    hints: data.hints,
  };

  // Map test cases
  const testCases: TestCase[] = (data.test_cases as Record<string, unknown>[]).map(
    (tc) => ({
      id: tc.id as string,
      label: tc.label as string,
      inputs: tc.inputs as Array<{ name: string; value: string }>,
      stdin: tc.stdin as string | undefined,
      expectedOutput: tc.expected_output as string,
    })
  );

  // Map code templates
  const codeTemplates: APICodeTemplate[] = (
    data.code_templates as Record<string, unknown>[]
  ).map((ct) => ({
    id: ct.id as string,
    language: ct.language as string,
    judge0LanguageId: ct.judge0_language_id as number,
    templateCode: ct.template_code as string,
    driverCode: ct.driver_code as string | null,
  }));

  return { problem, testCases, codeTemplates };
}

// ── Helpers ───────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build executable code by appending the driver to user code.
 * The driver reads stdin, calls the user's method, and prints to stdout.
 */
export function buildExecutableCode(
  userCode: string,
  driverCode: string | null | undefined
): string {
  if (!driverCode) return userCode;
  return userCode + "\n" + driverCode;
}

/**
 * The stdin to feed a test case when running it.
 *
 * PREFERS `tc.stdin`, the value the grader actually uses.
 *
 * This function used to only ever return the `inputs` projection, which meant
 * there were two independent representations of a case's input: Run executed
 * the reconstruction, Submit executed the database column, and nothing asserted
 * they agreed. They happen to agree in the current seed. The moment they did
 * not, the learner would see "it passes when I hit Run" and have no way to
 * explain the failure on Submit — the worst class of bug on a teaching tool,
 * because it makes the platform look wrong about the thing it is teaching.
 *
 * The join fallback stays for older payloads that predate `stdin` being served,
 * and `test_stdin_matches_inputs_projection` pins the two together server-side.
 */
export function testCaseToStdin(
  tc: TestCase
): string {
  return tc.stdin ?? tc.inputs.map((i) => i.value).join("\n");
}
