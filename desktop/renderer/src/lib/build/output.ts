/**
 * The Output panel's channels, and the bound on each.
 *
 * VS Code's Output pane is a channel picker over several producers, which is exactly what this
 * app already has scattered about: the linter says which tool it ran, the agent streams steps,
 * the save coordinator reports failures, and terminals report exit codes. Every one of them
 * already emits text. **So this adds no IPC at all** — it is a place to put what is already
 * crossing the boundary.
 *
 * **There is no Models channel, and that is not an omission.** Pull progress is delivered with
 * `ctx.sender.send("models:pullProgress", …)` (`src/main/ipc/handlers/index.ts:1086`) — to the
 * window that asked for the pull. Downloads are started from `/models`, which is a different
 * window, so a Build window can never receive a frame. It shipped in the picker anyway and was
 * permanently empty: a channel you can select and that can never contain anything is the same
 * failure as a Problems tab that cannot tell "clean" from "no linter installed". Feeding it
 * would mean broadcasting pull progress to every window, which is a real decision about what
 * one window may observe of another's downloads, not a plumbing job.
 *
 * **Main's `log.ts` is deliberately not a channel.** There is no main→renderer push for it, and
 * adding one means deciding what the renderer may see of a redacted log — a real question, not a
 * plumbing job. `help.openLogs` stays the way to read it, and it is main-owned so it works
 * exactly when the renderer is the thing that is broken.
 *
 * **The bound is surfaced, not silent.** A ring buffer that quietly forgets is how a panel starts
 * lying about what happened; `dropped` is rendered, in the same way `BuildProjectTree.truncated`
 * and `CommandResult.truncated` are.
 */

/**
 * Channels with a producer, which is the only kind worth having.
 *
 * This list has now shrunk twice for the same reason. `models` went when it turned out
 * `ctx.sender.send` delivers to the requesting window only, so nothing could ever write it.
 * `lint` and `save` go here: the workspace stopped saving, and linting ran on a successful save
 * — so one lost its trigger and the other its only producer. A tab that can only ever be empty
 * is worse than no tab, because it reads as a feature that is broken rather than absent.
 */
export const OUTPUT_CHANNELS = ["agent", "terminal"] as const;

export type OutputChannel = (typeof OUTPUT_CHANNELS)[number];

export const CHANNEL_LABELS: Record<OutputChannel, string> = {
  agent: "Agent",
  terminal: "Terminal",
};

/**
 * Roughly a screenful times forty.
 *
 * Enough to scroll back through a long agent run, small enough that four channels of it is not a
 * memory problem in a renderer that also holds Monaco.
 */
export const MAX_OUTPUT_LINES = 2_000;

export interface OutputLine {
  /** Monotonic per channel. A React key that survives the oldest lines being dropped. */
  seq: number;
  text: string;
}

export interface ChannelBuffer {
  lines: OutputLine[];
  /** How many lines fell off the start. Rendered — see the header. */
  dropped: number;
  nextSeq: number;
}

export function emptyChannel(): ChannelBuffer {
  return { lines: [], dropped: 0, nextSeq: 1 };
}

export type OutputState = Record<OutputChannel, ChannelBuffer>;

export function emptyOutput(): OutputState {
  return {
    agent: emptyChannel(),
    terminal: emptyChannel(),
  };
}

/**
 * Append, dropping from the front once the cap is reached.
 *
 * Splits on newlines so a caller can hand over a whole block — the cap counts lines, and a
 * producer that emitted one 5,000-line string would otherwise occupy one slot and defeat it.
 * Empty input is a no-op that returns the same object, so it cannot cause a re-render.
 */
export function appendOutput(buffer: ChannelBuffer, text: string): ChannelBuffer {
  const incoming = text.split("\n").filter((line, index, all) => {
    // A trailing newline is a terminator, not an empty last line.
    return !(line === "" && index === all.length - 1);
  });
  if (incoming.length === 0) return buffer;

  let seq = buffer.nextSeq;
  const added = incoming.map((line) => ({ seq: seq++, text: line }));
  const combined = [...buffer.lines, ...added];

  const overflow = Math.max(0, combined.length - MAX_OUTPUT_LINES);
  return {
    lines: overflow === 0 ? combined : combined.slice(overflow),
    dropped: buffer.dropped + overflow,
    nextSeq: seq,
  };
}

export function appendTo(state: OutputState, channel: OutputChannel, text: string): OutputState {
  const next = appendOutput(state[channel], text);
  // Identity preserved when nothing was added, so an empty write does not re-render the panel.
  return next === state[channel] ? state : { ...state, [channel]: next };
}

export function clearChannel(state: OutputState, channel: OutputChannel): OutputState {
  return { ...state, [channel]: emptyChannel() };
}

/**
 * The shape `describeStep` needs, named structurally.
 *
 * `AgentStepPayload` satisfies it, but this module deliberately imports nothing: it is reached
 * from `tests/`, which is compiled under the *main* tsconfig, and `agent-stream.ts` reaches for
 * `window.host` and the renderer-only `BuildDiff`. Importing it — even as a type — pulls the
 * whole file into that program and breaks the main typecheck. Structural typing costs one
 * interface and keeps this file free of that.
 */
export interface LoggableStep {
  kind: string;
  text: string;
  toolName?: string;
}

/**
 * A step as one line of log, or null if it does not belong in one.
 *
 * `thought` is dropped for the same reason the transcript drops it: it repeats prose the tokens
 * already delivered. Output carries no tokens, so including it would not duplicate anything on
 * screen — but it would turn the Agent channel into a second copy of the answer, and the reason
 * to open a log is to find what the run *did*, not to re-read what it said.
 *
 * Tools name themselves; everything else is named by its kind, so a line is legible without the
 * surrounding conversation.
 */
export function describeStep(step: LoggableStep): string | null {
  if (step.kind === "thought") return null;
  const label = step.toolName ?? step.kind;
  const text = step.text.trim();
  return text === "" ? label : `${label}: ${text}`;
}
