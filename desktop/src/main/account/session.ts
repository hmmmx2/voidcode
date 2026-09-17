/**
 * The VoidCode session on this device: whether there is one, who it belongs to, and ending it.
 *
 * SIGN-IN IS OPTIONAL, AND THIS MODULE IS WHERE THAT IS KEPT TRUE
 *
 * Signed out, nothing here touches the network. `state()` answers from the keychain alone, and every
 * authenticated call in `platform/http.ts` short-circuits without a session. A learner who never
 * creates an account gets an application that never contacts our server.
 *
 * WHAT IS STORED, AND WHERE
 *
 *   * The session token: encrypted by the OS credential store, via `inference/vault.ts`. Never
 *     returned to the renderer.
 *   * Who is signed in (email, name, linked providers): held in MEMORY ONLY. It is fetched from
 *     `GET /v1/auth/me` and never written to SQLite. The local `profile` table has no email column,
 *     the Privacy Policy says so, and `honest-copy.test.ts` checks that no file in this directory
 *     imports from `store/` — an account email persisted locally would be a copy of server data
 *     that outlives sign-out.
 *
 * WHY "SIGNED IN" STILL DOES NOT NEED THE NETWORK
 *
 * A stored token means signed in, even offline; `refresh()` then asks the server whether that is
 * still true, and a 401 from anywhere ends it. Requiring the network to believe your own keychain
 * would sign someone out every time their Wi-Fi dropped.
 */
import { detailOf, apiCall, registerSessionHooks } from "../platform/http.js";
import {
  EncryptionUnavailableError,
  clearSecret,
  secretIsDurable,
  secretValue,
  setSecret,
} from "../inference/vault.js";
import { overridesAllowed } from "../platform/config.js";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  emailVerified: boolean;
  providers: string[];
}

export interface SessionState {
  signedIn: boolean;
  /** Null until `refresh()` has succeeded at least once this launch. */
  user: AccountUser | null;
  /** The last attempt to reach the server failed for want of a connection. */
  offline: boolean;
  /** False when the session is held only until the app quits (no usable keyring). */
  durable: boolean;
}

export type ChangeReason = "signedIn" | "signedOut" | "expired" | "updated";

let cachedUser: AccountUser | null = null;
let offline = false;
let broadcast: (event: { reason: ChangeReason; state: SessionState }) => void = () => {};

/** Main's `index.ts` supplies a sender to every window. Tests supply a recorder. */
export function setAccountBroadcaster(fn: typeof broadcast): void {
  broadcast = fn;
}

/**
 * The token to present, or undefined.
 *
 * `VOIDCODE_DEV_SESSION_TOKEN` is honoured only when nothing is stored AND this process may be
 * configured by its environment (an unpackaged build). See `inference/registry.ts` for why it
 * replaced the old unsigned `VOIDCODE_USER_ID`.
 */
export function sessionToken(): string | undefined {
  const stored = secretValue("voidcode");
  if (stored !== undefined) return stored;
  if (!overridesAllowed()) return undefined;
  const dev = process.env.VOIDCODE_DEV_SESSION_TOKEN;
  return dev !== undefined && dev !== "" ? dev : undefined;
}

export function state(): SessionState {
  const signedIn = sessionToken() !== undefined;
  return {
    signedIn,
    user: signedIn ? cachedUser : null,
    offline: signedIn && offline,
    durable: signedIn && secretIsDurable("voidcode"),
  };
}

function emit(reason: ChangeReason): void {
  broadcast({ reason, state: state() });
}

function toUser(body: unknown): AccountUser | null {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b.id !== "string" || typeof b.email !== "string") return null;
  return {
    id: b.id,
    email: b.email,
    name: typeof b.name === "string" ? b.name : "",
    hasPassword: b.has_password === true,
    emailVerified: b.email_verified === true,
    providers: Array.isArray(b.providers) ? b.providers.filter((p): p is string => typeof p === "string") : [],
  };
}

/**
 * Ask the server who this session belongs to. Signed out: no request, just the state.
 *
 * A 401 is handled by `http.ts`, which calls `handleUnauthorized` — so by the time this returns,
 * an ended session has already been cleared and announced.
 */
export async function refresh(): Promise<SessionState> {
  if (sessionToken() === undefined) return state();

  try {
    const { status, body } = await apiCall("/auth/me", { auth: true });
    offline = false;
    if (status === 200) {
      const user = toUser(body);
      const changed = JSON.stringify(user) !== JSON.stringify(cachedUser);
      cachedUser = user;
      if (changed) emit("updated");
    }
  } catch {
    // Not configured, or no connection. Keep the session — see the module header — and say so.
    offline = true;
  }
  return state();
}

/**
 * Keep a session the server just issued. Returns an outcome rather than throwing.
 *
 * THE SERVER HAS ALREADY ISSUED THE TOKEN, which is why a storage failure cannot simply be reported:
 * with no usable credential store the token would sit live on the server, held by no device and
 * revocable by nobody. It is revoked with its own header before the failure is returned.
 */
export async function storeSession(
  token: string,
  user: { id: string; email: string; name: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    setSecret("voidcode", token);
  } catch (err) {
    try {
      await apiCall("/auth/desktop/session", { method: "DELETE", bearer: token });
    } catch {
      // Unreachable now is fine: the orphan still expires on its own.
    }
    return {
      ok: false,
      message:
        err instanceof EncryptionUnavailableError
          ? err.message
          : "VoidCode could not keep your sign-in on this computer.",
    };
  }

  offline = false;
  cachedUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    // Filled in by the refresh below; a sign-in response does not carry them.
    hasPassword: cachedUser?.id === user.id ? cachedUser.hasPassword : false,
    emailVerified: cachedUser?.id === user.id ? cachedUser.emailVerified : false,
    providers: cachedUser?.id === user.id ? cachedUser.providers : [],
  };
  emit("signedIn");
  void refresh();
  return { ok: true };
}

function forget(): void {
  clearSecret("voidcode");
  cachedUser = null;
  offline = false;
}

/**
 * End this device's session. The local secret is cleared even when the server call fails: a person
 * who pressed "sign out" and was told it failed, while their machine kept a working credential, has
 * been given the worst of both answers. The token expires on its own regardless.
 */
export async function signOut(): Promise<void> {
  if (secretValue("voidcode") !== undefined) {
    try {
      await apiCall("/auth/desktop/session", { method: "DELETE", auth: true });
    } catch {
      // Deliberately swallowed — see above.
    }
  }
  forget();
  emit("signedOut");
}

/** Sign this account out of every device, this one included. */
export async function signOutEverywhere(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (secretValue("voidcode") === undefined) return { ok: false, message: "You're not signed in." };
  let result;
  try {
    result = await apiCall("/auth/desktop/sessions", { method: "DELETE", auth: true });
  } catch {
    return { ok: false, message: "Could not reach VoidCode, so other devices are still signed in." };
  }
  if (result.status !== 200 && result.status !== 401) {
    return { ok: false, message: detailOf(result.body) ?? "Could not sign out of every device." };
  }
  forget();
  emit("signedOut");
  return { ok: true };
}

/**
 * The server rejected `tokenThatFailed`. End the session — but only if it is still the stored one.
 *
 * A request can outlive the session it was sent with: sign out, sign back in, and a slow request
 * from before finishes with a 401. Clearing unconditionally would sign the person out of the session
 * they just created. Comparing against the token that actually failed makes the order irrelevant.
 */
export function handleUnauthorized(tokenThatFailed: string): void {
  if (secretValue("voidcode") !== tokenThatFailed) return;
  forget();
  emit("expired");
}

registerSessionHooks({ token: sessionToken, onUnauthorized: handleUnauthorized });

/** Tests only: forget the in-memory user without touching the keychain. */
export function __resetSessionMemory(): void {
  cachedUser = null;
  offline = false;
}
