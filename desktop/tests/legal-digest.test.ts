/**
 * Each legal document still hashes to the number committed beside it.
 *
 * WHY A DIGEST AND NOT A COMPARISON. `tests/test_marketing_pages.py` compares the application's
 * copy of each document with the website's, character for character. That works only while both
 * trees are in one checkout, and the website is being extracted into its own repository — at which
 * point that test has no second tree to read. One committed number per document replaces it: each
 * repository hashes its own copy against the same constant, and neither reads the other.
 *
 * THIS FILE IS THE SOURCE REPOSITORY'S HALF. It fails when the text moves without the constant, so
 * the digest cannot silently fall behind the document it pins. `voidcode-web` runs the mirror of it
 * against its own copy, which it pulls from here with `scripts/sync-from-app.mjs`.
 *
 * THE EXTRACTION RULE IS COPIED DELIBERATELY, not shared. It is `sections_of()` in
 * `test_marketing_pages.py`, and it has to be reproduced here in a second language: the digest is
 * only meaningful if both sides agree on which characters it covers. Restating it in three places
 * is the cost of the two copies being independent, and each restatement carries this note so the
 * next person changes all of them or none.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVACY_SECTIONS_SHA256, TERMS_SECTIONS_SHA256 } from "@shared/legal";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OPEN = "const SECTIONS: Section[] = [";
const CLOSE = "// ── Sub-components";

/**
 * The document's text, and nothing around it.
 *
 * Carriage returns go because the two checkouts can disagree about line endings while the words do
 * not. Python's `read_text` translates every ending to LF and then strips CR; this strips CR from
 * the raw bytes. Those agree as long as no lone CR exists in the file, which `legal.ts` records as
 * verified and the first test below re-checks rather than trusting.
 */
function sectionsOf(file: string): string {
  const source = readFileSync(file, "utf8");
  expect(source, `${file} has no SECTIONS array`).toContain(OPEN);
  const afterOpen = source.slice(source.indexOf(OPEN) + OPEN.length);
  const end = afterOpen.indexOf(CLOSE);
  expect(end, `${file} has no ${CLOSE} marker`).toBeGreaterThan(-1);
  return afterOpen.slice(0, end).replace(/\r/g, "");
}

const DOCUMENTS = [
  ["PrivacyClient.tsx", PRIVACY_SECTIONS_SHA256],
  ["TermsClient.tsx", TERMS_SECTIONS_SHA256],
] as const;

describe("the legal documents match their committed digests", () => {
  it("contains no lone carriage return, which is what makes the two rules equivalent", () => {
    for (const [name] of DOCUMENTS) {
      const raw = readFileSync(path.join(root, "renderer/src/components/Legal", name));
      // Drop every CRLF pair, then look for what is left. A survivor would mean Python's universal
      // newlines turn it into LF while this file deletes it, and the two digests would differ for a
      // reason nobody would find quickly.
      const lone = raw.toString("binary").replace(/\r\n/g, "").split("\r").length - 1;
      expect(lone, `${name} contains a lone CR`).toBe(0);
    }
  });

  for (const [name, expected] of DOCUMENTS) {
    it(`${name} hashes to its constant`, () => {
      const text = sectionsOf(path.join(root, "renderer/src/components/Legal", name));
      const actual = createHash("sha256").update(text, "utf8").digest("hex");

      expect(
        actual,
        `${name}'s text has changed and its digest has not.\n` +
          `  If the change was intended, put this in src/shared/legal.ts:\n` +
          `    ${actual}\n` +
          "  and run `python scripts/sync_web_legal.py` so the website's copy moves with it."
      ).toBe(expected);
    });
  }

  it("covers the text and not the chrome around it", () => {
    /*
     * A positive control on the extraction, because a rule that returned "" would make every
     * assertion above agree on the hash of nothing.
     *
     * The two ends are asserted by content: section 1's id must be inside, and THE BREADCRUMB must
     * be outside. The breadcrumb is the right thing to check because it is precisely what the two
     * copies disagree about — `href="/profile"` here, `href="/"` on the website, since the
     * application's Settings screen does not exist there. If it fell inside the digest, the two
     * copies could never hash the same and the whole mechanism would be unusable.
     *
     * NOT "Last updated", which was the first attempt and was wrong: section 12's prose says "This
     * page carries a 'Last updated' date", so the phrase appears INSIDE the digest as well as in
     * the footer outside it. The assertion passed for the footer and failed on the sentence about
     * it — a reminder that these are documents, and a marker chosen from the rendering can also be
     * something the text talks about.
     */
    const privacy = sectionsOf(path.join(root, "renderer/src/components/Legal/PrivacyClient.tsx"));
    expect(privacy.length).toBeGreaterThan(5_000);
    expect(privacy, "section 1's own id is not inside the digest").toContain('id: "overview"');
    expect(privacy, "6.4 is not inside the digest").toContain("One way in, and why");
    expect(privacy, "the breadcrumb is inside the digest, so the two copies could never agree")
      .not.toContain('href="/profile"');
  });

  it("commits a digest the other repository can check its copy against", () => {
    /*
     * A TEST THAT READ `apps/web/src/lib/legal.ts` STOOD HERE. It asserted the website's tree
     * carried a copy of these constants, because at the time both trees were in one checkout. The
     * website is `voidcode-web` now and this repository cannot see it.
     *
     * What is left is the half that belongs here: the digests are declared, and they are the shape
     * the other side expects to read. `voidcode-web`'s `scripts/sync-from-app.mjs` PULLS them out
     * of `src/shared/legal.ts` with a regex, and its `check-legal-digest.mjs` compares its own
     * documents against what it pulled. A constant renamed or reformatted here breaks that pull —
     * so the format is asserted, not just the value.
     *
     * What NEITHER repository can prove is that the copy over there is current. If a document
     * changes here and nobody re-runs that script, every check on both sides passes and the site
     * publishes the old version. That is the residual cost of two repositories, and it is handled
     * by this repository failing first: the digest test above goes red the moment the text moves.
     */
    /*
     * SPLIT AND TRIM, NOT `new RegExp` WITH A TEMPLATE LITERAL. The first attempt built the pattern
     * as `new RegExp(\`... =\s*\n?\s*"[0-9a-f]{64}";\`)` and matched nothing: inside a template
     * literal `\s` collapses to `\s`, which JS resolves to a plain `s`, so the pattern looked for
     * a literal "s*" — printing it showed `=s*` where `=\s*` was meant. The only regex here is a
     * LITERAL, which has no such layer.
     */
    const source = readFileSync(path.join(root, "src/shared/legal.ts"), "utf8");
    for (const name of ["PRIVACY_SECTIONS_SHA256", "TERMS_SECTIONS_SHA256"]) {
      const after = source.split(`export const ${name} =`)[1];
      expect(after, `${name} is not declared in src/shared/legal.ts`).toBeDefined();
      const value = (after ?? "").split(";")[0]?.trim() ?? "";
      expect(
        value,
        `${name} is not a quoted 64-hex digest, which is the shape voidcode-web's sync reads`
      ).toMatch(/^"[0-9a-f]{64}"$/);
    }
    // The two values the website also copies, for the same reason.
    expect(source).toMatch(/export const TERMS_VERSION = "[^"]+";/);
    expect(source).toMatch(/export const TERMS_DISPLAY_DATE = "[^"]+";/);
  });
});
