import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * Paths reachable without a session.
 *
 * `/` is the public marketing landing page. Before it existed this middleware
 * bounced *every* unauthenticated request to `/login`, so there was no public
 * surface at all.
 *
 * `/terms` and `/privacy` are listed here to fix an existing bug rather than to
 * support the landing page: `app/login/page.tsx` links both with
 * `target="_blank"`, and they were auth-gated — so they were unreachable for
 * exactly the audience that clicks them.
 */
const PUBLIC_PATHS = new Set(["/", "/terms", "/privacy"]);

/**
 * The pages that exist to get you a session.
 *
 * EXACT MATCHES, not `startsWith`. The previous check was
 * `pathname.startsWith("/login")`, which also matched `/loginfoo`, `/login-x`
 * and anything else sharing the prefix — so those URLs rendered the login page
 * instead of 404ing, and any future `/login-help` route would have inherited
 * the same accidental exemption. A `Set` cannot over-match.
 *
 * These are separate from `PUBLIC_PATHS` because they need the *opposite*
 * treatment when a session exists: a signed-in visitor should be sent to the
 * app rather than shown a sign-in form, whereas `/terms` stays readable either
 * way.
 */
// `/verify-email` was listed here and had no page, so the entry routed nothing —
// dead config that reads as a working feature. It is removed rather than given a
// page, because nothing issues an email-verification token: registration sends no
// verification mail, and `users.email_verified_at` is never set.
//
// The pieces do exist — `PURPOSE_EMAIL_VERIFY`, `issue_email_verification` and
// `email_verification_email` were built alongside password reset — so finishing it
// means an endpoint plus a send on registration. Add the path back at that point,
// together with the page.
const AUTH_PATHS = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
]);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;

  // Auth API routes must pass through regardless of session state — this is how
  // a session gets established in the first place.
  if (pathname.startsWith("/api/auth")) return NextResponse.next();

  const isAuthPage = AUTH_PATHS.has(pathname);

  // A signed-in visitor has no use for the marketing page or a sign-in form.
  // Redirecting `/` preserves the behaviour that existed when `app/page.tsx`
  // was an unconditional `redirect("/homepage")`.
  //
  // `/reset-password` is the exception: arriving from an emailed link while
  // already signed in elsewhere is normal, and bouncing that to the dashboard
  // would make the link look broken to someone who has genuinely forgotten
  // their password.
  if (isLoggedIn && (pathname === "/" || (isAuthPage && pathname !== "/reset-password"))) {
    return NextResponse.redirect(new URL("/homepage", req.nextUrl));
  }

  if (!isLoggedIn && !isAuthPage && !PUBLIC_PATHS.has(pathname)) {
    // Carry the destination through the sign-in rather than dropping it.
    //
    // This used to redirect to a bare `/login`, so every gated deep link landed
    // the user on the dashboard instead of where they were going — a shared
    // filtered catalogue, a specific problem, or the link in a Daily Challenge
    // email. Signing in should resume what you were doing, not reset it.
    //
    // `pathname + search` only, never `req.url`: an absolute URL in a redirect
    // parameter is how a login page becomes an open redirect. A leading-slash
    // relative path cannot leave the origin, and the login page re-checks that
    // it starts with `/` before using it.
    const login = new URL("/login", req.nextUrl);
    login.searchParams.set("callbackUrl", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Everything here must be reachable without a session.
    //
    // `landing/` holds the pre-rendered 3D stills for the marketing page.
    //
    // The metadata routes — `icon.svg`, `apple-icon`, `opengraph-image` — are the
    // subtle ones. Next generates them from file conventions, they are not in
    // PUBLIC_PATHS, and **every social crawler is sessionless**. Without them
    // listed here the OG image 307s to /login for every unfurler on the
    // internet, and the failure is invisible from a browser: the page looks
    // completely fine and only link previews are broken.
    //
    // Kept as an explicit list rather than a "has a file extension" pattern —
    // that shape of regex reliably un-gates real app routes by accident.
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon|opengraph-image|twitter-image|manifest\\.webmanifest|robots\\.txt|sitemap\\.xml|icons/|landing/).*)",
  ],
};
