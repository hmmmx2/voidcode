/**
 * Plans as data.
 *
 * The thing under test is not "a plan can be saved" but **a plan is either well-formed or
 * absent**. Every consumer of one is a panel that renders it, and a panel given a step with no
 * title draws an empty row while a status outside the union becomes a class name matching no
 * style. Both fail by looking slightly wrong, which is the failure mode that survives longest.
 *
 * So `parseStoredPlan` refuses rather than repairs, and the tests below are mostly about the
 * refusals — a parser is only as good as what it declines.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebContents } from "electron";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { parseStoredPlan, planProgress, PLAN_VERSION } = await import("../src/shared/plan.js");
const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const { beginRun, recordPlan, planForRun } = await import("../src/main/store/agent.js");
const { dispatchTool, newBudget } = await import("../src/main/agent/dispatch.js");
const { toolsForSurface } = await import("../src/main/inference/personas.js");

const ROOT = "/projects/alpha";

/** A minimal valid stored envelope, for tests that break exactly one thing about it. */
const stored = (doc: unknown) => ({ version: PLAN_VERSION, doc });

const goodDoc = {
  title: "Add the plan pane",
  steps: [
    { title: "Read the store", status: "done" },
    { title: "Write the table", status: "active", files: ["src/main/store/db.ts"] },
    { title: "Render it", status: "pending", detail: "right pane" },
  ],
};

describe("parseStoredPlan", () => {
  it("round-trips a complete document", () => {
    expect(parseStoredPlan(stored(goodDoc))).toEqual(goodDoc);
  });

  it("declines a version it does not know", () => {
    // The whole reason the version is stored beside the document. An old build meeting a new
    // shape must show nothing rather than show it wrongly.
    expect(parseStoredPlan({ version: PLAN_VERSION + 1, doc: goodDoc })).toBeNull();
    expect(parseStoredPlan({ version: PLAN_VERSION - 1, doc: goodDoc })).toBeNull();
    expect(parseStoredPlan({ doc: goodDoc })).toBeNull();
  });

  it("declines a step with no title", () => {
    // Renders as an empty row, which reads as a UI bug rather than as bad data.
    expect(parseStoredPlan(stored({ ...goodDoc, steps: [{ title: "", status: "pending" }] }))).toBeNull();
  });

  it("declines a status outside the union", () => {
    // Becomes a class name that matches no style — the step silently loses its state.
    expect(
      parseStoredPlan(stored({ ...goodDoc, steps: [{ title: "x", status: "blocked" }] }))
    ).toBeNull();
    expect(parseStoredPlan(stored({ ...goodDoc, steps: [{ title: "x" }] }))).toBeNull();
  });

  it("declines an empty plan", () => {
    // A title with no steps is not a plan, and a pane showing one has nothing to say.
    expect(parseStoredPlan(stored({ title: "t", steps: [] }))).toBeNull();
    expect(parseStoredPlan(stored({ title: "", steps: goodDoc.steps }))).toBeNull();
  });

  it("declines the shapes a JSON column can actually hold", () => {
    for (const value of [null, undefined, 42, "a plan", [], stored(null), stored([])]) {
      expect(parseStoredPlan(value)).toBeNull();
    }
  });

  it("drops optional fields rather than keeping a wrong type", () => {
    // `files` is rendered as a list. A string there would spread into characters.
    const parsed = parseStoredPlan(
      stored({ title: "t", steps: [{ title: "s", status: "pending", detail: 7, files: "a.ts" }] })
    );
    expect(parsed?.steps[0]).toEqual({ title: "s", status: "pending" });
  });

  it("declines a files array holding a non-string", () => {
    const parsed = parseStoredPlan(
      stored({ title: "t", steps: [{ title: "s", status: "pending", files: ["a.ts", 3] }] })
    );
    expect(parsed?.steps[0]?.files).toBeUndefined();
  });
});

describe("planProgress", () => {
  it("counts only the done steps", () => {
    expect(planProgress(goodDoc as never)).toEqual({ done: 1, total: 3 });
  });

  it("does not count an active step as done", () => {
    // The distinction the pane exists to show. Counting `active` would report a run as
    // finished while it is still working.
    expect(planProgress({ title: "t", steps: [{ title: "a", status: "active" }] })).toEqual({
      done: 0,
      total: 1,
    });
  });
});

describe("the agent_plans table", () => {
  beforeEach(() => {
    __useInMemory();
  });

  it("round-trips a plan through SQLite", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordPlan(runId, goodDoc as never);
    expect(planForRun(ROOT, runId)).toEqual(goodDoc);
  });

  it("replaces an earlier plan rather than keeping both", () => {
    // A second write_plan is the model reconsidering. Two rows would leave the pane guessing.
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordPlan(runId, goodDoc as never);
    recordPlan(runId, { title: "Rethought", steps: [{ title: "only", status: "pending" }] });

    expect(planForRun(ROOT, runId)?.title).toBe("Rethought");
    const rows = openDatabase().prepare(`SELECT COUNT(*) AS n FROM agent_plans`).get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("returns null for a run with no plan, and for an unknown run", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    expect(planForRun(ROOT, runId)).toBeNull();
    expect(planForRun(ROOT, "no-such-run")).toBeNull();
  });

  it("returns null rather than throwing on a corrupt row", () => {
    // Not hypothetical: this column is the one place a hand-edited or half-written value can
    // reach a JSON.parse. A crash here would take down a run that has nothing to do with plans.
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordPlan(runId, goodDoc as never);
    openDatabase().prepare(`UPDATE agent_plans SET state = ?`).run("{not json");
    expect(planForRun(ROOT, runId)).toBeNull();
  });

  it("is not readable from a window holding a different project", () => {
    // The rule stepsFor follows, and the reason planForRun takes a root at all. Run ids are
    // uuids, and unguessable is not an access control — the scoping is in the query, so a run
    // from another repository returns nothing rather than being filtered after the fact.
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordPlan(runId, goodDoc as never);

    expect(planForRun("/projects/beta", runId)).toBeNull();
    expect(planForRun(ROOT, runId)).toEqual(goodDoc);
  });

  it("goes with the run it belongs to", () => {
    // ON DELETE CASCADE, which only works because openDatabase turns foreign_keys on — it is
    // off by default in SQLite, per connection.
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordPlan(runId, goodDoc as never);
    openDatabase().prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    expect(planForRun(ROOT, runId)).toBeNull();
  });
});

describe("the write_plan tool", () => {
  /** The modules only ever read `.id` off a sender, and `write_plan` never touches one. */
  const sender = { id: 1, once: () => {}, isDestroyed: () => false } as unknown as WebContents;

  const call = (args: unknown) =>
    dispatchTool(
      sender,
      { id: "c1", name: "write_plan", argumentsJson: JSON.stringify(args) },
      toolsForSurface("assistant"),
      newBudget(Date.now())
    );

  it("returns the plan as a document, every step pending", async () => {
    // Status is not an argument. A plan is written before any of it happens, so the only
    // honest answer is "none of it" — and a model that could set status could report a step
    // done in the same call that invented it.
    const result = await call({
      title: "Ship it",
      steps: [{ title: "one" }, { title: "two", detail: "d", files: ["a.ts"] }],
    });

    expect(result.isError).toBe(false);
    expect(result.plan).toEqual({
      title: "Ship it",
      steps: [
        { title: "one", status: "pending" },
        { title: "two", status: "pending", detail: "d", files: ["a.ts"] },
      ],
    });
  });

  it("produces a document parseStoredPlan accepts", () => {
    // The two halves of the contract, checked against each other rather than separately: the
    // tool builds it, the parser guards it, and nothing forces them to agree but this.
    return call({ title: "t", steps: [{ title: "s" }] }).then((result) => {
      expect(parseStoredPlan(stored(result.plan))).toEqual(result.plan);
    });
  });

  /**
   * The shapes real models send, normalised rather than refused.
   *
   * Every case below was captured from Ollama driving the models `unwrapped.ts` recommends for
   * tool use — not invented to make a parser look tolerant. Without this, `write_plan` is a tool
   * llama3.1:8b can call and never satisfy.
   */
  describe("the shapes real models send", () => {
    it("accepts a JSON-encoded steps array", async () => {
      // llama3.1:8b, verbatim shape: the array arrives as a string.
      const result = await call({
        title: "Adding a CHANGELOG.md",
        steps: JSON.stringify([
          { title: "Create the file", detail: "At the root.", files: [] },
          { title: "Write the first entry" },
        ]),
      });
      expect(result.isError).toBe(false);
      expect(result.plan?.steps.map((s) => s.title)).toEqual([
        "Create the file",
        "Write the first entry",
      ]);
    });

    it("accepts bare strings as steps", async () => {
      const result = await call({ title: "t", steps: ["Create the file", "Write the entry"] });
      expect(result.isError).toBe(false);
      expect(result.plan?.steps).toEqual([
        { title: "Create the file", status: "pending" },
        { title: "Write the entry", status: "pending" },
      ]);
    });

    it("accepts a JSON-encoded array of bare strings", async () => {
      // Both quirks at once, which is what the flat-schema runs actually produced.
      const result = await call({ title: "t", steps: JSON.stringify(["One", "Two"]) });
      expect(result.plan?.steps.map((s) => s.title)).toEqual(["One", "Two"]);
    });

    it("still refuses a string that is not an encoded array", async () => {
      // Normalising must not become "accept anything". Prose where steps belong is a mistake
      // the model needs told about, and the message should be about the type.
      const result = await call({ title: "t", steps: "first do this, then that" });
      expect(result.isError).toBe(true);
    });

    it("still refuses encoded JSON that is not an array", async () => {
      expect((await call({ title: "t", steps: JSON.stringify({ a: 1 }) })).isError).toBe(true);
      expect((await call({ title: "t", steps: JSON.stringify("x") })).isError).toBe(true);
    });

    it("still refuses a step object that is malformed after normalising", async () => {
      // The bound stays where it was: normalising changes the shape, never the rules.
      expect((await call({ title: "t", steps: [{ detail: "no title" }] })).isError).toBe(true);
      expect((await call({ title: "t", steps: [""] })).isError).toBe(true);
      expect((await call({ title: "t", steps: JSON.stringify([]) })).isError).toBe(true);
      expect((await call({ title: "t", steps: [{ title: "x", status: "done" }] })).isError).toBe(
        true
      );
    });

    it("does not let encoding smuggle past the length bound", async () => {
      const many = Array.from({ length: 31 }, (_, i) => `step ${String(i)}`);
      expect((await call({ title: "t", steps: JSON.stringify(many) })).isError).toBe(true);
    });
  });

  it("refuses a plan with no steps, as an answer rather than a throw", async () => {
    // The rule the whole dispatcher is built on: a bad call comes back as text the model can
    // read and correct. Throwing would end the run and look like the model simply stopping.
    const result = await call({ title: "t", steps: [] });
    expect(result.isError).toBe(true);
    expect(result.plan).toBeUndefined();
  });

  it("refuses a step that carries no title at all", async () => {
    // A bare string used to be refused here too. It is now read as the step's title — see the
    // normalising block below, and `planSteps` for the two model behaviours that drove it. What
    // stays refused is a step with no title anywhere in it, which is not a step.
    expect((await call({ title: "t", steps: [{ detail: "no title" }] })).isError).toBe(true);
    expect((await call({ title: "t", steps: [42] })).isError).toBe(true);
    expect((await call({ title: "", steps: [{ title: "s" }] })).isError).toBe(true);
  });

  it("refuses a status the model tried to set itself", async () => {
    // `.strict()` — the schema rejects unknown keys rather than dropping them, so a model that
    // invents `status` is told, instead of quietly having it ignored.
    const result = await call({ title: "t", steps: [{ title: "s", status: "done" }] });
    expect(result.isError).toBe(true);
  });

  it("refuses a plan too long to be a plan", async () => {
    const steps = Array.from({ length: 31 }, (_, i) => ({ title: `step ${String(i)}` }));
    expect((await call({ title: "t", steps })).isError).toBe(true);
    // The boundary itself is allowed — an off-by-one here silently costs a step.
    expect((await call({ title: "t", steps: steps.slice(0, 30) })).isError).toBe(false);
  });
});
