"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/lib/mock-data";
import type { ConsoleState } from "./DemoConsole";
import { DEMO_STARTER_CODE, gradeBuffer } from "./demo-content";
import {
  DEMO_BEATS,
  DEMO_FALLBACK,
  matchBeat,
  type DemoStep,
  type TutorMode,
} from "./demo-script";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Roughly 25 repaints per second, whatever the requested characters-per-second. */
const TICK_MS = 40;

/**
 * Interprets a beat's steps against React state.
 *
 * Cancellation is a monotonically increasing token rather than an AbortSignal.
 * Every `await` is followed by a liveness check, so a new beat starting mid-
 * stream — a visitor clicking a second chip while the first is still typing —
 * abandons the old run at its next tick instead of interleaving two streams into
 * the same message. Unmount bumps the same token.
 */
export function useDemoRunner() {
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [mode, setMode] = useState<TutorMode | null>(null);
  const [code, setCode] = useState(DEMO_STARTER_CODE);
  const [consoleState, setConsoleState] = useState<ConsoleState>({ phase: "idle" });
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usedBeatIds, setUsedBeatIds] = useState<string[]>([]);
  const [hasInteracted, setHasInteracted] = useState(false);

  const tokenRef = useRef(0);
  const idRef = useRef(0);
  // The runner grades whatever is in the buffer *now*, including edits the
  // visitor made after the script started, so it cannot read stale state.
  const codeRef = useRef(code);
  codeRef.current = code;

  useEffect(() => () => void (tokenRef.current += 1), []);

  const nextId = () => `demo-${(idRef.current += 1)}`;

  const play = useCallback(async (steps: DemoStep[], token: number) => {
    const alive = () => token === tokenRef.current;
    let pendingId: string | null = null;

    for (const step of steps) {
      if (!alive()) return;

      switch (step.kind) {
        case "mode": {
          setMode(step.mode);
          await wait(220);
          break;
        }

        case "pause": {
          await wait(step.ms);
          break;
        }

        case "think": {
          const id = nextId();
          pendingId = id;
          setStreamingId(id);
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: "assistant",
              content: "",
              thinking: step.text,
              tokenCount: step.tokens,
            },
          ]);
          await wait(step.ms);
          break;
        }

        case "say": {
          const id = pendingId ?? nextId();
          if (!pendingId) {
            setStreamingId(id);
            setMessages((prev) => [...prev, { id, role: "assistant", content: "" }]);
          }
          pendingId = null;

          const perTick = Math.max(1, Math.round(((step.cps ?? 60) * TICK_MS) / 1000));
          for (let i = perTick; i < step.text.length; i += perTick) {
            if (!alive()) return;
            const slice = step.text.slice(0, i);
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, content: slice } : m))
            );
            await wait(TICK_MS);
          }
          if (!alive()) return;
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, content: step.text } : m))
          );
          setStreamingId(null);
          break;
        }

        case "editor": {
          setCode((prev) => {
            const at = prev.indexOf(step.anchor);
            // The visitor may have edited or deleted the anchor line. Appending
            // is a poor placement but a better outcome than dropping the hint.
            if (at === -1) return `${prev.replace(/\n+$/, "")}\n\n${step.text}\n`;
            const end = at + step.anchor.length;
            return `${prev.slice(0, end)}\n${step.text}${prev.slice(end)}`;
          });
          await wait(400);
          break;
        }

        case "tests": {
          setConsoleState({ phase: "running" });
          await wait(step.ms);
          if (!alive()) return;
          setConsoleState({ phase: "done", ...gradeBuffer(codeRef.current) });
          break;
        }
      }
    }
  }, []);

  const send = useCallback(
    async (text: string, options?: { fromAutoplay?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!options?.fromAutoplay) setHasInteracted(true);

      const token = (tokenRef.current += 1);
      setBusy(true);
      setStreamingId(null);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: trimmed },
      ]);

      const beat = matchBeat(trimmed);
      if (beat) setUsedBeatIds((prev) => (prev.includes(beat.id) ? prev : [...prev, beat.id]));

      await wait(320);
      await play(beat ? beat.steps : DEMO_FALLBACK, token);

      if (token === tokenRef.current) {
        setBusy(false);
        setStreamingId(null);
      }
    },
    [play]
  );

  /** The Run button. Nothing executes — see `gradeBuffer`. */
  const run = useCallback(async () => {
    setHasInteracted(true);
    const token = (tokenRef.current += 1);
    setConsoleState({ phase: "running" });
    await wait(700);
    if (token !== tokenRef.current) return;
    setConsoleState({ phase: "done", ...gradeBuffer(codeRef.current) });
  }, []);

  const replay = useCallback(() => {
    tokenRef.current += 1;
    setMessages([]);
    setMode(null);
    setCode(DEMO_STARTER_CODE);
    setConsoleState({ phase: "idle" });
    setStreamingId(null);
    setBusy(false);
    setUsedBeatIds([]);
    setHasInteracted(false);
  }, []);

  /** Chips already played drop off, so the visitor is always offered a next step. */
  const chips = DEMO_BEATS.filter((beat) => !usedBeatIds.includes(beat.id)).map(
    (beat) => beat.chip
  );

  return {
    messages,
    mode,
    code,
    setCode,
    consoleState,
    streamingId,
    busy,
    chips,
    hasInteracted,
    hasPlayed: usedBeatIds.length > 0,
    send,
    run,
    replay,
  };
}
