"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Surface } from "@/components/app";
import { Pill } from "@/components/ui/Pill";
import { fetchPaper, type PaperDetail } from "@/lib/api/papers";
import PaperWorkspace from "./PaperWorkspace";

/** Data shell for `/research/[slug]`. */
type State =
  | { status: "loading" }
  | { status: "ready"; data: PaperDetail }
  | { status: "missing" }
  | { status: "failed" };

export default function PaperReaderClient({ slug }: { slug: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const userId = (session?.user as { backendId?: string } | undefined)
    ?.backendId;
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (sessionStatus === "loading") return;
    let cancelled = false;

    fetchPaper(slug, userId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        console.error("Failed to load paper:", err);
        if (cancelled) return;
        const missing = err instanceof Error && err.message.includes("404");
        setState({ status: missing ? "missing" : "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [slug, userId, sessionStatus]);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="flex h-[calc(100vh-3.5rem)] animate-pulse gap-0 motion-reduce:animate-none"
      >
        <span className="sr-only">Loading paper…</span>
        <div className="flex-1 border-r border-line bg-void-2" />
        <div className="flex-1 bg-void-0" />
      </div>
    );
  }

  if (state.status !== "ready") {
    const missing = state.status === "missing";
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <Surface radius="panel" className="p-8 text-center">
          <h2 className="text-lg font-medium text-ink">
            {missing ? "That paper isn't in the library" : "We couldn't load it"}
          </h2>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            {missing
              ? "The link may be out of date. The full library is on the research page."
              : "The API didn't respond. If you're running this locally, check that the API server is up on port 8000."}
          </p>
          <Pill
            href={missing ? "/research" : undefined}
            variant="outline"
            size="md"
            className="mt-6"
            onClick={missing ? undefined : () => window.location.reload()}
          >
            {missing ? "Browse the library" : "Try again"}
          </Pill>
        </Surface>
      </div>
    );
  }

  /* Keyed on slug so read-state and the active tab reset on navigation. */
  return <PaperWorkspace key={slug} paper={state.data} userId={userId} />;
}
