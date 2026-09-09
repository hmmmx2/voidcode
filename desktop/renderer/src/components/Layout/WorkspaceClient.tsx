"use client";

import { useUserId } from "@/lib/hooks/useUserId";


import { useState, useCallback, useEffect, useMemo } from "react";
import WorkspaceToolbar from "./WorkspaceToolbar";
import ResizableLayout from "./ResizableLayout";
import ProblemTabs, { type ExtraPanel } from "@/components/ProblemPanel/ProblemTabs";
import CodeColumn from "@/components/Editor/CodeColumn";
import TestConsole from "@/components/Editor/TestConsole";
import VoidCodeAIPanel from "@/components/VoidCodeAI/VoidCodeAIPanel";
import type { Problem, TestCase, Submission } from "@/lib/mock-data";
import { cancelCurrentRun } from "@/lib/api/client";
import { fetchSubmissions } from "@/lib/api/submissions";
import { loadDraft } from "@/lib/api/drafts";
import { useAutosave } from "@/lib/hooks/useAutosave";
import { LANGUAGE_MAP } from "@/lib/constants";
import {
  executeCode,
  submitCode,
  type ExecutionState,
  type SubmissionState,
  type SubmissionResult,
} from "@/lib/api/grading";
import {
  fetchProblem,
  buildExecutableCode,
  testCaseToStdin,
  type APICodeTemplate,
  type ProblemDetail,
} from "@/lib/api/problems";
import { useUserProfile } from "@/lib/context/UserProfileContext";
import {
  usePublishWorkspaceActions,
  type WorkspaceActions,
} from "@/lib/shell/workspace-actions";

interface WorkspaceClientProps {
  problemSlug: string;
  currentProblem: number;
  totalProblems: number;
  /**
   * How to fetch the thing being solved.
   *
   * Defaults to `fetchProblem`, which is what the curriculum route wants and
   * keeps that call site unchanged. The interview route passes its own loader
   * so the IDE can render a question whose test cases arrive with their
   * expected outputs withheld — same component, different contract.
   */
  loadQuestion?: (slug: string) => Promise<ProblemDetail>;
  /**
   * URL prefix for the prev/next chevrons and the problem list.
   *
   * Was the literal `/problems/${n}` in two places. Threading it means the
   * navigator moves you through interview questions when you are in one,
   * instead of silently jumping to the curriculum.
   */
  basePath?: string;
  /** Extra tabs for the left panel — the interview reveal panels go here. */
  extraPanels?: ExtraPanel[];
  /**
   * Held back until the user submits. Undefined means "not gated", which is the
   * curriculum's behaviour and why Problems is unaffected.
   */
  isTutorLocked?: boolean;
  onSubmitted?: () => void;
}

export default function WorkspaceClient({
  problemSlug,
  currentProblem,
  totalProblems,
  loadQuestion = fetchProblem,
  basePath = "/problems",
  extraPanels,
  isTutorLocked,
  onSubmitted,
}: WorkspaceClientProps) {
  // unauthenticated) and avoid fetching drafts with the wrong (anonymous) userId.
  const userId = useUserId();
  const { profile } = useUserProfile();
  const [isVoidCodeAIOpen, setIsVoidCodeAIOpen] = useState(true);

  // Problem data from API
  const [problem, setProblem] = useState<Problem | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [codeTemplates, setCodeTemplates] = useState<APICodeTemplate[]>([]);
  const [isLoadingProblem, setIsLoadingProblem] = useState(true);

  // Code editor state
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("Python");

  // Execution state (Run button)
  const [executionState, setExecutionState] = useState<ExecutionState>({
    status: "idle",
  });

  // Submission state (Submit button)
  const [submissionState, setSubmissionState] = useState<SubmissionState>({
    status: "idle",
  });

  // Submission history from DB
  const [submissions, setSubmissions] = useState<Submission[]>([]);

  // Editor expand state
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);

  // Autosave hook
  const saveStatus = useAutosave(problem?.id, language, code, userId);

  // ── Load problem + draft ──────────────────────────────────────
  // Re-runs if the slug changes OR the session finishes loading, so the draft is loaded
  // with the real userId rather than the anonymous fallback. (This used to open by naming
  // the "correct X-User-Id header", whose first line had already been edited away; the
  // header itself is gone now, and `lib/api/client.ts` records why.)

  useEffect(() => {
    // the anonymous user and then immediately discard the result once the
    // real userId arrives.
    // The web build waited here for NextAuth to resolve, so a request was never sent
    // with a missing X-User-Id. There is no session to wait for now — `useUserId`
    // returns synchronously — so the gate is gone rather than always-true.

    let cancelled = false;

    async function loadProblem() {
      setIsLoadingProblem(true);
      try {
        const data = await loadQuestion(problemSlug);
        if (cancelled) return;

        setProblem(data.problem);
        setTestCases(data.testCases);
        setCodeTemplates(data.codeTemplates);

        // Try to load a saved draft first, fall back to template.
        // Pass userId so the backend looks up the right user's draft.
        const template = data.codeTemplates.find(
          (ct) => ct.language === "Python"
        );
        try {
          const draft = await loadDraft(data.problem.id, "Python", userId);
          if (!cancelled && draft) {
            setCode(draft.source_code);
          } else if (!cancelled && template) {
            setCode(template.templateCode);
          }
        } catch {
          if (!cancelled && template) {
            setCode(template.templateCode);
          }
        }
      } catch (err) {
        console.error("Failed to load problem:", err);
      } finally {
        if (!cancelled) setIsLoadingProblem(false);
      }
    }

    loadProblem();
    return () => {
      cancelled = true;
    };
  }, [problemSlug, userId, loadQuestion]);

  // ── Load submission history when problem is available ─────────

  useEffect(() => {
    if (!problem?.id) return;
    fetchSubmissions(problem.id, userId, profile?.timezone)
      .then(setSubmissions)
      .catch((err) => console.error("Failed to load submissions:", err));
  }, [problem?.id, userId, profile?.timezone]);

  // ── Language change: update code template ─────────────────────

  const handleLanguageChange = useCallback(
    async (newLanguage: string) => {
      setLanguage(newLanguage);
      const template = codeTemplates.find((ct) => ct.language === newLanguage);

      // Try to load a saved draft for the new language
      if (problem?.id) {
        try {
          const draft = await loadDraft(problem.id, newLanguage, userId);
          if (draft) {
            setCode(draft.source_code);
            return;
          }
        } catch {
          // Fall through to template
        }
      }

      if (template) {
        setCode(template.templateCode);
      }
    },
    [codeTemplates, problem?.id, userId]
  );

  // ── Reset code to original template ──────────────────────────

  const handleReset = useCallback(() => {
    const template = codeTemplates.find((ct) => ct.language === language);
    if (template) {
      setCode(template.templateCode);
    }
  }, [codeTemplates, language]);

  // ── Load code from submission history ───────────────────────

  const handleLoadSubmission = useCallback((sourceCode: string, submissionLanguage: string) => {
    // Map language names from backend (e.g. "Python") to match our LANGUAGE_MAP keys
    const langKey = Object.keys(LANGUAGE_MAP).find(
      (k) => k.toLowerCase() === submissionLanguage.toLowerCase()
    );
    if (langKey && langKey !== language) {
      setLanguage(langKey);
    }
    setCode(sourceCode);
  }, [language]);

  // ── Expand/collapse editor ─────────────────────────────────

  const handleExpandToggle = useCallback(() => {
    setIsEditorExpanded((prev) => !prev);
  }, []);

  // ── Get active driver code ────────────────────────────────────

  const getDriverCode = useCallback((): string | null => {
    const template = codeTemplates.find((ct) => ct.language === language);
    return template?.driverCode ?? null;
  }, [codeTemplates, language]);

  // ── Run button ────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    const langConfig = LANGUAGE_MAP[language];
    if (!langConfig || testCases.length === 0) return;

    /**
     * The same guard `performSubmit` has, and for the same reason.
     *
     * Running is grading against one visible case, so without a problem there is nothing to
     * run against. Submit was given this guard when its id was fixed; Run was left sending
     * none at all, the seam substituted an empty string, and the channel rejected every
     * request as an invalid payload — so the button had never worked on the desktop.
     *
     * Reported as an error state rather than a silent return: a Run that does nothing and
     * says nothing is indistinguishable from one that is still thinking.
     */
    if (!problem?.id) {
      setExecutionState({
        status: "error",
        error: "Open a problem before running — there is nothing to run this against.",
      });
      return;
    }

    setExecutionState({ status: "running" });

    try {
      const executableCode = buildExecutableCode(code, getDriverCode());
      const stdin = testCaseToStdin(testCases[0]);

      const result = await executeCode({
        sourceCode: executableCode,
        problemId: problem.id,
        stdin,
        userId,
      });
      setExecutionState({ status: "success", result });
    } catch (err) {
      setExecutionState({
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [code, language, testCases, getDriverCode, userId, problem?.id]);

  // ── Submit (shared logic) ────────────────────────────────────

  const performSubmit = useCallback(async (): Promise<SubmissionResult> => {
    const langConfig = LANGUAGE_MAP[language];
    if (!langConfig) throw new Error("Unsupported language");
    // Grading is keyed entirely on the problem, so without an id there is
    // nothing to grade against. Previously this fell through as `null` and the
    // server graded the client's own test cases anyway.
    if (!problem?.id) throw new Error("Cannot submit without a problem");

    setSubmissionState({
      status: "running",
      // `testCases` holds only the VISIBLE cases — the API omits hidden ones.
      // The real total arrives with the result and may be larger.
      progress: { current: 0, total: testCases.length },
    });

    try {
      const executableCode = buildExecutableCode(code, getDriverCode());

      const result = await submitCode({
        sourceCode: executableCode,
        problemId: problem.id,
        language,
        userId,
      });
      setSubmissionState({ status: "success", result });
      onSubmitted?.();

      // Refetch submission history from DB
      if (problem?.id) {
        fetchSubmissions(problem.id, userId, profile?.timezone)
          .then(setSubmissions)
          .catch(console.error);
      }

      return result;
    } catch (err) {
      setSubmissionState({
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      throw err;
    }
  }, [code, language, testCases, getDriverCode, problem?.id, userId, profile?.timezone, onSubmitted]);

  // ── Submit button (UI) ─────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    try {
      await performSubmit();
    } catch {
      // Error already set in submissionState
    }
  }, [performSubmit]);

  // ── Submit for VoidCode AI (returns result) ───────────────────────

  const handleSubmitForAI = useCallback(async (): Promise<SubmissionResult> => {
    return performSubmit();
  }, [performSubmit]);

  // ── Loading state ─────────────────────────────────────────────

  /**
   * Offer Run, Submit and Reset to the shell, so the menu and Ctrl+Enter can reach them.
   *
   * Published from an effect rather than called directly by the shell, because these close
   * over the code, the language and the loaded test cases — all of which belong here.
   *
   * `undefined` on unmount is what greys the whole Run menu on the dashboard: no route
   * checks anywhere, just nothing bound.
   */
  const publishWorkspaceActions = usePublishWorkspaceActions();

  const workspaceActions = useMemo<WorkspaceActions>(
    () => ({
      run: () => void handleRun(),
      submit: () => void handleSubmit(),
      reset: handleReset,
      // No state to update here. The run is not over when Stop is pressed — it is over when
      // `exec.run` resolves, which it does with a cancelled outcome, and the existing
      // success/error paths below carry that through like any other result.
      stop: () => void cancelCurrentRun(),
      // Both states, because either one running means the sandbox is busy. Firing Run while a
      // submit is in flight would supersede it in main — `runInSandbox` allows one job — and
      // silently cancel the grading the learner is waiting on.
      busy: executionState.status === "running" || submissionState.status === "running",
      canRun: LANGUAGE_MAP[language] !== undefined && testCases.length > 0,
      canSubmit: problem?.id !== undefined,
    }),
    [
      handleRun,
      handleSubmit,
      handleReset,
      executionState.status,
      submissionState.status,
      language,
      testCases.length,
      problem?.id,
    ]
  );

  useEffect(() => {
    publishWorkspaceActions(workspaceActions);
    return () => publishWorkspaceActions(undefined);
  }, [publishWorkspaceActions, workspaceActions]);

  if (isLoadingProblem) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-ide-gutter">
        <WorkspaceToolbar
          currentProblem={currentProblem}
          totalProblems={totalProblems}
          isVoidCodeAIOpen={isVoidCodeAIOpen}
          onToggleVoidCodeAI={() => setIsVoidCodeAIOpen((prev) => !prev)}
        />
        <div className="flex-1 flex items-center justify-center">
          <span className="text-sm text-ink-3">Loading problem...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ide-gutter">
      <WorkspaceToolbar
        currentProblem={currentProblem}
        totalProblems={totalProblems}
        basePath={basePath}
        isVoidCodeAIOpen={isVoidCodeAIOpen}
        onToggleVoidCodeAI={() => setIsVoidCodeAIOpen((prev) => !prev)}
      />
      <ResizableLayout
        leftPanel={
          <ProblemTabs
            problem={problem}
            submissions={submissions}
            basePath={basePath}
            extraPanels={extraPanels}
            onLoadSubmission={handleLoadSubmission}
          />
        }
        topMiddle={
          <CodeColumn
            code={code}
            language={language}
            availableLanguages={codeTemplates.map((ct) => ct.language)}
            onCodeChange={setCode}
            onLanguageChange={handleLanguageChange}
            onRun={handleRun}
            onSubmit={handleSubmit}
            onReset={handleReset}
            onExpand={handleExpandToggle}
            isRunning={executionState.status === "running"}
            isSubmitting={submissionState.status === "running"}
            isExpanded={isEditorExpanded}
            saveStatus={saveStatus}
          />
        }
        bottomMiddle={
          <TestConsole
            problemSlug={problemSlug}
            testCases={testCases}
            executionState={executionState}
            submissionState={submissionState}
          />
        }
        rightPanel={
          problem ? (
            <VoidCodeAIPanel
              onClose={() => setIsVoidCodeAIOpen(false)}
              userId={userId}
              isLocked={isTutorLocked}
              context={{
                problem,
                sourceCode: code,
                language,
                executionState,
                submissionState,
                testCases,
                templateCode: codeTemplates.find((ct) => ct.language === language)?.templateCode ?? "",
                onSubmit: handleSubmitForAI,
              }}
            />
          ) : null
        }
        isRightPanelOpen={isVoidCodeAIOpen}
        isEditorExpanded={isEditorExpanded}
      />
    </div>
  );
}
