"use client";

import { AppBackdrop, Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";

import { useState, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import TopNavigation from "./TopNavigation";
import ResizableLayout from "./ResizableLayout";
import ProblemTabs, { type ExtraPanel } from "@/components/ProblemPanel/ProblemTabs";
import CodeColumn from "@/components/Editor/CodeColumn";
import TestConsole from "@/components/Editor/TestConsole";
import VoidCodeAIPanel from "@/components/VoidCodeAI/VoidCodeAIPanel";
import type { Problem, TestCase, Submission } from "@/lib/mock-data";
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
} from "@/lib/api/judge0";
import {
  fetchProblem,
  buildExecutableCode,
  testCaseToStdin,
  type APICodeTemplate,
  type ProblemDetail,
} from "@/lib/api/problems";
import { useUserProfile } from "@/lib/context/UserProfileContext";

interface WorkspaceClientProps {
  problemSlug: string;
  /** `null` for a problem outside the curriculum sequence — see lib/curriculum.ts. */
  currentProblem: number | null;
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
  // Use useSession directly so we can check status (loading / authenticated /
  // unauthenticated) and avoid fetching drafts with the wrong (anonymous) userId.
  const { data: session, status: sessionStatus } = useSession();
  const userId = (session?.user as { backendId?: string } | undefined)
    ?.backendId;
  const { profile } = useUserProfile();
  const [isVoidCodeAIOpen, setIsVoidCodeAIOpen] = useState(true);

  // Problem data from API
  const [problem, setProblem] = useState<Problem | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [codeTemplates, setCodeTemplates] = useState<APICodeTemplate[]>([]);
  const [isLoadingProblem, setIsLoadingProblem] = useState(true);
  /**
   * Why the problem could not be loaded, or null.
   *
   * This did not exist: the catch logged to the console and fell through to
   * `finally`, so the component rendered the FULL IDE with `problem === null` —
   * "No problem loaded" in the tabs, an empty editor, no test cases, no tutor
   * panel. A working-looking workspace with nothing in it and no explanation.
   *
   * `missing` and `failed` are separated because they need different actions: a
   * dead link should send you to the catalogue, an unreachable API should offer a
   * retry. Collapsing them means one of the two buttons is always wrong.
   */
  const [loadError, setLoadError] = useState<"missing" | "failed" | null>(null);

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
  // Wait for next-auth session to resolve before fetching so we send the
  // correct X-User-Id header. Re-runs if the slug changes OR the session
  // finishes loading (so the draft is loaded with the real userId, not the
  // anonymous fallback).

  useEffect(() => {
    // Don't run while next-auth is still resolving — we'd load the draft as
    // the anonymous user and then immediately discard the result once the
    // real userId arrives.
    if (sessionStatus === "loading") return;

    let cancelled = false;

    async function loadProblem() {
      setIsLoadingProblem(true);
      setLoadError(null);
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
        if (!cancelled) {
          // Same 404-vs-everything-else split QuestionRouter already uses.
          const missing = err instanceof Error && err.message.includes("404");
          setLoadError(missing ? "missing" : "failed");
        }
      } finally {
        if (!cancelled) setIsLoadingProblem(false);
      }
    }

    loadProblem();
    return () => {
      cancelled = true;
    };
  }, [problemSlug, sessionStatus, userId, loadQuestion]);

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

    setExecutionState({ status: "running" });

    try {
      const executableCode = buildExecutableCode(code, getDriverCode());
      const stdin = testCaseToStdin(testCases[0]);

      const result = await executeCode({
        sourceCode: executableCode,
        languageId: langConfig.judge0Id,
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
  }, [code, language, testCases, getDriverCode, userId]);

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
        languageId: langConfig.judge0Id,
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

  if (isLoadingProblem) {
    return (
      <div className="relative isolate flex h-screen flex-col overflow-hidden bg-ide-gutter">
        <AppBackdrop tone="workspace" />
        <TopNavigation
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

  // ── Failure state ─────────────────────────────────────────────
  //
  // Rendered INSTEAD of the IDE. Without this the component fell straight through
  // to the workspace with `problem === null`, so a failed load looked like a
  // working editor that had lost its question. This is the same fix
  // `HomepageClient` already had, applied to the page it matters most on.
  if (loadError || !problem) {
    const missing = loadError === "missing";
    return (
      <div className="relative isolate flex h-screen flex-col overflow-hidden bg-ide-gutter">
        <AppBackdrop tone="workspace" />
        <TopNavigation
          currentProblem={currentProblem}
          totalProblems={totalProblems}
          isVoidCodeAIOpen={isVoidCodeAIOpen}
          onToggleVoidCodeAI={() => setIsVoidCodeAIOpen((prev) => !prev)}
        />
        <div className="flex flex-1 items-center justify-center px-6">
          <Surface radius="panel" className="max-w-lg p-8 text-center">
            <h2 className="text-lg font-medium text-ink">
              {missing ? "That problem doesn't exist" : "We couldn't load this problem"}
            </h2>
            <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
              {missing
                ? "The link may be out of date, or the problem may have been renamed. The full catalogue is on the problems page."
                : "The API didn't respond. If you're running this locally, check that the API server is up."}
            </p>
            <Pill
              href={missing ? "/problems" : undefined}
              variant="outline"
              size="md"
              className="mt-6"
              onClick={missing ? undefined : () => window.location.reload()}
            >
              {missing ? "Browse all problems" : "Try again"}
            </Pill>
          </Surface>
        </div>
      </div>
    );
  }

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-ide-gutter">
      <AppBackdrop tone="workspace" />
      <TopNavigation
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
