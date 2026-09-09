"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Is there a model to talk to, and what is this machine?
 *
 * Both questions are answerable today and neither is asked anywhere in the UI. The
 * consequence is that "the assistant is not responding" has no visible cause — the daemon
 * being stopped, the model not being pulled, and the model simply thinking all look
 * identical from the outside.
 *
 * Fetched once on mount and re-fetched on demand. Deliberately not polled: a timer that
 * probes a local daemon every few seconds costs more than it tells you, and the moments that
 * matter (a chat failing, a completion erroring) can ask for a refresh directly.
 */

export interface RuntimeStatus {
  /** `undefined` while the first probe is in flight — distinct from "nothing is running". */
  provider?: { id: string; label: string; models: string[] };
  /** Present only when the machine has a discrete GPU worth naming. */
  gpu?: { name: string; vramTotalMB: number };
  ready: boolean;
  loading: boolean;
}

export function useRuntimeStatus(): RuntimeStatus & { refresh: () => void } {
  const [status, setStatus] = useState<RuntimeStatus>({ ready: false, loading: true });

  const refresh = useCallback(() => {
    const host = window.host;
    if (host === undefined) {
      setStatus({ ready: false, loading: false });
      return;
    }

    setStatus((prev) => ({ ...prev, loading: true }));

    void Promise.allSettled([host.providers.list(), host.hw.scan()]).then(
      ([providersResult, hardwareResult]) => {
        // `local` first: the sort in `availableProviders` already puts non-remote backends
        // ahead of remote ones, so the first entry is the one actually running on this
        // machine when there is one.
        const provider =
          providersResult.status === "fulfilled"
            ? providersResult.value.providers[0]
            : undefined;

        // Largest VRAM, not the first: a machine with an integrated adapter alongside a
        // discrete card lists both, and the integrated one is never the interesting answer.
        const gpu =
          hardwareResult.status === "fulfilled"
            ? [...hardwareResult.value.gpus].sort(
                (a, b) => b.vramTotalMB - a.vramTotalMB
              )[0]
            : undefined;

        setStatus({
          ...(provider !== undefined ? { provider } : {}),
          ...(gpu !== undefined ? { gpu: { name: gpu.name, vramTotalMB: gpu.vramTotalMB } } : {}),
          // Reachable is not enough — a running daemon with nothing pulled cannot answer.
          ready: provider !== undefined && provider.models.length > 0,
          loading: false,
        });
      }
    );
  }, []);

  useEffect(refresh, [refresh]);

  return { ...status, refresh };
}

/**
 * `qwen2.5-coder:7b` → `Qwen2.5-Coder 7B`.
 *
 * Tags are lowercase and colon-separated, which is correct for an API and looks like debug
 * output in a status bar. Only cosmetic — nothing keys off the result.
 */
export function prettyModelName(id: string): string {
  const [name, tag] = id.split(":");
  if (name === undefined) return id;

  const words = name
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("-");

  return tag === undefined ? words : `${words} ${tag.toUpperCase()}`;
}

/** `15905` → `15.5 GB`. Binary, because that is how every GPU vendor reports VRAM. */
export function formatVram(megabytes: number): string {
  return `${(megabytes / 1024).toFixed(1)} GB`;
}
