/**
 * What every account call answers with, and the two steps every sign-in path shares.
 *
 * WHY THIS IS ITS OWN FILE. `keep()` is the second half of every sign-in there is — password,
 * registration, a reset code, Google, Microsoft — and it is not a formatting helper: when the
 * credential store refuses the token, it is what revokes the session the server has ALREADY issued.
 * A second copy of that in the provider path would be a second chance to leave a live session on our
 * server held by no device and revocable by nobody. This was inside `password.ts`; `oauth.ts` needing
 * it is what moved it.
 *
 * NOTHING HERE THROWS. The IPC broker turns an unexpected error into "<channel> failed", which tells
 * a person nothing they can act on, so a refusal is a value that carries the server's own wording.
 */
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

export type SignedIn = {
  ok: true;
  user: Pick<AccountUser, "id" | "email" | "name">;
  /**
   * True when this sign-in created the account — registration, or a first provider sign-in.
   *
   * Not optional: `keep()` reads it from every session response, so a caller that has a `SignedIn`
   * has an answer. An optional field would invite `if (result.created)` to mean "an older build",
   * when what it actually means is "signed in to an account that already existed".
   */
  created: boolean;
};

export const OFFLINE: Failure = {
  ok: false,
  code: "offline",
  message: "Could not reach VoidCode. Check your connection and try again.",
};

export const RATE_LIMITED: Failure = {
  ok: false,
  code: "rate_limited",
  message: "Too many attempts. Wait a few minutes and try again.",
};

/** `apiCall`, with its two throwing cases turned into the outcomes a caller can show. */
export async function request(
  path: string,
  init: Parameters<typeof apiCall>[1],
): Promise<ApiResult | Failure> {
  try {
    return await apiCall(path, init);
  } catch (err) {
    if (err instanceof ApiNotConfiguredError) {
      return { ok: false, code: "not_configured", message: err.message };
    }
    return OFFLINE;
  }
}

export function isFailure(value: ApiResult | Failure): value is Failure {
  return (value as Failure).ok === false;
}

/** A non-2xx response as a failure, preferring the server's `code`, `message` and `field`. */
export function refusal(result: ApiResult, fallback: string): Failure {
  if (result.status === 429) return RATE_LIMITED;
  const field = fieldOf(result.body);
  return {
    ok: false,
    code: codeOf(result.body) ?? `http_${String(result.status)}`,
    message: detailOf(result.body) ?? fallback,
    ...(field !== null ? { field } : {}),
  };
}

/**
 * A session response (`{token, user, created?}`) into a kept session.
 *
 * The token goes to the OS credential store and is never returned; the caller learns who signed in.
 *
 * `password_cleared` USED TO BE READ HERE and is gone with the providers that produced it: it meant
 * "attaching a provider removed a password set on this address without the address ever being
 * proven", and nothing can attach a provider any more. An older API still sending the field is
 * handled by not looking for it, which is what this already did for a field that was optional.
 */
export async function keep(result: ApiResult): Promise<SignedIn | Failure> {
  const body = result.body as {
    token?: unknown;
    user?: { id?: unknown; email?: unknown; name?: unknown };
    created?: unknown;
  } | null;
  const token = body?.token;
  const user = body?.user;
  if (typeof token !== "string" || typeof user?.id !== "string" || typeof user.email !== "string") {
    return { ok: false, code: "bad_response", message: "VoidCode returned an unexpected response." };
  }
  const name = typeof user.name === "string" ? user.name : "";
  const kept = await storeSession(token, { id: user.id, email: user.email, name });
  if (!kept.ok) return { ok: false, code: "storage_unavailable", message: kept.message };
  return {
    ok: true,
    user: { id: user.id, email: user.email, name },
    created: body?.created === true,
  };
}
