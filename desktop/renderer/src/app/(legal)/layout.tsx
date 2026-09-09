import TopNavigation from "@/components/Layout/TopNavigation";
import AppFooter from "@/components/Layout/AppFooter";
import { AppBackdrop } from "@/components/app";

/**
 * Shell for `/terms` and `/privacy`.
 *
 * A route group because it does not appear in the URL: both paths are unchanged, so every link to
 * them in the product keeps working. They used to live in the `(profile)` group and inherited its
 * chrome, including a sidebar item reading "Log Out" — which this build has no auth to act on, and
 * which has since been removed outright.
 *
 * WHAT THIS COMMENT USED TO SAY, AND WHY IT IS WORTH RECORDING. It explained the group in terms of a
 * signed-out visitor: `PUBLIC_PATHS` in `middleware.ts`, login and registration forms linking here,
 * a reader who "has by definition not accepted them yet", and a link in an already-sent email. None
 * of those exist — no `middleware.ts`, no auth forms, no email, and under Apache-2.0 there is nothing
 * to accept. The reasoning was sound for a web product and described this one incorrectly.
 *
 * It also justified a `session-aware` header. There is no session, and what stood in for one was a
 * literal `true` where the check used to be — so the signed-out branch was unreachable while still
 * containing a "Sign in" link to `/login`, the only route in the renderer with no page. One edit from
 * shipping a sign-in button to a build with no auth. Both are gone; `tests/honest-copy.test.ts` now
 * asserts every internal href resolves to a real route.
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      <TopNavigation variant="homepage" />

      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
        <AppFooter />
      </main>
    </div>
  );
}
