/**
 * A design as a specification, and the check that makes it one.
 *
 * A spec saying "a muted grey border" is a sentence someone has to interpret. One saying
 * `color-line` is a claim about the project, and `unknownTokens` is what turns that claim into a
 * finding — a design naming three tokens the codebase does not have is a design that will not
 * build, and the point is to know before anyone writes the CSS rather than after.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebContents } from "electron";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { parseStoredDesignSpec, unknownTokens, DESIGN_SPEC_VERSION } = await import(
  "../src/shared/design.js"
);
const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const { beginRun, recordDesign, designForRun } = await import("../src/main/store/agent.js");
const { dispatchTool, newBudget } = await import("../src/main/agent/dispatch.js");
const { toolsForSurface } = await import("../src/main/inference/personas.js");
const { parseCssTokens } = await import("../src/main/design/tokens.js");

const ROOT = "/projects/alpha";
const stored = (doc: unknown) => ({ version: DESIGN_SPEC_VERSION, doc });

const goodDoc = {
  title: "The workspace pane",
  intent: "Show the conversation's artefacts without becoming an editor.",
  sections: [
    { name: "Tab strip", purpose: "Switch surfaces.", tokens: ["color-line", "color-ink-3"] },
    { name: "Empty state", purpose: "Say what will appear.", notes: ["Centred", "No action"] },
  ],
};

describe("parseStoredDesignSpec", () => {
  it("round-trips a complete document", () => {
    expect(parseStoredDesignSpec(stored(goodDoc))).toEqual(goodDoc);
  });

  it("declines a version it does not know", () => {
    expect(parseStoredDesignSpec({ version: DESIGN_SPEC_VERSION + 1, doc: goodDoc })).toBeNull();
    expect(parseStoredDesignSpec({ doc: goodDoc })).toBeNull();
  });

  it("declines a section with no name", () => {
    // Renders as an empty heading, which reads as a UI bug rather than as bad data.
    const doc = { ...goodDoc, sections: [{ name: "", purpose: "x" }] };
    expect(parseStoredDesignSpec(stored(doc))).toBeNull();
    expect(parseStoredDesignSpec(stored({ ...goodDoc, sections: [{ purpose: "x" }] }))).toBeNull();
  });

  it("declines a spec with no title or no sections", () => {
    expect(parseStoredDesignSpec(stored({ ...goodDoc, title: "" }))).toBeNull();
    expect(parseStoredDesignSpec(stored({ ...goodDoc, sections: [] }))).toBeNull();
  });

  it("declines the shapes a JSON column can actually hold", () => {
    for (const value of [null, undefined, 7, "spec", [], stored(null), stored([])]) {
      expect(parseStoredDesignSpec(value)).toBeNull();
    }
  });

  it("drops an optional array rather than keeping a wrong type", () => {
    // `tokens` is rendered as a list of chips. A number in it becomes a chip with nothing in it.
    const doc = {
      ...goodDoc,
      sections: [{ name: "n", purpose: "p", tokens: ["ok", 3], notes: "not an array" }],
    };
    expect(parseStoredDesignSpec(stored(doc))?.sections[0]).toEqual({ name: "n", purpose: "p" });
  });
});

describe("unknownTokens", () => {
  const known = ["color-ink", "color-line", "radius-md"];

  it("says nothing when every token exists", () => {
    expect(unknownTokens(goodDoc as never, ["color-line", "color-ink-3"])).toEqual([]);
  });

  it("names the tokens the project does not have", () => {
    // What a model reaches for when it has only partly read the codebase: the name most
    // codebases use, rather than the name this one does.
    const spec = {
      ...goodDoc,
      sections: [{ name: "n", purpose: "p", tokens: ["color-primary", "color-ink", "spacing-lg"] }],
    };
    expect(unknownTokens(spec, known)).toEqual(["color-primary", "spacing-lg"]);
  });

  it("ignores the leading dashes either side writes", () => {
    // The two halves come from different places: `tokens.ts` reports `color-ink` from
    // `--color-ink:`, and a model writes whichever spelling it saw last. Not a real disagreement.
    const spec = { ...goodDoc, sections: [{ name: "n", purpose: "p", tokens: ["--color-ink"] }] };
    expect(unknownTokens(spec, known)).toEqual([]);
    expect(unknownTokens(spec, ["--color-ink"])).toEqual([]);
  });

  it("reports each missing token once, in the spec's own spelling", () => {
    // Once, so a token used in six sections is one finding. In the spec's spelling, so a reader
    // can find it in the document.
    const spec = {
      ...goodDoc,
      sections: [
        { name: "a", purpose: "p", tokens: ["--color-primary"] },
        { name: "b", purpose: "p", tokens: ["color-primary"] },
      ],
    };
    expect(unknownTokens(spec, known)).toEqual(["--color-primary"]);
  });

  it("ignores a token that is nothing but dashes or space", () => {
    const spec = { ...goodDoc, sections: [{ name: "n", purpose: "p", tokens: ["--", "  ", ""] }] };
    expect(unknownTokens(spec, known)).toEqual([]);
  });

  it("says every token is unknown when the project declares none", () => {
    // A project with no tokens file at all. The honest answer, and the panel's cue to say so.
    expect(unknownTokens(goodDoc as never, [])).toEqual(["color-line", "color-ink-3"]);
  });

  it("checks against tokens parsed from real CSS, not a hand-written list", () => {
    // The two halves, joined — which is the only place their spellings are forced to agree.
    const css = `:root { --gray-950: #0a0a0a; } @theme inline { --color-ink: var(--gray-950); }`;
    const known2 = parseCssTokens(css).map((t) => t.name);
    const spec = {
      ...goodDoc,
      sections: [{ name: "n", purpose: "p", tokens: ["color-ink", "color-nope"] }],
    };
    expect(unknownTokens(spec, known2)).toEqual(["color-nope"]);
  });
});

describe("the agent_designs table", () => {
  beforeEach(() => {
    __useInMemory();
  });

  it("round-trips a spec through SQLite", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordDesign(runId, goodDoc as never);
    expect(designForRun(ROOT, runId)).toEqual(goodDoc);
  });

  it("replaces an earlier spec rather than keeping both", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordDesign(runId, goodDoc as never);
    recordDesign(runId, { title: "Rethought", intent: "i", sections: [{ name: "s", purpose: "p" }] });

    expect(designForRun(ROOT, runId)?.title).toBe("Rethought");
    const rows = openDatabase().prepare(`SELECT COUNT(*) AS n FROM agent_designs`).get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("is not readable from a window holding a different project", () => {
    // The rule stepsFor and planForRun follow. Run ids are uuids, and unguessable is not an
    // access control.
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordDesign(runId, goodDoc as never);
    expect(designForRun("/projects/beta", runId)).toBeNull();
    expect(designForRun(ROOT, runId)).toEqual(goodDoc);
  });

  it("returns null rather than throwing on a corrupt row", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordDesign(runId, goodDoc as never);
    openDatabase().prepare(`UPDATE agent_designs SET state = ?`).run("{not json");
    expect(designForRun(ROOT, runId)).toBeNull();
  });

  it("goes with the run it belongs to", () => {
    const runId = beginRun({ projectRoot: ROOT, question: "q", provider: "ollama", model: "m" });
    recordDesign(runId, goodDoc as never);
    openDatabase().prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    expect(designForRun(ROOT, runId)).toBeNull();
  });
});

describe("the write_design_spec tool", () => {
  const sender = { id: 1, once: () => {}, isDestroyed: () => false } as unknown as WebContents;

  const call = (args: unknown) =>
    dispatchTool(
      sender,
      { id: "c1", name: "write_design_spec", argumentsJson: JSON.stringify(args) },
      toolsForSurface("assistant"),
      newBudget(Date.now())
    );

  it("returns the spec as a document", async () => {
    const result = await call({
      title: "Pane",
      intent: "Show artefacts.",
      sections: [{ name: "Strip", purpose: "Switch.", tokens: ["color-line"], notes: ["36px"] }],
    });

    expect(result.isError).toBe(false);
    expect(result.design).toEqual({
      title: "Pane",
      intent: "Show artefacts.",
      sections: [{ name: "Strip", purpose: "Switch.", tokens: ["color-line"], notes: ["36px"] }],
    });
  });

  it("produces a document parseStoredDesignSpec accepts", async () => {
    // The two halves checked against each other rather than separately: the tool builds it, the
    // parser guards it, and nothing forces them to agree but this.
    const result = await call({ title: "t", intent: "i", sections: [{ name: "n", purpose: "p" }] });
    expect(parseStoredDesignSpec(stored(result.design))).toEqual(result.design);
  });

  it("accepts a JSON-encoded tokens array", async () => {
    // The same quirk `planSteps` normalises: llama3.1:8b sends nested arrays as strings.
    const result = await call({
      title: "t",
      intent: "i",
      sections: [{ name: "n", purpose: "p", tokens: JSON.stringify(["color-ink", "radius-md"]) }],
    });
    expect(result.isError).toBe(false);
    expect(result.design?.sections[0]?.tokens).toEqual(["color-ink", "radius-md"]);
  });

  it("refuses a spec with no sections, as an answer rather than a throw", async () => {
    const result = await call({ title: "t", intent: "i", sections: [] });
    expect(result.isError).toBe(true);
    expect(result.design).toBeUndefined();
  });

  it("refuses a section missing its name or purpose", async () => {
    expect((await call({ title: "t", intent: "i", sections: [{ name: "n" }] })).isError).toBe(true);
    expect((await call({ title: "t", intent: "i", sections: [{ purpose: "p" }] })).isError).toBe(
      true
    );
    expect((await call({ title: "", intent: "i", sections: [{ name: "n", purpose: "p" }] })).isError).toBe(
      true
    );
  });

  it("refuses a design too long to be one screen", async () => {
    const sections = Array.from({ length: 13 }, (_, i) => ({ name: `s${String(i)}`, purpose: "p" }));
    expect((await call({ title: "t", intent: "i", sections })).isError).toBe(true);
    // The boundary itself is allowed — an off-by-one here silently costs a section.
    expect((await call({ title: "t", intent: "i", sections: sections.slice(0, 12) })).isError).toBe(
      false
    );
  });

  it("refuses an unknown field rather than dropping it", async () => {
    // `.strict()`, so a model inventing `colors` is told instead of quietly having it ignored.
    const result = await call({
      title: "t",
      intent: "i",
      sections: [{ name: "n", purpose: "p", colors: ["#fff"] }],
    });
    expect(result.isError).toBe(true);
  });
});
