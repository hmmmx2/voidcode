/**
 * Google and Microsoft, as this application asks for them.
 *
 * WHICH HALF LIVES HERE. The desktop runs the browser half of the flow (RFC 8252) and the API runs
 * the token half, so this file holds only what a browser is sent to: the authorize endpoint, the
 * scopes, and the query the provider reads. The token endpoints, the signing keys and every check on
 * what comes back are in `apps/api/src/services/oidc.py`, because verification belongs where it can
 * be changed without shipping a new installer.
 *
 * WHY THE AUTHORIZE URL IS BUILT HERE AND NOT PASSED IN. `account:signInOAuth` takes two enums and
 * nothing else. A channel that accepted a URL would be a channel through which a renderer could ask
 * this process to open any address in the user's browser — which is the whole reason the renderer
 * has no way to reach `openExternal`. So the renderer names a provider; this file decides where
 * that name goes.
 *
 * WHAT IS DELIBERATELY NOT REQUESTED
 *
 *   * No `offline_access` (Microsoft) and no `access_type=offline` (Google), so neither provider
 *     issues a refresh token. We sign someone in once and are done; a refresh token would be
 *     standing permission to act as them, held for as long as we kept it, in exchange for nothing.
 *   * Nothing beyond `openid email profile`. No mail, no files, no contacts, no directory. The
 *     consent screen a person sees should be short enough to read, and it is short because this is
 *     all we ask for.
 *
 * `prompt=select_account` because both providers otherwise sign in whichever account the browser is
 * already holding, with no visible choice. Someone with a personal and a university account has no
 * way to tell which one they just attached — and on the Connect buttons in `/account` that is the
 * entire question being asked.
 */
import { oauthClientId } from "../platform/config.js";

export const PROVIDERS = ["google", "microsoft"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** How long a sign-in may sit waiting in the browser before this side gives up. */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface Descriptor {
  /** As the provider writes it, and as the button says. Never "OAuth" — nobody signs in to that. */
  label: string;
  authorizeUrl: string;
  scope: string;
  /** Provider-specific query beyond the parameters every authorization request carries. */
  extra: Record<string, string>;
}

const DESCRIPTORS: Record<ProviderId, Descriptor> = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    extra: {},
  },
  microsoft: {
    label: "Microsoft",
    // `/common/`, so both work and personal accounts can sign in. Which tenant a token came from is
    // then decided by the token's own `tid`, server-side.
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    scope: "openid email profile",
    // The code comes back in the query string, which is where a loopback listener can read it.
    // Microsoft's default for a native client is `query` already; stating it means a change of
    // default cannot silently start posting the code to a listener that only parses a URL.
    extra: { response_mode: "query" },
  },
};

export function isProvider(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function labelFor(provider: ProviderId): string {
  return DESCRIPTORS[provider].label;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /** False when this build has no client id for it: the button is not drawn. */
  configured: boolean;
}

/**
 * Every provider, with whether this build can actually use it.
 *
 * Both are always listed, rather than filtering here, so the renderer can say "not in this build"
 * where that is the useful thing to say (the Connect rows on `/account`) and simply draw nothing
 * where it is not (the sign-in dialog).
 */
export function providerStatuses(): ProviderStatus[] {
  return PROVIDERS.map((id) => ({
    id,
    label: DESCRIPTORS[id].label,
    configured: oauthClientId(id) !== null,
  }));
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  /** The S256 challenge — `base64url(sha256(verifier))`. The verifier never leaves this process. */
  codeChallenge: string;
}

/**
 * The address to open in the user's browser.
 *
 * Built with `URLSearchParams`, so every value is escaped exactly once. Hand-concatenated query
 * strings are how a `+` in a challenge becomes a space and a flow fails with `invalid_grant` from
 * the provider, which reads like a server problem.
 */
export function authorizeUrl(provider: ProviderId, request: AuthorizeRequest): string {
  const descriptor = DESCRIPTORS[provider];
  const url = new URL(descriptor.authorizeUrl);
  const query: Record<string, string> = {
    client_id: request.clientId,
    response_type: "code",
    redirect_uri: request.redirectUri,
    scope: descriptor.scope,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    ...descriptor.extra,
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
