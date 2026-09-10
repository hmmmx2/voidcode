"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/components/markdown/Markdown";
import {
  DEFAULT_MODE,
  MODE_HELP,
  MODE_LABELS,
  SELECTABLE_MODES,
  type SelectableMode,
} from "@shared/agent-modes";
import { useRouter } from "next/navigation";
import { IconChat, IconHistory, IconModel, IconPlus } from "@/components/icons";
import {
  selectViewSafely,
  type AssistantView,
} from "@/lib/build/assistant-view";
import SessionList, { type SessionRow } from "./SessionList";
import DiffView from "./DiffView";
import PlanCard from "./PlanCard";
import { runViewOf, type RunView } from "@/lib/build/run-view";
import { IdePanel, IdeBar, EmptyState, useToast } from "@/components/app";
import { describeStep } from "@/lib/build/output";
import SlashAutocomplete from "./SlashAutocomplete";
import QuickOpen from "./QuickOpen";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { complete, parseSlash, resolve, suggest, type SlashCommand } from "@/lib/build/slash";
import {
  candidatesFor,
  decodeRefDrag,
  DEFAULT_REF_LIMITS,
  droppedTextName,
  expandRefs,
  REF_MIME,
  rejectionForDrop,
  type ContextRef,
  type RefTree,
} from "@/lib/build/context-refs";
import {
  streamAgent,
  type AgentContentBlock,
  type AgentStepPayload,
} from "@/lib/build/agent-stream";
import {
  toAttachment,
  imageFilesFrom,
  MAX_ATTACHMENTS,
  type Attachment,
} from "@/lib/attachments";

/**
 * The assistant. One surface, not two.
 *
 * This was a Chat tab and an Agent tab, and each had half of what a person actually wants:
 * chat streamed prose and could not call a tool, the agent called tools and produced no text
 * until the whole run had finished. A user had to decide, before typing, which kind of question
 * they were about to ask — and getting that wrong meant retyping it in the other tab.
 *
 * There is no such choice here, for the same reason there is none in any tool of this kind:
 * whether a question needs the filesystem is something the model works out, not something the
 * person asking should have to declare. "What does this function do?" simply produces no tool
 * calls. "Rename it everywhere" produces several.
 *
 * Three things the layout is built around:
 *
 *   **Prose and tool activity share one ordered stream.** A turn that says "let me look at
 *   that", reads the file, and then explains what it found renders as those three things in
 *   sequence — not as a block of text with a list of tools beside it. That is what
 *   `agent:open` carries and why it is a port rather than an `invoke`.
 *
 *   **Diffs are read here and authorised elsewhere.** Every proposal renders in full, and none
 *   has an Apply button: `fs.commitDiff` refuses agent-origin diffs by design, so a per-file
 *   Apply would be a control that fails every time. One button applies the batch, and what it
 *   opens is a native dialog naming every file.
 *
 *   **Stop is the port closing.** No second channel, no run id — main ties the model's
 *   `AbortSignal` to the port's lifetime.
 */

type ProviderId = "ollama" | "llamacpp" | "openrouter" | "hosted";

interface ProviderOption {
  id: ProviderId;
  label: string;
  models: string[];
  /** False for the local default when it is not running — shown, never silently dropped. */
  available?: boolean;
}

/**
 * One piece of an assistant turn.
 *
 * A turn is a *list* of these rather than a string plus metadata, because the ordering carries
 * meaning: text written before a tool ran is reasoning about what to do, and text after it is
 * a conclusion drawn from the result. Flattening them loses which is which.
 */
type Block =
  | { kind: "text"; text: string }
  | { kind: "step"; step: AgentStepPayload };

type Turn =
  | { role: "user"; text: string; imageCount: number }
  | { role: "assistant"; blocks: Block[] };

interface ApplyOutcome {
  path: string;
  ok: boolean;
  reason: string | null;
}

interface RunSummary {
  id: string;
  question: string;
  finishReason: string | null;
  createdAt: string;
  stepCount: number;
}

interface AssistantPanelProps {
  host: NonNullable<Window["host"]>;
  model: string;
  /** Contents of the open file, sent as context so the model is not guessing. */
  openFile: { path: string; contents: string } | undefined;
  /** Open a result in the focused editor group and put the cursor on the line. */
  onOpenLocation?: (path: string, line: number) => void;
  /** Close the pane. Same state the View menu and Cmd+Alt+B toggle — two doors, one flag. */
  onClose?: () => void;
  /** One line per agent step, for Output's Agent channel. Optional: the panel works without it. */
  onAgentLog?: (text: string) => void;
  /**
   * The current run, for the right pane.
   *
   * Derived from the transcript rather than tracked beside it — see `run-view.ts`. Reported
   * rather than lifted because the transcript is genuinely this component's state: the pane is
   * a second view of it, and a second owner would be a second thing to keep in step.
   */
  onRunView?: (view: RunView<AgentStepPayload>) => void;
}

/** How a step is labelled. Tools name themselves; the rest say what they are. */
function labelFor(step: AgentStepPayload): string {
  if (step.kind === "tool") return step.toolName ?? "tool";
  if (step.kind === "proposal") return "proposed edit";
  if (step.kind === "error") return "problem";
  return "";
}

export default function AssistantPanel({
  host,
  model,
  openFile,
  onOpenLocation,
  onClose,
  onAgentLog,
  onRunView,
}: AssistantPanelProps) {
  const notify = useToast();
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<ApplyOutcome[]>([]);
  const [finished, setFinished] = useState<string | null>(null);
  /**
   * What actually answered, once a turn has run.
   *
   * Main resolves the model — a preference that cannot call tools is not honoured — so the
   * header would otherwise show a name that had nothing to do with the reply.
   */
  const [answeredBy, setAnsweredBy] = useState<string | undefined>(undefined);
  /**
   * The conversation these turns belong to.
   *
   * Created lazily on the first send, the same pattern the tutor uses -- an empty session row
   * for every time someone opened the panel and typed nothing would be history nobody made.
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  /**
   * One view at a time.
   *
   * Was two booleans, either of which could be true — so both drawers could stack above the
   * transcript at `max-h-48` each and leave the conversation in a slot. `selectViewSafely`
   * keeps `history` unreachable without an agent, matching the button's own guard.
   */
  const [view, setView] = useState<AssistantView>("chat");
  const showSessions = view === "sessions";
  const [history, setHistory] = useState<RunSummary[]>([]);
  const showHistory = view === "history";
  const [viewingPast, setViewingPast] = useState(false);
  const [locations, setLocations] = useState<
    Record<string, { status: "running" } | { status: "failed"; message: string } | {
      status: "done";
      candidates: Array<{ path: string; line: number; symbol: string | null; why: string; confidence: string }>;
      searched: string[];
    }>
  >({});

  /**
   * Local by default and always — the cloud is something the user picks, not something they
   * land on. Main prompts natively before any image reaches a remote provider, so this
   * selector is a convenience rather than the control.
   */
  const [providerId, setProviderId] = useState<ProviderId>("ollama");
  /**
   * What the agent may do this turn.
   *
   * The renderer names it and main enforces it: `toolsFor` intersects the mode's tools with
   * the surface's, so choosing one here can only ever take capability away. There is no value
   * this control can hold that grants a tool main would not otherwise allow.
   *
   * Auto is deliberately absent -- `SELECTABLE_MODES` in main does not include it, and the
   * channel's schema is built from that list, so offering it here would produce a rejected
   * turn rather than an unattended one.
   */
  const [agentMode, setAgentMode] = useState<SelectableMode>(DEFAULT_MODE);

  /**
   * Files and folders attached to the next message.
   *
   * References, not contents: what a folder actually expands to is decided at send time by
   * `expandRefs`, because the tree can change between attaching and sending and because reading
   * four hundred files to show a chip would be absurd.
   */
  const [refs, setRefs] = useState<ContextRef[]>([]);
  const [picking, setPicking] = useState<"file" | "folder" | null>(null);
  /**
   * Text dropped from outside the app, held as contents rather than as a reference.
   *
   * An OS drop has no path — Electron 32 removed `File.path` and the replacement is deliberately
   * not in the preload — so these cannot become `ContextRef`s and cannot be re-read at send.
   * They are the bytes that were dropped, named for the file they came from and nothing more.
   */
  const [drops, setDrops] = useState<Array<{ name: string; contents: string }>>([]);
  const [tree, setTree] = useState<RefTree | null>(null);
  /** Which suggestion the arrows are on. The textarea owns this — see `SlashAutocomplete`. */
  const [slashIndex, setSlashIndex] = useState(0);
  /** Whether this window is armed for Auto. Main owns the truth; this mirrors it. */
  const [armed, setArmed] = useState(false);
  /** The last Auto run that wrote something, so its undo can be offered. */
  const [undoable, setUndoable] = useState<{ runId: string; paths: string[] } | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);

  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const attachmentsRef = useRef<Attachment[]>([]);
  /** Prose from the turn in flight, assembled as tokens arrive. Reset at each send. */
  const saidRef = useRef("");
  const transcript = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = (await host.providers?.list()) as { providers?: ProviderOption[] } | undefined;
        setProviders(result?.providers ?? []);
      } catch {
        setProviders([]);
      }
    })();
  }, [host]);

  /**
   * The local default is always offered, marked when it is not running.
   *
   * Dropping it from the list when Ollama is down silently moved the selection to the cloud —
   * the one provider that sends the user's code off the machine — which is not a fallback
   * anyone consented to.
   */
  const providerOptions = useMemo<ProviderOption[]>(() => {
    const seen = [...providers];
    if (!seen.some((p) => p.id === "ollama")) {
      seen.unshift({ id: "ollama", label: "Ollama", models: [], available: false });
    }
    return seen;
  }, [providers]);

  // Follow the tail while it works. Reading a live transcript means watching the newest line.
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [turns]);

  /**
   * Save a turn, without letting a storage problem interrupt the conversation.
   *
   * Persistence is a convenience here, not the product: if the write fails the user still has
   * their answer on screen, and turning a failed INSERT into a thrown error mid-stream would
   * lose the thing they actually wanted. It is reported through `sessionError` rather than
   * swallowed, because the tutor's habit of logging these to a console nobody opens is exactly
   * how its delete button stayed broken for months.
   */
  const persist = useCallback(
    async (id: string, role: "user" | "assistant", content: string) => {
      if (content === "") return;
      try {
        await host.chat.saveMessage({ sessionId: id, role, content });
      } catch (err) {
        setSessionError(
          err instanceof Error ? `Not saved: ${err.message}` : "This turn was not saved."
        );
      }
    },
    [host]
  );

  const refreshSessions = useCallback(
    async (query: string) => {
      setSessionsLoading(true);
      try {
        const result = await host.chat.searchSessions({ query, limit: 30, surface: "assistant" });
        setSessions(
          result.sessions.map((s) => ({
            id: s.id,
            title: s.title,
            messageCount: s.messageCount,
            updatedAt: s.updatedAt,
            snippet: s.snippet,
          }))
        );
        setSessionError(null);
      } catch (err) {
        setSessions([]);
        setSessionError(err instanceof Error ? err.message : "Could not load conversations.");
      } finally {
        setSessionsLoading(false);
      }
    },
    [host]
  );

  /**
   * Open a stored conversation.
   *
   * Prose only. The tool steps of a past turn live in `agent_steps` and are reachable through
   * the run history beside this; a conversation is what was said, which is what someone
   * scrolling back is looking for. Diffs are not restored at all -- they expire in memory
   * after an hour, and offering an Apply button that cannot work is worse than not offering
   * one.
   */
  const openSession = useCallback(
    async (id: string) => {
      try {
        const { session, messages } = await host.chat.getSession({ sessionId: id });
        setSessionId(session.id);
        setTurns(
          messages.map((message) =>
            message.role === "user"
              ? { role: "user" as const, text: message.content, imageCount: 0 }
              : {
                  role: "assistant" as const,
                  blocks: [{ kind: "text" as const, text: message.content }],
                }
          )
        );
        setPendingIds([]);
        setOutcomes([]);
        setFinished(null);
        setViewingPast(false);
        setSessionError(null);
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : "Could not open that conversation.");
      }
    },
    [host]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      // Stop first when the open conversation is the one going, so a live run cannot keep
      // writing into a transcript that has been cleared -- and cannot try to append to a row
      // that no longer exists.
      if (id === sessionId) {
        cancelRef.current?.();
        setStreaming(false);
        setSessionId(null);
        setTurns([]);
      }
      try {
        await host.chat.deleteSession({ sessionId: id });
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setSessionError(null);
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : "Could not delete that conversation.");
      }
    },
    [host, sessionId]
  );

  const newSession = useCallback(() => {
    cancelRef.current?.();
    setStreaming(false);
    setSessionId(null);
    setTurns([]);
    setPendingIds([]);
    setOutcomes([]);
    setFinished(null);
    setViewingPast(false);
    setSessionError(null);
  }, []);

  /** Main is the authority; this only mirrors it, and re-reads after every change. */
  const refreshArmed = useCallback(async () => {
    try {
      const state = await host.agent?.armStatus();
      setArmed(state?.armed === true);
    } catch {
      setArmed(false);
    }
  }, [host]);

  const toggleArmed = useCallback(async () => {
    try {
      if (armed) {
        await host.agent?.disarmAuto();
        setArmed(false);
        return;
      }
      // Opens main's own window. Nothing this component does can arm without it.
      const result = await host.agent?.armAuto();
      setArmed(result?.armed === true);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Could not change Auto mode.");
      await refreshArmed();
    }
  }, [host, armed, refreshArmed]);

  const undoRun = useCallback(
    async (runId: string) => {
      try {
        const result = await host.agent?.revertRun({ runId });
        const restored = (result?.restored.length ?? 0) + (result?.deleted.length ?? 0);
        setUndoable(null);
        setUndoNote(
          result === undefined
            ? "Could not undo that run."
            : // Says what it did and what it could not, rather than a bare "done". A partial
              // undo that reports success is the failure mode worth avoiding here.
              `Undid ${String(restored)} file change(s)` +
              (result.failed.length > 0 ? `, ${String(result.failed.length)} failed` : "") +
              (result.truncated ? ". The record was incomplete, so this may be partial." : ".") +
              " Anything its commands did is not covered."
        );
      } catch (err) {
        setUndoNote(err instanceof Error ? err.message : "Could not undo that run.");
      }
    },
    [host]
  );

  const refreshHistory = useCallback(async () => {
    try {
      const result = await host.agent?.history({ limit: 20 });
      setHistory(result?.runs ?? []);
    } catch {
      // No project open, most likely. An empty list is the right thing to show.
      setHistory([]);
    }
  }, [host]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // Re-read whenever Auto is selected: another window, or a project change, may have altered
  // it since this component last looked.
  useEffect(() => {
    if (agentMode === "auto") void refreshArmed();
  }, [agentMode, refreshArmed]);

  const attach = useCallback(
    async (files: readonly File[]) => {
      for (const file of files) {
        try {
          // Read one at a time and re-check the count each time, so a drop of six images
          // adds four and explains why rather than silently keeping the first four.
          const attachment = await toAttachment(file, attachmentsRef.current.length);
          attachmentsRef.current = [...attachmentsRef.current, attachment];
          setAttachments(attachmentsRef.current);
        } catch (err) {
          notify("Could not attach that image", {
            detail: err instanceof Error ? err.message : String(err),
            tone: "warn",
          });
          return;
        }
      }
    },
    [notify]
  );

  /** Append streamed prose to the open assistant turn, extending its last text block. */
  const appendToken = useCallback((text: string) => {
    // Accumulated beside the state, not derived from it. The saved copy has to be read
    // *outside* a state updater: React may invoke an updater more than once for the same
    // change, and a side effect in there writes the turn to the database twice.
    saidRef.current += text;
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return prev;

      const blocks = [...last.blocks];
      const tail = blocks[blocks.length - 1];
      if (tail?.kind === "text") {
        blocks[blocks.length - 1] = { kind: "text", text: tail.text + text };
      } else {
        // A tool ran since the last prose, so this starts a new paragraph rather than
        // continuing one the tool result now sits inside.
        blocks.push({ kind: "text", text });
      }
      next[next.length - 1] = { role: "assistant", blocks };
      return next;
    });
  }, []);

  /**
   * Steps go to the transcript and to Output's Agent channel.
   *
   * The transcript is the conversation and gets scrolled away or replaced by the next turn;
   * Output is the log you go back to when a run did something you did not expect. Read through a
   * ref so a parent that re-renders on every appended line does not rebuild this callback and
   * re-subscribe the whole stream.
   */
  const agentLogRef = useRef(onAgentLog);
  agentLogRef.current = onAgentLog;

  const appendStep = useCallback((step: AgentStepPayload) => {
    const line = describeStep(step);
    if (line !== null) agentLogRef.current?.(line);
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return prev;
      /**
       * A `thought` step is dropped.
       *
       * It carries the same prose the tokens already delivered — the graph emits it once a
       * turn ends, for the stored transcript. Rendering both would print every sentence twice.
       */
      if (step.kind === "thought") return prev;
      next[next.length - 1] = { role: "assistant", blocks: [...last.blocks, { kind: "step", step }] };
      return next;
    });
  }, []);

  /**
   * The right pane's view of this run, recomputed when the transcript changes.
   *
   * Through a ref for the same reason `onAgentLog` is: the parent re-renders whenever the pane
   * it feeds does, and a callback in the dependency array would rebuild this effect on every
   * one of those renders. `useMemo` over `turns` means the object is stable while the
   * transcript is, so the effect fires when the run actually changes rather than on each token.
   */
  const runViewRef = useRef(onRunView);
  runViewRef.current = onRunView;

  const runView = useMemo(() => runViewOf(turns), [turns]);

  useEffect(() => {
    runViewRef.current?.(runView);
  }, [runView]);

  /** What the composer's text currently offers, if anything. Pure — see `slash.ts`. */
  const suggestions = useMemo(() => suggest(parseSlash(input)), [input]);

  // The list changes under the cursor as the name narrows; leaving the index where it was would
  // run whichever command happened to land there.
  useEffect(() => setSlashIndex(0), [input]);

  /** How many files the current chips name. Cheap: a tree walk, with nothing read. */
  const namedFiles = useMemo(
    () => (tree === null ? 0 : candidatesFor(tree, refs).length),
    [tree, refs]
  );

  /** Fetch the tree lazily — only when a picker actually opens. */
  const openPicker = useCallback(
    async (target: "file" | "folder") => {
      setPicking(target);
      if (tree !== null) return;
      try {
        const result = await host.fs?.tree();
        if (result !== undefined) setTree(result.tree);
      } catch {
        // A picker over an empty list says "Nothing to choose from", which is the honest
        // outcome of a tree we could not read and needs no separate error.
      }
    },
    [host, tree]
  );

  /**
   * Run what a slash command asked for.
   *
   * Every branch is something a click already does. `mode` in particular only moves the select —
   * choosing Auto still needs arming, which is a window main owns and nothing here can perform.
   */
  const runIntent = useCallback(
    (intent: ReturnType<typeof resolve>) => {
      if (intent === null) return false;
      switch (intent.kind) {
        case "pick":
          void openPicker(intent.target);
          break;
        case "clear":
          newSession();
          break;
        case "mode":
          setAgentMode(intent.mode);
          break;
        case "models":
          router.push("/models");
          break;
        case "history":
          setView("history");
          break;
      }
      setInput("");
      return true;
    },
    [newSession, openPicker, router]
  );

  const send = useCallback(async () => {
    // A command is not a message. `resolve` returns null for anything unrecognised, so a typo
    // like `/flie` is sent as literal text rather than silently discarded.
    if (runIntent(resolve(input))) return;

    const question = input.trim();
    // An image with no question is a legitimate turn — "what is wrong here?" is implicit in
    // pasting a screenshot of an error. Dropped text counts the same way.
    if ((question === "" && attachments.length === 0 && drops.length === 0) || streaming) return;

    /**
     * Text dropped from outside, inlined as what it is.
     *
     * Named, not pathed. `File.path` was removed in Electron 32 and `webUtils.getPathForFile` is
     * deliberately not exposed, so all we have is the filename — and writing it where a path goes
     * would tell the model the file exists at that location in this project, which is exactly the
     * sort of small untruth that sends it looking for something that is not there.
     */
    const dropped = drops
      .map((file) => `Dropped file named \`${file.name}\`:\n\n\`\`\`\n${file.contents}\n\`\`\`\n\n`)
      .join("");

    /**
     * Attached files are read now, not when they were attached.
     *
     * A chip is a reference: the tree can change between attaching and sending, and reading four
     * hundred files to draw one chip would be absurd. `expandRefs` applies the budget and reports
     * what it left out — and that report goes above the composer, to the user, rather than into
     * the prompt. The model does not need to be told what it was not given; the person choosing
     * what to attach does.
     */
    let attached = "";
    if (refs.length > 0 && tree !== null && host.fs !== undefined) {
      const fs = host.fs;
      const expansion = await expandRefs(tree, refs, async (path) => {
        const file = await fs.read({ path });
        /**
         * A binary @-mention contributes nothing rather than a block of mojibake.
         *
         * The empty string is deliberate: `expandRefs` still counts the file against the budget
         * and still lists it as included, so the report above the composer names it. Dropping it
         * silently would leave someone wondering why the file they attached had no effect.
         */
        return file.binary ? "" : file.contents;
      });
      attached = expansion.included
        .map((file) => `\`${file.path}\`:\n\n\`\`\`\n${file.contents}\n\`\`\`\n\n`)
        .join("");
    }

    /**
     * The open file is SENT, not described.
     *
     * This used to wrap it in "Currently open file ..." and a fenced block and prepend the lot
     * to the question. Two things were wrong with that. It is prompt text composed in a
     * renderer, which `personas.ts` says never happens. And it decided something this component
     * cannot know — whether the model has a `read_file` to reach for — which turns out to matter
     * a great deal: inlining the contents suppressed tool calling badly enough that the Plan
     * pane was usually empty in practice. `agent/open-file.ts` carries the measurements behind
     * that and makes the call from the mode's own policy table.
     *
     * The @-mentions in `attached` stay inline deliberately. Those are files the user asked for
     * by name, and honouring that literally is the point of the syntax.
     */
    const context = `${dropped}${attached}${question}`;

    const content: string | AgentContentBlock[] =
      attachments.length === 0
        ? context
        : [
            { type: "text" as const, text: context },
            ...attachments.map((a) => ({
              type: "image" as const,
              data: a.data,
              mediaType: a.mediaType,
            })),
          ];

    const sentAttachments = attachments;
    setInput("");
    setRefs([]);
    setDrops([]);
    setAttachments([]);
    attachmentsRef.current = [];
    setPendingIds([]);
    setOutcomes([]);
    setFinished(null);
    setView("chat");

    /**
     * A past run on screen is a record, not a conversation to continue.
     *
     * `openRun` replaces the transcript with one synthetic turn rebuilt from stored steps, and
     * sending used only to flip `viewingPast` off -- so the notice explaining that those
     * proposals had expired disappeared while the expired blocks stayed, and the new turn was
     * appended underneath them. Clearing is the honest behaviour: the run is still in the
     * history list, and the model was never given those turns as context anyway.
     */
    saidRef.current = "";
    const wasViewingPast = viewingPast;
    setViewingPast(false);
    if (wasViewingPast) setTurns([]);

    setTurns((prev) => [
      ...(wasViewingPast ? [] : prev),
      { role: "user", text: question, imageCount: sentAttachments.length },
      { role: "assistant", blocks: [] },
    ]);
    setStreaming(true);

    /**
     * The conversation row, created on the first send rather than on mount.
     *
     * A failure here must not stop the turn. Persistence is a convenience; the answer is the
     * product, and a database problem is not a reason to refuse to ask the model.
     */
    let conversation = sessionId;
    if (conversation === null) {
      try {
        const created = await host.chat.createSession({
          problemId: null,
          // The other half of the pair with the tutor's. Sharing the tables is right; sharing
          // the *list* was not.
          surface: "assistant",
          // The first question, trimmed to something that fits a list. Nothing else knows what
          // the conversation is about at this point, and "Untitled" for every row is what makes
          // the tutor's history unusable today.
          title: question === "" ? "Screenshot" : question.slice(0, 80),
        });
        conversation = created.id;
        setSessionId(created.id);
      } catch (err) {
        setSessionError(
          err instanceof Error ? `Not saved: ${err.message}` : "This conversation is not saved."
        );
      }
    }

    // The question as typed, not `context` -- the @-mentions are padding for the model, and
    // storing them would make a transcript mostly source code the user did not write. The open
    // file is no longer part of `context` at all; main adds it.
    if (conversation !== null) void persist(conversation, "user", question);

    const handle = streamAgent(
      host,
      {
        provider: providerId,
        model,
        content,
        sessionId: conversation,
        mode: agentMode,
        /**
         * The two fields, named — not the object.
         *
         * `openFile` is a `FileBuffer` at runtime and carries `baseline` as well, which the
         * contract's `.strict()` rejects outright. TypeScript does not catch it: a wider object
         * is assignable to `{path, contents}` whenever it is not a fresh literal, so the extra
         * key is invisible here and fatal at the boundary. It failed as "Invalid payload for
         * agent:open" on the first real turn.
         */
        ...(openFile === undefined
          ? {}
          : { openFile: { path: openFile.path, contents: openFile.contents } }),
      },
      { onToken: appendToken, onStep: appendStep }
    );
    cancelRef.current = handle.cancel;

    try {
      const outcome = await handle.completed;
      setPendingIds(outcome.proposedDiffIds);
      setFinished(outcome.finishReason);
      if (outcome.model !== "") setAnsweredBy(outcome.model);

      /**
       * An Auto run that wrote something offers its undo, and only if it can honour it.
       *
       * `revertable` is false when the checkpoint hit its bound, and the offer is withheld
       * rather than qualified — a button that silently restores some of the files is worse
       * than no button, because it reads as a completed undo.
       */
      if (outcome.applied !== undefined && outcome.applied.revertable) {
        setUndoable({ runId: outcome.runId, paths: outcome.applied.paths });
      }
      if (outcome.applied !== undefined && !outcome.applied.revertable) {
        setUndoNote(
          outcome.applied.paths.length === 0
            ? null
            : "Wrote " + String(outcome.applied.paths.length) + " file(s). No undo is available for this run."
        );
      }

      /**
       * Save what the assistant actually said, read back off the rendered turn.
       *
       * The prose is assembled from tokens as they arrive, so there is no complete string
       * until the stream ends -- which is why this is here rather than beside the user's
       * message. Only the `text` blocks: tool output and proposals are already in
       * `agent_steps`, and `chat_messages.role` could not hold them anyway.
       */
      if (conversation !== null) void persist(conversation, "assistant", saidRef.current.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /**
       * A declined upload is not a failure to reach the model.
       *
       * The user cancelled the native prompt on purpose, so the images go back into the
       * composer rather than being lost — cancelling should cost nothing but the click.
       */
      const cancelled = message.includes("Sending images was cancelled");
      if (cancelled) {
        setAttachments(sentAttachments);
        attachmentsRef.current = sentAttachments;
      }
      appendStep({
        kind: "error",
        text: cancelled ? "Cancelled — the images were not sent." : message,
      });
    } finally {
      setStreaming(false);
      cancelRef.current = undefined;
      // Refreshed whether or not it succeeded — a run that failed is recorded too, and it is
      // the one most worth being able to find again.
      void refreshHistory();
    }
  }, [
    input,
    attachments,
    streaming,
    openFile,
    host,
    providerId,
    model,
    appendToken,
    appendStep,
    refreshHistory,
    runIntent,
    refs,
    tree,
    drops,
  ]);

  const applyAll = useCallback(async () => {
    if (pendingIds.length === 0 || applying || host.agent === undefined) return;
    setApplying(true);
    try {
      const result = await host.agent.applyDiffs({ ids: pendingIds });
      if (!result.approved) {
        // Declining is a decision, not a failure. Say so and leave the proposals in place so
        // the user can read them again and change their mind.
        notify("Nothing was applied", { detail: "You declined the change.", tone: "info" });
        return;
      }
      setOutcomes(result.results);
      setPendingIds([]);

      const failed = result.results.filter((r) => !r.ok);
      if (failed.length > 0) {
        notify(`${String(failed.length)} of ${String(result.results.length)} could not be applied`, {
          detail: failed.map((f) => `${f.path}: ${f.reason ?? "unknown"}`).join("; "),
          tone: "warn",
        });
      }
    } catch (err) {
      appendStep({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setApplying(false);
    }
  }, [pendingIds, applying, host, notify, appendStep]);

  /**
   * Find where a screenshot's contents live in the project.
   *
   * Its own action rather than something `send` does silently: it runs several project-wide
   * searches and can prompt for a cloud upload, both of which deserve a deliberate click.
   */
  const locate = useCallback(
    async (attachment: Attachment) => {
      if (host.vision === undefined) return;
      setLocations((prev) => ({ ...prev, [attachment.id]: { status: "running" } }));
      try {
        const result = await host.vision.locate({
          provider: providerId,
          model,
          image: { data: attachment.data, mediaType: attachment.mediaType },
        });
        setLocations((prev) => ({
          ...prev,
          [attachment.id]: {
            status: "done",
            candidates: result.candidates,
            searched: result.searched,
          },
        }));
      } catch (err) {
        setLocations((prev) => ({
          ...prev,
          [attachment.id]: {
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [host, providerId, model]
  );

  /** Open a past run. Its diffs expired, so it renders as a record rather than as a proposal. */
  const openRun = useCallback(
    async (runId: string) => {
      try {
        const result = await host.agent?.steps({ runId });
        setTurns([
          {
            role: "assistant",
            blocks: (result?.steps ?? []).map((s) => ({
              kind: "step" as const,
              step: {
                kind: s.kind,
                text: s.text,
                ...(s.toolName !== null ? { toolName: s.toolName } : {}),
                ...(s.diffId !== null ? { diffId: s.diffId } : {}),
                /*
                  The plan is reattached to the step that wrote it.

                  It lives in its own table, so it comes back beside the steps rather than
                  inside one — and it has to land on the `write_plan` step specifically,
                  because that is where the live path puts it and the renderer branches on
                  `step.plan`. Dropping it here would make a restored run look like a run that
                  never planned, which is the one thing this whole part exists to fix.

                  Only ever one: run_id is the primary key of agent_plans, so a second
                  write_plan replaced the first rather than adding a row.
                */
                ...(s.toolName === "write_plan" && result?.plan != null
                  ? { plan: result.plan }
                  : {}),
                // And the design spec, on the step that wrote it, for the same reasons.
                ...(s.toolName === "write_design_spec" && result?.design != null
                  ? { design: result.design }
                  : {}),
              },
            })),
          },
        ]);
        setPendingIds([]);
        setOutcomes([]);
        setViewingPast(true);
        setView("chat");
      } catch (err) {
        appendStep({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    },
    [host, appendStep]
  );

  return (
    <IdePanel>
      <IdeBar>
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
          AI Assistant
        </span>
        <div className="flex min-w-0 items-center gap-1">
          {/*
            `aria-pressed`, not `aria-expanded`. These select which of three views the panel
            is showing; they no longer expand a region that stays put. A screen reader
            announcing "expanded" for a control that swaps the surface beneath it describes
            the wrong interaction.
          */}
          <ViewButton
            label="Chat"
            active={showSessions}
            icon={<IconChat size={13} />}
            onClick={() => {
              const next = selectViewSafely(view, "sessions", host.agent !== undefined);
              setView(next);
              if (next === "sessions") void refreshSessions("");
            }}
          />
          {host.agent !== undefined && (
            <ViewButton
              label="History"
              active={showHistory}
              icon={<IconHistory size={13} />}
              onClick={() => {
                const next = selectViewSafely(view, "history", true);
                setView(next);
                if (next === "history") void refreshHistory();
              }}
            />
          )}
          {/*
            The model, as a way to the model manager rather than a third drawer.
            
            A 300px panel cannot hold a model directory, and a third view would make this the
            fourth place model state lives. The `title` stays: when main substitutes a
            tool-capable model for one that cannot call tools, that sentence is the only
            explanation the user gets.
          */}
          <button
            type="button"
            onClick={() => router.push("/models")}
            title={
              answeredBy !== undefined && answeredBy !== model
                ? `${model} cannot call tools, so ${answeredBy} answered instead. Manage models…`
                : "Manage models"
            }
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-ink-3 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            <IconModel size={13} />
            <span className="truncate font-mono text-[11px]">{answeredBy ?? model}</span>
          </button>
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assistant"
              title="Close assistant (Ctrl+Alt+B)"
              className="rounded px-1 text-[13px] leading-none text-ink-3 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              ×
            </button>
          )}
        </div>
      </IdeBar>

      {showSessions && (
        <SessionList
          sessions={sessions}
          activeSessionId={sessionId}
          loading={sessionsLoading}
          onSelect={(id) => void openSession(id)}
          onDelete={(id) => void deleteSession(id)}
          onNew={newSession}
          onSearch={(query) => void refreshSessions(query)}
          error={sessionError}
        />
      )}

      {showHistory && (
        <div className="max-h-48 shrink-0 overflow-auto border-b border-line px-3 py-1">
          {history.length === 0 ? (
            <p className="py-1 text-[11px] text-ink-3">No runs recorded for this project yet.</p>
          ) : (
            <ul className="flex flex-col">
              {history.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => void openRun(entry.id)}
                    className="w-full rounded px-1 py-1 text-left text-[11px] text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink"
                  >
                    <span className="block truncate">{entry.question}</span>
                    <span className="text-ink-3">
                      {entry.createdAt} · {entry.stepCount}{" "}
                      {entry.stepCount === 1 ? "step" : "steps"}
                      {/* A run with no ending never finished — worth showing, not hiding. */}
                      {entry.finishReason === null && " · did not finish"}
                      {entry.finishReason === "budget" && " · hit its limit"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div ref={transcript} className="flex-1 space-y-4 overflow-y-auto p-3">
        {turns.length === 0 && (
          <EmptyState
            size="sm"
            title="Ask about this project."
            /**
             * The mode's own description, not a fifth copy of it.
             *
             * This used to say "Nothing is written without your review" unconditionally, which
             * Auto made false — the same stale-claim bug the persona and `dispatch.ts` both
             * had, except here it is the sentence a user actually reads. Sourcing it from
             * `MODE_HELP` means the empty state, the dropdown tooltip and the policy table
             * cannot disagree, because there is one of them.
             */
            body={MODE_HELP[agentMode]}
          />
        )}

        {viewingPast && (
          <p className="text-[11px] text-ink-3">
            A past run — its proposals have expired.
          </p>
        )}

        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <div key={index} className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-ink-3">
                You
              </span>
              <p className="max-w-[80ch] whitespace-pre-wrap break-words text-sm text-ink">
                {turn.text}
                {turn.imageCount > 0 && (
                  <span className="text-ink-3">
                    {turn.text === "" ? "" : " "}
                    [{turn.imageCount} image{turn.imageCount === 1 ? "" : "s"}]
                  </span>
                )}
              </p>
            </div>
          ) : (
            <div key={index} className="flex flex-col gap-2">
              {turn.blocks.map((block, blockIndex) =>
                block.kind === "text" ? (
                  /**
                   * Assistant prose is markdown; the user's own turn above is not.
                   *
                   * That asymmetry is deliberate. A model writes markdown and expects it to be
                   * rendered — headings, lists, fenced code with highlighting. What the user
                   * typed should be shown back exactly as typed, so a question containing
                   * `**` or a stray backtick is not silently reformatted into something they
                   * did not write. Tool output below stays literal for the same reason: it is
                   * a program's stdout, not prose.
                   */
                  /*
                    `max-w-[80ch]` is a reading measure, and it is on the prose alone.

                    This panel was a ~300px sidebar and needed no width limit anywhere. In the
                    centre pane it does: prose set across half a wide window runs past 140
                    characters a line, which is genuinely hard to read.

                    Deliberately not on the transcript column. Diffs, tool output and code blocks
                    are in this stream too, and they want every pixel the pane has — clamping the
                    column would have narrowed them to suit paragraphs. `ch` rather than a `rem`
                    width for the same reason `page-width.test.ts` exempts it: this is a limit on
                    a line of text, which should not grow with the monitor.
                  */
                  <Markdown
                    key={blockIndex}
                    source={block.text}
                    className="max-w-[80ch] break-words text-sm text-ink-2"
                  />
                ) : block.step.plan !== undefined ? (
                  /*
                    A plan replaces the step line rather than sitting under it.

                    The generic row above would print `write_plan` and then the tool's own
                    confirmation text — "Recorded a plan: 5 steps." — directly above a card
                    that says the same thing better and in more detail. That text exists for
                    the model, which needs telling that the call landed; the reader has the
                    card.
                  */
                  <PlanCard key={blockIndex} plan={block.step.plan} />
                ) : (
                  <div key={blockIndex} className="flex flex-col gap-1">
                    <span
                      className={
                        block.step.kind === "error"
                          ? "font-mono text-[10px] uppercase tracking-wide text-diff-remove-ink"
                          : "font-mono text-[10px] uppercase tracking-wide text-ink-3"
                      }
                    >
                      {labelFor(block.step)}
                    </span>

                    {block.step.kind === "proposal" && block.step.diff !== undefined ? (
                      <DiffView
                        diff={block.step.diff}
                        // Never applied from here — see the `readOnly` docstring.
                        readOnly
                        onApply={() => {}}
                        onReject={() => {}}
                      />
                    ) : (
                      /**
                       * Tool output is clipped in the view, not in the data.
                       *
                       * A `list_files` result is tens of kilobytes of JSON, and pasting all of
                       * it into the transcript buries every other block. The model still
                       * received the whole thing.
                       */
                      <p
                        className={
                          block.step.kind === "error"
                            ? "whitespace-pre-wrap break-words text-xs text-diff-remove-ink"
                            : "whitespace-pre-wrap break-words text-xs text-ink-3"
                        }
                      >
                        {block.step.kind === "tool" && block.step.text.length > 400
                          ? `${block.step.text.slice(0, 400)}…`
                          : block.step.text}
                      </p>
                    )}
                  </div>
                )
              )}
            </div>
          )
        )}

        {streaming && <p className="text-xs text-ink-3">Working…</p>}

        {finished === "budget" && (
          // The run was cut short by its own limits, which is different from finishing.
          <p className="text-xs text-ink-3">
            The assistant reached its limit for this turn and stopped early.
          </p>
        )}

        {outcomes.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {outcomes.map((outcome) => (
              <li key={outcome.path} className="text-xs">
                <button
                  type="button"
                  onClick={() => onOpenLocation?.(outcome.path, 1)}
                  className="text-left text-ink-2 underline-offset-2 hover:underline"
                >
                  <span className={outcome.ok ? "text-diff-add-ink" : "text-diff-remove-ink"}>
                    {outcome.ok ? "applied" : "not applied"}
                  </span>{" "}
                  {outcome.path}
                  {outcome.reason !== null && (
                    <span className="text-ink-3"> — {outcome.reason}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {Object.entries(locations).map(([id, state]) => {
          if (state.status === "running") {
            return (
              <p key={id} className="text-[11px] text-ink-3">
                Reading the screenshot and searching the project…
              </p>
            );
          }
          if (state.status === "failed") {
            return (
              <p key={id} className="text-[11px] text-diff-remove-ink">
                {state.message}
              </p>
            );
          }
          if (state.candidates.length === 0) {
            /**
             * Nothing matched, said plainly and with the strings it tried.
             *
             * Offering the closest-scoring file anyway is the specific failure this feature is
             * designed against — a plausible file is indistinguishable from a correct one
             * until someone acts on it.
             */
            return (
              <p key={id} className="text-[11px] text-ink-3">
                {state.searched.length === 0
                  ? "I couldn't read any text from that screenshot."
                  : `I couldn't find ${state.searched
                      .slice(0, 3)
                      .map((s) => `"${s}"`)
                      .join(", ")} anywhere in this project.`}
              </p>
            );
          }
          return (
            <ul key={id} className="flex flex-col gap-1 rounded-md border border-line bg-ide-code p-2">
              {state.candidates.map((candidate) => (
                <li key={`${candidate.path}:${candidate.line}`}>
                  <button
                    type="button"
                    onClick={() => onOpenLocation?.(candidate.path, candidate.line)}
                    className="w-full rounded px-1 py-0.5 text-left text-[11px] text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink"
                  >
                    <span className="text-ink">{candidate.path}</span>
                    <span className="text-ink-3">:{candidate.line}</span>
                    {candidate.symbol !== null && (
                      <span className="text-ink-3"> in {candidate.symbol}</span>
                    )}
                    <span className="block text-ink-3">{candidate.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          );
        })}
      </div>

      <div
        className={dragging ? "border-t border-ink bg-ide-raised p-2" : "border-t border-line p-2"}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(REF_MIME)) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          /**
           * An internal drag first, because it is the only one that knows where the file is.
           *
           * A drag from the tree carries the exact project-relative path. A drop from Explorer or
           * Finder carries bytes and a filename and no location whatsoever, so the two cannot be
           * handled the same way and the difference is visible to the user: one becomes a
           * reference that is re-read at send, the other becomes the text that was dropped.
           */
          const dragged = e.dataTransfer.getData(REF_MIME);
          if (dragged !== "") {
            e.preventDefault();
            setDragging(false);
            const ref = decodeRefDrag(dragged);
            if (ref !== null) {
              setRefs((prev) =>
                prev.some((r) => r.kind === ref.kind && r.path === ref.path) ? prev : [...prev, ref]
              );
            }
            return;
          }

          const images = imageFilesFrom(e.dataTransfer.items);
          // `dataTransfer` is emptied when the handler returns, so the list is taken now and read
          // afterwards.
          const others = [...e.dataTransfer.files].filter((file) => !images.includes(file));
          if (images.length === 0 && others.length === 0) return;

          e.preventDefault();
          setDragging(false);
          if (images.length > 0) void attach(images);

          for (const file of others) {
            const reason = rejectionForDrop(file);
            if (reason !== null) {
              notify(`${file.name} was not attached — ${reason}.`, { tone: "warn" });
              continue;
            }
            void file.text().then((contents) => {
              setDrops((prev) => [...prev, { name: droppedTextName(file.name), contents }]);
            });
          }
        }}
      >
        {pendingIds.length > 0 && !viewingPast && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-ide-code px-2 py-1.5">
            <span className="text-xs text-ink-2">
              {pendingIds.length} {pendingIds.length === 1 ? "change" : "changes"} proposed
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={() => void applyAll()}
              disabled={applying}
              className="rounded-md bg-ink px-2 py-1 text-[11px] text-void-0 transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {/* Says what it opens. The dialog is the decision point, not this button. */}
              {applying ? "Waiting…" : "Review and apply…"}
            </button>
          </div>
        )}

        {undoable !== null && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-ide-code px-2 py-1.5">
            <span className="text-xs text-ink-2">
              Wrote {undoable.paths.length}{" "}
              {undoable.paths.length === 1 ? "file" : "files"} without asking
            </span>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={() => void undoRun(undoable.runId)}
              className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink"
            >
              {/* "Undo file changes", not "Undo this run". The checkpoint covers what the run
                  wrote and not what its commands did, and the label is where that distinction
                  is either kept or quietly lost. */}
              Undo file changes
            </button>
          </div>
        )}

        {undoNote !== null && (
          <p className="mb-2 text-[11px] text-ink-3">{undoNote}</p>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL has no
                    remote origin to optimise, and next/image would refuse it anyway. */}
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  title={`${attachment.name} — ${(attachment.bytes / 1024).toFixed(0)} KB`}
                  className="h-14 w-14 rounded border border-line object-cover"
                />
                {host.vision !== undefined && (
                  <button
                    type="button"
                    onClick={() => void locate(attachment)}
                    disabled={locations[attachment.id]?.status === "running"}
                    aria-label={`Find ${attachment.name} in project`}
                    title="Find where this is in the project"
                    className="absolute -bottom-1.5 -left-1.5 h-4 rounded-full border border-line bg-ide-panel px-1 text-[9px] leading-[14px] text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none disabled:opacity-40"
                  >
                    {locations[attachment.id]?.status === "running" ? "…" : "find"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    attachmentsRef.current = attachmentsRef.current.filter(
                      (a) => a.id !== attachment.id
                    );
                    setAttachments(attachmentsRef.current);
                    setLocations((prev) => {
                      const { [attachment.id]: _dropped, ...rest } = prev;
                      return rest;
                    });
                  }}
                  aria-label={`Remove ${attachment.name}`}
                  className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full border border-line bg-ide-panel text-[10px] leading-none text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/*
          Attached files and folders, with what the expansion will leave out.

          A folder chip says how many files it stands for *before* the message is sent, because
          "12 files, 3 skipped" is the sort of thing you want to know while you can still change
          your mind about attaching it.
        */}
        {(refs.length > 0 || drops.length > 0) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {drops.map((file, i) => (
              <span
                key={`${file.name}-${i}`}
                // Visibly different from a reference chip: this one is bytes that were dropped,
                // not a file in the project, and it cannot be re-read.
                title={`Dropped text — ${file.contents.length} characters. Not a file in this project.`}
                className="inline-flex items-center gap-1 rounded border border-dashed border-line bg-ide-raised px-1.5 py-0.5 text-[11px] text-ink-2"
              >
                <span className="text-ink-3">⬓</span>
                <span className="max-w-[14rem] truncate font-mono">{file.name}</span>
                <button
                  type="button"
                  onClick={() => setDrops((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${file.name}`}
                  className="text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
            {refs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.path}`}
                className="group inline-flex items-center gap-1 rounded border border-line bg-ide-raised px-1.5 py-0.5 text-[11px] text-ink-2"
              >
                <span className="text-ink-3">{ref.kind === "folder" ? "▾" : "▸"}</span>
                <span className="max-w-[14rem] truncate font-mono">{ref.path}</span>
                <button
                  type="button"
                  onClick={() =>
                    setRefs((prev) => prev.filter((r) => !(r.kind === ref.kind && r.path === ref.path)))
                  }
                  aria-label={`Remove ${ref.path}`}
                  className="text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink"
                >
                  ×
                </button>
              </span>
            ))}

            {/*
              What the chips actually amount to, before anything is sent.
              
              A folder chip says "src/" and means forty-three files, and the number matters while
              you can still change your mind. This is the cheap half — a tree walk, no reading —
              so it counts what was *named*; how much of it fits is decided at send time by the
              budget, and the warning below says when those two will differ.
            */}
            {namedFiles > 0 && (
              <span className="text-[11px] text-ink-3">
                {namedFiles} {namedFiles === 1 ? "file" : "files"}
                {namedFiles > DEFAULT_REF_LIMITS.maxFiles && (
                  <span className="text-ink-2">
                    {" "}
                    — the first {DEFAULT_REF_LIMITS.maxFiles} will be sent
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        {/* `relative`, so the slash list can sit above the textarea without a portal. */}
        <div className="relative">
          <SlashAutocomplete
            commands={suggestions}
            activeIndex={slashIndex}
            onPick={(command: SlashCommand) => setInput(complete(command))}
          />

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="slash-autocomplete"
            // Focus never moves to the list — see `SlashAutocomplete`. This is how a screen
            // reader is told which row is current anyway.
            aria-activedescendant={
              suggestions[slashIndex] === undefined
                ? undefined
                : `slash-option-${suggestions[slashIndex]!.name}`
            }
            // Paste is how a screenshot actually arrives — Win+Shift+S then Ctrl+V, with no file
            // on disk to drag.
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData.items);
              if (files.length === 0) return;
              e.preventDefault();
              void attach(files);
            }}
            onKeyDown={(e) => {
              /**
               * The list is open, so it gets the navigation keys first.
               *
               * Only while it is open: the arrows have to keep moving the caret the rest of the
               * time, which is the reason the keyboard lives here rather than in the list. A
               * component that owns these keys owns them always.
               */
              if (suggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((i) => Math.min(i + 1, suggestions.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const picked = suggestions[slashIndex];
                  if (picked !== undefined) setInput(complete(picked));
                  return;
                }
                if (e.key === "Escape") {
                  // Dismiss the list without losing what was typed — the text is still a message.
                  e.preventDefault();
                  setSlashIndex(0);
                  setInput((current) => `${current} `);
                  return;
                }
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                  e.preventDefault();
                  const picked = suggestions[slashIndex];
                  // A complete command runs; a partial one completes first.
                  if (picked !== undefined && `/${picked.name}` !== input.trimEnd()) {
                    setInput(complete(picked));
                  } else {
                    void send();
                  }
                  return;
                }
              }

              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder={openFile === undefined ? "Ask anything…" : `Ask about ${openFile.path}…`}
            className="w-full resize-none rounded-md border border-line bg-ide-code px-2 py-1.5 text-sm text-ink-2 placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-ink/40"
          />
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          {/*
            The discoverable door to the same thing `/file` and `/folder` do.
            
            Slash commands are faster once you know them and invisible until you do; a button in
            the control row is how someone finds out attaching is possible at all. Both routes
            call `openPicker`, so there is one implementation and no second way for it to differ.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Attach context"
                title="Attach a file or folder from this project"
                className="flex shrink-0 items-center rounded-md border border-line px-1.5 py-1 text-ink-3 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink data-[state=open]:bg-ide-raised data-[state=open]:text-ink"
              >
                <IconPlus size={13} />
              </button>
            </DropdownMenuTrigger>
            {/* Above the button: the composer sits at the bottom of the panel. */}
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuLabel>Attach</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void openPicker("file")}>
                <span className="text-ink-3">▸</span> Add file
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openPicker("folder")}>
                <span className="text-ink-3">▾</span> Add folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <select
            value={agentMode}
            onChange={(e) => setAgentMode(e.target.value as SelectableMode)}
            aria-label="Agent mode"
            title={MODE_HELP[agentMode]}
            className="rounded-md border border-line bg-ide-code px-1.5 py-1 text-[11px] text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            {SELECTABLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          {agentMode === "auto" && (
            <button
              type="button"
              onClick={() => void toggleArmed()}
              title={
                armed
                  ? "Armed for this project. The assistant writes without asking."
                  : "Auto mode writes nothing until you arm this window."
              }
              className={`rounded-md border px-1.5 py-1 text-[11px] transition-colors ${
                armed
                  ? "border-diff-remove-ink/60 text-diff-remove-ink hover:bg-ide-raised"
                  : "border-line text-ink-3 hover:bg-ide-raised hover:text-ink"
              }`}
            >
              {/* States the fact, not the action, when armed — someone glancing at this needs
                  to know the assistant can currently write more than they need a verb. */}
              {armed ? "ARMED" : "Arm Auto…"}
            </button>
          )}
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value as ProviderId)}
            aria-label="Model provider"
            title={
              providerId === "openrouter"
                ? "Runs in the cloud — you will be asked before any image is sent"
                : "Runs on this machine"
            }
            className="rounded-md border border-line bg-ide-code px-1.5 py-1 text-[11px] text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            {providerOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
                {/*
                  `=== false`, not falsy.

                  `availableProviders()` in main already filters to backends it could reach, so
                  every entry it returns is running and none of them carry an `available` field.
                  Testing truthiness therefore labelled *every* provider "(not running)" —
                  including the local Ollama that was serving the model on screen. Only the
                  synthesised fallback below sets the flag, and only it should say so.
                */}
                {provider.available === false ? " (not running)" : ""}
              </option>
            ))}
          </select>

          {attachments.length > 0 && (
            <span className="text-[11px] text-ink-3">
              {attachments.length}/{MAX_ATTACHMENTS}
            </span>
          )}

          <span className="ml-auto" />

          {streaming && (
            <button
              type="button"
              onClick={() => cancelRef.current?.()}
              className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={streaming || (input.trim() === "" && attachments.length === 0)}
            /**
             * Labelled, for two reasons.
             *
             * While streaming the visible text is "Thinking…", which is a status rather than an
             * action — a screen reader announcing it says nothing about what the control does.
             * The label names the action in both states and keeps the visible word inside the
             * accessible name.
             *
             * It is also how the smoke finds this button. It used to locate it by walking up from
             * the textarea, which broke silently the moment `SlashAutocomplete` wrapped the
             * textarea in a `relative` div — the Send button became a sibling of that wrapper
             * rather than a child, and the probe reported "no Send button" for days about a button
             * that was working. A label travels with the element through any restructuring.
             */
            aria-label={streaming ? "Thinking, sending a message" : "Send message"}
            className="rounded-md bg-ink px-3 py-1 text-[11px] text-void-0 transition-opacity duration-150 ease-void hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
          >
            {streaming ? "Thinking…" : "Send"}
          </button>
        </div>
      </div>

      {picking !== null && (
        <QuickOpen
          // Files or folders, never both: a picker that offers both makes you read every row to
          // find out which kind it is.
          paths={pathsOf(tree, picking)}
          title={picking === "folder" ? "Attach a folder" : "Attach a file"}
          placeholder={picking === "folder" ? "Search folders…" : "Search files…"}
          onPick={(path) =>
            setRefs((prev) =>
              prev.some((r) => r.kind === picking && r.path === path)
                ? prev
                : [...prev, { kind: picking, path }]
            )
          }
          onClose={() => setPicking(null)}
        />
      )}
    </IdePanel>
  );
}

/**
 * A header nav item: icon, label, and a pressed state.
 *
 * Its own component because the two of them plus the model button would otherwise be three
 * copies of the same twelve-class string, which is how the title bar's icons drifted apart.
 */
function ViewButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors duration-150 ease-void focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
        active ? "bg-ide-raised text-ink" : "text-ink-3 hover:bg-ide-raised hover:text-ink"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Every file, or every folder, in tree order.
 *
 * Flattened here rather than in `context-refs.ts` because that module is about what a reference
 * *expands to*; this is about what can be named in the first place, which is a picker's concern.
 */
function pathsOf(tree: RefTree | null, kind: "file" | "folder"): string[] {
  if (tree === null) return [];
  const wanted = kind === "folder" ? "directory" : "file";
  const out: string[] = [];
  const walk = (nodes: readonly { path: string; kind: string; children?: readonly unknown[] }[]): void => {
    for (const node of nodes) {
      if (node.kind === wanted) out.push(node.path);
      if (node.children !== undefined) {
        walk(node.children as readonly { path: string; kind: string; children?: readonly unknown[] }[]);
      }
    }
  };
  walk(tree.entries);
  return out;
}
