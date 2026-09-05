import Link from "next/link";
import { auth } from "@/auth";
import { Mark } from "@/components/brand/Mark";
import TopNavigation from "@/components/Layout/TopNavigation";
import AppFooter from "@/components/Layout/AppFooter";
import { AppBackdrop } from "@/components/app";
import { Pill } from "@/components/ui/Pill";

/**
 * Shell for `/terms` and `/privacy`.
 *
 * THIS ROUTE GROUP EXISTS TO FIX A REAL BUG.
 *
 * Both pages are listed in `PUBLIC_PATHS` in `middleware.ts` — they have to be,
 * because the login and registration forms link to them and a visitor reading
 * the terms has by definition not accepted them yet. But they used to live in
 * the `(profile)` group, so a signed-out visitor following that link was handed
 * the full logged-in chrome: a top bar with an avatar and a notification bell,
 * and a sidebar whose last item is "Log Out". Nothing there worked, and the
 * page implied an account the reader did not have.
 *
 * A route group is the right tool because it does not appear in the URL:
 * `/terms` and `/privacy` are unchanged, so `middleware.ts` needs no edit and
 * no link anywhere in the product or in any already-sent email breaks.
 *
 * The alternative — conditionally hiding the sidebar inside `(profile)/layout`
 * — was rejected. One layout serving two audiences drifts: the next person to
 * add something to the profile chrome has no reason to think about the
 * logged-out case, and the bug comes straight back.
 *
 * The header is session-aware rather than absent, so a signed-in reader who
 * clicks "Terms of Use" in the sidebar does not lose their navigation.
 */
export default async function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      {session ? (
        <TopNavigation variant="homepage" />
      ) : (
        /* Signed out: a mark and one way in. No avatar, no bell, no search,
           and above all no Log Out. */
        <header className="relative z-40 flex h-14 flex-shrink-0 items-center justify-between border-b border-line px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-ink transition-colors hover:text-ink-2"
            aria-label="VoidCode AI, home"
          >
            <Mark className="h-[22px] w-[22px]" />
            <span className="text-sm font-medium tracking-tight">VoidCode AI</span>
          </Link>

          <Pill href="/login" variant="outline" size="sm">
            Sign in
          </Pill>
        </header>
      )}

      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
        <AppFooter />
      </main>
    </div>
  );
}
