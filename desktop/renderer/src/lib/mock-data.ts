export interface Problem {
  id: string;
  orderIndex: number;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  description: string;
  examples: Array<{ input: string; output: string; explanation?: string }>;
  constraints: string[];
  hints: string[];
  /**
   * What goes in and what comes out.
   *
   * Derived in main from the cases' own arguments and the reference's actual output — never
   * authored, for the same reason `expectedOutput` is not a field: a hand-written shape can
   * silently disagree with what the code does. Absent when it could not be derived.
   */
  shapes?: {
    inputs: Array<{ name: string; shape: string }>;
    output?: string;
  };
  /**
   * The curve this exercise computes, from the reference's real output.
   *
   * Absent for most problems and that is correct — a scalar loss, a shape tuple or a list of
   * token strings is not a function anyone would plot, and drawing one anyway would be
   * decoration pretending to be data.
   */
  plot?: { input?: number[]; output: number[] };
  /**
   * The definition, as LaTeX.
   *
   * Authored, unlike `shapes` and the derived outputs — a definition has no reference to
   * disagree with, it *is* the specification. Absent for exercises that are procedures.
   */
  math?: string;
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
   * guarantees the two agree — see `testCaseToStdin`.
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
  // Max thinking tokens, whatever the chosen model's budget is. The example here used to be
  // "8192 for SGLang Qwen3.5-9B" — a serving stack this app does not have and a model that does
  // not exist, so it read as a default rather than as the arbitrary number it was.
  budgetTotal: number;
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

export const defaultCode = `import math

class Solution(object):
    def softmax(self, logits):
        """
        :type logits: List[float]
        :rtype: List[float]
        """
`;
