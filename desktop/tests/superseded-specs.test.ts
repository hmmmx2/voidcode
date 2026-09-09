/**
 * `docs/SUPERSEDED-SPECS.md` has to keep being true.
 *
 * It exists because "have you implemented these two specs?" had been answered by a full repository
 * audit three times. A document is the right fix, and it is also the artefact most likely to rot
 * quietly: forty-odd citations into a moving tree, and no compiler that reads prose.
 *
 * **Both directions are checked, and that is the design.** Half the document's job is naming things
 * that are *absent* — no Spark, no LambdaMART, no `training/` — so a test asserting every cited path
 * resolves would fail on the document working correctly. Instead:
 *
 *   - paths it cites as evidence about this application must **exist**
 *   - deliverables it claims are absent must **stay absent**
 *
 * The second half is the one with a future. It fails on the day someone adds a Spark pipeline or a
 * `rl/` directory, which is exactly the day the document stops being true and nobody would otherwise
 * think to reread it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "..");
const doc = fs.readFileSync(path.join(repo, "docs/SUPERSEDED-SPECS.md"), "utf8");

/** Every backtick-quoted token that looks like a path rather than an identifier. */
function citedPaths(): string[] {
  const cited = [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  return cited.filter(
    (token) =>
      token.includes("/") &&
      // Not a branch name, a home-relative path, a glob, or a prose fragment.
      !token.startsWith("feat/") &&
      !token.startsWith("~/") &&
      !token.includes("|") &&
      !token.includes(" ") &&
      !token.includes("→")
  );
}

/**
 * Prefixes whose citations are load-bearing evidence about this application.
 *
 * `docs/` is not a prefix here on purpose — the document cites both `docs/desktop-app-spec.md`
 * (real) and `docs/METRICS.md` (deliberately absent), so that directory is split by hand below.
 */
const MUST_EXIST_PREFIXES = ["desktop/", "scripts/"];
const MUST_EXIST_EXACT = [
  "docs/desktop-app-spec.md",
  "docs/MEMORY_AUDIT.md",
  "docs/DECISIONS.md",
  "docs/SUPERSEDED-SPECS.md",
];

/**
 * What the document asserts this repository does not have.
 *
 * Not derived from the prose, because the claim being guarded is about the world rather than about
 * the text: if any of these appears, the document is wrong regardless of how it is worded.
 *
 * **THIS LIST WAS CUT DOWN ONCE, AND THAT WAS THE TEST WORKING.** It used to also name `training`,
 * `rl`, `features`, `sql`, `ranking`, `deploy`, `experiments`, `quality`, `analysis`, `Makefile`,
 * `docs/METRICS.md`, `docs/KNOWLEDGE_ARCHITECTURE.md` and `docs/RANKING_DESIGN.md` — correct while
 * the desktop application was its own repository, and false the moment the two codebases were
 * consolidated into one tree, because the platform and RL halves brought every one of them.
 *
 * Thirteen entries failing at once is what sent someone back to reread the document, which is
 * exactly what the header of this file says the second half is for. The entries were removed only
 * after the document was rewritten to say what is now true: the claim it makes is *absent from
 * `desktop/`*, which is a narrower claim than *absent from the repository*, and the two are no
 * longer the same sentence.
 *
 * What remains here is the genuinely-absent set. Do not trim it further to make a failure go away —
 * a failure here means the document needs rereading, not that the list needs editing.
 */
const MUST_STAY_ABSENT = [
  "serving",
  "configs",
  "docs/RISK_REGISTER.md",
  // The specs are committed now, but at docs/specs/ — a copy reappearing at the ROOT would mean
  // the consolidation had been partly undone.
  "VOIDCODE_PLATFORM_SPEC.md",
  "VOIDCODE_TRAINING_SPEC.md",
];

describe("the superseded-specs document", () => {
  it("cites enough to be worth checking", () => {
    // Guards the extractor. If the regex or the fence style changes and this finds nothing, every
    // assertion below passes vacuously — the failure mode this whole file is about.
    expect(citedPaths().length).toBeGreaterThan(15);
  });

  it("cites only files that exist, where it cites them as evidence", () => {
    const missing = citedPaths()
      .filter(
        (p) =>
          MUST_EXIST_PREFIXES.some((prefix) => p.startsWith(prefix)) || MUST_EXIST_EXACT.includes(p)
      )
      .filter((p) => !fs.existsSync(path.join(repo, p)));

    expect(missing, "cited as evidence but not on disk").toEqual([]);
  });

  it("is still right that the spec deliverables are absent", () => {
    const appeared = MUST_STAY_ABSENT.filter((p) => fs.existsSync(path.join(repo, p)));

    // If this fails, do not edit the list — reread the document. Something it describes as another
    // branch's work now exists on this one.
    expect(appeared, "the document says these do not exist here").toEqual([]);
  });

  it("states no content counts", () => {
    /**
     * The durable rule, and the reason it is enforced on this file specifically.
     *
     * Several corrections that prompted this document were prose restating a count the catalogue
     * owns — "38 interview questions" in four places, long after it was 44. Writing a new document
     * full of counts would have recreated that failure on day one, so the document points at
     * `content-census.test.ts` instead and this asserts that it kept doing so.
     */
    const offenders = [
      ...doc.matchAll(/\b\d+\s+(?:\w+\s+)?(problems|questions|concepts|cases|items)\b/gi),
    ].map((m) => m[0]);

    expect(offenders, "counts belong in content-census.test.ts, not in prose").toEqual([]);
  });

  it("is reachable from the README", () => {
    // A document nobody is pointed at gets re-derived by audit, which is the cost it exists to
    // remove. The README's "where to read next" table is the entry point.
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toContain("SUPERSEDED-SPECS.md");
  });
});
