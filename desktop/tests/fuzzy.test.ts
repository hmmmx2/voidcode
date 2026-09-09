/**
 * Ranking paths, which is the whole of whether a file picker feels usable.
 *
 * A picker that finds the file is table stakes; one that puts it *first* is the difference
 * between typing three characters and reading a list. So most of these test ordering rather
 * than membership — `includes` would pass a membership test and be useless in a real project.
 */
import { describe, it, expect } from "vitest";
import { fuzzyMatch, highlight, rankPaths } from "../renderer/src/lib/build/fuzzy.js";

/** A slice of a real tree, with the collisions that make ranking hard. */
const PATHS = [
  "src/index.ts",
  "src/components/Build/BuildWorkspace.tsx",
  "src/components/Build/BottomDock.tsx",
  "src/components/Layout/DockGrid.tsx",
  "src/lib/build/dock.ts",
  "src/lib/build/output.ts",
  "index/legacy/thing.ts",
  "docs/build-workspace-notes.md",
  "vendor/deep/nested/app.ts",
  "src/app.ts",
];

const best = (query: string): string => rankPaths(query, PATHS)[0]!.path;
const order = (query: string): string[] => rankPaths(query, PATHS).map((r) => r.path);

describe("matching", () => {
  it("matches a subsequence, not just a substring", () => {
    // Nobody types a contiguous slice of a long path.
    expect(fuzzyMatch("bwork", "src/components/Build/BuildWorkspace.tsx")).not.toBeNull();
    expect(fuzzyMatch("bldwsp", "src/components/Build/BuildWorkspace.tsx")).not.toBeNull();
  });

  it("refuses when the letters are not in order", () => {
    expect(fuzzyMatch("krow", "BuildWorkspace.tsx")).toBeNull();
  });

  it("refuses when a letter is missing entirely", () => {
    expect(fuzzyMatch("buildz", "BuildWorkspace.tsx")).toBeNull();
  });

  it("ignores case in both directions", () => {
    expect(fuzzyMatch("BUILD", "src/lib/build/dock.ts")).not.toBeNull();
    expect(fuzzyMatch("bw", "BuildWorkspace.tsx")).not.toBeNull();
  });

  it("treats a space as a gap rather than a character to find", () => {
    // Paths rarely contain spaces; a user typing two terms means "and then".
    expect(fuzzyMatch("build work", "src/components/Build/BuildWorkspace.tsx")).not.toBeNull();
  });

  it("reports the positions it matched, ascending", () => {
    const match = fuzzyMatch("idx", "src/index.ts")!;
    expect(match.positions).toEqual([...match.positions].sort((a, b) => a - b));
    expect(match.positions).toHaveLength(3);
    for (const p of match.positions) expect("src/index.ts"[p]).toMatch(/[idx]/);
  });
});

describe("ranking", () => {
  it("puts a basename hit above a directory hit", () => {
    /**
     * The rule that makes a picker feel like it read your mind. Both paths contain "index";
     * only one is *called* index, and that is the one meant.
     */
    expect(best("index")).toBe("src/index.ts");
  });

  it("puts a contiguous run above scattered letters", () => {
    // "dock" is a run in dock.ts and scattered through DockGrid's ancestors.
    expect(best("dock")).toBe("src/lib/build/dock.ts");
  });

  it("answers to the capitals of a camel-case name", () => {
    /**
     * Tested against a controlled pair rather than the corpus, because in the corpus `bw` is
     * genuinely ambiguous: `BuildWorkspace.tsx` and `build-workspace-notes.md` both put b and w
     * at real word boundaries, and the `.md` is shorter and shallower. Asserting that one beats
     * the other would be encoding a preference the scoring cannot justify — so this isolates the
     * rule instead: a capital is a boundary, and beats the same letters mid-word.
     */
    const camel = fuzzyMatch("bw", "x/BuildWorkspace.ts")!;
    const midWord = fuzzyMatch("bw", "x/abuildxworks.ts")!;
    expect(camel).not.toBeNull();
    expect(camel.score).toBeGreaterThan(midWord.score);
  });

  it("finds a camel-case name in the corpus even when it does not win", () => {
    expect(order("bw")).toContain("src/components/Build/BuildWorkspace.tsx");
  });

  it("prefers the shorter path among otherwise equal matches", () => {
    expect(best("app")).toBe("src/app.ts");
  });

  it("finds a hyphenated name by its parts", () => {
    expect(best("bwn")).toBe("docs/build-workspace-notes.md");
  });

  it("excludes what does not match at all", () => {
    expect(order("zzz")).toEqual([]);
  });
});

/**
 * Each scoring rule against a controlled pair.
 *
 * The corpus tests above check outcomes, which is what a user experiences — but an outcome can
 * stay correct while a rule is deleted, because another rule was carrying it. These isolate one
 * variable at a time: two targets identical except for the thing being measured.
 */
describe("the scoring rules, one at a time", () => {
  const score = (query: string, target: string): number => fuzzyMatch(query, target)!.score;

  it("rewards a contiguous run over the same letters scattered", () => {
    /**
     * The contiguous one is deliberately placed *later* and without a leading boundary, so every
     * other rule favours the scattered one: it starts on a boundary and its letters sit earlier.
     * Only the run bonus can make the first win, which is what makes this a test of the run
     * bonus rather than of the position penalty carrying it.
     */
    expect(score("abc", "x/xxabc.ts")).toBeGreaterThan(score("abc", "x/axbxc.ts"));
  });

  it("rewards a capital as a word boundary", () => {
    // Identical but for the case of one character.
    expect(score("ab", "x/aBcd.ts")).toBeGreaterThan(score("ab", "x/abcd.ts"));
  });

  it("rewards the shorter of two otherwise identical matches", () => {
    // Same match positions, same boundaries; only the trailing length differs.
    expect(score("app", "a/app.ts")).toBeGreaterThan(score("app", "b/app.tsx"));
  });

  it("rewards a boundary over the middle of a word", () => {
    expect(score("b", "x/b.ts")).toBeGreaterThan(score("b", "x/ab.ts"));
  });

  it("rewards an earlier match, all else equal", () => {
    // Same length, both on a boundary (`_` counts), neither in the basename, no runs. The only
    // thing that can separate them is how far in the match sits.
    expect(score("z", "z_/a.ts")).toBeGreaterThan(score("z", "_z/a.ts"));
  });
});

describe("the empty query", () => {
  it("keeps tree order rather than sorting alphabetically", () => {
    // "The tree, from the top" is a more useful starting view than an arbitrary slice.
    expect(order("")).toEqual(PATHS);
  });

  it("respects the limit", () => {
    expect(rankPaths("", PATHS, 3).map((r) => r.path)).toEqual(PATHS.slice(0, 3));
  });

  it("treats whitespace as empty", () => {
    expect(order("   ")).toEqual(PATHS);
  });
});

describe("stability", () => {
  it("does not reshuffle equal scores between keystrokes", () => {
    // A list that reorders under the cursor as you type is worse than one that ranks badly.
    const big = Array.from({ length: 40 }, (_, i) => `pkg/mod${i}/same.ts`);
    expect(rankPaths("same", big, 40).map((r) => r.path)).toEqual(big);
  });

  it("caps the result at the limit", () => {
    const big = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    expect(rankPaths("file", big, 25)).toHaveLength(25);
  });
});

describe("highlighting", () => {
  it("splits into matched and unmatched runs that rebuild the original", () => {
    const match = fuzzyMatch("idx", "src/index.ts")!;
    const parts = highlight("src/index.ts", match.positions);
    expect(parts.map((p) => p.text).join("")).toBe("src/index.ts");
    expect(parts.some((p) => p.hit)).toBe(true);
  });

  it("marks exactly the matched characters", () => {
    const parts = highlight("abc", [1]);
    expect(parts).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: true },
      { text: "c", hit: false },
    ]);
  });

  it("handles a match at position zero", () => {
    expect(highlight("abc", [0])).toEqual([
      { text: "a", hit: true },
      { text: "bc", hit: false },
    ]);
  });

  it("returns the whole string unmarked when nothing matched", () => {
    expect(highlight("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});
