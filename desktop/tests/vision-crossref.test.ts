/**
 * Locating a screenshot in the source.
 *
 * Two claims are being tested, and both are about *not* being confidently wrong:
 *
 *   Exact beats semantic. A file containing a string that is visibly on screen outranks a file
 *   that merely reads like the screenshot, and the two are labelled differently rather than
 *   averaged into one number that hides which kind of evidence was found.
 *
 *   Nothing is a real answer. A screenshot of an app this project has never seen returns an
 *   empty list, not the closest-looking file.
 *
 * The cap matters for a duller reason: each searched string is a full project walk, so a
 * screenshot full of text must not turn into thirty of them.
 */
import { describe, it, expect } from "vitest";
import {
  rankCandidates,
  searchableStrings,
  MAX_EXACT_QUERIES,
  type ExactHit,
  type ScreenshotFacts,
  type SemanticHit,
} from "../src/main/vision/crossref.js";
import { parseFacts, hasFacts, NO_FACTS } from "../src/main/vision/describe.js";

function facts(over: Partial<ScreenshotFacts> = {}): ScreenshotFacts {
  return { ...NO_FACTS, ...over };
}

function exact(path: string, line: number, query: string): ExactHit {
  return { path, line, query, preview: `…${query}…` };
}

function semantic(path: string, score: number, symbol: string | null = null): SemanticHit {
  return { path, line: 1, symbol, score };
}

describe("choosing what to search for", () => {
  it("puts identifiers ahead of visible text", () => {
    // `E_MODE_DENIED` identifies one place in a codebase; "Continue" identifies fifty.
    const chosen = searchableStrings(
      facts({ visibleText: ["Continue"], identifiers: ["E_MODE_DENIED"] })
    );
    expect(chosen[0]).toBe("E_MODE_DENIED");
  });

  it("caps the number of searches", () => {
    // Each one is a full walk of the project.
    const many = Array.from({ length: 40 }, (_, i) => `distinctString${i}`);
    expect(searchableStrings(facts({ visibleText: many }))).toHaveLength(MAX_EXACT_QUERIES);
  });

  it("drops strings too short or too common to identify anything", () => {
    const chosen = searchableStrings(
      facts({ visibleText: ["OK", "x", "Save", "Error", "AppearanceSettings"] })
    );
    expect(chosen).toEqual(["AppearanceSettings"]);
  });

  it("does not spend two searches on the same string in different cases", () => {
    const chosen = searchableStrings(
      facts({ visibleText: ["OpenFolder", "openfolder", "OPENFOLDER"] })
    );
    expect(chosen).toHaveLength(1);
  });

  it("mines an error banner, which names files outright", () => {
    const chosen = searchableStrings(
      facts({ errorText: "TypeError: Object has been destroyed\n  at windows.ts:214" })
    );
    expect(chosen.some((s) => s.includes("windows.ts"))).toBe(true);
  });

  it("skips a paragraph of prose, which cannot appear in source verbatim", () => {
    const paragraph = "The settings dialog is shown ".repeat(10);
    expect(searchableStrings(facts({ visibleText: [paragraph] }))).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts a file found both ways above one found only by embedding", () => {
    const ranked = rankCandidates(
      [exact("src/settings.ts", 42, "Appearance")],
      [semantic("src/settings.ts", 0.8), semantic("src/theme.ts", 0.9)]
    );

    expect(ranked[0]?.path).toBe("src/settings.ts");
    expect(ranked[0]?.confidence).toBe("high");
    // Even though theme.ts scored higher on the embedding, which is the point.
    expect(ranked[1]?.path).toBe("src/theme.ts");
    expect(ranked[1]?.confidence).toBe("low");
  });

  it("puts a both-ways hit above an exact-only one that matched more strings", () => {
    /**
     * The case that actually distinguishes the confidence ordering from the match count.
     *
     * Everywhere else the both-ways file also has the most exact matches, so a sort on count
     * alone produces the same answer and the ordering rule looks tested when it is not — which
     * is exactly what mutating it revealed.
     */
    const ranked = rankCandidates(
      [
        exact("src/agrees.ts", 5, "Appearance"),
        exact("src/count.ts", 1, "Appearance"),
        exact("src/count.ts", 2, "Theme"),
        exact("src/count.ts", 3, "Density"),
      ],
      [semantic("src/agrees.ts", 0.6)]
    );

    expect(ranked[0]?.path).toBe("src/agrees.ts");
    expect(ranked[0]?.confidence).toBe("high");
    expect(ranked[1]?.confidence).toBe("medium");
  });

  it("puts an exact-only hit above a semantic-only one", () => {
    const ranked = rankCandidates(
      [exact("src/a.ts", 10, "E_MODE_DENIED")],
      [semantic("src/b.ts", 0.99)]
    );
    expect(ranked.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(ranked[0]?.confidence).toBe("medium");
  });

  it("counts a file once, at its earliest line", () => {
    // Four matches in one file is one answer, not four results crowding out everything else.
    const ranked = rankCandidates(
      [
        exact("src/a.ts", 90, "Save"),
        exact("src/a.ts", 12, "Save"),
        exact("src/a.ts", 44, "Save"),
        exact("src/b.ts", 5, "Save"),
      ],
      []
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.path).toBe("src/a.ts");
    expect(ranked[0]?.line).toBe(12);
  });

  it("ranks a file matching several distinct strings above one matching a single string", () => {
    const ranked = rankCandidates(
      [
        exact("src/dialog.ts", 5, "Appearance"),
        exact("src/dialog.ts", 9, "Theme"),
        exact("src/other.ts", 3, "Appearance"),
      ],
      []
    );
    expect(ranked[0]?.path).toBe("src/dialog.ts");
  });

  it("names the strings it found, so the reason can be checked", () => {
    const ranked = rankCandidates([exact("src/a.ts", 1, "E_MODE_DENIED")], []);
    expect(ranked[0]?.why).toContain("E_MODE_DENIED");
  });

  it("says plainly that a semantic-only hit contains none of the screenshot's text", () => {
    const ranked = rankCandidates([], [semantic("src/a.ts", 0.7)]);
    expect(ranked[0]?.why).toContain("none of its text appears here");
  });

  it("takes the symbol name from the index when only the indexer knows it", () => {
    const ranked = rankCandidates(
      [exact("src/a.ts", 42, "Save")],
      [semantic("src/a.ts", 0.5, "handleSave")]
    );
    // Exact line, indexed symbol — the string is a place, the embedding is a neighbourhood.
    expect(ranked[0]).toMatchObject({ line: 42, symbol: "handleSave" });
  });

  it("returns nothing when nothing matched, rather than a guess", () => {
    // The failure this feature is designed against.
    expect(rankCandidates([], [])).toEqual([]);
  });

  it("bounds the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => exact(`src/f${i}.ts`, 1, "Save"));
    expect(rankCandidates(many, [], 8)).toHaveLength(8);
  });

  it("orders deterministically when everything else ties", () => {
    // Two runs over the same project must not disagree about which file to show first.
    const hits = [exact("src/b.ts", 1, "Save"), exact("src/a.ts", 1, "Save")];
    expect(rankCandidates(hits, []).map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rankCandidates([...hits].reverse(), []).map((c) => c.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

describe("reading the model's reply", () => {
  it("takes the fields it asked for", () => {
    const parsed = parseFacts(
      JSON.stringify({
        visibleText: ["Open Folder"],
        identifiers: ["E_MODE_DENIED"],
        uiElements: ["sidebar"],
        errorText: "boom",
        appearance: "a dialog",
      })
    );
    expect(parsed).toEqual({
      visibleText: ["Open Folder"],
      identifiers: ["E_MODE_DENIED"],
      uiElements: ["sidebar"],
      errorText: "boom",
      appearance: "a dialog",
    });
  });

  it("digs the object out of a markdown fence", () => {
    // `json: true` guarantees parseable JSON from a compliant server, and some models fence it
    // anyway.
    const parsed = parseFacts('```json\n{"visibleText":["Save"]}\n```');
    expect(parsed.visibleText).toEqual(["Save"]);
  });

  it("keeps what is usable when a field is the wrong shape", () => {
    // A grammar guarantees parseable JSON, not the shape that was asked for.
    const parsed = parseFacts(
      JSON.stringify({ visibleText: "Save", identifiers: [{ name: "x" }, "realOne"] })
    );
    expect(parsed.visibleText).toEqual(["Save"]);
    expect(parsed.identifiers).toEqual(["realOne"]);
  });

  it("treats an empty errorText as no error", () => {
    expect(parseFacts(JSON.stringify({ errorText: "   " })).errorText).toBeNull();
  });

  it("returns no facts rather than throwing on unparseable output", () => {
    expect(parseFacts("I'm sorry, I can't see the image.")).toEqual(NO_FACTS);
    expect(parseFacts("")).toEqual(NO_FACTS);
    expect(parseFacts("[1,2,3]")).toEqual(NO_FACTS);
  });

  it("distinguishes nothing-legible from a failure", () => {
    expect(hasFacts(NO_FACTS)).toBe(false);
    expect(hasFacts(facts({ visibleText: ["Save"] }))).toBe(true);
    // Layout alone is enough to run the semantic pass.
    expect(hasFacts(facts({ appearance: "a sidebar" }))).toBe(true);
  });

  it("bounds a model that returns an enormous list", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `string${i}`);
    expect(parseFacts(JSON.stringify({ visibleText: huge })).visibleText.length).toBeLessThanOrEqual(60);
  });
});
