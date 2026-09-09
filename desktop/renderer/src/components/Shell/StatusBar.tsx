"use client";

import {
  useRuntimeStatus,
  prettyModelName,
  formatVram,
} from "@/lib/shell/useRuntimeStatus";
import { useBuildActions } from "@/lib/shell/build-actions";
import { useRouter } from "next/navigation";
import TelemetryStrip from "./TelemetryStrip";

/**
 * The workbench's status bar.
 *
 * Everything in here is real data the app already had and never showed. The model indicator
 * is the reason to build it: without it, a stopped daemon, an unpulled model and a model
 * that is simply thinking are indistinguishable from the outside, so "the assistant is not
 * responding" has no visible cause.
 *
 * 22px, one hairline above, `bg-ide-bar` — the same surface as every other toolbar. It is
 * the quietest strip on screen and should stay that way: metadata in `ink-3`, nothing
 * clickable that is not obviously a control, no colour except the readiness dot.
 */

export const STATUS_BAR_HEIGHT = 22;

interface StatusBarProps {
  /** Destination-scoped text for the left zone — the open file, or the problem's position. */
  context?: string;
}

export default function StatusBar({ context }: StatusBarProps) {
  const { provider, gpu, ready, loading } = useRuntimeStatus();
  const build = useBuildActions();
  const router = useRouter();

  return (
    <footer
      style={{ height: STATUS_BAR_HEIGHT }}
      className="flex shrink-0 items-center gap-4 border-t border-line bg-ide-bar px-3 text-[11px] text-ink-3"
    >
      {context !== undefined && <span className="truncate">{context}</span>}

      <div className="ml-auto flex items-center gap-4">
        <TelemetryStrip />

        {gpu !== undefined && (
          // The local-first premise, made visible. Costs nothing and is the kind of detail
          // that tells a developer this app knows what machine it is on.
          //
          // A button now rather than a span. The bar's rule is "nothing clickable that is not
          // obviously a control", and the honest reading is that a hardware summary in an app
          // with a hardware page *is* a control — it was already the thing people pointed at
          // when asking where the model settings were.
          <button
            type="button"
            onClick={() => router.push("/models")}
            title={`${gpu.name}, ${formatVram(gpu.vramTotalMB)} VRAM — open the model manager`}
            className="hidden truncate rounded px-1 transition-colors hover:bg-ide-raised hover:text-ink-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink sm:inline"
          >
            {gpu.name} · {formatVram(gpu.vramTotalMB)}
          </button>
        )}


        {/*
          The active model, and the way to change it.
          
          Until now this was the only place the running model was named and there was nowhere
          to go from it — "No model backend" told you what was wrong and left you to find the
          fix. It routes to the manager, which is where both the explanation and the download
          live.
        */}
        <button
          type="button"
          onClick={() => router.push("/models")}
          title={`${modelTitle({ provider, ready, loading })} — open the model manager`}
          className="flex items-center gap-1.5 rounded px-1 transition-colors hover:bg-ide-raised hover:text-ink-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
        >
          <Dot state={loading ? "loading" : ready ? "ready" : "down"} />
          <span className="truncate">{modelLabel({ provider, ready, loading })}</span>
        </button>
      </div>
    </footer>
  );
}

type Status = Pick<ReturnType<typeof useRuntimeStatus>, "provider" | "ready" | "loading">;

/**
 * Three states, and the distinction between the last two is the whole point: a reachable
 * daemon with nothing installed is a different problem from no daemon at all, and they need
 * different fixes.
 */
function modelLabel({ provider, ready, loading }: Status): string {
  if (loading) return "Checking…";
  if (provider === undefined) return "No model backend";
  if (!ready) return `${provider.label} · no models`;
  return prettyModelName(provider.models[0] ?? "");
}

function modelTitle({ provider, ready, loading }: Status): string {
  if (loading) return "Looking for a local model backend";
  if (provider === undefined) {
    // "in Settings" was wrong: the key panel is on the model manager, which is also where this
    // button already goes. Naming ollama.com closes the gap for a reader who does not have Ollama.
    return "No backend reachable. Start Ollama — a free download from ollama.com — or add an OpenRouter key in the model manager.";
  }
  if (!ready) return `${provider.label} is running but has no models installed.`;
  return `${provider.label} · ${provider.models.length} model${
    provider.models.length === 1 ? "" : "s"
  } installed`;
}

/**
 * Colour is not the only carrier — the adjacent label always says the same thing in words,
 * so the dot is reinforcement rather than the message. That is why it is safe to be the one
 * coloured pixel in the bar.
 *
 * `status-*`, not `verdict-*`. Those are documented as having exactly one consumer, with any
 * other file matching them called a regression, and borrowing them here would be the first
 * crack in the rule that keeps this palette monochrome.
 */
function Dot({ state }: { state: "ready" | "down" | "loading" }) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 rounded-full ${
        state === "ready"
          ? "bg-status-up"
          : state === "down"
            ? "bg-status-down"
            : "bg-ink-3"
      }`}
    />
  );
}
