/**
 * Shared API client helper.
 *
 * WHY THIS POINTS AT A LOCAL ROUTE AND NOT AT THE API
 *
 * It used to be `process.env.NEXT_PUBLIC_API_URL`, so the browser talked to
 * FastAPI directly and asserted its own identity with an `X-User-Id` header.
 * That header was unsigned and unchecked: anyone could send somebody else's UUID
 * and read or write their chat history, drafts and profile.
 *
 * Calls now go to `/api/proxy/...`, a server-side route handler that reads the
 * session, signs the identity it resolved with `INTERNAL_API_SECRET`, and
 * forwards. The secret is server-only and never enters the browser bundle.
 * See `src/app/api/proxy/[...path]/route.ts` and `apps/api/src/identity.py`.
 *
 * The relative base is deliberate — it inherits the page's origin, so no CORS
 * preflight and no tunnel-origin allowance is involved in normal operation.
 *
 * WHY `makeHeaders` STILL TAKES A userId AND STILL IGNORES IT
 *
 * Roughly thirty call sites pass one. Changing every signature at once would
 * have made this a far larger diff with no security gain, because **the proxy
 * strips any client-supplied `X-User-Id` regardless** — trusting it there would
 * defeat the entire change. The parameter is accepted and dropped, so the call
 * sites are correct today and can be cleaned up separately.
 */

/**
 * Browser calls are proxied. Server-side callers that legitimately need the API
 * directly — `src/auth.ts` and `src/app/api/auth/register/route.ts`, both of
 * which run before a session exists — read `NEXT_PUBLIC_API_URL` themselves.
 */
export const API_BASE = "/api/proxy";

// Unused on purpose, not by oversight: see the note above. Kept in the signature
// so ~30 call sites stay valid while the proxy makes the argument meaningless.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function makeHeaders(_userId?: string): HeadersInit {
  // No X-User-Id. The proxy derives identity from the session; a header set here
  // would be stripped, and sending one would only suggest it was trusted.
  return {
    "Content-Type": "application/json",
  };
}
