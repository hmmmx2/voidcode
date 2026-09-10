/**
 * Talking to the VoidCode platform API: signing in, reading a balance, starting a purchase.
 *
 * WHY THIS IS IN MAIN AND NOT THE RENDERER
 *
 * The session token is the credential. It lives in the OS keychain via `vault.ts`, and main is the
 * only process that can reach it — the renderer gets answers, never the token. That is the same
 * arrangement the OpenRouter key already has, and the reason is stronger here: this token can spend
 * a person's money.
 *
 * WHY THERE IS NO SDK AND NO CLIENT OBJECT
 *
 * Four `fetch` calls against endpoints we control. `payments.py` on the other side makes the same
 * choice about Stripe for the same reason, and its comment is worth repeating: a dependency that
 * can be replaced by twenty lines is twenty lines.
 *
 * EVERY FUNCTION HERE TOLERATES THE API BEING ABSENT
 *
 * The desktop app is local-first and must keep working with no network and no account. A learner
 * who never signs in should see the local providers behave exactly as they always have, so these
 * return a shaped failure rather than throwing into a renderer that has no way to recover.
 */
import { clearSecret, secretValue, setSecret } from "./vault.js";

/** Where the platform lives. Overridable so a developer can point at a local instance. */
function apiBase(): string {
  return process.env.VOIDCODE_API_URL ?? "http://127.0.0.1:8020/v1";
}

/** A request is a request, not a wait. A hung API must not hang the window. */
const TIMEOUT_MS = 20_000;

export interface SignedInUser {
  id: string;
  email: string;
  name: string;
}

export type SignInResult =
  | { ok: true; user: SignedInUser }
  | { ok: false; message: string };

async function call(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.auth === true) {
    const token = secretValue("voidcode");
    if (token === undefined) return { status: 401, body: { detail: "Not signed in." } };
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A proxy error page, or an empty 204. The status is the part that matters.
  }
  return { status: response.status, body };
}

/**
 * Exchange an email and password for a session token, and keep the token.
 *
 * The token never leaves this function's scope except into the vault. The renderer is told who
 * signed in, not what they signed in with.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  let result;
  try {
    result = await call("/auth/desktop/session", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, message: "Could not reach VoidCode. Check your connection." };
  }

  if (result.status !== 200) {
    // The API returns one message for every credential failure on purpose — it must not report
    // whether an address has an account. Passed through rather than reworded, so the two do not
    // drift into saying different things.
    const detail = (result.body as { detail?: unknown } | null)?.detail;
    return {
      ok: false,
      message: typeof detail === "string" ? detail : "Incorrect email or password.",
    };
  }

  const body = result.body as { token?: string; user?: SignedInUser } | null;
  if (typeof body?.token !== "string" || body.user === undefined) {
    return { ok: false, message: "VoidCode returned an unexpected response." };
  }

  setSecret("voidcode", body.token);
  return { ok: true, user: body.user };
}

/**
 * End this device's session.
 *
 * The local secret is cleared even when the server call fails. A learner who clicks sign out and
 * is told it failed, while their machine keeps a working credential, has been given the worst of
 * both answers; the token expires on its own regardless.
 */
export async function signOut(): Promise<void> {
  try {
    await call("/auth/desktop/session", { method: "DELETE", auth: true });
  } catch {
    // Deliberately swallowed — see above.
  }
  clearSecret("voidcode");
}

export function isSignedIn(): boolean {
  return secretValue("voidcode") !== undefined;
}

export interface CreditBalance {
  availableCredits: number;
  reservedMicro: number;
  estimatedMinutes?: number;
  rateMicroPerSlotSecond?: number;
}

export async function credits(): Promise<
  { ok: true; balance: CreditBalance } | { ok: false; message: string }
> {
  try {
    const { status, body } = await call("/credits", { auth: true });
    if (status === 401) return { ok: false, message: "Sign in to see your balance." };
    if (status !== 200) return { ok: false, message: "Could not read your balance." };
    return { ok: true, balance: body as CreditBalance };
  } catch {
    return { ok: false, message: "Could not reach VoidCode." };
  }
}

export interface CreditPack {
  code: string;
  label: string;
  priceDisplay: string;
  credits: number;
}

export async function packs(): Promise<CreditPack[]> {
  try {
    const { status, body } = await call("/credits/packs", { auth: true });
    if (status !== 200) return [];
    return ((body as { packs?: CreditPack[] } | null)?.packs ?? []);
  } catch {
    return [];
  }
}

/**
 * Start a purchase and return where to send the buyer.
 *
 * Returns a URL rather than opening it. Opening a browser is a main-process side effect with its
 * own consent question, and the caller — `index.ts` — is where every other external navigation in
 * this app is already funnelled and checked.
 */
export async function checkout(
  packCode: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const { status, body } = await call("/credits/checkout", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ pack_code: packCode }),
    });
    if (status === 401) return { ok: false, message: "Sign in before buying credit." };
    if (status === 503) return { ok: false, message: "Purchases are not available yet." };
    const url = (body as { redirectUrl?: string } | null)?.redirectUrl;
    if (status !== 200 || typeof url !== "string") {
      return { ok: false, message: "Could not start the purchase." };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: "Could not reach VoidCode." };
  }
}
