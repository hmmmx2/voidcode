/**
 * The one way main talks to the VoidCode API.
 *
 * This was `call()` inside `inference/hosted.ts`. It moved because signing in, the account, credits
 * and the research library all need it, and because two rules have to hold for every one of them
 * rather than being re-implemented per caller:
 *
 *   1. SIGNED OUT MEANS NO REQUEST. An authenticated call with no session answers a synthetic 401
 *      without touching the network. A local-first app launched by someone who never signed in must
 *      not be reaching our server, and "the caller checked first" is not a guarantee.
 *
 *   2. A 401 ON A SESSION WE SENT ENDS THAT SESSION. The server says the token is no longer good —
 *      revoked on another device, expired, account deactivated. Until this existed the desktop kept
 *      the dead token and reported itself signed in, and every hosted request failed one at a time.
 *      The handler is told WHICH token got the 401, so a slow request finishing after the person has
 *      signed in again cannot sign them out of the new session.
 *
 * The session module registers its hooks here rather than being imported, because the session also
 * makes calls through this module and a direct import would be a cycle.
 */
import { apiBase } from "./config.js";

/** A request is a request, not a wait. A hung API must not hang the window. */
const TIMEOUT_MS = 20_000;

export interface ApiResult {
  status: number;
  body: unknown;
}

/** No API address is configured for this build, or the configured one is unacceptable. */
export class ApiNotConfiguredError extends Error {
  constructor() {
    super("VoidCode isn't set up in this build.");
    this.name = "ApiNotConfiguredError";
  }
}

interface SessionHooks {
  token(): string | undefined;
  onUnauthorized(tokenThatFailed: string): void;
}

let hooks: SessionHooks = {
  token: () => undefined,
  onUnauthorized: () => {},
};

export function registerSessionHooks(next: SessionHooks): void {
  hooks = next;
}

export interface ApiRequest extends Omit<RequestInit, "headers" | "signal"> {
  headers?: Record<string, string>;
  /** Send the stored session. Without one, answers 401 without a request. */
  auth?: boolean;
  /**
   * Send this token instead of the stored one, and do NOT treat a 401 as the stored session ending.
   * For the one case that needs it: revoking a token that was issued but could not be stored.
   */
  bearer?: string;
}

/**
 * Throws `ApiNotConfiguredError` when there is no address, and lets network failures propagate as
 * `TypeError`/`AbortError` so callers can say "could not reach VoidCode" rather than guessing.
 */
export async function apiCall(path: string, init: ApiRequest = {}): Promise<ApiResult> {
  const base = apiBase();
  if (base === null) throw new ApiNotConfiguredError();

  const { auth, bearer, headers: extra, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };

  let sentSession: string | undefined;
  if (bearer !== undefined) {
    headers.authorization = `Bearer ${bearer}`;
  } else if (auth === true) {
    const token = hooks.token();
    if (token === undefined) return { status: 401, body: { detail: "Not signed in." } };
    headers.authorization = `Bearer ${token}`;
    sentSession = token;
  }

  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A proxy error page, or an empty 204. The status is the part that matters.
  }

  if (response.status === 401 && sentSession !== undefined) {
    hooks.onUnauthorized(sentSession);
  }
  return { status: response.status, body };
}

/** The server's `detail` when it is a string, or its `{message}` when it is an object, else null. */
export function detailOf(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (detail !== null && typeof detail === "object") {
    const message = (detail as { message?: unknown; detail?: unknown }).message ??
      (detail as { detail?: unknown }).detail;
    if (typeof message === "string") return message;
  }
  return null;
}

/** The API's machine-readable `detail.code`, when it sends one. */
export function codeOf(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const code = detail !== null && typeof detail === "object" ? (detail as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

/** The field a validation error names (`{field, detail}`), when the API sends one. */
export function fieldOf(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const field = detail !== null && typeof detail === "object" ? (detail as { field?: unknown }).field : undefined;
  return typeof field === "string" ? field : null;
}
