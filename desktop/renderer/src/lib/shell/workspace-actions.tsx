"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Run and Submit, offered to the shell.
 *
 * These lived as private `useCallback`s inside `WorkspaceClient`, so the Run menu emitted
 * `run.execute` and `run.submit` into nothing while a working Run button sat six inches away
 * — and `CodeColumn`'s tooltips advertised Ctrl+Enter, which had never done anything.
 *
 * One publisher covers two routes. `InterviewWorkspaceClient` is a thin wrapper around the
 * same `WorkspaceClient` — its own docstring says the editor, console and submit pipeline are
 * "`WorkspaceClient` doing exactly what it does for Problems" — so `/problems/[id]` and
 * `/interviews/[slug]` both get this from a single edit.
 *
 * Follows `open-files.tsx` and `editor-host.tsx`: the workspace keeps its state and offers
 * actions, rather than the shell reaching in.
 */

export interface WorkspaceActions {
  run: () => void;
  submit: () => void;
  reset: () => void;
  /**
   * Stop the run in flight.
   *
   * Enabled by `busy` — the inverse of every other command here, and the reason Stop is
   * worth having: it is the one thing that should be reachable precisely when the others
   * are not.
   */
  stop: () => void;
  /** A run or submit is in flight. Both commands go dead rather than queueing a second. */
  busy: boolean;
  /** There is a language mapping and at least one visible test case to run against. */
  canRun: boolean;
  /** A problem is loaded, so there is something to submit against. */
  canSubmit: boolean;
}

interface WorkspaceActionsStore {
  actions: WorkspaceActions | undefined;
  publish: (actions: WorkspaceActions | undefined) => void;
}

const WorkspaceActionsContext = createContext<WorkspaceActionsStore>({
  actions: undefined,
  publish: () => {},
});

export function WorkspaceActionsProvider({ children }: { children: React.ReactNode }) {
  const [actions, setActions] = useState<WorkspaceActions | undefined>(undefined);

  const publish = useCallback((next: WorkspaceActions | undefined) => {
    // Field-compared before storing. The workspace publishes from an effect whose dependency
    // is a memo over changing state, so storing every object would loop the provider — the
    // same trap `open-files.tsx` documents.
    setActions((prev) => {
      if (prev === next) return prev;
      if (prev === undefined || next === undefined) return next;
      const same =
        prev.run === next.run &&
        prev.submit === next.submit &&
        prev.reset === next.reset &&
        prev.stop === next.stop &&
        prev.busy === next.busy &&
        prev.canRun === next.canRun &&
        prev.canSubmit === next.canSubmit;
      return same ? prev : next;
    });
  }, []);

  const store = useMemo<WorkspaceActionsStore>(() => ({ actions, publish }), [actions, publish]);

  return (
    <WorkspaceActionsContext.Provider value={store}>{children}</WorkspaceActionsContext.Provider>
  );
}

/** For the shell — the Run menu reads this. */
export function useWorkspaceActions(): WorkspaceActions | undefined {
  return useContext(WorkspaceActionsContext).actions;
}

/** For the workspace — publish from an effect, and `undefined` on unmount. */
export function usePublishWorkspaceActions(): (actions: WorkspaceActions | undefined) => void {
  return useContext(WorkspaceActionsContext).publish;
}
