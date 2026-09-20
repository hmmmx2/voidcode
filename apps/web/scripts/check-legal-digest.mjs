/**
 * Refuse to build if a legal document is not the one that was written.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 *
 * This site publishes the application's Terms of Use and Privacy Policy. They are a COPY: the
 * original lives in the desktop application, because that is where a person clicks "I agree", and
 * registration records which version they accepted. Neither package can import from the other.
 *
 * While both trees were in one repository, a test compared them character for character. This site
 * is its own repository now, so there is no second tree to compare against. What replaces that is
 * one committed number per document: `src/lib/legal.ts` carries a SHA-256 of each document's text,
 * copied from the application, and this script hashes the copy in this repository against it.
 *
 * ── WHY IT FAILS THE BUILD RATHER THAN WARNING ───────────────────────────────────────────────────
 *
 * `package.json` runs it as `prebuild`, so npm runs it before `next build` — which means Vercel
 * runs it on every deploy. A mismatch means this site is about to publish a legal document that is
 * not the one the application records consent against. That is the one failure on this site that
 * should stop a deploy rather than produce a warning nobody reads: a stale privacy policy is a
 * factual misstatement to the person least able to check it.
 *
 * ── WHAT IT DOES NOT PROVE ───────────────────────────────────────────────────────────────────────
 *
 * That the digest itself is right. The number comes from the application's repository, committed by
 * hand in the same act as writing the words; this script only proves that the text here is the text
 * that number describes. Nothing in CI can prove the DEPLOYED site serves the current version
 * either — that is what deploying is for.
 *
 * ── THE EXTRACTION RULE ──────────────────────────────────────────────────────────────────────────
 *
 * The digest covers the `SECTIONS` array and nothing else: everything from
 * `const SECTIONS: Section[] = [` up to the `Sub-components` banner, with carriage returns removed.
 *
 * That scope is not a detail. This copy legitimately differs OUTSIDE it — it carries a "this is a
 * copy" header, and a breadcrumb pointing at this site's root rather than at the application's
 * Settings screen, which does not exist here. A digest over the whole file would differ between the
 * two by construction and could never agree. Carriage returns go because two checkouts can disagree
 * about line endings while the words do not.
 *
 * The same rule is implemented in the application's repository, in TypeScript and in Python. Three
 * copies is the cost of the two repositories being independent; change all of them or none.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const LEGAL = join(root, "src/components/Legal");
const CONSTANTS = join(root, "src/lib/legal.ts");

const OPEN = "const SECTIONS: Section[] = [";
const CLOSE = "// ── Sub-components";

const DOCUMENTS = [
  ["PrivacyClient.tsx", "PRIVACY_SECTIONS_SHA256"],
  ["TermsClient.tsx", "TERMS_SECTIONS_SHA256"],
];

const problems = [];

function sectionsOf(file) {
  const source = readFileSync(file, "utf8");
  const open = source.indexOf(OPEN);
  if (open === -1) return null;
  const after = source.slice(open + OPEN.length);
  const close = after.indexOf(CLOSE);
  if (close === -1) return null;
  return after.slice(0, close).replace(/\r/g, "");
}

const constants = readFileSync(CONSTANTS, "utf8");

for (const [name, constant] of DOCUMENTS) {
  const declared = new RegExp(`${constant}\\s*=\\s*\\n?\\s*"([0-9a-f]{64})"`).exec(constants);
  if (declared === null) {
    problems.push(`${constant} is not declared as a 64-hex constant in src/lib/legal.ts`);
    continue;
  }

  const text = sectionsOf(join(LEGAL, name));
  if (text === null) {
    problems.push(`${name}: could not find the SECTIONS array between its two markers`);
    continue;
  }
  // A positive control on the extraction: a rule that returned almost nothing would agree with a
  // digest of almost nothing, and every check here would pass against a truncated document.
  if (text.length < 5000) {
    problems.push(`${name}: the extraction returned only ${text.length} characters`);
    continue;
  }

  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (actual !== declared[1]) {
    problems.push(
      `${name} does not match its committed digest.\n` +
        `    committed: ${declared[1]}\n` +
        `    actual:    ${actual}\n` +
        "    This copy has drifted from the application's. Re-sync it from the application's\n" +
        "    repository; do not edit the constant to match, or the pin means nothing."
    );
  }
}

if (problems.length > 0) {
  console.error("Legal documents failed verification:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nRefusing to build. This site would publish a legal document that is not the one the\n" +
      "application records consent against.\n"
  );
  process.exit(1);
}

console.log(`Legal documents verified (${DOCUMENTS.length} of ${DOCUMENTS.length} match).`);
