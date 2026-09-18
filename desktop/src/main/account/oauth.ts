/**
 * Signing in with Google or Microsoft, and connecting one to an existing account.
 *
 * THE SHAPE OF THE FLOW, AND WHO HOLDS WHAT
 *
 *   renderer  ── provider + mode, two enums and nothing else ──▶  this file
 *   this file ── opens the system browser at the authorize URL ──▶  the person's own browser
 *   browser   ── redirected back with ?code ──▶  the loopback listener (`loopback.ts`)
 *   this file ── {code, verifier, redirect_uri, nonce} ──▶  our API
 *   our API   ── redeems the code, verifies the ID token ──▶  a session, or a refusal
 *
 * THE SYSTEM BROWSER, NOT A WINDOW OF OURS. An embedded window would mean the person typing their
 * Google password into a window this application controls and can read, with no address bar to
 * check — which is indistinguishable from a phishing page, and is why RFC 8252 says not to do it.
 * The browser they already use also already holds their session, so most sign-ins are one click.
 *
 * WHAT THE CODE IS BOUND TO. The verifier is 32 random bytes, kept in this process and sent only to
 * our API; the provider is given its SHA-256, so a code intercepted in transit cannot be redeemed by
 * anything that did not start this flow (PKCE, RFC 7636). `state` binds the redirect to this flow —
 * checked by the listener — and `nonce` binds the ID token to it, checked server-side. None of the
 * three is ever written to disk or logged.
 *
 * LINK MODE IS DECIDED BY THE CREDENTIAL. Connecting a provider sends the current session as a
 * Bearer token, and the API reads link mode from the presence of that credential rather than from a
 * flag in the body — a flag could ask to attach a provider to an account without proving who is
 * asking. Signed out, link mode is refused HERE, before a browser is opened: a five-minute detour
 * through a consent screen that can only end in "you're not signed in" is worse than a refusal.
 *
 * ONE FLOW AT A TIME. Starting a second cancels the first, because the first is by then a browser
 * tab the person has abandoned in favour of the provider they actually meant. Its listener is closed
 * and its outcome is `cancelled`.
 */
import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { TERMS_VERSION } from "../../shared/legal.js";
import { checkedExternalUrl } from "../net/external.js";
import { oauthClientId } from "../platform/config.js";
import { isFailure, keep, refusal, request, type Failure, type SignedIn } from "./outcomes.js";
import { sessionToken, refresh } from "./session.js";
import { openLoopback, type Loopback } from "./loopback.js";
import { OAUTH_TIMEOUT_MS, authorizeUrl, labelFor, type ProviderId } from "./providers.js";

export type OAuthMode = "signIn" | "link";

/** A provider attached to the account that is already signed in. No new session is issued. */
export type Linked = { ok: true; linked: true; provider: ProviderId };

export type OAuthResult = SignedIn | Linked | Failure;

/**
 * 32 bytes, base64url, which is 43 characters — the length the API's `nonce` pattern requires and
 * comfortably inside RFC 7636's 43-128 for a verifier. `base64url` emits no `+`, `/` or `=`, so
 * every one of these survives a query string unescaped.
 */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface Pending {
  provider: ProviderId;
  mode: OAuthMode;
  /** Kept so "Open the browser again" reopens the SAME authorization request. */
  url: string;
  loopback: Loopback;
}

let pending: Pending | null = null;

/** Which provider is waiting on the browser, for a renderer that mounts mid-flow. */
export function pendingFlow(): { provider: ProviderId; mode: OAuthMode } | null {
  return pending === null ? null : { provider: pending.provider, mode: pending.mode };
}

/** Stop waiting. Also called when the window that started the flow is destroyed. */
export function cancel(): { ok: true } {
  pending?.loopback.cancel();
  pending = null;
  return { ok: true };
}

/**
 * Open the browser again at the authorization request already in progress.
 *
 * The same URL, deliberately: a fresh one would mean a new `state` and a new listener, and the tab
 * the person still has open would then be answering a flow nobody is waiting for. This is for the
 * ordinary case of a browser that opened behind another window, or a tab closed by accident.
 */
export async function reopen(): Promise<{ ok: true } | Failure> {
  if (pending === null) {
    return { ok: false, code: "no_flow", message: "There's no sign-in waiting." };
  }
  await shell.openExternal(pending.url);
  return { ok: true };
}

/** Every way the browser half can end without a code, in the words the app shows. */
function browserFailure(
  provider: ProviderId,
  outcome: { outcome: "denied"; error: string; description: string | null } | { outcome: "timeout" } | { outcome: "cancelled" },
): Failure {
  const label = labelFor(provider);
  if (outcome.outcome === "timeout") {
    return { ok: false, code: "timeout", message: "That sign-in timed out. Try again." };
  }
  if (outcome.outcome === "cancelled") {
    return { ok: false, code: "cancelled", message: "Sign-in cancelled." };
  }
  // `access_denied` is the person pressing Cancel, which is not an error to apologise for. Anything
  // else is the provider refusing for its own reasons, and its description is more use than ours.
  if (outcome.error === "access_denied") {
    return { ok: false, code: "denied", message: `${label} sign-in was cancelled.` };
  }
  return {
    ok: false,
    code: "denied",
    message: outcome.description ?? `${label} could not complete the sign-in (${outcome.error}).`,
  };
}

/**
 * Run the whole flow. Resolves when it ends, which may be five minutes later.
 *
 * Never throws: every outcome, including "you closed the tab", is a value.
 */
export async function signIn(provider: ProviderId, mode: OAuthMode): Promise<OAuthResult> {
  const clientId = oauthClientId(provider);
  if (clientId === null) {
    // No browser is opened, and this is the state a fork's build is in. `providerStatuses()` reports
    // it too, so the button is normally not drawn at all — this is the second line of that defence.
    return {
      ok: false,
      code: "not_configured",
      message: `${labelFor(provider)} sign-in isn't set up in this build.`,
    };
  }
  if (mode === "link" && sessionToken() === undefined) {
    return { ok: false, code: "signed_out", message: "Sign in first, then connect an account." };
  }

  cancel();

  const verifier = randomToken();
  const state = randomToken();
  const nonce = randomToken();

  let loopback: Loopback;
  try {
    loopback = await openLoopback({ state, timeoutMs: OAUTH_TIMEOUT_MS });
  } catch {
    return {
      ok: false,
      code: "no_listener",
      message: "VoidCode could not open a local port to finish signing in.",
    };
  }

  const url = authorizeUrl(provider, {
    clientId,
    redirectUri: loopback.redirectUri,
    state,
    nonce,
    codeChallenge: challengeFor(verifier),
  });

  /**
   * Checked even though we built it. The one part of this URL that comes from outside this file is
   * the client id, which an unpackaged build reads from the environment — and every call to
   * `openExternal` in this application goes through this check, which is a rule worth more than the
   * one line it costs here.
   */
  if (checkedExternalUrl(url, { allowLoopbackHttp: false }) === null) {
    loopback.cancel();
    return { ok: false, code: "bad_provider_url", message: "Refused to open that sign-in page." };
  }

  const flow: Pending = { provider, mode, url, loopback };
  pending = flow;

  try {
    await shell.openExternal(url);
  } catch {
    loopback.cancel();
    if (pending === flow) pending = null;
    return {
      ok: false,
      code: "no_browser",
      message: "VoidCode could not open your browser. Sign in with an email address instead.",
    };
  }

  const outcome = await loopback.result;
  if (pending === flow) pending = null;

  if (outcome.outcome !== "code") return browserFailure(provider, outcome);

  return await exchange(provider, mode, {
    clientId,
    code: outcome.code,
    verifier,
    nonce,
    redirectUri: loopback.redirectUri,
  });
}

/**
 * Relay the code to our API, which redeems it and verifies the ID token.
 *
 * The code and the verifier go no further than this call and are not returned to the renderer or
 * logged. A `terms_version` is sent in sign-in mode only, because a first provider sign-in may
 * CREATE an account and the API refuses to create one without a version — and it is this build's
 * version, never a value the renderer supplied.
 */
async function exchange(
  provider: ProviderId,
  mode: OAuthMode,
  input: { clientId: string; code: string; verifier: string; nonce: string; redirectUri: string },
): Promise<OAuthResult> {
  const result = await request(`/auth/desktop/oauth/${provider}`, {
    method: "POST",
    auth: mode === "link",
    body: JSON.stringify({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      nonce: input.nonce,
      ...(mode === "signIn" ? { terms_version: TERMS_VERSION } : {}),
    }),
  });
  if (isFailure(result)) return result;

  if (mode === "link") {
    if (result.status !== 200) {
      return refusal(result, `Could not connect your ${labelFor(provider)} account.`);
    }
    // The account's list of sign-in methods just changed, and `/account` renders from it.
    void refresh();
    return { ok: true, linked: true, provider };
  }

  if (result.status !== 200) {
    return refusal(result, `Could not sign in with ${labelFor(provider)}.`);
  }
  return await keep(result);
}
