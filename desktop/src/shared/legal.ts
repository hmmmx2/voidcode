/**
 * Which version of the Terms of Use and Privacy Policy this build displays.
 *
 * Sent with registration and recorded by the API, so "this person accepted the terms" says WHICH
 * terms. It is the "Last updated" date both documents show, in ISO form, and
 * `tests/honest-copy.test.ts` fails if either document's date stops matching it — a version string
 * that drifted from the page it names would record consent to a document nobody was shown.
 *
 * Shared by main (which sends it) and the renderer (which shows the date), so there is one value.
 */
export const TERMS_VERSION = "2026-09-20";

/** The same date as the documents print it. */
export const TERMS_DISPLAY_DATE = "20 September 2026";

/**
 * The longest email address anything here will accept: 254 characters.
 *
 * NOT A ROUND NUMBER AND NOT A GUESS. RFC 5321 caps an SMTP forward-path at 256 octets including
 * the angle brackets, which leaves 254 for the address itself — and that is exactly where the API's
 * own validator draws the line. Measured, not assumed: `pydantic.EmailStr` accepts a 254-character
 * address and rejects a 255-character one, because `email-validator` enforces the RFC limits.
 *
 * IT LIVES HERE BECAUSE IT DISAGREED IN THREE PLACES. The renderer's `validateEmail` said 255, the
 * IPC contract said 320, and the API said 254. Each was defensible alone and together they made two
 * ways to be rejected by something other than the thing that decides: a 255-character address
 * passed the form, passed the channel's schema, reached the API and came back as a validation
 * error with no field attached, and a 300-character one passed the channel too. One constant, two
 * importers, and the number that agrees with the server.
 *
 * `users.email` is `String(255)`, which is wider than this on purpose — a column that is exactly as
 * wide as the limit turns an off-by-one into a database error instead of a message.
 */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A digest of each legal document's text, so two repositories can hold one document.
 *
 * ── WHAT THIS REPLACES, AND WHY IT HAD TO ────────────────────────────────────────────────────────
 *
 * `tests/test_marketing_pages.py` compares the application's copy of each document with the
 * website's, character for character, and fails on any difference. That works because both trees
 * are in one checkout. The website is being extracted into its own repository, at which point that
 * test cannot run at all — not "becomes awkward": there is no second tree to read.
 *
 * The answer is ONE COMMITTED NUMBER PER DOCUMENT. Each repository hashes its own copy and compares
 * it to the same constant. Two repositories, one number, and neither has to read the other.
 *
 * ── THE EXTRACTION RULE IS NOT A DETAIL ──────────────────────────────────────────────────────────
 *
 * The digest covers the `SECTIONS` array and nothing else: everything from
 * `const SECTIONS: Section[] = [` up to `// ── Sub-components`, with carriage returns removed. That
 * is `sections_of()` in `test_marketing_pages.py`, unchanged, and it is exactly the right scope —
 * the two copies legitimately differ OUTSIDE it. The website's file carries a "this is a copy"
 * header and a breadcrumb pointing at the site root instead of the application's Settings screen.
 * A digest over the whole file would differ between the two by construction and could never agree.
 *
 * Carriage returns are stripped because the two checkouts can disagree about line endings while the
 * words do not. Verified: neither document contains a lone CR, so "remove every CR" and "translate
 * every ending to LF" produce the same string here — which is what lets the TypeScript and Python
 * sides compute the same hash from different reading rules.
 *
 * ── WHAT IT DOES AND DOES NOT PROVE ──────────────────────────────────────────────────────────────
 *
 * Editing a document without bumping its constant fails in the repository that holds the source. A
 * copy that has drifted fails in its own CI. What NEITHER can prove is that the DEPLOYED site is
 * serving the current version — nothing in CI can, without reaching the network. That is residual
 * and handled by publishing, not by a test.
 *
 * Bump these deliberately, and in the same commit as the text. The test prints the correct value
 * when it fails, so this is a copy-and-paste, not an arithmetic exercise — but it is meant to be an
 * ACT, because a document whose digest updated itself is a document with no pin at all.
 */
export const PRIVACY_SECTIONS_SHA256 =
  "05544267f17d45f6a1adb12030945a2cae29df197c91329f076969ea93fa8f31";
export const TERMS_SECTIONS_SHA256 =
  "e3e369f766aaaae0dff63f0c2b4c18d49d669b1b729402430d52a63e72304ce2";
