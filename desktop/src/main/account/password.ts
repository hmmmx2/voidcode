/**
 * Email-and-password accounts: sign in, create one, reset a forgotten password by emailed code, and
 * change a known one.
 *
 * EVERY FUNCTION RETURNS AN OUTCOME AND NONE THROWS. The IPC broker masks an unexpected error as
 * "<channel> failed", which tells a person nothing; an outcome carries the server's own wording.
 *
 * THE SERVER'S WORDING IS PASSED THROUGH, NOT REWRITTEN. Sign-in answers one message for every
 * credential failure on purpose, so it cannot reveal whether an address has an account; paraphrasing
 * it here would risk inventing a distinction the server refuses to make.
 *
 * PASSWORDS CROSS ONE IPC CALL AND ARE NOT KEPT. Nothing here stores or logs one, and the renderer is
 * never handed the session token — only who signed in.
 */
import { TERMS_VERSION } from "../../shared/legal.js";
import {
  ApiNotConfiguredError,
  apiCall,
  codeOf,
  detailOf,
  fieldOf,
  type ApiResult,
} from "../platform/http.js";
import { storeSession, type AccountUser } from "./session.js";

export type Failure = {
  ok: false;
  /** Stable, for the renderer to branch on: `offline`, `not_configured`, `rate_limited`, … */
  code: string;
  message: string;
  /** Which form field the message belongs to, when the server named one. */
  field?: string;
};

export type SignedIn = { ok: true; user: Pick<AccountUser, "id" | "email" | "name"> };

const OFFLINE: Failure = {
  ok: false,
  code: "offline",
  message: "Could not reach VoidCode. Check your connection and try again.",
};
const RATE_LIMITED: Failure = {
  ok: false,
  code: "rate_limited",
  message: "Too many attempts. Wait a few minutes and try again.",
};

async function request(path: string, init: Parameters<typeof apiCall>[1]): Promise<ApiResult | Failure> {
  try {
    return await apiCall(path, init);
  } catch (err) {
    if (err instanceof ApiNotConfiguredError) {
      return { ok: false, code: "not_configured", message: err.message };
    }
    return OFFLINE;
  }
}

function isFailure(value: ApiResult | Failure): value is Failure {
  return (value as Failure).ok === false;
}

function refusal(result: ApiResult, fallback: string): Failure {
  if (result.status === 429) return RATE_LIMITED;
  const field = fieldOf(result.body);
  return {
    ok: false,
    code: codeOf(result.body) ?? `http_${result.status}`,
    message: detailOf(result.body) ?? fallback,
    ...(field !== null ? { field } : {}),
  };
}

/** A session response (`{token, user}`) into a kept session and a `SignedIn`. */
async function keep(result: ApiResult): Promise<SignedIn | Failure> {
  const body = result.body as { token?: unknown; user?: { id?: unknown; email?: unknown; name?: unknown } } | null;
  const token = body?.token;
  const user = body?.user;
  if (typeof token !== "string" || typeof user?.id !== "string" || typeof user.email !== "string") {
    return { ok: false, code: "bad_response", message: "VoidCode returned an unexpected response." };
  }
  const kept = await storeSession(token, {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : "",
  });
  if (!kept.ok) return { ok: false, code: "storage_unavailable", message: kept.message };
  return { ok: true, user: { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : "" } };
}

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
