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
