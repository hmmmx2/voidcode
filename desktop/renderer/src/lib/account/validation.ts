// Ported from the website's `lib/validation/auth.ts` when sign-in moved into the desktop app. The website is
// being removed, so this is now the only copy.
import { EMAIL_MAX_LENGTH } from "@shared/legal";

/**
 * Client-side validation for the auth forms.
 *
 * WHY THERE IS NO VALIDATION LIBRARY HERE
 *
 * The repo has no zod, no react-hook-form, no yup. Adding one for two forms
 * costs bundle on a page whose whole point is to load fast, and buys type
 * inference we do not need for four fields. These are five small pure
 * functions.
 *
 * WHY THESE RULES ARE A MIRROR, NOT A SOURCE OF TRUTH
 *
 * The server re-validates every one of them in `apps/api/src/services/password_service.py`'s `validate_password`,
 * and the server's answer is the only one that matters — anyone can skip this
 * code entirely by POSTing directly. What client-side validation buys is
 * *latency*: telling someone their password is too short without a round trip,
 * and before they have submitted a password to the network at all.
 *
 * The consequence is that these rules must be kept in step with the Python
 * deliberately. They are duplicated, not shared, because the alternatives are
 * worse: shipping a rules endpoint adds a round trip to the thing we were
 * avoiding, and generating one from the other adds a build step for ~40 lines.
 * Any change to the policy in `password_service.py` must be repeated here, and
 * `desktop/tests/account-validation.test.ts` fails when the blocklist or bounds drift apart.
 */

/** Mirrors `password_service.MIN_PASSWORD_LENGTH`. */
export const MIN_PASSWORD_LENGTH = 12;
/** Mirrors `password_service.MAX_PASSWORD_LENGTH`. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Deliberately permissive.
 *
 * Client-side email validation should reject *typos*, not enforce RFC 5322 —
 * which permits quoted strings, comments and IP literals, and which no regex
 * shorter than a page implements correctly. Over-strict patterns reject real
 * addresses (plus-addressing, new TLDs, apostrophes) and there is no recourse
 * for the user when they do. The authoritative check is the verification email:
 * an address that cannot receive mail cannot complete signup, whatever it
 * looks like.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Mirrors the server blocklist closely enough to catch the common cases. */
const BLOCKED = new Set([
  "password", "passw0rd", "password1", "password123", "password1234",
  "letmein", "welcome", "iloveyou", "admin", "administrator",
  "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm",
  "111111", "123456", "1234567", "12345678", "123456789", "1234567890",
  "voidcode", "voidcodeai", "leetcode", "interview",
  "changeme", "secret", "trustno1", "monkey", "dragon", "sunshine",
]);

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return "Enter your email address.";
  if (!EMAIL_SHAPE.test(trimmed)) return "That doesn't look like an email address.";
  if (trimmed.length > EMAIL_MAX_LENGTH) return "That email address is too long.";
  return null;
}

export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter your name.";
  if (trimmed.length > 200) return "That name is too long.";
  return null;
}

export function validatePassword(
  password: string,
  { email = "", name = "" }: { email?: string; name?: string } = {}
): string | null {
  if (!password) return "Choose a password.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  }

  const lowered = password.toLowerCase().trim();
  // Collapse digit-suffix variants, so `password2024` is caught as `password`.
  if (BLOCKED.has(lowered) || BLOCKED.has(lowered.replace(/\d+$/, ""))) {
    return "That password is too common. Choose something else.";
  }
  if (new Set(password).size < 5) {
    return "Use at least 5 different characters.";
  }

  // A password containing the account's own email or name is guessable by
  // anyone who can see the account — which is exactly the person attacking it.
  const local = email.split("@")[0]?.toLowerCase().trim() ?? "";
  if (local.length >= 3 && lowered.includes(local)) {
    return "Your password must not contain your email address.";
  }
  const trimmedName = name.toLowerCase().trim();
  if (trimmedName.length >= 3 && lowered.includes(trimmedName)) {
    return "Your password must not contain your name.";
  }

  // NOTE: no character-class requirement, matching the server. Composition
  // rules push people toward `Password1!` — which satisfies every class rule,
  // sits on every cracking list, and is far weaker than four random words.
  return null;
}

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string };

/**
 * A coarse strength estimate for the meter.
 *
 * Length-dominant on purpose, because length is what actually drives the cost
 * of a guess. This is a *hint*, not a gate — `validatePassword` decides what is
 * accepted, and a user who wants a long lowercase passphrase should not be
 * nagged into adding a `!`.
 */
export function estimateStrength(password: string): Strength {
  if (!password) return { score: 0, label: "" };
  if (password.length < MIN_PASSWORD_LENGTH) return { score: 1, label: "Too short" };

  let score = 1;
  if (password.length >= 16) score++;
  if (password.length >= 24) score++;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(password)
  ).length;
  if (classes >= 3) score++;

  const capped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: capped, label: ["", "Weak", "Fair", "Good", "Strong"][capped] ?? "" };
}
