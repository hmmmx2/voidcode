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
