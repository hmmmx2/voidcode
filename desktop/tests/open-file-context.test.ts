/**
 * How the file on screen reaches the model.
 *
 * The property under test is not a string format but a *decision*: a mode that can call
 * `read_file` is told the file's name, and a mode that cannot is given its contents. Inlining
 * the contents where a read tool exists is what suppressed tool calling badly enough that the
 * Plan pane was usually empty — `agent/open-file.ts` carries the measurements.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { withOpenFile } = await import("../src/main/agent/open-file.js");
const { POLICIES } = await import("../src/main/agent/modes.js");
import type { AgentMode } from "../src/shared/agent-modes.js";

const FILE = { path: "docs/api.md", contents: "# API\n\nverify(doc)\n" };
const ALL: AgentMode[] = ["plan", "manual", "acceptEdits", "auto"];

const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : (value as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");

describe("withOpenFile", () => {
  it("changes nothing when no file is open", () => {
    for (const mode of ALL) expect(withOpenFile("what is this?", undefined, mode)).toBe("what is this?");
  });

  it("names the file for every mode that can read one", () => {
    // The whole fix. `read_file` is bound, so the model is told where to look rather than being
    // handed a wall of source that stops it reaching for the tool at all.
    for (const mode of ALL.filter((m) => POLICIES[m].tools.includes("read_file"))) {
      const out = text(withOpenFile("plan a change", FILE, mode));
      expect(out, mode).toContain("docs/api.md");
      expect(out, mode).toContain("read_file");
      expect(out, mode).not.toContain("verify(doc)");
      // The question survives, and comes after.
      expect(out.endsWith("plan a change"), mode).toBe(true);
    }
  });

  it("inlines the contents for a mode with no tools", () => {
    /**
     * Manual inverts the argument rather than being an oversight.
     *
     * It binds nothing, so there is no `read_file` to point at — naming the file would describe
     * something the model cannot open. And a turn with no tools has no tool calling to suppress,
     * so the cost that motivates the reference does not exist there.
     */
    expect(POLICIES.manual.tools).toEqual([]);
    const out = text(withOpenFile("what does this do?", FILE, "manual"));
    expect(out).toContain("verify(doc)");
    expect(out).toContain("docs/api.md");
    expect(out).not.toContain("read_file");
  });

  it("decides from the policy table rather than a hard-coded list of modes", () => {
    /**
     * Asserted as a relationship, so a mode that gains or loses `read_file` changes this
     * behaviour by changing the table — which is the only place the decision should live.
     *
     * What this cannot currently distinguish: `read_file` and `write_plan` are bound in exactly
     * the same three modes, so consulting either gives the same answer. `open-file.ts` reads
     * `read_file` because that is the tool the reference tells the model to call, and if the two
     * lists ever diverge this test starts telling them apart on its own.
     */
    for (const mode of ALL) {
      const inlines = text(withOpenFile("q", FILE, mode)).includes("verify(doc)");
      expect(inlines, mode).toBe(!POLICIES[mode].tools.includes("read_file"));
    }
  });

  describe("with images attached", () => {
    const blocks = [
      { type: "text" as const, text: "what is wrong here?" },
      { type: "image" as const, data: "abc", mediaType: "image/png" as const },
    ];

    it("joins the first text block rather than adding another", () => {
      // A turn that reads [text, text, image] where every other turn reads [text, image] is a
      // shape nothing else here produces, and providers do not all treat the two alike.
      const out = withOpenFile(blocks, FILE, "plan") as Array<{ type: string; text?: string }>;
      expect(out).toHaveLength(2);
      expect(out[0]?.type).toBe("text");
      expect(out[0]?.text).toContain("docs/api.md");
      expect(out[0]?.text?.endsWith("what is wrong here?")).toBe(true);
      // The image is untouched and still last.
      expect(out[1]).toEqual(blocks[1]);
    });

    it("adds a text block when there is none to join", () => {
      const imageOnly = [blocks[1]!];
      const out = withOpenFile(imageOnly, FILE, "plan") as Array<{ type: string; text?: string }>;
      expect(out).toHaveLength(2);
      expect(out[0]?.type).toBe("text");
      expect(out[1]).toEqual(blocks[1]);
    });

    it("does not mutate what it was given", () => {
      // The caller keeps `input.content` for the image checks that already ran against it.
      const original = structuredClone(blocks);
      withOpenFile(blocks, FILE, "plan");
      expect(blocks).toEqual(original);
    });
  });

  it("keeps the reference wording the measurements were taken with", () => {
    /**
     * Pinned deliberately.
     *
     * The eight-runs-per-cell numbers in `open-file.ts` are about these words. Rewording is
     * allowed, but it invalidates the evidence, and this test is what makes that a decision
     * rather than an accident.
     */
    expect(text(withOpenFile("q", FILE, "plan"))).toContain(
      "The file `docs/api.md` is open on screen. Read it with read_file if you need it."
    );
  });
});
