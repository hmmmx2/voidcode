"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type {
  ChatMessage as ChatMessageType,
  Problem,
  TestCase,
} from "@/lib/mock-data";
import type {
  ExecutionState,
  SubmissionState,
  SubmissionResult,
} from "@/lib/api/judge0";
import {
  createSession,
  listSessions,
  getSession,
  saveMessage,
  deleteSession,
  sessionMessageToChatMessage,
  type SessionSummary,
} from "@/lib/api/chat";
import ChatMessage from "./ChatMessage";
import ChatHistoryDropdown from "./ChatHistoryDropdown";
import ReviewTemplateBlock from "./ReviewTemplateBlock";
import { API_BASE, makeHeaders } from "@/lib/api/client";
import { useUserProfile } from "@/lib/context/UserProfileContext";

// ── Context passed from WorkspaceClient ─────────────────────────

export interface VoidCodeAIContext {
  problem: Problem;
  sourceCode: string;
  language: string;
  executionState: ExecutionState;
  submissionState: SubmissionState;
  testCases: TestCase[];
  /** The original template code for the current language (used to detect unmodified code) */
  templateCode: string;
  /** Callback to trigger a submit from the workspace (auto-submit) */
  onSubmit: () => Promise<SubmissionResult>;
}

interface VoidCodeAIPanelProps {
  onClose?: () => void;
  context?: VoidCodeAIContext;
  /** Backend user ID from auth session — passed to all chat API calls */
  userId?: string;
  /**
   * Replace the panel with a locked notice.
   *
   * Interview questions gate the tutor until the first submit: hints while you
   * are being assessed defeat the point, and the same tutor is genuinely useful
   * once you have committed to an answer. Undefined for curriculum problems,
   * which is why Problems is untouched.
   */
  isLocked?: boolean;
}

// ── 5 Mode Types ────────────────────────────────────────────────

type TutorMode = "TEACHING" | "DEBUG" | "FOLLOWUP" | "EXPLAIN" | "GENERAL";

// ── Step 1: Is the prompt related to the current problem? ───────

/**
 * Determines whether the user's message is related to the current problem
 * (questions 1–5 in the problem set). If yes, auto-submit is triggered.
 * If no, we check if it's a programming question (EXPLAIN) or general (GENERAL).
 */
function isProblemRelated(
  userMessage: string,
  problem: Problem | undefined,
  conversationLength: number = 0
): {
  related: boolean;
  reasoning: string;
} {
  if (!problem) {
    return { related: false, reasoning: "No problem loaded." };
  }

  const msg = userMessage.toLowerCase().trim();

  // Direct references to problem by name / keywords from the problem title
  const titleWords = problem.title.toLowerCase().split(/\s+/);
  for (const word of titleWords) {
    if (word.length >= 3 && msg.includes(word)) {
      return {
        related: true,
        reasoning: `Prompt references problem keyword "${word}" from "${problem.title}".`,
      };
    }
  }

  // Patterns that indicate user is talking about their code / this problem
  const problemRelatedPatterns = [
    /my\s*code/,
    /this\s*(problem|question|challenge)/,
    /the\s*(problem|question|challenge)/,
    /code\s*review/,
    /review\s*(my)?\s*code/,
    /check\s*(my)?\s*code/,
    /what('?s|\s+is)\s+wrong/,
    /fix\s*(my)?\s*(code|bug|error|issue)/,
    /debug/,
    /not\s+(working|passing)/,
    /failing/,
    /test\s*case/,
    /sample\s*(code|solution)/,
    /show\s+(me\s+)?(a\s+)?solution/,
    /how\s+(do\s+i|to|can\s+i|should\s+i)\s+(solve|approach|implement|code|write|start|tackle)/,
    /step\s+by\s+step/,
    /walk\s+me\s+through/,
    /guide\s+me/,
    /help\s+me\s+(solve|fix|debug|understand|figure)/,
    /improve\s*(my)?\s*(code|solution)/,
    /optimize/,
    /submit/,
    /hint/,
    /stuck/,
    /approach/,
    /algorithm/,
    /can you (help|show|explain how)/,
    /where\s+(am\s+i|did\s+i)\s+(going\s+wrong|make\s+a\s+mistake)/,
    /why\s+(is|does|doesn'?t|isn'?t|am\s+i\s+getting)/,
    /what\s+(approach|algorithm|strategy|method|data\s+structure)/,
    /how\s+would\s+(you|i)\s+(solve|implement|approach)/,
    /teach\s+me/,
    /example\s*(code|solution|implementation)/,
    /run\s*(my)?\s*code/,
    /pass\s*(all)?\s*(test|case)/,
    /correct\s*(answer|solution|output)/,
  ];

  for (const pattern of problemRelatedPatterns) {
    if (pattern.test(msg)) {
      return {
        related: true,
        reasoning: `Prompt matches problem-related pattern "${pattern.source}".`,
      };
    }
  }

  // Conceptual question guard: "what/how/why does X work" without code references
  // must NOT be treated as problem-related just because the message is short.
  // e.g. "what hash map can do?" → EXPLAIN, not CONGRATULATION.
  const isConceptualQuestion =
    (/^what\s+(is|are|does|can|do)\b/.test(msg) ||
      /^how\s+(does|do|is|are)\b/.test(msg) ||
      /^why\s+(is|are|does|do)\b/.test(msg) ||
      /^explain\s+/.test(msg)) &&
    !/(my\s*(code|solution|error|bug)|the\s*(error|bug|issue))/.test(msg);

  if (isConceptualQuestion) {
    return {
      related: false,
      reasoning: "Conceptual question — not a problem-specific code review request.",
    };
  }

  // Contextual follow-up heuristic:
  // Ultra-short messages (≤30 chars) in an active session (4+ messages = 2 full exchanges)
  // are almost certainly continuations, not new off-topic questions.
  if (conversationLength >= 4 && msg.length <= 30) {
    return {
      related: true,
      reasoning: `Short message (${msg.length} chars) in active session (${conversationLength} messages). Treating as problem-related follow-up.`,
    };
  }

  return {
    related: false,
    reasoning: "Prompt does not reference the current problem, code, or solution approach.",
  };
}

// ── Step 2a: If problem-related, pick the mode AFTER auto-submit ─

function detectProblemMode(
  userMessage: string,
  submissionResult: SubmissionResult,
  conversationLength: number,
  codeIsTemplate: boolean = false
): { mode: TutorMode; reasoning: string } {
  const msg = userMessage.toLowerCase().trim();

  // ── Template guard: if code is still the unmodified template, force TEACHING ──
  // The student hasn't started coding yet, so debugging makes no sense.
  if (codeIsTemplate) {
    return {
      mode: "TEACHING",
      reasoning: `Code is still the unmodified template — student hasn't started coding yet. Using TEACHING mode to guide them on how to approach the problem. ${submissionResult.passedTests}/${submissionResult.totalTests} tests passed.`,
    };
  }

  // ── Frustration / distress detection — ABSOLUTE PRIORITY ──────────────────
  // This check must run BEFORE any other pattern matching, including the default
  // "tests failing → DEBUG" fallback. When a student is frustrated, injecting a
  // repeated [MODE: DEBUG] format makes things dramatically worse. Switch to
  // FOLLOWUP mode so the backend can activate its EMPATHY_SYSTEM_PROMPT instead.
  //
  // Only fires in an active conversation (4+ messages = 2 full exchanges) so we
  // don't misfire on a brand-new session where the student is just being casual.
  const frustrationSignals = [
    "im dumb", "i'm dumb", "im stupid", "i'm stupid",
    "im useless", "i'm useless", "i suck",
    "im an idiot", "i'm an idiot",
    "im terrible", "i'm terrible",
    "im bad at this", "i'm bad at this",
    "i give up", "give up", "i quit",
    "cant do this", "can't do this", "cannot do this",
    "this is impossible", "it's impossible", "its impossible",
    "forget it", "hopeless", "i'll never get this",
    "im so confused", "i'm so confused", "so confused",
    "im lost", "i'm lost", "completely lost",
    "im stuck", "i'm stuck", "completely stuck",
    "i dont understand", "i don't understand",
    "dont understand", "don't understand",
    "i dont get it", "i don't get it",
    "makes no sense", "makes no sense to me",
    "i have no idea", "have no idea",
    "no idea what to do", "dont know what to do", "don't know what to do",
    "what do i even do", "what am i supposed to do",
  ];
  if (
    conversationLength >= 4 &&
    frustrationSignals.some((signal) => msg.includes(signal))
  ) {
    return {
      mode: "FOLLOWUP",
      reasoning: `Student is showing frustration or distress ("${msg.slice(0, 40)}"). Switching to FOLLOWUP mode so the tutor can respond with empathy first, not another debug list. (${submissionResult.passedTests}/${submissionResult.totalTests} tests passed)`,
    };
  }

  // If ALL tests passed → CONGRATULATION is handled via allPassed flag in template builder,
  // but we still detect what the user was asking:
  // - If they asked for teaching/sample → TEACHING (template will override to CONGRATULATION if allPassed)
  // - If they asked for review/debug → DEBUG (template will override to CONGRATULATION if allPassed)

  // TEACHING — user wants to learn approach / see solution
  const teachingPatterns = [
    /how\s+(do\s+i|to|can\s+i|should\s+i)\s+(solve|approach|implement|code|write|start|tackle)/,
    /teach\s+me/,
    /walk\s+me\s+through/,
    /step\s+by\s+step/,
    /guide\s+me/,
    /help\s+me\s+(solve|understand\s+how|figure\s+out\s+how)/,
    /sample\s*(code|solution)/,
    /show\s+(me\s+)?(a\s+)?solution/,
    /example\s*(code|solution|implementation)/,
    /how\s+would\s+(you|i)\s+(solve|implement|approach)/,
    /what\s+(approach|algorithm|strategy|method)/,
  ];

  for (const pattern of teachingPatterns) {
    if (pattern.test(msg)) {
      return {
        mode: "TEACHING",
        reasoning: `User wants to learn the approach (pattern: "${pattern.source}"). ${submissionResult.passedTests}/${submissionResult.totalTests} tests passed.`,
      };
    }
  }

  // DEBUG — user references code issues, review, bugs
  const debugPatterns = [
    /review\s*(my)?\s*code/,
    /code\s*review/,
    /check\s*(my)?\s*code/,
    /what('?s|\s+is)\s+wrong/,
    /fix\s*(my)?\s*(code|bug|error|issue)/,
    /why\s+(is|does|doesn'?t|isn'?t|am\s+i\s+getting)/,
    /debug/,
    /not\s+(working|passing)/,
    /failing/,
    /error/,
    /bug/,
    /improve/,
    /where\s+(am\s+i|did\s+i)/,
    /stuck/,
  ];

  for (const pattern of debugPatterns) {
    if (pattern.test(msg)) {
      return {
        mode: "DEBUG",
        reasoning: `User wants debugging help (pattern: "${pattern.source}"). ${submissionResult.passedTests}/${submissionResult.totalTests} tests passed.`,
      };
    }
  }

  // FOLLOWUP — short message in ongoing conversation
  if (conversationLength >= 2 && msg.length < 80) {
    const followupPatterns = [
      // All common question words — how, what, why, where, who, when, which
      /^(yes|no|ok|sure|thanks|why|how|what|where|who|when|which|can you|could you)/,
      /^(and|but|also|what about|how about)/,
      /\?$/,
    ];

    for (const pattern of followupPatterns) {
      if (pattern.test(msg)) {
        return {
          mode: "FOLLOWUP",
          reasoning: `Short follow-up message (${msg.length} chars) in conversation with ${conversationLength} messages.`,
        };
      }
    }
  }

  // Default for problem-related messages: if tests fail → DEBUG, if pass → handled by allPassed
  if (!submissionResult.allPassed) {
    return {
      mode: "DEBUG",
      reasoning: `Problem-related message with failing tests (${submissionResult.passedTests}/${submissionResult.totalTests}). Defaulting to DEBUG mode.`,
    };
  }

  return {
    mode: "TEACHING",
    reasoning: `Problem-related message with all tests passing. User may want approach guidance or confirmation.`,
  };
}

// ── Step 2b: If NOT problem-related, is it programming? ──────────

function detectNonProblemMode(
  userMessage: string,
  conversationLength: number
): { mode: TutorMode; reasoning: string } {
  const msg = userMessage.toLowerCase().trim();

  // EXPLAIN — programming-related concepts (checked BEFORE followup so
  // "what hash map can do?" routes here, not to FOLLOWUP)
  const programmingPatterns = [
    /what\s+(is|are|does|do)\s+(a\s+)?(hash\s*map|array|linked\s*list|stack|queue|tree|graph|heap|set|dictionary|tuple|string|variable|function|class|object|method|loop|recursion|iteration|pointer|reference|sort|search|algorithm|data\s*structure|complexity|big\s*o|binary|dynamic\s*programming|greedy|backtracking|bfs|dfs|memoization|cache|index|boolean|integer|float|type|interface|api|database|sql|regex)/i,
    // "what hash map can do?" / "what can a hash map do?"
    /what\s+(can\s+)?\w[\w\s]*\s+can\s+(do|be|store|hold|return|give)/i,
    /what\s+can\s+(a\s+)?\w/i,
    /explain\s/,
    /what\s+does\s+.+\s+mean/,
    /can\s+you\s+explain/,
    /tell\s+me\s+about/,
    /how\s+does\s+.+\s+work/,
    /define\s/,
    /meaning\s+of/,
    /difference\s+between/,
    /what('?s|\s+is)\s+the\s+(time|space)\s+complexity/,
    /how\s+to\s+(use|implement|create|write|make)\s/,
    /what\s+(is|are)\s+(a\s+)?\w+(ing|tion|ment|ity|ness)/,
    /python|javascript|java|c\+\+|typescript|programming|coding|syntax|compile|runtime|debug|error|exception|memory|performance|optimization/,
  ];

  for (const pattern of programmingPatterns) {
    if (pattern.test(msg)) {
      return {
        mode: "EXPLAIN",
        reasoning: `Programming-related question (pattern: "${pattern.source}"). Not specific to the current problem.`,
      };
    }
  }

  // FOLLOWUP — short message in ongoing conversation
  if (conversationLength >= 2 && msg.length < 80) {
    const followupPatterns = [
      // All common question words: how, what, why, where, who, when, which
      /^(yes|no|ok|sure|thanks|why|how|what|where|who|when|which|can you|could you)/,
      /^(and|but|also|what about|how about)/,
      /\?$/,
      // Very short messages in ongoing sessions are almost always contextual continuations.
      // e.g. "goes where", "idk", "huh", "that one", "how so"
      /^.{1,20}$/,
      // Locational/demonstrative starters natural in code follow-ups
      /^(goes|where|when|which|who|that|this|there|here|those|these|after|before|then|idk|huh)\b/i,
    ];

    for (const pattern of followupPatterns) {
      if (pattern.test(msg)) {
        return {
          mode: "FOLLOWUP",
          reasoning: `Short follow-up message (${msg.length} chars) in ongoing conversation.`,
        };
      }
    }
  }

  // GENERAL — non-programming
  return {
    mode: "GENERAL",
    reasoning: "Not related to the current problem and not a programming concept question.",
  };
}

// ── Code with line numbers ──────────────────────────────────────

function addLineNumbers(code: string): string {
  return code
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(3, " ")} | ${line}`)
    .join("\n");
}

/**
 * Check if the student's code is essentially the unmodified template.
 * Normalises whitespace so minor formatting changes don't count as "modified".
 */
function isUnmodifiedTemplate(sourceCode: string, templateCode: string): boolean {
  if (!templateCode) return false;
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
  return normalise(sourceCode) === normalise(templateCode);
}

// ── Debug error classification helpers ────────────────────────────

interface DebugTriage {
  errorType: "CRASH" | "LOGIC" | "COMPILE";
  errorSummary: string;
  tracebackQuote: string | null;
  errorLine: number | null;
  errorName: string | null;
}

function parseTraceback(stderr: string): {
  line: number | null;
  errorName: string;
  errorMessage: string;
} {
  // Extract line number from Python traceback: "line 8"
  const lineMatch = stderr.match(/line\s+(\d+)/i);
  const line = lineMatch ? parseInt(lineMatch[1], 10) : null;

  // Extract error name and message from last line: "NameError: name 'x' is not defined"
  const lines = stderr.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const errorMatch = lastLine.match(/^(\w+Error):\s*(.+)$/);

  return {
    line,
    errorName: errorMatch ? errorMatch[1] : "RuntimeError",
    errorMessage: errorMatch ? errorMatch[2] : lastLine,
  };
}

function classifyErrorType(submissionResult: SubmissionResult): DebugTriage {
  // Priority 1: Compilation errors
  for (const tcr of submissionResult.testCaseResults) {
    if (tcr.executionResult.compileOutput) {
      const output = tcr.executionResult.compileOutput.trim();
      const parsed = parseTraceback(output);
      return {
        errorType: "COMPILE",
        errorSummary: output.split("\n").pop() ?? output,
        tracebackQuote: output,
        errorLine: parsed.line,
        errorName: "CompilationError",
      };
    }
  }

  // Priority 2: Runtime errors (stderr with traceback/Error)
  for (const tcr of submissionResult.testCaseResults) {
    const stderr = tcr.executionResult.stderr;
    if (
      stderr &&
      (stderr.includes("Traceback") || stderr.includes("Error"))
    ) {
      const parsed = parseTraceback(stderr);
      return {
        errorType: "CRASH",
        errorSummary: `${parsed.errorName}: ${parsed.errorMessage}`,
        tracebackQuote: stderr.trim(),
        errorLine: parsed.line,
        errorName: parsed.errorName,
      };
    }
  }

  // Priority 3: No crash — logic error (code runs, wrong output)
  return {
    errorType: "LOGIC",
    errorSummary:
      "Code runs without crashing. Output does not match expected results.",
    tracebackQuote: null,
    errorLine: null,
    errorName: null,
  };
}

// ── Build the review template (visible in UI + sent to AI) ──────

export interface ReviewTemplate {
  problemDescription: string;
  sourceCode: string;
  sourceCodeWithLines: string;
  language: string;
  testCaseDetails: string;
  executionOutput: string;
  passFail: string;
  mode: TutorMode;
  modeReasoning: string;
  allPassed: boolean;
  debugTriage: DebugTriage | null;
  lineCount: number;
  /** True when the student's code is still the unmodified template (hasn't started) */
  codeIsTemplate: boolean;
}

function buildReviewTemplate(
  ctx: VoidCodeAIContext,
  submissionResult: SubmissionResult,
  mode: TutorMode,
  modeReasoning: string
): ReviewTemplate {
  const problemDescription = `${ctx.problem.title} (${ctx.problem.difficulty})\n${ctx.problem.description}`;
  const sourceCodeWithLines = addLineNumbers(ctx.sourceCode);
  const lineCount = ctx.sourceCode.split("\n").length;
  const debugTriage =
    mode === "DEBUG" && !submissionResult.allPassed
      ? classifyErrorType(submissionResult)
      : null;

  /*
   * Test case details for the tutor prompt.
   *
   * This block is assembled in the BROWSER and POSTed as free text to
   * /v1/chat/completions, so it is presentation, not a security boundary — the
   * server cannot validate what a modified client sends. The control is that a
   * hidden case's input, expected output and stdout are redacted server-side
   * and never reach this code. What follows only has to avoid rendering the
   * word "null" at the learner and to tell the tutor why it is thin on detail.
   *
   * `ctx.testCases` holds visible cases only, so `matchingTc` is undefined for
   * hidden ones and the Input lines are skipped for free. That is correct, but
   * it is correct by accident — do not "fix" the lookup by feeding hidden cases
   * into `ctx.testCases`.
   */
  const testLines: string[] = [];
  for (const tcr of submissionResult.testCaseResults) {
    const status = tcr.passed ? "✅ PASS" : "❌ FAIL";
    const matchingTc = ctx.testCases.find((tc) => tc.id === tcr.testCaseId);
    const label = matchingTc?.label ?? tcr.label ?? tcr.testCaseId;

    if (tcr.isHidden) {
      testLines.push(`${status} — ${label} (hidden)`);
      testLines.push("  Input and expected output are withheld for this case.");
      if (!tcr.passed) {
        testLines.push(
          "  Reason for the tutor: do NOT speculate about what this case " +
            "contains. Point the student at the general case their code does " +
            "not handle — an edge case, a boundary, or an input size."
        );
      }
      // compile_output is preserved server-side: it is produced before the
      // program runs, so it cannot contain the hidden input.
      if (!tcr.passed && tcr.executionResult.compileOutput) {
        testLines.push(`  compile:  ${tcr.executionResult.compileOutput.trim()}`);
      }
      testLines.push("");
      continue;
    }

    testLines.push(`${status} — ${label}`);
    if (matchingTc) {
      for (const inp of matchingTc.inputs) {
        testLines.push(`  Input: ${inp.name} = ${inp.value}`);
      }
    }
    testLines.push(`  Expected: ${tcr.expectedOutput ?? "N/A"}`);
    testLines.push(`  Got:      ${tcr.actualOutput ?? "N/A"}`);
    if (!tcr.passed && tcr.executionResult.stderr) {
      testLines.push(`  stderr:   ${tcr.executionResult.stderr.trim()}`);
    }
    if (!tcr.passed && tcr.executionResult.compileOutput) {
      testLines.push(`  compile:  ${tcr.executionResult.compileOutput.trim()}`);
    }
    testLines.push("");
  }

  // Execution output summary
  const execParts: string[] = [];
  if (submissionResult.overallTime) {
    execParts.push(`Time: ${submissionResult.overallTime}s`);
  }
  if (submissionResult.overallMemory) {
    execParts.push(`Memory: ${submissionResult.overallMemory} KB`);
  }
  for (const tcr of submissionResult.testCaseResults) {
    if (tcr.executionResult.compileOutput) {
      execParts.push(`Compilation Error:\n${tcr.executionResult.compileOutput}`);
      break;
    }
    if (tcr.executionResult.stderr) {
      execParts.push(`Runtime Error (${tcr.testCaseId}):\n${tcr.executionResult.stderr}`);
    }
  }

  const passFail = `${submissionResult.passedTests}/${submissionResult.totalTests} tests passed${submissionResult.allPassed ? " — All Correct!" : ""}`;

  return {
    problemDescription,
    sourceCode: ctx.sourceCode,
    sourceCodeWithLines,
    language: ctx.language,
    testCaseDetails: testLines.join("\n"),
    executionOutput: execParts.length > 0 ? execParts.join("\n") : "No errors",
    passFail,
    mode,
    modeReasoning,
    allPassed: submissionResult.allPassed,
    debugTriage,
    lineCount,
    codeIsTemplate: false, // set by caller after construction
  };
}

// ── Problem-specific teaching templates ─────────────────────────
// Each entry maps a problem title keyword → exact scaffold the AI must output.
// The AI is instructed to use this scaffold verbatim (only fill the [EXPLAIN]
// and [GUIDE] with its own words) so blanks always match the real solution.

interface TeachingScaffold {
  explain: string;          // 2-3 sentence approach hint
  template: string;         // code template with ____ blanks
  guide: string;            // line-by-line Socratic questions
}

/**
 * Hand-written teaching scaffolds, matched against the problem title.
 *
 * These 300 lines used to hold scaffolds for Two Sum, Reverse String, Valid
 * Parentheses, Merge Two Sorted Lists and Best Time to Buy and Sell Stock —
 * every one of which was deleted when the curriculum became ML. The lookup is
 * `title.toLowerCase().includes(key)`, so they had silently stopped matching
 * anything at all.
 *
 * ONLY THE FIRST PROBLEM HAS ONE, AND THAT IS DELIBERATE.
 *
 * A scaffold is a fallback for the moment the model is cold or unreachable, and
 * the first problem is the one where a new user forms their impression of
 * whether the tutor is worth talking to. Beyond that, `getProblemTeachingTemplate`
 * returns null and the request goes to the model, which has the full problem
 * text at request time and does not need a canned answer.
 *
 * Note what the template does NOT do: it never contains the answer. The line
 * that matters is left as a blank with a comment, because a scaffold that
 * completes the exercise has taught nothing.
 */
const PROBLEM_TEACHING_TEMPLATES: Record<string, TeachingScaffold> = {
  "stable softmax": {
    explain:
      "The definition you will find in any textbook is `exp(x_i) / sum(exp(x_j))`. Written literally, it **breaks on real model outputs**.\n\n" +
      "A language model's logits routinely reach the hundreds. `math.exp(1000)` is not a large number - it is an `OverflowError`, and in floating point it becomes `inf`. Divide `inf` by `inf` and you get `nan`, which then propagates through every layer downstream.\n\n" +
      "The fix rests on a property worth remembering: **softmax is shift-invariant**.\n\n" +
      "* `softmax(x) == softmax(x - c)` for *any* constant `c`\n\n" +
      "Why? Subtracting `c` multiplies every numerator by `exp(-c)` and the denominator by `exp(-c)` too, so it cancels exactly.\n\n" +
      "So pick the one `c` that makes every exponent safe: `c = max(x)`.\n\n" +
      "**Example:** `logits = [1000, 1000, 1000]`\n" +
      "1. **Naive:** `exp(1000)` overflows to `inf`. Result: `[nan, nan, nan]`.\n" +
      "2. **Shifted:** subtract `max = 1000`, giving `[0, 0, 0]`.\n" +
      "3. **Now:** `exp(0) = 1` for each, so the sum is 3.\n" +
      "4. **Result:** `[0.333333, 0.333333, 0.333333]` - correct, and it never overflowed.\n\n" +
      "After shifting, the largest exponent is always `exp(0) == 1` and every other is in `(0, 1]`, so the denominator is always at least 1. The division can never blow up.",
    template:
      "```python\n" +
      "import math\n" +
      "\n" +
      "class Solution(object):\n" +
      "    def softmax(self, logits):\n" +
      "        # Step 1: Find the shift that makes every exponent safe.\n" +
      "        # Which value guarantees the largest exponent becomes exp(0)?\n" +
      "        m = # _______ (Fill this in)\n" +
      "\n" +
      "        # Step 2: Exponentiate each SHIFTED logit, not the raw one.\n" +
      "        exps = [math.exp(v - m) for v in logits]\n" +
      "\n" +
      "        # Step 3: Normalise so the result is a probability distribution.\n" +
      "        total = sum(exps)\n" +
      "\n" +
      "        # Step 4: Divide each entry by the total and return the list.\n" +
      "        return # _______ (Fill this in)\n" +
      "```\n\n" +
      "**Check yourself:** run it on `[1000, 1000, 1000]`. If you get `nan`, step 1 is the line to look at - not the division.",
    guide:
      "**Step 1: Choose the shift**\n" +
      "* **Goal:** Pick a constant to subtract so `math.exp` can never overflow.\n" +
      "* **Hint:** After subtracting it, what should the LARGEST logit become? What value of `c` makes `x_max - c == 0`?\n\n" +
      "**Step 2: Exponentiate the shifted values**\n" +
      "* **Goal:** Apply `math.exp` to each logit *after* the shift.\n" +
      "* **Hint:** Every exponent is now `<= 0`, so every result lands in `(0, 1]`. Nothing can overflow.\n\n" +
      "**Step 3: Sum them**\n" +
      "* **Goal:** Get the denominator.\n" +
      "* **Hint:** One of the exponentials is exactly `1` (the shifted maximum), so this sum is always at least 1 - which is why the division is safe.\n\n" +
      "**Step 4: Normalise**\n" +
      "* **Goal:** Divide each exponential by the sum and return the list.\n" +
      "* **Hint:** The result must sum to 1. If it does not, check that you divided by the total rather than by the count.\n\n" +
      "**Sanity check:** does your answer for `[1, 2, 3]` match your answer for `[-1, 0, 1]`? It should - those differ by a constant shift, and that is the whole property you just used.",
  },
};

/**
 * Look up a problem-specific teaching scaffold by matching the problem title
 * (case-insensitive substring match against the map keys).
 */
function getProblemTeachingTemplate(problemTitle: string): TeachingScaffold | null {
  const lower = problemTitle.toLowerCase();
  for (const key of Object.keys(PROBLEM_TEACHING_TEMPLATES)) {
    if (lower.includes(key)) {
      return PROBLEM_TEACHING_TEMPLATES[key];
    }
  }
  return null;
}

// ── Build full prompt (after auto-submit, with review template) ──

function buildContextPrompt(
  userMessage: string,
  template: ReviewTemplate,
  problemTitle: string = ""
): string {
  const sections: string[] = [];

  // For TEACHING mode the student hasn't started yet — clarify this upfront so
  // the model doesn't try to "review" the unmodified template and hallucinate issues.
  const isTeachingMode = !template.allPassed && template.mode === "TEACHING";
  const userRequestNote = isTeachingMode
    ? `\n\n⚠️ NOTE: The student's code is still the unmodified template — they have not written any code yet. Do NOT analyze or critique the template. Do NOT say "I found N issues." Output ONLY the teaching scaffold shown below.`
    : "";
  sections.push(`[USER REQUEST]\n${userMessage}${userRequestNote}`);

  sections.push(
    `[PROBLEM DESCRIPTION]\n${template.problemDescription}`
  );

  sections.push(
    `[SOURCE CODE (${template.language}) — ${template.lineCount} lines total]\n` +
      `\`\`\`${template.language.toLowerCase()}\n${template.sourceCodeWithLines}\n\`\`\`\n` +
      `⚠️ This code has exactly ${template.lineCount} lines (1–${template.lineCount}). Do NOT reference any line beyond Line ${template.lineCount}.`
  );

  // Skip execution output for TEACHING mode — test failures on an unmodified
  // template are expected and irrelevant; showing them confuses the model into
  // producing a debug-style preamble before the scaffold.
  if (!isTeachingMode) {
    sections.push(
      `[TEST CASE DETAILS]\n${template.testCaseDetails}`
    );

    sections.push(
      `[CODE EXECUTION OUTPUT]\n${template.executionOutput}`
    );

    sections.push(
      `[PASS/FAIL SUMMARY]\n${template.passFail}`
    );
  }

  // Debug triage section — pre-classified error type for DEBUG mode
  if (template.debugTriage) {
    const t = template.debugTriage;
    const isCrash = t.errorType === "CRASH" || t.errorType === "COMPILE";
    let triageContent = `[DEBUG TRIAGE — ERROR CLASSIFICATION]\n`;
    triageContent += `Error Type: ${t.errorType}\n`;
    triageContent += `Summary: ${t.errorSummary}\n`;
    if (isCrash) {
      triageContent += `\n⛔ MANDATORY: The code CRASHES before producing output.\n`;
      triageContent += `You MUST address this ${t.errorType.toLowerCase()} error ONLY. Do NOT discuss algorithm logic.\n`;
      if (t.tracebackQuote)
        triageContent += `\nExact error from logs:\n${t.tracebackQuote}\n`;
      if (t.errorLine !== null)
        triageContent += `\nError location: Line ${t.errorLine}`;
    } else {
      triageContent += `\nCode runs without crashing (exit code 0). Analyze output differences.`;
    }
    sections.push(triageContent);
  }

  // Mode-specific instructions — allPassed overrides to CONGRATULATION
  if (template.allPassed) {
    sections.push(
      "[MODE: CONGRATULATION]\n" +
        "All test cases have passed! 🎉\n" +
        "Congratulate the student warmly on their correct solution. " +
        "Briefly highlight what they did well (e.g., correct approach, good use of data structures). " +
        "Let them know they can proceed to the next problem. " +
        "Do NOT suggest improvements, optimizations, or further changes — this is a celebration moment. " +
        "Keep the response concise (3-5 sentences). Use emojis to make it feel celebratory."
    );
  } else {
    switch (template.mode) {
      case "TEACHING": {
        const scaffold = getProblemTeachingTemplate(problemTitle);
        if (scaffold) {
          // Strategy: construct the EXACT response we want the model to output.
          // We embed it as a "pre-approved response" that the model must echo verbatim.
          // This prevents the model from generating its own solution.
          const problemName = problemTitle || "this";
          // Use [EXPLAIN]/[TEMPLATE]/[GUIDE] headers — the same format the system
          // prompt defines so both the pre-built scaffold and the fallback path
          // produce identical section markers for the student.
          const preBuiltResponse =
            `[EXPLAIN]\n` +
            scaffold.explain + `\n\n` +
            `---\n\n` +
            `[TEMPLATE]\n\n` +
            scaffold.template + `\n\n` +
            `---\n\n` +
            `[GUIDE]\n\n` +
            scaffold.guide;

          sections.push(
            "[MODE: TEACHING — PRE-BUILT SCAFFOLD]\n\n" +
            "⛔ ABSOLUTE RULE: A teaching scaffold has been pre-built for this problem.\n" +
            "Your ONLY job is to output the EXACT text below. Do NOT generate your own code.\n" +
            "Do NOT write a solution. Do NOT fill in any blanks. Do NOT modify the template.\n" +
            "Do NOT replace `____` with actual code. Do NOT add any text before or after.\n" +
            "The `____` placeholders are INTENTIONAL — they are for the student to fill in.\n\n" +
            preBuiltResponse
          );
        } else {
          // Fallback for problems not in the template library — use the same
          // [EXPLAIN]/[TEMPLATE]/[GUIDE] format as the system prompt so the model
          // sees ONE consistent format spec, not two conflicting ones.
          sections.push(
            "[MODE: TEACHING]\n" +
            "Use the three-section format from your system prompt instructions:\n\n" +
            "[EXPLAIN]\n" +
            "2-3 sentences: the key algorithm/data structure and WHY it works. No code.\n\n" +
            "[TEMPLATE]\n" +
            "The code skeleton in the student's language. Rules:\n" +
            "- Every key expression MUST be replaced with `____` (four underscores)\n" +
            "- Every line with a blank MUST have a `# Line N` comment (N = line number)\n" +
            "- NEVER write complete working code — minimum 4 blanks\n" +
            "- Blanks must cover the HARD decisions (data structure choice, lookup key, loop condition, return value)\n\n" +
            "[GUIDE]\n" +
            "One guiding question per blank line, in order:\n" +
            "Line N: <question ending with ?>\n" +
            "- Questions must point toward the answer WITHOUT revealing it\n" +
            "- Each ends with `?`\n\n" +
            "⛔ NEVER skip any section. NEVER write complete solutions. NEVER fill in the blanks."
          );
        }
        break;
      }

      case "DEBUG": {
        const triage = template.debugTriage;
        const isCrash =
          triage &&
          (triage.errorType === "CRASH" || triage.errorType === "COMPILE");

        let d = "[MODE: DEBUG]\n";

        // Universal anti-hallucination rules
        d += "ANTI-HALLUCINATION RULES (MANDATORY):\n";
        d += `1. This code has ${template.lineCount} lines. NEVER reference a line number greater than ${template.lineCount}.\n`;
        d +=
          "2. Before quoting any line, verify it exists in the [SOURCE CODE] block above.\n";
        d +=
          "3. Quoted code lines MUST exactly match the source code text.\n\n";

        if (isCrash) {
          // ── CRASH/COMPILE PATH ──
          d += "⛔ CRASH/SYNTAX ERROR — special response required:\n";
          d += "The code cannot run at all. Do NOT analyze algorithm logic.\n";
          d += "Your SOLE task: explain the crash from [DEBUG TRIAGE] and guide the student to fix it.\n\n";
          d += `The crash is on Line ${triage!.errorLine ?? "?"}: "${triage!.errorSummary}"\n\n`;
          d += "RESPONSE FORMAT — use this exactly:\n\n";
          d += "Opening: 'I found 1 issue in your code.' (no positive opener — code cannot run)\n\n";
          d += `**Issue 1 — Line ${triage!.errorLine ?? "?"}**\n`;
          d += "```<language>\n[exact line from [SOURCE CODE]]\n```\n";
          d += `Line ${triage!.errorLine ?? "?"} [plain-English explanation of why this causes the crash — reference the exact error].\n`;
          d += "[One guiding question toward the fix — ends with `?`]\n\n";
          d += "Closing: 'Let's fix this first since the code cannot run until line ";
          d += `${triage!.errorLine ?? "?"} is corrected. [Guiding question]?'\n\n`;
          d += "FORBIDDEN:\n";
          d += "- Do NOT discuss algorithm correctness, logic errors, or optimization\n";
          d += "- Do NOT suggest the code 'almost works'\n";
          d += `- Do NOT reference any line beyond Line ${template.lineCount}\n`;
          d += "- No emoji markers in output (🔴, 🟢, ✅) — plain text only";
        } else {
          // ── LOGIC PATH (code runs, wrong output) ──
          d += "LOGIC ERROR (code runs but produces wrong output):\n";
          d += "The code exits normally (no crash). Use [TEST CASE DETAILS] to see which tests failed and what the actual vs expected output was.\n\n";
          d += "RESPONSE FORMAT — match your system prompt exactly:\n\n";
          d += "Opening sentence (choose ONE):\n";
          d += `  • Some tests pass: "Your [correct aspect] is right — [positive note]. I found N issue(s) in your code."\n`;
          d += `  • All tests fail: "I found N issue(s) in your code."\n\n`;
          d += "For EACH bug — use this exact structure:\n\n";
          d += `**Issue N — Line X**\n`;
          d += "```<language>\n[exact line of code copied from [SOURCE CODE] — no modifications]\n```\n";
          d += "Line X [plain-English explanation of what this line does wrong and WHY it violates the problem's requirements — reference the student's actual variable names].\n";
          d += "[One guiding question leading toward the fix — must end with `?`]\n\n";
          d += "Closing line (always last, always ends with `?`):\n";
          d += `  "Let's fix Issue 1 first since [one-sentence reason]. [Guiding question]?"\n\n`;
          d += "NON-NEGOTIABLE RULES:\n";
          d += `- Line numbers: valid range is 1–${template.lineCount}. NEVER cite a line outside this range.\n`;
          d += "- Every quoted line MUST be copied verbatim from [SOURCE CODE]. Zero paraphrasing.\n";
          d += "- Every Issue block ends with exactly one `?`. Your final character must be `?`.\n";
          d += "- NEVER show the fix. NEVER rewrite the solution. Guide only.\n";
          d += "- No emoji markers (🔴, 🟢, ✅) in your output — plain text only.\n";
          d += "- Language does NOT change the format — Java, C#, JavaScript use the same structure as Python.";
        }

        sections.push(d);
        break;
      }

      case "FOLLOWUP":
        sections.push(
          "[MODE: FOLLOWUP]\n" +
            "This is a follow-up question in an ongoing conversation. " +
            "Provide a brief, focused response that builds on the previous context. " +
            "Keep it concise — 1-3 sentences unless the student asks for more detail."
        );
        break;

      default:
        sections.push(
          "[MODE: GENERAL]\n" +
            "Respond helpfully to the student's question in the context of their current code and test results."
        );
        break;
    }
  }

  sections.push(`[MODE REASONING]\n${template.modeReasoning}`);

  return sections.join("\n\n");
}

// ── Build lightweight prompt (no auto-submit, EXPLAIN or GENERAL) ─

function buildLightPrompt(
  userMessage: string,
  ctx: VoidCodeAIContext | undefined,
  mode: TutorMode,
  reasoning: string
): string {
  if (!ctx) return userMessage;

  const sections: string[] = [];

  sections.push(`[USER REQUEST]\n${userMessage}`);

  // Only include problem/code context for programming-related modes.
  // For GENERAL mode, send the raw question without any code context
  // so the backend's NON_PROGRAMMING_SYSTEM_PROMPT can handle it cleanly.
  if (mode !== "GENERAL") {
    sections.push(
      `[PROBLEM CONTEXT]\nThe student is working on: ${ctx.problem.title} (${ctx.problem.difficulty})`
    );

    if (ctx.sourceCode.trim()) {
      sections.push(
        `[CURRENT CODE (${ctx.language})]\n\`\`\`${ctx.language.toLowerCase()}\n${ctx.sourceCode}\n\`\`\``
      );
    }
  }

  switch (mode) {
    case "TEACHING":
      sections.push(
        "[MODE: TEACHING — NO CODE SUBMITTED]\n" +
          "The student has not written any code yet (editor is empty or auto-submit could not run). " +
          "Use the three-section format from your system prompt:\n\n" +
          "[EXPLAIN]\n" +
          "2-3 sentences: the key algorithm/data structure and WHY it works. No code.\n\n" +
          "[TEMPLATE]\n" +
          "Code skeleton in the student's language with `____` blanks for every key expression. " +
          "Minimum 4 blanks covering the hard decisions. Each blank line needs a `# Line N` comment.\n\n" +
          "[GUIDE]\n" +
          "One Socratic question per blank, in order. Each ends with `?`.\n\n" +
          "⛔ NEVER write complete solutions. NEVER fill in the blanks."
      );
      break;
    case "EXPLAIN":
      sections.push(
        "[MODE: EXPLAIN]\n" +
          "The student is asking about a programming concept (not directly about solving the current problem). " +
          "Provide a direct, clear explanation with a code example if relevant. " +
          "Keep it concise (1-4 sentences + optional hint). " +
          "If relevant to their current problem, mention the connection briefly."
      );
      break;
    case "FOLLOWUP":
      sections.push(
        "[MODE: FOLLOWUP]\n" +
          "Brief, focused follow-up response. 1-3 sentences."
      );
      break;
    default:
      sections.push(
        "[MODE: GENERAL]\n" +
          "The student's question is not about programming. " +
          "Respond helpfully and concisely as a general-purpose tutor."
      );
      break;
  }

  sections.push(`[MODE REASONING]\n${reasoning}`);

  return sections.join("\n\n");
}

// ── Component ───────────────────────────────────────────────────

export default function VoidCodeAIPanel({
  isLocked = false,
  onClose,
  context,
  userId,
}: VoidCodeAIPanelProps) {
  const { profile } = useUserProfile();
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingContentRef = useRef<string>("");
  // Refs that always hold the latest context/messages so that long-running
  // async callbacks (performAutoSubmit, handleSend) don't need them in their
  // dependency arrays — preventing needless recreation every streaming chunk.
  const contextRef = useRef<VoidCodeAIContext | undefined>(context);
  const messagesRef = useRef<ChatMessageType[]>([]);
  // AbortController for the active SSE stream — allows clean cancellation on
  // unmount, new-chat, or re-entrant handleSend calls.
  const abortControllerRef = useRef<AbortController | null>(null);
  const [autoSubmitStatus, setAutoSubmitStatus] = useState<string | null>(null);
  /**
   * Where this request sits in the GPU queue, or null when it is not waiting.
   *
   * Only ever set from a `type: "queue"` frame, and cleared the moment any answer content
   * arrives — the position stops being true at that point, and a stale "3rd in line" sitting above
   * a streaming answer would read as a fault rather than as history.
   */
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  // Mirrors `queuePosition` for the streaming loop, which runs far faster than React re-renders
  // and must not read a value that is one render behind. Same pattern as `streamingContentRef`.
  const queuePositionRef = useRef<number | null>(null);
  const [currentReviewTemplate, setCurrentReviewTemplate] =
    useState<ReviewTemplate | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasInteracted = messages.length > 0;

  // Session persistence state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const newHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${newHeight}px`;
  }, [input]);

  // Keep refs current so stable callbacks always read the latest values.
  useEffect(() => { contextRef.current = context; }, [context]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Abort any in-flight SSE stream when the component unmounts.
  useEffect(() => {
    return () => { abortControllerRef.current?.abort(); };
  }, []);

  // ── Session management ──────────────────────────────────────

  const fetchSessions = useCallback(async () => {
    setIsLoadingSessions(true);
    try {
      const data = await listSessions(20, 0, userId);
      setSessions(data.sessions);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setIsLoadingSessions(false);
    }
  }, [userId]);

  const handleNewChat = useCallback(() => {
    // Abort any in-flight streaming so it doesn't write into a cleared chat.
    abortControllerRef.current?.abort();
    setMessages([]);
    setActiveSessionId(null);
    setIsHistoryOpen(false);
    setCurrentReviewTemplate(null);
    setIsLoading(false);
    setIsStreaming(false);
  }, []);

  const handleToggleHistory = useCallback(() => {
    setIsHistoryOpen((prev) => {
      if (!prev) {
        fetchSessions();
      }
      return !prev;
    });
  }, [fetchSessions]);

  const handleSelectSession = useCallback(async (sessionId: string) => {
    setIsHistoryOpen(false);
    try {
      const detail = await getSession(sessionId, userId);
      const chatMessages = detail.messages.map(sessionMessageToChatMessage);
      setMessages(chatMessages);
      setActiveSessionId(sessionId);
      setCurrentReviewTemplate(null);
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  }, [userId]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await deleteSession(sessionId, userId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (activeSessionId === sessionId) {
          setMessages([]);
          setActiveSessionId(null);
          setCurrentReviewTemplate(null);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [activeSessionId, userId]
  );

  // ── Persist message (fire-and-forget with retry) ────────────

  const persistMessage = useCallback(
    async (
      sessionId: string,
      role: "user" | "assistant",
      content: string,
      extra?: {
        detectedMode?: string;
        thinkingContent?: string;
        thinkingTokenCount?: number;
        thinkingBudgetUsed?: number;
        promptTokens?: number;
        completionTokens?: number;
      }
    ) => {
      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await saveMessage(sessionId, { role, content, ...extra }, userId);
          return; // Success
        } catch (err) {
          if (attempt < maxRetries) {
            // Wait before retry (500ms, 1000ms)
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          } else {
            console.error("Failed to persist message after retries:", err);
          }
        }
      }
    },
    [userId]
  );

  // ── Quick actions ───────────────────────────────────────────

  const handleQuickAction = (action: string) => {
    if (action === "code-review") {
      setInput("Can you review my code and tell me what's wrong?");
    } else if (action === "sample-code") {
      setInput("Can you show me how to solve this problem step by step?");
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // ── Auto-submit ───────────────────────────────────────────

  const performAutoSubmit = useCallback(
    async (): Promise<SubmissionResult | null> => {
      const ctx = contextRef.current;
      if (!ctx?.onSubmit) return null;

      // Empty editor check
      if (!ctx.sourceCode.trim()) {
        setAutoSubmitStatus("Editor is empty — please write some code first.");
        return null;
      }

      setAutoSubmitStatus("Auto-submitting your code to evaluate test results...");

      try {
        const result = await ctx.onSubmit();
        setAutoSubmitStatus(null);
        return result;
      } catch (err) {
        console.error("Auto-submit failed:", err);
        setAutoSubmitStatus(
          `Auto-submit failed: ${err instanceof Error ? err.message : "Unknown error"}. Proceeding without test results.`
        );
        return null;
      }
    },
    [] // Uses contextRef — stable regardless of context prop changes
  );

  // ── Send message ────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userContent = input.trim();
    // Snapshot the latest context and messages from refs at call-time.
    // This keeps handleSend stable (they are NOT in the dep array) so the
    // ongoing async execution is never torn down by a mid-stream re-render.
    const context = contextRef.current;
    const messages = messagesRef.current;
    const userMessage: ChatMessageType = {
      id: Date.now().toString(),
      role: "user",
      content: userContent,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setAutoSubmitStatus(null);
    setCurrentReviewTemplate(null);

    // Session management: create on first message, reuse thereafter
    let sessionId = activeSessionId;
    if (!sessionId) {
      try {
        const pid = context?.problem.id;
        const isUuid =
          pid &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            pid
          );
        const session = await createSession({
          problemId: isUuid ? pid : undefined,
        }, userId);
        sessionId = session.id;
        setActiveSessionId(sessionId);
      } catch (err) {
        console.error("Failed to create session:", err);
      }
    }

    // Persist user message
    if (sessionId) {
      persistMessage(sessionId, "user", userContent);
    }

    // ── CoT Decision Flow ──────────────────────────────────
    //
    // Step 1: Is the prompt related to the current problem?
    //   YES → auto-submit code → get test results → pick mode from results
    //   NO  → is it programming-related? → EXPLAIN : GENERAL
    //

    let enrichedContent: string;
    let reviewTemplate: ReviewTemplate | null = null;
    let detectedMode: TutorMode = "GENERAL";

    const { related, reasoning: relevanceReasoning } = isProblemRelated(
      userContent,
      context?.problem,
      messages.length
    );

    if (related && context) {
      // ── Problem-related: auto-submit first ──────────────
      const autoResult = await performAutoSubmit();

      if (autoResult) {
        // Decide mode based on submission results + user intent
        // Check if student's code is still the unmodified template
        const codeIsTemplate = isUnmodifiedTemplate(
          context.sourceCode,
          context.templateCode
        );
        const { mode, reasoning } = detectProblemMode(
          userContent,
          autoResult,
          messages.length,
          codeIsTemplate
        );
        detectedMode = mode;

        const fullReasoning = `${relevanceReasoning} ${reasoning}`;

        // Build the full review template
        reviewTemplate = buildReviewTemplate(
          context,
          autoResult,
          mode,
          fullReasoning
        );
        reviewTemplate.codeIsTemplate = codeIsTemplate;
        setCurrentReviewTemplate(reviewTemplate);

        enrichedContent = buildContextPrompt(userContent, reviewTemplate, context?.problem.title ?? "");
      } else {
        // Auto-submit failed (empty editor or error) — still problem-related,
        // use lightweight prompt with TEACHING since we can't evaluate code
        detectedMode = "TEACHING";
        const fallbackReasoning = `${relevanceReasoning} Auto-submit could not complete. Using TEACHING mode without test results.`;
        enrichedContent = buildLightPrompt(
          userContent,
          context,
          "TEACHING",
          fallbackReasoning
        );
      }
    } else {
      // ── NOT problem-related ─────────────────────────────
      const { mode, reasoning } = detectNonProblemMode(
        userContent,
        messages.length
      );
      detectedMode = mode;

      const fullReasoning = `${relevanceReasoning} ${reasoning}`;
      enrichedContent = buildLightPrompt(
        userContent,
        context,
        mode,
        fullReasoning
      );
    }

    // Build messages array for the API (include conversation history)
    const apiMessages = [
      ...messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: enrichedContent },
    ];

    // Cancel any previous in-flight stream before starting a new one.
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: makeHeaders(userId),
        signal: controller.signal,
        body: JSON.stringify({
          messages: apiMessages,
          stream: true,                 // SSE streaming — first token in ~1–2 s
          include_reasoning: true,      // DEMO: surface the debug tutor's thinking stream so the
                                        // ThinkingBlock renders on camera. Debug reasoning is
                                        // withheld from learners by default (disclosure gate);
                                        // remove this line to restore that after filming.
          max_tokens: 8192,
          // Force low temperature for scaffold-based teaching (prevent model from
          // "improvising" and generating complete solutions instead of echoing blanks)
          ...(detectedMode === "TEACHING" && getProblemTeachingTemplate(context?.problem.title ?? "") && {
            temperature: 0.1,
          }),
          // Lower temperature for crash-type debug to minimize hallucination
          ...(reviewTemplate?.debugTriage?.errorType === "CRASH" && {
            temperature: 0.15,
          }),
        }),
      });

      if (!response.ok || !response.body) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: "Unknown error" }));
        throw new Error(
          errorData.detail || `API error (${response.status})`
        );
      }

      // ── Insert assistant message stub immediately ────────────────────────
      // When the student hasn't written any code yet (TEACHING mode with
      // unmodified template), prepend the preamble before the model's tokens.
      const isTemplateTeaching =
        detectedMode === "TEACHING" && reviewTemplate?.codeIsTemplate === true;
      const streamPreamble = isTemplateTeaching
        ? "You didn't write any code in your code editor. But here is the programming guidance:\n\n"
        : "";
      const streamId = (Date.now() + 1).toString();
      streamingContentRef.current = streamPreamble;
      setMessages((prev) => [
        ...prev,
        { id: streamId, role: "assistant" as const, content: streamPreamble },
      ]);
      setIsStreaming(true);

      // ── SSE Read Loop ───────────────────────────────────────────────────
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      // Out-of-band metadata — arrives as special SSE event types near end of stream
      let thinkingContent = "";
      let thinkingMeta: ChatMessageType["thinkingMeta"] | undefined;
      let usageData: ChatMessageType["usage"] | undefined;

      let streamDone = false;
      // Throttle React state updates during streaming — content accumulates
      // in the ref instantly, but the DOM only repaints every FLUSH_INTERVAL ms.
      // This prevents a flood of setMessages calls (one per SSE chunk) from
      // creating render pressure that competes with user interactions like
      // expanding/collapsing the ReviewTemplateBlock.
      const FLUSH_INTERVAL = 50;           // ~20 fps
      let lastFlushTime = 0;
      let flushScheduled = false;

      const flushToReact = () => {
        flushScheduled = false;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? { ...m, content: streamingContentRef.current }
              : m
          )
        );
      };

      try {
        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) break;

          // SSE events are delimited by "\n\n"; a single TCP segment may contain
          // multiple complete events or one event split across two reads.
          sseBuffer += decoder.decode(value, { stream: true });
          const events = sseBuffer.split("\n\n");
          sseBuffer = events.pop() ?? "";   // keep any incomplete trailing chunk

          for (const event of events) {
            const line = event.trim();
            if (!line.startsWith("data: ")) continue;

            const raw = line.slice(6);
            if (raw === "[DONE]") { streamDone = true; break; }

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(raw);
            } catch {
              continue;                     // malformed chunk — skip silently
            }

            // ── Thinking metadata event ──────────────────────────────
            if (parsed.type === "thinking") {
              thinkingContent = (parsed.content as string) ?? "";
              thinkingMeta = {
                content: thinkingContent,
                tokenCount: (parsed.token_count as number) ?? 0,
                budgetUsed: (parsed.budget_used as number) ?? 0,
                // Fallback matches SGLANG_THINKING_BUDGET in main.py / chat.ts
                budgetTotal: (parsed.budget_total as number) ?? 8192,
              };
              continue;
            }

            // ── Queue position ───────────────────────────────────────
            // The request is waiting for a GPU slot. The frame is a valid OpenAI chunk with an
            // empty delta, so it would fall through harmlessly to the content branch below and
            // render nothing; this is what turns it into something the learner can see.
            if (parsed.type === "queue") {
              const q = parsed.queue as { position?: number } | undefined;
              if (typeof q?.position === "number") {
                queuePositionRef.current = q.position;
                setQueuePosition(q.position);
              }
              continue;
            }

            // ── Token usage event ────────────────────────────────────
            if (parsed.type === "usage") {
              const u = parsed.usage as Record<string, number>;
              usageData = {
                promptTokens: u.prompt_tokens ?? 0,
                completionTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? 0,
              };
              continue;
            }

            // ── Delta content chunk ──────────────────────────────────
            const delta = (
              parsed as { choices?: { delta?: { content?: string } }[] }
            ).choices?.[0]?.delta?.content;

            if (delta) {
              // The wait is over the instant the first token lands. Clearing here rather than on
              // stream completion means the queue line never overlaps a visible answer.
              if (queuePositionRef.current !== null) {
                queuePositionRef.current = null;
                setQueuePosition(null);
              }

              // Content accumulates in the ref instantly (zero React overhead).
              streamingContentRef.current += delta;

              // Throttle the actual React state update so user interactions
              // (expand/collapse ReviewTemplateBlock, scroll, click editor)
              // don't have to fight dozens of renders per second.
              const now = Date.now();
              if (now - lastFlushTime >= FLUSH_INTERVAL) {
                lastFlushTime = now;
                flushToReact();
              } else if (!flushScheduled) {
                flushScheduled = true;
                setTimeout(flushToReact, FLUSH_INTERVAL - (now - lastFlushTime));
              }
            }
          }
        }
      } finally {
        reader.cancel();
        // Final flush — ensures no content is left in the ref un-rendered.
        flushToReact();
        setIsStreaming(false);
      }

      // ── Apply out-of-band metadata to the finalised message ────────────
      // ThinkingBlock and usage stats appear once the stream ends.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: streamingContentRef.current,
                thinking: thinkingContent || undefined,
                tokenCount:
                  thinkingMeta?.tokenCount ?? usageData?.totalTokens ?? 0,
                thinkingMeta,
                usage: usageData,
              }
            : m
        )
      );

      // ── Persist to DB (assembled post-stream, same schema as before) ───
      if (sessionId) {
        persistMessage(sessionId, "assistant", streamingContentRef.current, {
          detectedMode: detectedMode.toLowerCase(),
          thinkingContent: thinkingContent || undefined,
          thinkingTokenCount: thinkingMeta?.tokenCount,
          thinkingBudgetUsed: thinkingMeta?.budgetUsed,
          promptTokens: usageData?.promptTokens,
          completionTokens: usageData?.completionTokens,
        });
      }
    } catch (err) {
      // AbortError is expected when the component unmounts, the user starts a
      // new chat, or a new handleSend is invoked — silently discard it.
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }

      // Preserve partial streamed content if any was received before the error
      const partial = streamingContentRef.current;
      const errorMessage: ChatMessageType = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: partial
          ? `${partial}\n\n---\n*Response interrupted.*`
          : `**Error:** ${err instanceof Error ? err.message : "Failed to connect to VoidCode AI. Make sure the FastAPI server is running on port 8000."}`,
      };
      setMessages((prev) => {
        // Replace the empty stub if it exists; otherwise append a new message
        const stubIdx = prev.findLastIndex(
          (m) => m.role === "assistant" && m.content === ""
        );
        if (stubIdx !== -1) {
          const next = [...prev];
          next[stubIdx] = errorMessage;
          return next;
        }
        return [...prev, errorMessage];
      });
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setAutoSubmitStatus(null);
      // Cleared here as well as on the first token, because a request can leave the queue without
      // ever producing one -- a queue timeout, a refusal delivered in-band, a dropped connection.
      // Without this the position line survives the request that owned it.
      queuePositionRef.current = null;
      setQueuePosition(null);
    }
  }, [
    input,
    isLoading,
    activeSessionId,
    persistMessage,
    performAutoSubmit,
    userId,
  ]);

  if (isLocked) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-ide-panel">
        <div className="h-9 flex-shrink-0 flex items-center px-3 bg-ide-bar border-b border-line">
          <span className="text-xs font-medium text-ink-3">VoidCode AI</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span aria-hidden className="text-ink-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="10.5" width="16" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 10.5V7.5a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <p className="text-sm text-ink-2">The tutor unlocks after you submit</p>
          <p className="max-w-[34ch] text-xs leading-relaxed text-ink-3">
            This is the part of an interview you do alone. Submit an attempt —
            right or wrong — and it will review what you actually wrote.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-ide-panel">
      {/* Header */}
      <div className="h-9 flex-shrink-0 flex items-center justify-between px-3 bg-ide-bar border-b border-line relative">
        <span className="text-xs font-medium text-ink">VoidCode AI</span>
        <div className="flex items-center gap-1">
          {/* New Chat button */}
          <button
            onClick={handleNewChat}
            className="p-0.5 rounded hover:bg-ide-raised transition-colors"
            title="New Chat"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7 4V10M4 7H10"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {/* History button */}
          <button
            onClick={handleToggleHistory}
            className={`p-0.5 rounded transition-colors ${
              isHistoryOpen ? "bg-ide-raised" : "hover:bg-ide-raised"
            }`}
            title="Chat History"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7 4V7L9 9"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {/* Close button */}
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-ide-raised transition-colors"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 2L12 12M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* History dropdown */}
        {isHistoryOpen && (
          <ChatHistoryDropdown
            sessions={sessions}
            activeSessionId={activeSessionId}
            isLoading={isLoadingSessions}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onClose={() => setIsHistoryOpen(false)}
            timezone={profile?.timezone}
          />
        )}
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-6">
        {!hasInteracted ? (
          /* THE EMPTY STATE IS THE TUTOR'S ONLY CHANCE TO SET EXPECTATIONS.
             It used to read "Hello, student! I'm here to guide you through your
             programming challenges" over two unlabelled buttons. Three problems:
             it called the user a student on a product for working engineers, it
             described the tutor in terms so general they could describe
             anything, and it gave no hint that this tutor deliberately withholds
             the answer -- so the first response reads as a refusal rather than
             as the design.

             What replaces it says what the tutor will and will not do, and what
             the two buttons are for. */
          <div className="flex h-full flex-col justify-center px-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
              VoidCode AI
            </p>

            <h3 className="mt-3 text-[15px] font-medium leading-snug text-ink">
              A tutor that works through it with you.
            </h3>

            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              Ask about the approach, paste an error, or request a review of what
              you have written. It reads the problem and your current code.
            </p>

            <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
              It will not hand you a finished solution &mdash; that is deliberate.
              You get the idea, the structure, and the next question to ask
              yourself.
            </p>

            <div className="mt-6 space-y-2">
              <button
                type="button"
                onClick={() => handleQuickAction("code-review")}
                className="group flex w-full items-start gap-3 rounded-xl border border-line-strong bg-void-2 px-3.5 py-3 text-left transition-colors duration-150 ease-void hover:border-ink-3 hover:bg-void-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-ide-panel"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="mt-0.5 flex-shrink-0 text-ink-3 transition-colors group-hover:text-ink">
                  <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">
                    Review my code
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-3">
                    What is wrong, and why
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleQuickAction("sample-code")}
                className="group flex w-full items-start gap-3 rounded-xl border border-line-strong bg-void-2 px-3.5 py-3 text-left transition-colors duration-150 ease-void hover:border-ink-3 hover:bg-void-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-ide-panel"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="mt-0.5 flex-shrink-0 text-ink-3 transition-colors group-hover:text-ink">
                  <path d="M5.5 4.5L2.5 8l3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10.5 4.5L13.5 8l-3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">
                    Show me the shape
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-3">
                    A skeleton with the key line left blank
                  </span>
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => (
              <div key={msg.id}>
                <ChatMessage
                  message={msg}
                  /**
                   * `queuePosition === null` is not a tidy-up: it stops the panel telling a lie.
                   *
                   * `ChatMessage` renders `ThinkingBlock` whenever `isStreaming` is true, and
                   * `isStreaming` goes true the moment the response opens — which, for a queued
                   * request, is before any model has seen the question. The learner was shown
                   * "Thinking..." above "Waiting for a free GPU slot...", so the app claimed the
                   * tutor was reasoning about their problem while it sat in a queue behind
                   * somebody else.
                   *
                   * A message that is waiting is not streaming an answer. The thinking block
                   * appears when the first token does.
                   */
                  isStreaming={
                    isStreaming
                    && queuePosition === null
                    && idx === messages.length - 1
                    && msg.role === "assistant"
                  }
                />
                {/* Show review template after the user message that triggered it */}
                {msg.role === "user" &&
                  idx === messages.length - 2 &&
                  currentReviewTemplate && (
                    <div className="mt-3">
                      <ReviewTemplateBlock template={currentReviewTemplate} />
                    </div>
                  )}
              </div>
            ))}
            {/* Show auto-submit status */}
            {autoSubmitStatus && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ide-code/60 border border-line">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-ink-2">{autoSubmitStatus}</span>
              </div>
            )}
            {/* Show review template for the latest message if it was just sent */}
            {messages.length >= 1 &&
              messages[messages.length - 1].role === "user" &&
              currentReviewTemplate && (
                <div className="mt-1">
                  <ReviewTemplateBlock template={currentReviewTemplate} />
                </div>
              )}
            {queuePosition !== null && (
              // Replaces the "Thinking..." dots while queued, rather than sitting beside them:
              // two simultaneous status lines saying different things is worse than either.
              <div className="flex items-center gap-2 text-ink-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:300ms]" />
                </div>
                <span className="text-xs">
                  {queuePosition <= 1
                    ? "Waiting for a free GPU slot..."
                    : `Waiting for a free GPU slot — ${queuePosition - 1} ahead of you...`}
                </span>
              </div>
            )}
            {isLoading && !autoSubmitStatus && !isStreaming && queuePosition === null && (
              <div className="flex items-center gap-2 text-ink-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-ink-3 rounded-full animate-bounce motion-reduce:animate-none [animation-delay:300ms]" />
                </div>
                <span className="text-xs">Thinking...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Bar */}
      <div className="p-3 flex-shrink-0">
        <div className="flex items-end gap-2 bg-ide-code rounded-2xl px-4 py-2.5 border border-line focus-within:border-line-strong transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            className="bg-transparent flex-1 outline-none text-xs text-ink placeholder:text-ink-3 resize-none overflow-y-auto leading-5"
            style={{ maxHeight: "160px" }}
            placeholder="Ask Anything..."
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            className="flex-shrink-0 mb-0.5"
            disabled={isLoading || !input.trim()}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className={`transition-opacity ${
                isLoading || !input.trim() ? "opacity-30" : "opacity-100"
              }`}
            >
              <circle cx="11" cy="11" r="11" className="fill-ide-raised" />
              <path
                d="M17 11L7 17L8.09375 11.75H11.2031V10.25H8.09375L7 5L17 11Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
