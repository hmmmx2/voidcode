"use client";

import { LOCAL_LOAD_FAILURE } from "@/lib/copy";
import { useUserId } from "@/lib/hooks/useUserId";

import { useEffect, useState } from "react";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import {
  fetchInterviewQuestion,
  type InterviewQuestionDetail,
} from "@/lib/api/interviews";
import InterviewWorkspaceClient from "./InterviewWorkspaceClient";
import WrittenWorkspace from "./WrittenWorkspace";

/**
 * Picks the experience for a question, then renders it.
 *
 * A question with an executable form opens the IDE — same editor, console and
 * submit pipeline as the Problem page. Everything else opens the two-column
 * written workspace, where the tutor marks a prose answer.
 *
 * The decision is made here rather than in the route because it needs
 * `hasWorkspace`, which only the API knows. That costs one small request
 * before the heavy component mounts — worth it, because guessing wrong means
 * loading Monaco for a question that has no code to edit.
 */

type State =
  | { status: "loading" }
  | { status: "ready"; data: InterviewQuestionDetail }
  | { status: "missing" }
  | { status: "failed" };

export default function QuestionRouter({ slug }: { slug: string }) {
  const userId = useUserId();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    // The web build waited here for NextAuth to resolve, so a request was never sent
    // with a missing X-User-Id. There is no session to wait for now — `useUserId`
    // returns synchronously — so the gate is gone rather than always-true.
    let cancelled = false;

    fetchInterviewQuestion(slug, userId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        console.error("Failed to load question:", err);
        if (cancelled) return;
        const missing = err instanceof Error && err.message.includes("404");
        setState({ status: missing ? "missing" : "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [slug, userId]);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="page-workspace px-6 py-8 lg:px-10"
      >
        <span className="sr-only">Loading question…</span>
        <div className="grid animate-pulse gap-6 motion-reduce:animate-none lg:grid-cols-2">
          <div className="h-[520px] rounded-panel border border-line bg-void-2" />
          <div className="h-[520px] rounded-panel border border-line bg-void-2" />
        </div>
      </div>
    );
  }

  if (state.status !== "ready") {
    const missing = state.status === "missing";
    return (
      <div className="page-content px-6 py-16">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            {missing ? "That question doesn't exist" : "We couldn't load it"}
          </h2>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            {missing
              ? "The link may be out of date. The full bank is on the questions page."
              : LOCAL_LOAD_FAILURE}
          </p>
          <Pill
            href={missing ? "/interviews" : undefined}
            variant="outline"
            size="md"
            className="mt-6"
            onClick={missing ? undefined : () => window.location.reload()}
          >
            {missing ? "Browse all questions" : "Try again"}
          </Pill>
        </Surface>
      </div>
    );
  }

  /* Keyed on slug so nothing carries between questions — revealed answers,
     typed drafts, assessment feedback. A key, not an effect: this is identity
     changing, not state needing synchronisation. */
  return state.data.hasWorkspace ? (
    <InterviewWorkspaceClient key={slug} slug={slug} />
  ) : (
    <WrittenWorkspace key={slug} question={state.data} userId={userId} />
  );
}
