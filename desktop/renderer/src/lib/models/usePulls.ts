"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyFrame,
  beginPull,
  completePull,
  dismissPull,
  failPull,
  type Pulls,
} from "@/lib/models/pull-progress";

export type { Pull, PullPhase, Pulls } from "@/lib/models/pull-progress";

/**
 * Downloads in flight, keyed by model id.
 *
 * `models:pull` resolves when the pull finishes, which for a nine-gigabyte model is several
 * minutes after the click. The progress arrives separately on `onModelPullProgress`, so this
 * hook is what joins the two back together: start a pull, watch the frames, and know when it is
 * done.
 *
 * Every decision about what a frame *means* lives in `pull-progress.ts` — including the rule
 * that completion is an explicit `success` frame and not a fraction reaching 1. This file holds
 * the state and the subscription and nothing else, which is what makes that rule testable
 * without a window.
 */
export function usePulls(): {
  pulls: Pulls;
  start: (id: string) => void;
  dismiss: (id: string) => void;
} {
  const [pulls, setPulls] = useState<Pulls>(new Map());

  /**
   * Which ids this hook started, so a frame for something else is ignored.
   *
   * A second Model Manager window would be started by the same user pulling the same model, and
   * a progress bar for a download this page did not begin is confusing rather than helpful.
   */
  const mine = useRef<Set<string>>(new Set());

  useEffect(() => {
    const host = typeof window === "undefined" ? undefined : window.host;
    return host?.onModelPullProgress?.((raw) => {
      setPulls((prev) => applyFrame(prev, raw, mine.current));
    });
  }, []);

  const start = useCallback((id: string) => {
    const host = typeof window === "undefined" ? undefined : window.host;
    if (host?.models?.pull === undefined) return;

    mine.current.add(id);
    setPulls((prev) => beginPull(prev, id));

    void host.models
      .pull({ id })
      .then(() => setPulls((prev) => completePull(prev, id)))
      .catch((err: unknown) => setPulls((prev) => failPull(prev, id, err)));
  }, []);

  const dismiss = useCallback((id: string) => {
    mine.current.delete(id);
    setPulls((prev) => dismissPull(prev, id));
  }, []);

  return { pulls, start, dismiss };
}
