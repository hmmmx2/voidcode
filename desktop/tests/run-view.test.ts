/**
 * The right pane's data, derived from the transcript.
 *
 * The two properties worth having are the two the fields are scoped differently for: **steps
 * belong to one run**, so a new turn must not stack its work on top of the last one's, and **a
 * plan outlives the turn that wrote it**, because the usual shape of planning is that one turn
 * plans and later turns carry it out — a plan that vanished when work started would disappear
 * exactly when someone wanted to look at it.
 */
import { describe, it, expect } from "vitest";
import { runViewOf, EMPTY_RUN_VIEW } from "../renderer/src/lib/build/run-view";
import { parseWorkspaceTab, WORKSPACE_TABS, DEFAULT_WORKSPACE_TAB, WORKSPACE_TAB_LABELS } from "../renderer/src/lib/build/workspace-tabs";
import type { PlanDoc } from "../src/shared/plan.js";

const plan = (title: string): PlanDoc => ({
  title,
  steps: [{ title: "a", status: "pending" }],
});

/**
 * The step shape this file tests with.
 *
 * Named rather than inline so `runViewOf`'s generic infers it: from a bare object literal the
 * inference collapses to `StepLike`, and excess-property checking then rejects `kind` and `text`
 * as fields that shape does not have.
 */
interface TestStep {
  kind: string;
  text: string;
  plan?: PlanDoc;
}

const step = (text: string, extra: Partial<TestStep> = {}): { kind: string; step: TestStep } => ({
  kind: "step",
  step: { kind: "tool", text, ...extra },
});

const user = (text: string) => ({ role: "user" as const, text, imageCount: 0 });
const assistant = (...blocks: ReturnType<typeof step>[]) => ({
  role: "assistant" as const,
  blocks,
});

/** A turn whose blocks are not all well-formed — what the two tolerance tests need. */
const looseTurn = (blocks: Array<{ kind: string; step?: TestStep }>) => ({
  role: "assistant" as const,
  blocks,
});

describe("runViewOf", () => {
  it("is empty for an empty transcript", () => {
    expect(runViewOf([])).toEqual(EMPTY_RUN_VIEW);
  });

  it("ignores user turns", () => {
    expect(runViewOf([user("hello"), user("again")])).toEqual(EMPTY_RUN_VIEW);
  });

  it("does not let a user turn clear the last run's steps", () => {
    /**
     * The `role !== "assistant"` guard, asserted as behaviour rather than as a line of code.
     *
     * `AssistantPanel` pushes the user turn and an empty assistant turn together, so today a
     * transcript never ends on a user turn and the guard changes nothing there. That is the
     * caller's invariant, not this function's — it takes a structural shape and must be right
     * for any caller, including one that appends the user's message first and starts the run
     * afterwards. Without the guard that caller would blank the pane between the two.
     */
    const view = runViewOf([user("q"), assistant(step("a"), step("b")), user("q2")]);
    expect(view.steps.map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("collects the steps of an assistant turn in order", () => {
    const view = runViewOf([user("q"), assistant(step("one"), step("two"))]);
    expect(view.steps.map((s) => s.text)).toEqual(["one", "two"]);
  });

  it("scopes steps to the last run, not the whole conversation", () => {
    // A turn is a run — its own id, its own row in agent_runs. Stacking two runs' steps under
    // one heading makes the count mean nothing.
    const view = runViewOf([
      user("first"),
      assistant(step("old-a"), step("old-b")),
      user("second"),
      assistant(step("new")),
    ]);
    expect(view.steps.map((s) => s.text)).toEqual(["new"]);
  });

  it("clears the previous run's steps when a turn runs no tools", () => {
    // The reason `steps` is reset per turn rather than filtered at the end. Answering from
    // memory is a real turn, and it must not leave the last run's work on screen under it.
    const view = runViewOf([user("q"), assistant(step("old")), user("q2"), assistant()]);
    expect(view.steps).toEqual([]);
  });

  it("keeps the plan across later turns", () => {
    // The asymmetry this module exists for: one turn plans, later turns carry it out.
    const view = runViewOf([
      user("plan it"),
      assistant(step("planned", { plan: plan("The plan") })),
      user("now do it"),
      assistant(step("working")),
    ]);
    expect(view.plan?.title).toBe("The plan");
    expect(view.steps.map((s) => s.text)).toEqual(["working"]);
  });

  it("takes the most recent plan when the model reconsiders", () => {
    const view = runViewOf([
      assistant(step("a", { plan: plan("First") }), step("b", { plan: plan("Second") })),
    ]);
    expect(view.plan?.title).toBe("Second");
  });

  it("keeps a plan from an earlier turn when a later one replans", () => {
    const view = runViewOf([
      assistant(step("a", { plan: plan("First") })),
      assistant(step("b", { plan: plan("Second") })),
    ]);
    expect(view.plan?.title).toBe("Second");
  });

  it("is null when nothing planned", () => {
    expect(runViewOf([assistant(step("a"), step("b"))]).plan).toBeNull();
  });

  it("ignores non-step blocks and steps with no payload", () => {
    // Prose blocks share the array with steps, and a malformed block must not become a row.
    const view = runViewOf([
      looseTurn([{ kind: "text" }, { kind: "step" }, step("real")]),
    ]);
    expect(view.steps.map((s) => s.text)).toEqual(["real"]);
  });

  it("treats the block's kind as authoritative, not the presence of a payload", () => {
    /**
     * Two conditions guard the loop, and this separates them.
     *
     * `block.kind !== "step" || block.step === undefined` reads as one check but is two, and a
     * transcript where every text block lacks a payload cannot tell them apart — dropping the
     * `kind` half passes such a test unchanged. A block that says it is prose is prose, whatever
     * else is hanging off it.
     */
    const view = runViewOf([
      looseTurn([
        { kind: "text", step: { kind: "tool", text: "smuggled", plan: plan("Ghost") } },
        step("real"),
      ]),
    ]);
    expect(view.steps.map((s) => s.text)).toEqual(["real"]);
    expect(view.plan).toBeNull();
  });

  it("tolerates an assistant turn with no blocks at all", () => {
    expect(runViewOf([{ role: "assistant" as const }])).toEqual(EMPTY_RUN_VIEW);
  });
});

describe("parseWorkspaceTab", () => {
  it("accepts every tab this build has", () => {
    for (const tab of WORKSPACE_TABS) expect(parseWorkspaceTab(tab)).toBe(tab);
  });

  it("falls back for a surface this build does not have", () => {
    /**
     * Not an error — a newer build wrote a name this one has no surface for, and an older build
     * opens where it can.
     *
     * The examples here have been rewritten twice, because both were real tabs by the next part:
     * `preview` in Part 4 and `design` in Part 5. That is the parser doing exactly its job, and
     * the reason it is written against the list rather than a literal union.
     */
    expect(parseWorkspaceTab("code")).toBe(DEFAULT_WORKSPACE_TAB);
    expect(parseWorkspaceTab("terminal")).toBe(DEFAULT_WORKSPACE_TAB);
  });

  it("falls back for what a hand-edited document can actually hold", () => {
    for (const value of [undefined, null, 3, {}, [], ""]) {
      expect(parseWorkspaceTab(value)).toBe(DEFAULT_WORKSPACE_TAB);
    }
  });

  it("does not accept an inherited property name as a tab", () => {
    // The reason membership is tested against the array. `"__proto__" in {}` and
    // `({})["toString"]` are both truthy, so a lookup table would accept these and fail later.
    expect(parseWorkspaceTab("__proto__")).toBe(DEFAULT_WORKSPACE_TAB);
    expect(parseWorkspaceTab("toString")).toBe(DEFAULT_WORKSPACE_TAB);
    expect(parseWorkspaceTab("constructor")).toBe(DEFAULT_WORKSPACE_TAB);
  });

  it("labels every tab", () => {
    // A tab added to the list without a label would render as an empty button.
    for (const tab of WORKSPACE_TABS) {
      expect(WORKSPACE_TAB_LABELS[tab]).toBeTruthy();
    }
    expect(Object.keys(WORKSPACE_TAB_LABELS)).toHaveLength(WORKSPACE_TABS.length);
  });

  it("has a default that is one of its tabs", () => {
    expect(WORKSPACE_TABS).toContain(DEFAULT_WORKSPACE_TAB);
  });
});
