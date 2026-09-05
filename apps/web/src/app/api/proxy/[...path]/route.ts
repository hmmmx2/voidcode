/**
 * Server-side proxy to the FastAPI backend.
 *
 * WHY EVERY BROWSER CALL NOW GOES THROUGH HERE
 *
 * The API used to derive identity from a raw `X-User-Id` header that the browser
 * set itself. `NEXT_PUBLIC_API_URL` is public, so anyone could call the API
 * directly with somebody else's UUID and read or write their chat history,
 * drafts and profile.
 *
 * `apps/api/src/identity.py` now requires an HMAC signature over that id, keyed
 * on `INTERNAL_API_SECRET`. This route is where that signature is produced. The
 * secret is a server-only env var — deliberately NOT `NEXT_PUBLIC_` — so it
 * never reaches the browser bundle.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 * The identity is read from the session and NOTHING ELSE. Any `X-User-Id` or
 * `X-Internal-Auth` the caller supplied is stripped before forwarding.
 *
 * That is the whole security property. A proxy that forwarded the client's own
 * `X-User-Id` and signed it would be strictly worse than no proxy at all: the
 * forgery would arrive carrying a valid signature, so the backend would trust
 * it, and every test of the signing logic would still pass. See
 * `test_the_proxy_ignores_a_client_supplied_identity`.
 *
 * WHY THE RESPONSE IS STREAMED RATHER THAN READ
 *
 * Two endpoints stream: `GET /v1/notifications/stream` (SSE) and
 * `POST /v1/chat/completions` (token-by-token). Calling `.json()` or `.text()`
 * here would buffer them to completion, so notifications would arrive in one
 * batch when the connection closed and the tutor would appear to hang for the
 * whole generation and then dump its answer at once. `upstream.body` is passed
 * through untouched.
 *
 * Request bodies ARE buffered, which is fine — they are small JSON payloads, and
 * streaming a request body needs `duplex: "half"` and is not supported evenly
 * across runtimes.
 */

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { auth } from "@/auth";

// Streaming responses cannot be statically rendered or cached.
export const dynamic = "force-dynamic";

/**
 * Server-side only. `NEXT_PUBLIC_API_URL` is the fallback so a local setup that
 * only sets the public var keeps working.
 */
const API_URL =
  process.env.API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:8000";

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Mirrors `sign_identity()` in `apps/api/src/identity.py`. The message is
 * `userId + "\n" + issuedAt` — the id is inside the signature, so a signature
 * cannot be lifted onto a different user.
 *
 * If these two implementations ever drift, every request fails closed with a
 * 401 rather than authenticating the wrong person.
 */
function signIdentity(userId: string, issuedAt: number): string {
  const digest = createHmac("sha256", INTERNAL_API_SECRET)
    .update(`${userId}\n${issuedAt}`)
    .digest("hex");
  return `${issuedAt}.${digest}`;
}

/**
 * Headers that must never survive the hop.
 *
 * `x-user-id` and `x-internal-auth` are the security-critical pair — see the
 * file header. `host` and `content-length` are dropped because we are changing
 * origin and may have re-encoded the body; forwarding a stale `content-length`
 * truncates it.
 */
const STRIPPED = new Set([
  "x-user-id",
  "x-internal-auth",
  "host",
  "content-length",
  "connection",
]);

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const session = await auth();
  const userId = (session?.user as { backendId?: string } | undefined)?.backendId;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
  });

  // Identity comes from the session or not at all. An unauthenticated caller is
  // forwarded with no id, and the backend treats that as the anonymous visitor —
  // which is what keeps the public catalogue browsable.
  if (userId) {
    if (!INTERNAL_API_SECRET) {
      // Refusing beats forwarding an unsigned id. With the backend's
      // INTERNAL_AUTH_ENFORCE on, an unsigned request 401s anyway; failing here
      // names the actual cause instead of looking like a broken session.
      console.error(
        "INTERNAL_API_SECRET is not set — cannot sign the identity for the API.",
      );
      return new Response(
        JSON.stringify({ detail: "Server is missing INTERNAL_API_SECRET." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    headers.set("X-User-Id", userId);
    headers.set("X-Internal-Auth", signIdentity(userId, issuedAt));
  }

  const search = request.nextUrl.search;
  const target = `${API_URL}/${path.join("/")}${search}`;

  const method = request.method;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      // Follow nothing: a redirect from the API would be resolved against the
      // API's origin and could leave the signed header on a host we did not mean
      // to send it to.
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    console.error(`Proxy request to ${method} ${target} failed:`, error);
    return new Response(
      JSON.stringify({ detail: "The API did not respond." }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  // Set by the upstream for its own origin; both are meaningless or wrong here.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  // `upstream.body` streams. Do not read it — see the file header.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
