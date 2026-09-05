/**
 * Shared domain types for the workspace, plus the editor's default contents.
 *
 * THE NAME IS NOW WRONG AND THE MOCKS ARE GONE. This file held `mockProblem`,
 * `mockSubmissions`, `mockTestCases`, `mockMessages` and a second
 * `testCaseToStdin`. None had a single importer, and `apps/web` has no test
 * directory, so they were not fixtures either — they were carcass from before
 * the API existed.
 *
 * They were also actively misleading. `mockProblem` had drifted into a hybrid:
 * the title of the ML curriculum's first problem attached to Two Sum's
 * description, examples, constraints and hints — a problem the catalogue no
 * longer contains at all (`grep -rli "two sum" content/` returns nothing). Its
 * `testCaseToStdin` ignored `tc.stdin` and rebuilt the input from the display
 * projection, which is exactly the bug the surviving copy in
 * `lib/api/problems.ts` carries a fifteen-line docstring about having fixed.
 *
 * Renaming the file is thirteen import updates and is deliberately not done
 * here; the types are what everything actually imports.
 */

export interface Problem {
  id: string;
  orderIndex: number;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  description: string;
  examples: Array<{ input: string; output: string; explanation?: string }>;
  constraints: string[];
  hints: string[];
}

export interface Submission {
  id: string;
  status: "Accepted" | "Wrong Answer" | "Time Limit Exceeded" | "Runtime Error";
  runtime: string;
  language: string;
  timestamp: string;
  passedTests?: number;
  totalTests?: number;
  sourceCode?: string;
}

export interface TestCase {
  id: string;
  label: string;
  inputs: Array<{ name: string; value: string }>;
  /**
   * The authoritative stdin the grader feeds this case, straight from the
   * database. `inputs` is a display projection of the same thing and nothing
   * guarantees the two agree — see `testCaseToStdin` in `lib/api/problems.ts`,
   * which is the only implementation.
   */
  stdin?: string;
  expectedOutput?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ThinkingMeta {
  content: string;
  tokenCount: number;
  budgetUsed: number;    // percentage (e.g. 42.5)
  budgetTotal: number;   // max thinking tokens — 8192 for SGLang Qwen3.5-9B
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tokenCount?: number;
  thinkingMeta?: ThinkingMeta;
  usage?: TokenUsage;
}

/**
 * What the editor shows before a problem's own template loads.
 *
 * A COPY OF `stable-softmax`'s `template_code`, and the only content in this
 * file. It is the first problem in the curriculum sequence, so it is what a new
 * learner sees. Duplicated rather than fetched because it has to render before
 * any request resolves — `tests/test_catalog_coverage.py` asserts it still
 * matches the YAML, so the copy cannot drift the way the mocks above did.
 */
export const defaultCode = `import math

class Solution(object):
    def softmax(self, logits):
        """
        :type logits: List[float]
        :rtype: List[float]
        """
`;
