/**
 * The mode policy table.
 *
 * Pure assertions over a data structure, which is the point of having made it one: "what can
 * Auto do" should be answerable by reading a value rather than by tracing conditionals through
 * the prompt builder, the tool binder and the loop condition.
 *
 * Two properties here are load-bearing rather than descriptive:
 *
 *   - **A mode can only narrow.** `toolsFor` intersects the mode's list with the surface's, so
 *     no value of `mode` grants the tutor a tool. The renderer names the mode; if the policy
 *     list were authoritative instead, a renderer would be choosing its own privileges.
 *   - **`auto` is defined and unreachable.** The table is the design and is worth having whole,
 *     but the enum `agent:open` accepts is built from `SELECTABLE_MODES`. Auto writes without a
 *     dialog and its consent and undo are not built.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MODE,
  POLICIES,
  SELECTABLE_MODES,
  isSelectableMode,
  recursionLimitFor,
  systemPromptFor,
  toolDefinitionsFor,
  toolsFor,
  type AgentMode,
} from "../src/main/agent/modes.js";
import { MODE_HELP } from "../src/shared/agent-modes.js";
import { toolsForSurface } from "../src/main/inference/personas.js";

const ALL: AgentMode[] = ["plan", "manual", "acceptEdits", "auto"];

describe("what each mode may call", () => {
  it("gives Plan every read tool and no way to write", () => {
    const tools = toolsFor("assistant", "plan");
    expect(tools).toContain("read_file");
    expect(tools).toContain("search_project");
    // The whole point of the mode. A plan that can edit is not a plan.
    expect(tools).not.toContain("propose_edit");
    expect(tools).not.toContain("run_command");
  });

  it("gives Manual nothing at all", () => {
    expect(toolsFor("assistant", "manual")).toEqual([]);
  });

  it("gives Accept Edits the read tools plus propose_edit", () => {
    const tools = toolsFor("assistant", "acceptEdits");
    expect(tools).toContain("read_file");
    expect(tools).toContain("propose_edit");
    expect(tools).not.toContain("run_command");
  });

  it("names run_command in exactly one policy", () => {
    // If a second mode ever gets a shell, that should be a decision someone made on purpose.
    const withShell = ALL.filter((mode) => POLICIES[mode].tools.includes("run_command"));
    expect(withShell).toEqual(["auto"]);
  });

  it("lets exactly one mode write without a dialog", () => {
    expect(ALL.filter((mode) => POLICIES[mode].autoApply)).toEqual(["auto"]);
  });
});

describe("the surface is the ceiling", () => {
  it.each(ALL)("gives the tutor nothing in %s mode", (mode) => {
    /**
     * The property the intersection exists for, asserted for every mode including `auto`.
     *
     * `toolsForSurface("tutor")` is `[]`, and intersecting anything with the empty set is the
     * empty set — so this is not a check that could be forgotten, it is the shape of the
     * operation. Remove the intersection from `toolsFor` and these four fail.
     */
    expect(toolsFor("tutor", mode)).toEqual([]);
  });

  it.each(ALL)("never returns a tool the surface does not permit in %s mode", (mode) => {
    const permitted = new Set(toolsForSurface("assistant"));
    for (const tool of toolsFor("assistant", mode)) {
      expect(permitted.has(tool), `${tool} is not on the assistant surface`).toBe(true);
    }
  });

  /**
   * The other direction, which the test above cannot see.
   *
   * "Never returns a tool the surface does not permit" passes *because* the intersection drops
   * it — so a tool named by a policy and forgotten on the surface satisfies that assertion
   * perfectly while being unreachable. `write_plan` was added to three policies and left off
   * the surface, and the whole suite stayed green.
   *
   * The `run_command` test below was the spot-check for one tool. This is the general rule it
   * is now an instance of: whatever a policy names, a model must actually be offered.
   */
  it("offers every tool its policy names", () => {
    for (const mode of ALL) {
      const reachable = new Set(toolsFor("assistant", mode));
      for (const tool of POLICIES[mode].tools) {
        expect(reachable.has(tool), `${tool} is named by ${mode} but dropped by the surface`).toBe(
          true
        );
      }
    }
  });

  it("gives Auto the shell, and no other mode", () => {
    /**
     * This test used to assert the opposite, and that was its job.
     *
     * `run_command` was named by `POLICIES.auto` before it existed on the surface, so the
     * intersection removed it — which is the intersection working, and also exactly how Auto
     * could have shipped with no terminal and no error explaining why. The test asserted the
     * gap so that adding the tool would fail it, and it did.
     *
     * A tool has to be in BOTH lists. That pairing is what this asserts now.
     */
    expect(POLICIES.auto.tools).toContain("run_command");
    expect(toolsForSurface("assistant")).toContain("run_command");
    expect(toolsFor("assistant", "auto")).toContain("run_command");

    for (const mode of ["plan", "manual", "acceptEdits"] as const) {
      expect(toolsFor("assistant", mode)).not.toContain("run_command");
    }
    // And the ceiling still holds: no mode gives the tutor a shell.
    expect(toolsFor("tutor", "auto")).toEqual([]);
  });
});

describe("every bound tool is actually described", () => {
  it.each(SELECTABLE_MODES)("has a definition for each tool in %s mode", (mode) => {
    /**
     * `toolDefinitionsFromNames` silently drops a name it has no definition for — a sensible
     * guard that becomes an undebuggable failure if a policy names a tool that does not exist:
     * the model is simply never told about it, and nothing anywhere says so.
     *
     * Selectable modes only. Auto deliberately names a tool that does not exist yet, which the
     * test above asserts on purpose.
     */
    const names = toolsFor("assistant", mode);
    const defined = toolDefinitionsFor("assistant", mode).map((d) => d.name);
    expect(defined).toEqual([...names]);
  });
});

describe("what the model is told", () => {
  it.each(ALL)("tells %s mode about exactly the tools it has", (mode) => {
    /**
     * The lesson `personas.ts` records: an instruction in the persona outranks a tool
     * definition, so a prompt naming a tool that is not bound produces a model announcing a
     * call it cannot make.
     *
     * Checked by name against the bound list. `run_command` is excluded because Auto's
     * guidance describes it before the surface offers it — the prompt is written for the mode
     * as designed, and Phase F closes that gap.
     */
    const prompt = systemPromptFor("assistant", mode);
    const bound = new Set(toolsFor("assistant", mode));
    for (const tool of ["read_file", "search_project", "list_files", "propose_edit"]) {
      if (prompt.includes(tool)) {
        expect(bound.has(tool), `${mode} prompt names ${tool} but does not bind it`).toBe(true);
      }
    }
  });

  it("tells Manual it has no tools, and names none", () => {
    const prompt = systemPromptFor("assistant", "manual");
    expect(prompt).toMatch(/no tools/i);
    for (const tool of ["read_file", "search_project", "propose_edit", "list_files"]) {
      expect(prompt).not.toContain(tool);
    }
  });

  it("does not promise Plan an edit it cannot make", () => {
    expect(systemPromptFor("assistant", "plan")).not.toMatch(/call propose_edit/i);
  });

  it("promises review in the modes that review, and not in Auto", () => {
    // The claim that would be actively harmful in Auto: telling a user who is not watching to
    // go and approve writes that already happened.
    expect(systemPromptFor("assistant", "acceptEdits")).toMatch(/approves it before anything/i);
    expect(systemPromptFor("assistant", "auto")).not.toMatch(/approves it before anything/i);
    expect(systemPromptFor("assistant", "auto")).toMatch(/written to the file as soon as/i);
  });

  it("warns Accept Edits that a read still shows the old file", () => {
    /**
     * The read-after-write lie, said out loud rather than left for the model to discover.
     *
     * Nothing is written until approval, so `read_file` after `propose_edit` returns the
     * ORIGINAL contents. A model that does not know this "corrects" its own edit against stale
     * text and proposes it again, losing its work.
     */
    expect(systemPromptFor("assistant", "acceptEdits")).toMatch(/ORIGINAL contents/);
  });

  it("keeps the tutor's prompt identical in every mode", () => {
    // The tutor has no tools in any mode, so a paragraph about which ones it has this turn
    // would be a paragraph about nothing.
    const prompts = new Set(ALL.map((mode) => systemPromptFor("tutor", mode)));
    expect(prompts.size).toBe(1);
  });

  it("shares the core across every assistant mode", () => {
    // Completeness, conventions and honesty are not mode-dependent, and four copies of them
    // would be four chances to drift.
    for (const mode of ALL) {
      expect(systemPromptFor("assistant", mode)).toContain("Write complete, working code");
    }
  });
});

describe("loop bounds", () => {
  it("gives Manual a single turn", () => {
    // It has no tools, so a provider can never answer `tool_calls` and the loop cannot
    // continue. `maxTurns: 1` says the same thing a second way rather than relying on it.
    expect(POLICIES.manual.maxTurns).toBe(1);
  });

  it.each(ALL)("derives a recursion limit above %s's turn ceiling", (mode) => {
    // The backstop must sit above the clean stop, or the run dies by throwing
    // `GraphRecursionError` — which discards the steps and diffs collected so far.
    expect(recursionLimitFor(mode)).toBeGreaterThan(POLICIES[mode].maxTurns * 2);
  });

  it("is derived at the call site, not written out again as a constant", () => {
    /**
     * A source assertion, because behaviour cannot reach this one.
     *
     * `shouldContinue` ends a run at `maxTurns` first and cleanly, so `recursionLimit` is a
     * backstop that a correct run never touches — which is the whole point of it, and also
     * why no test can observe its value by running the graph. Putting `64` back therefore
     * breaks nothing today and breaks everything the first time a mode's turn ceiling is
     * raised past it, as a `GraphRecursionError` that discards the run's work.
     *
     * So the guard is that the number is computed rather than typed.
     */
    const graph = readFileSync(join(__dirname, "../src/main/agent/graph.ts"), "utf8");
    expect(graph).toContain("recursionLimit: recursionLimitFor(context.agentMode)");
    expect(graph).not.toMatch(/recursionLimit:\s*\d+/);
  });

  it("moves the recursion limit when a turn ceiling moves", () => {
    // It was a hardcoded 64 with no relationship to any budget around it. Deriving it is the
    // point; this fails if anyone puts a constant back.
    const limits = new Set(ALL.map(recursionLimitFor));
    expect(limits.size).toBeGreaterThan(1);
  });
});

describe("auto is reachable, and bounded", () => {
  it("is selectable now that arming and the checkpoint exist", () => {
    /**
     * This assertion is the inverse of the one it replaces, and the inversion is the point.
     *
     * Auto was deliberately absent from the list while the two things that bound it did not
     * exist. `SELECTABLE_MODES` is what `agent:open`'s enum is built from, so adding the
     * string is the switch — and it belonged in the change that also built arming and the run
     * checkpoint, which is this one.
     */
    expect(SELECTABLE_MODES).toContain("auto");
    expect(isSelectableMode("auto")).toBe(true);
  });

  it("still defaults to a mode that asks before writing", () => {
    // Selectable is not the same as default. Shipping Auto as the default would be a decision
    // nobody made.
    expect(isSelectableMode(DEFAULT_MODE)).toBe(true);
    expect(POLICIES[DEFAULT_MODE].autoApply).toBe(false);
    expect(DEFAULT_MODE).not.toBe("auto");
  });

  /**
   * The source with its prose removed.
   *
   * Every assertion below was written against the raw file first, and three of them passed
   * under mutations that deleted the code — because the *comment explaining* the code still
   * contained the phrase being searched for. A docstring that names `policy.autoApply` is not
   * evidence that anything reads it.
   */
  const codeOf = (relative: string): string =>
    readFileSync(join(__dirname, "..", relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("writes nothing without an armed window", () => {
    /**
     * The gate is a conjunction, so both halves are asserted.
     *
     * `policy.autoApply` is the mode saying this is an unattended run; `isArmed` is a human
     * having said so, for this window and this project. Either alone is not enough, and a
     * renderer can supply only the first.
     */
    const stream = codeOf("src/main/agent/stream.ts");
    expect(stream).toMatch(/if\s*\(policy\.autoApply\s*&&/);
    expect(stream).toContain("if (!isArmed(sender, projectRoot))");
    // And the bypass is the named witness, never a lambda that returns true.
    expect(stream).toContain("armed: true");
    expect(stream).not.toMatch(/approve:\s*async\s*\(\)\s*=>\s*true/);
  });

  it("takes a checkpoint before it writes, not after", () => {
    // A crash between the two must leave a recoverable project rather than an overwritten one,
    // so the ordering is the design and not an implementation detail.
    const stream = codeOf("src/main/agent/stream.ts");
    const capture = stream.indexOf("await captureBeforeWrite(runId");
    const commit = stream.indexOf("commitAgentDiffs(sender");
    expect(capture, "nothing captures a checkpoint").toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(capture);
  });

  it("does not promise the user unconditional review anywhere in the UI", () => {
    /**
     * The claim that outlived the control, in the place it matters most.
     *
     * "Nothing is written without your review" was in two empty states, and Auto made it
     * false. It is the same failure as the persona describing a tool it did not have and
     * `dispatch.ts` asserting a confinement it no longer had — except a comment misleads the
     * next developer, and this misleads the user about whether their files are safe.
     *
     * The assistant's empty state now renders `MODE_HELP[agentMode]`, so it cannot disagree
     * with the mode it is describing. The workspace's says "by default", which is true:
     * `DEFAULT_MODE` asks before writing.
     *
     * `WorkspaceSurface.tsx` is on this list because the sentence moved there when the right
     * pane grew tabs — and this test failed at that commit, which is the only reason the check
     * did not quietly end up pointed at a file that no longer contains the claim. A guard that
     * follows the code only because someone remembered is not a guard.
     */
    for (const file of [
      "renderer/src/components/Build/AssistantPanel.tsx",
      "renderer/src/components/Build/BuildWorkspace.tsx",
      "renderer/src/components/Build/WorkspaceSurface.tsx",
    ]) {
      const code = codeOf(file);
      expect(code, `${file} still promises unconditional review`).not.toMatch(
        /Nothing is written without your review/
      );
    }

    // And the accurate replacements are actually there, so this cannot pass by the strings
    // simply having been deleted.
    expect(codeOf("renderer/src/components/Build/AssistantPanel.tsx")).toContain(
      "body={MODE_HELP[agentMode]}"
    );
    expect(codeOf("renderer/src/components/Build/WorkspaceSurface.tsx")).toContain("By default");
  });

  it("describes Auto to the user as writing without review", () => {
    // The other direction: the mode's own description has to say what it costs, or moving the
    // empty state onto `MODE_HELP` would just make it accurate-but-empty.
    expect(MODE_HELP.auto).toMatch(/straight to disk/i);
    expect(MODE_HELP.auto).toMatch(/commands cannot/i);
    expect(MODE_HELP.acceptEdits).toMatch(/review/i);
  });

  it("records what it wrote, rather than only showing it", () => {
    /**
     * The audit half, which was missing and had to be found by running the thing.
     *
     * `autoApply` posted its steps straight to the port, so "Wrote src/a.ts" appeared in the
     * panel and nothing reached `agent_steps`. For a mode that writes unattended that is
     * exactly backwards: the transcript is the only account left once the window closes, and
     * the steps most worth keeping are the ones about writes nobody reviewed. Migration 12
     * rebuilt a table so `applied` and `command` could be stored — for nothing, if the write
     * path bypasses the recorder.
     */
    const stream = codeOf("src/main/agent/stream.ts");
    // One emitter, used by the graph and by the write path alike.
    expect(stream).toContain("recordStep(runId, seq++, step)");
    expect(stream).toContain('emitStep({ kind: "applied"');
    /**
     * Exactly one place records a step.
     *
     * There were two before this: `emitStep`, and a hand-rolled copy for the unverified-model
     * warning. Two copies of record-then-post is how one of them ends up missing the record —
     * which is the bug this test was written for, found in the other direction.
     */
    expect(stream.match(/recordStep\(/g) ?? []).toHaveLength(1);
  });

  it("only offers a whole undo when every file was covered", () => {
    /**
     * `captureBeforeWrite` reports whether it recorded the path, and that report has to be
     * READ — returning it and ignoring it is the same bug with an extra step.
     *
     * Two ways coverage is lost and both must count: the capture throwing, and the checkpoint
     * reaching its bound and quietly stopping. Only the first was detected before, so a run
     * that wrote past 200 files still got a clean-looking "Undo file changes" and the user
     * learned it was partial after pressing it.
     */
    const stream = codeOf("src/main/agent/stream.ts");
    expect(stream).toContain("const { recorded } = await captureBeforeWrite");
    expect(stream).toContain("if (!recorded) covered = false;");
    expect(stream).toContain("revertable: covered && written.length > 0");
  });

  it("stops offering applied diffs for approval", () => {
    /**
     * Once a diff is on disk it is not awaiting anything.
     *
     * Reporting it as still proposed would put an Apply button in the panel for files that
     * were written minutes ago — and pressing it would open the review dialog for a change
     * that already happened.
     */
    const stream = codeOf("src/main/agent/stream.ts");
    expect(stream).toContain("applied === undefined ? result.proposedDiffIds : []");
  });

  it("records a command as its own kind, not as a generic tool", () => {
    // The whole reason migration 12 rebuilt a table. An audit log that files a shell
    // invocation under the same label as reading a file cannot answer the one question it
    // exists for.
    const graph = readFileSync(join(__dirname, "../src/main/agent/graph.ts"), "utf8");
    expect(graph).toContain('result.name === "run_command" ? "command"');
  });
});

describe("the mode reaches main from the composer", () => {
  /**
   * Four hops, each a separate edit somebody can forget: the composer sends it, the stream
   * helper carries it, the preload type admits it, and the contract validates it. Phase D
   * shipped a delete button whose route was missing from exactly this kind of chain, and
   * nothing failed.
   *
   * Source assertions rather than behavioural ones, for the same reason as there: the failure
   * being prevented is a *missing declaration*, which exercising the happy path cannot reveal.
   */
  const read = (relative: string): string =>
    readFileSync(join(__dirname, "..", relative), "utf8");

  it("is declared at every hop", () => {
    expect(read("renderer/src/components/Build/AssistantPanel.tsx")).toContain("mode: agentMode");
    expect(read("renderer/src/lib/build/agent-stream.ts")).toContain("mode?: SelectableMode");
    expect(read("renderer/src/types/host.d.ts")).toContain('mode?: "plan" | "manual" | "acceptEdits"');
    expect(read("src/main/ipc/contract.ts")).toContain("mode: z.enum(SELECTABLE_MODES)");
    // Bound to a local now rather than passed inline, because `withOpenFile` needs the same
    // value — the mode decides whether the open file is named or inlined. Same derivation, one
    // line up.
    expect(read("src/main/ipc/handlers/index.ts")).toContain(
      "const agentMode = input.mode ?? DEFAULT_MODE"
    );
  });

  it("offers the renderer exactly the modes main will accept", () => {
    /**
     * The composer iterates `SELECTABLE_MODES` and the contract's enum is built from it, so
     * they agree by construction — and this asserts that neither has been replaced by a
     * hand-written list, which is what would let a dropdown offer a mode main rejects.
     */
    expect(read("renderer/src/components/Build/AssistantPanel.tsx")).toContain(
      "SELECTABLE_MODES.map"
    );
    expect(read("src/main/ipc/contract.ts")).not.toMatch(/mode:\s*z\.enum\(\[/);
  });

  it("keeps the window mode and the agent mode distinguishable in main", () => {
    // `mode` already means WindowMode throughout main, including `ctx.mode` in the very
    // handler that builds the run context. Two different things called `mode` one line apart
    // is how the wrong one gets passed, and both are strings.
    expect(read("src/main/agent/graph.ts")).toContain("agentMode: AgentMode");
    expect(read("src/main/agent/graph.ts")).not.toMatch(/^\s+mode: AgentMode;/m);
  });
});
