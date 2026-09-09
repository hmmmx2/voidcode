/**
 * The Output panel's ring buffer, and the count it is required to surface.
 *
 * A bounded buffer that forgets silently is how a log pane starts lying: you scroll to the top of
 * a long agent run, see its first visible line, and believe it was the first line. Every other
 * bounded thing in this app reports its bound — `BuildProjectTree.truncated`, `fs.search`,
 * `CommandResult.truncated` — and `dropped` is this one's.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_LABELS,
  describeStep,
  type LoggableStep,
  MAX_OUTPUT_LINES,
  OUTPUT_CHANNELS,
  appendOutput,
  appendTo,
  clearChannel,
  emptyChannel,
  emptyOutput,
} from "../renderer/src/lib/build/output.js";

describe("a channel", () => {
  it("splits a block into lines, because the cap counts lines", () => {
    // A producer that emitted one 5,000-line string would otherwise occupy a single slot and
    // make the cap meaningless.
    const buffer = appendOutput(emptyChannel(), "one\ntwo\nthree");
    expect(buffer.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
  });

  it("treats a trailing newline as a terminator, not an empty line", () => {
    expect(appendOutput(emptyChannel(), "one\n").lines).toHaveLength(1);
    // But a blank line in the middle is real content and stays.
    expect(appendOutput(emptyChannel(), "one\n\ntwo").lines).toHaveLength(3);
  });

  it("keeps identity when nothing was added, so it cannot cause a render", () => {
    const buffer = emptyChannel();
    expect(appendOutput(buffer, "")).toBe(buffer);
    expect(appendTo(emptyOutput(), "agent", "")).toEqual(emptyOutput());
  });

  it("counts what fell off the front", () => {
    let buffer = emptyChannel();
    for (let i = 0; i < MAX_OUTPUT_LINES + 250; i += 1) buffer = appendOutput(buffer, `line ${i}`);

    expect(buffer.lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(buffer.dropped).toBe(250);
    // The oldest survivor is the 250th, not the first — the buffer drops from the front.
    expect(buffer.lines[0]!.text).toBe("line 250");
    expect(buffer.lines[buffer.lines.length - 1]!.text).toBe(`line ${MAX_OUTPUT_LINES + 249}`);
  });

  it("drops correctly when one write overflows the cap on its own", () => {
    const huge = Array.from({ length: MAX_OUTPUT_LINES + 40 }, (_, i) => `l${i}`).join("\n");
    const buffer = appendOutput(emptyChannel(), huge);
    expect(buffer.lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(buffer.dropped).toBe(40);
  });

  it("gives every surviving line a key that stays unique after dropping", () => {
    // `seq` keeps counting rather than restarting at the array index, so React does not reuse a
    // row's DOM for a different line when the front is trimmed.
    let buffer = emptyChannel();
    for (let i = 0; i < MAX_OUTPUT_LINES + 100; i += 1) buffer = appendOutput(buffer, `l${i}`);
    const seqs = buffer.lines.map((l) => l.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBeGreaterThan(MAX_OUTPUT_LINES - MAX_OUTPUT_LINES + 100);
  });
});

describe("the channel set", () => {
  it("labels every channel", () => {
    for (const channel of OUTPUT_CHANNELS) {
      expect(CHANNEL_LABELS[channel], `${channel} has no label`).toBeTruthy();
    }
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual([...OUTPUT_CHANNELS].sort());
  });

  it("starts every channel empty", () => {
    const state = emptyOutput();
    for (const channel of OUTPUT_CHANNELS) {
      expect(state[channel].lines).toEqual([]);
      expect(state[channel].dropped).toBe(0);
    }
  });

  it("writes to one channel without touching the others", () => {
    const state = appendTo(emptyOutput(), "agent", "read_file src/index.ts");
    expect(state.agent.lines).toHaveLength(1);
    expect(state.terminal.lines).toHaveLength(0);
  });

  it("clears one channel and leaves the rest", () => {
    let state = appendTo(emptyOutput(), "agent", "a");
    state = appendTo(state, "terminal", "b");
    const cleared = clearChannel(state, "agent");
    expect(cleared.agent.lines).toEqual([]);
    expect(cleared.terminal.lines).toHaveLength(1);
  });

  it("does not include main's log, which has no push to the renderer", () => {
    // Adding one means deciding what the renderer may see of a redacted log. `help.openLogs` is
    // main-owned and stays the way to read it, so it works when the renderer is the broken part.
    expect(OUTPUT_CHANNELS).not.toContain("log");
  });
});

/**
 * Every channel you can select must be able to contain something.
 *
 * The picker shipped with five channels and two producers: Agent, Terminal and Models were
 * selectable and permanently empty. That is the same failure as a Problems tab that cannot tell
 * "clean" from "no linter installed" — the UI offers a distinction it cannot honour. Nothing
 * caught it because every unit test here operates on a buffer that the test itself filled.
 *
 * So this reads the source instead and asks who writes to each channel. It is a coarse check by
 * design: a precise one would have to trace prop chains through three components, and the failure
 * it guards against is not subtle — it is a channel nobody wired at all.
 */
describe("every channel has a producer", () => {
  const workspace = readFileSync(
    join(__dirname, "../renderer/src/components/Build/BuildWorkspace.tsx"),
    "utf8"
    // Comments stripped first, house rule: a channel named only in prose is not a producer, and
    // the doc comment above `appendOutput` names all of them.
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

  it("writes to each declared channel from the workspace", () => {
    for (const channel of OUTPUT_CHANNELS) {
      // `appendOutput("x", …)` or a ref call — either counts as a producer.
      const written = new RegExp(String.raw`(appendOutput|outputRef\.current)\(\s*"${channel}"`).test(
        workspace
      );
      expect(written, `nothing ever writes to the "${channel}" channel`).toBe(true);
    }
  });

  it("declares no channel the picker cannot fill", () => {
    // Models was removed rather than wired: pull progress goes to `ctx.sender`, which is the
    // window that asked for the download, and downloads start on /models — a different window.
    expect(OUTPUT_CHANNELS).not.toContain("models");
  });

  it("labels exactly the channels it declares", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual([...OUTPUT_CHANNELS].sort());
  });
});

describe("a step as one line of log", () => {
  const step = (over: Partial<LoggableStep> = {}): LoggableStep => ({
    kind: "tool",
    text: "read src/index.ts",
    ...over,
  });

  it("names a tool by its own name", () => {
    expect(describeStep(step({ toolName: "read_file" }))).toBe("read_file: read src/index.ts");
  });

  it("names everything else by its kind", () => {
    expect(describeStep(step({ kind: "error", text: "boom" }))).toBe("error: boom");
    expect(describeStep(step({ kind: "applied", text: "3 files" }))).toBe("applied: 3 files");
  });

  it("drops a thought", () => {
    // It repeats prose the tokens already delivered. A log is for what the run did.
    expect(describeStep(step({ kind: "thought", text: "considering the options" }))).toBeNull();
  });

  it("survives an empty text without a dangling separator", () => {
    expect(describeStep(step({ kind: "command", text: "   " }))).toBe("command");
  });
});
