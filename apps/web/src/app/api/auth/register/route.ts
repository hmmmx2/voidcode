import { NextResponse } from "next/server";

/**
 * `POST /api/auth/register` — the endpoint `RegisterForm` has always called and
 * that has never existed.
 *
 * WHY THE FORM FAILED WITH NO ERROR ANYWHERE
 *
 * `api/auth/[...nextauth]/route.ts` is a catch-all, so it matched
 * `/api/auth/register` and answered `400 "Bad request."` — NextAuth rejecting an
 * action it does not have. The body is a bare string, not the `{ detail }` shape
 * the form parses, so every attempt fell through to the generic "We couldn't
 * create your account. Try again." with nothing logged on either side.
 *
 * A static segment outranks a catch-all in the App Router, so this file takes
 * `/api/auth/register` back from `[...nextauth]` simply by existing. Do not
 * rename the directory to something dynamic.
 *
 * WHY THIS PROXIES INSTEAD OF WRITING TO THE DATABASE
 *
 * The browser must not reach the API directly: password policy, argon2id
 * hashing and the unique-index race all live server-side in
 * `apps/api/src/routers/auth.py`, and the web app holds no database
 * credentials. This route exists to keep the API's origin off the client and to
 * translate transport failures into something the form can render.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Shape the form understands: `{ detail }`, plus `field` on a 422. */
type FormError = { detail: string; field?: string };

function fail(status: number, body: FormError) {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, { detail: "That request could not be read." });
  }

  const { name, email, password, terms_accepted } = (payload ?? {}) as Record<
    string,
    unknown
  >;

  // Cheap shape check before spending a network hop. The API re-validates
  // everything — this only catches a malformed client.
  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string"
  ) {
    return fail(400, { detail: "That request was missing required fields." });
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        terms_accepted: terms_accepted === true,
      }),
      // Never cached, and never prerendered into a static response.
      cache: "no-store",
    });
  } catch (error) {
    // The API being down is the single most likely failure in development, and
    // it used to be indistinguishable from "your details were rejected". Say so.
    console.error("[register] cannot reach API at", API_URL, error);
    return fail(503, {
      detail:
        "We can't reach the sign-up service right now. If you're running this locally, check that the API server is up on port 8000.",
    });
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    // FastAPI puts our `{ field, detail }` inside its own `detail` envelope.
    // Unwrap it so the form can attach the message to the right input instead
    // of showing "[object Object]" above the form.
    const inner = (body as { detail?: unknown } | null)?.detail;

    if (inner && typeof inner === "object" && "detail" in inner) {
      const { field, detail } = inner as FormError;
      return fail(response.status, { detail, field });
    }
    if (typeof inner === "string") {
      return fail(response.status, { detail: inner });
    }
    return fail(response.status, {
      detail: "We couldn't create your account. Try again.",
    });
  }

  // This route creates the account and nothing else — `RegisterForm` calls
  // `signIn("credentials", …)` immediately afterwards to establish the session.
  //
  // Keeping the two steps separate is deliberate: issuing a session cookie from
  // a plain route handler means duplicating what NextAuth's callback route
  // already does correctly (CSRF, JWE encoding, cookie flags, the `jwt` and
  // `session` callbacks that attach `backendId`). One extra round trip is
  // cheaper than a second, subtly different session implementation.
  //
  // Only the id is echoed back; nothing else is the client's business.
  return NextResponse.json(
    { id: (body as { id?: string } | null)?.id ?? null },
    { status: 201 }
  );
}
