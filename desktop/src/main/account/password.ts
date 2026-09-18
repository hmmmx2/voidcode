/**
 * Email-and-password accounts: sign in, create one, reset a forgotten password by emailed code, and
 * change a known one.
 *
 * EVERY FUNCTION RETURNS AN OUTCOME AND NONE THROWS — see `outcomes.ts`, which holds the request
 * wrapper, the refusal mapping and `keep()`, the step that stores an issued session. They live there
 * rather than here because `oauth.ts` performs the same second half of a sign-in.
 *
 * THE SERVER'S WORDING IS PASSED THROUGH, NOT REWRITTEN. Sign-in answers one message for every
 * credential failure on purpose, so it cannot reveal whether an address has an account; paraphrasing
 * it here would risk inventing a distinction the server refuses to make.
 *
 * PASSWORDS CROSS ONE IPC CALL AND ARE NOT KEPT. Nothing here stores or logs one, and the renderer is
 * never handed the session token — only who signed in.
 */
import { TERMS_VERSION } from "../../shared/legal.js";
import { isFailure, keep, refusal, request, type Failure, type SignedIn } from "./outcomes.js";

export type { Failure, SignedIn };

export async function signInPassword(email: string, password: string): Promise<SignedIn | Failure> {
  const result = await request("/auth/desktop/session", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (isFailure(result)) return result;
  if (result.status !== 200) return refusal(result, "Incorrect email or password.");
  return keep(result);
}

/**
 * Create an account and sign in, in one request. `acceptTerms` is a literal `true` at the IPC
 * boundary; the version sent is this build's, never one the renderer supplies.
 */
export async function register(input: {
  name: string;
  email: string;
  password: string;
}): Promise<SignedIn | Failure> {
  const result = await request("/auth/desktop/register", {
    method: "POST",
    body: JSON.stringify({
      name: input.name.trim(),
      email: input.email.trim(),
      password: input.password,
      terms_accepted: true,
      terms_version: TERMS_VERSION,
    }),
  });
  if (isFailure(result)) return result;
  if (result.status !== 201) return refusal(result, "Could not create your account.");
  return keep(result);
}

/** Always the server's uniform message on success — it never says whether the address exists. */
export async function requestPasswordCode(
  email: string,
): Promise<{ ok: true; message: string } | Failure> {
  const result = await request("/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify({ email: email.trim() }),
  });
  if (isFailure(result)) return result;
  if (result.status !== 200) return refusal(result, "Could not send a code.");
  const message = (result.body as { message?: unknown } | null)?.message;
  return {
    ok: true,
    message: typeof message === "string" ? message : "If that address has an account, a code is on its way.",
  };
}

/** Set a new password with an emailed code. Success signs this device in and every other one out. */
export async function resetPassword(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<SignedIn | Failure> {
  const result = await request("/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ email: input.email.trim(), code: input.code, new_password: input.newPassword }),
  });
  if (isFailure(result)) return result;
  if (result.status !== 200) return refusal(result, "That code isn't valid or has expired.");
  return keep(result);
}

/** Change a known password. Other devices are signed out by the server; this one stays signed in. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true; message: string } | Failure> {
  const result = await request("/auth/change-password", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ current_password: input.currentPassword, new_password: input.newPassword }),
  });
  if (isFailure(result)) return result;
  if (result.status !== 200) {
    // A 401 here is either "not signed in" (http.ts has already ended the session) or "that is not
    // your current password" — the server's detail says which.
    return refusal(result, "Could not change your password.");
  }
  const message = (result.body as { message?: unknown } | null)?.message;
  return { ok: true, message: typeof message === "string" ? message : "Your password has been changed." };
}
