import { MarketingNav } from "@/components/marketing/sections/MarketingNav";
import { MarketingFooter } from "@/components/marketing/sections/MarketingFooter";

/**
 * Shell for `/terms`, `/privacy` and the two pages Stripe returns a buyer to.
 *
 * THE SAME CHROME AS THE LANDING PAGE, because that is now the whole website. This layout used to
 * be session-aware: a signed-in reader got the application's top bar with an avatar and a
 * notification bell, and a signed-out one got a bare mark with a "Sign in" button. There is no
 * session to be aware of — sign-in lives in the desktop app — so both branches are gone, and with
 * them the `auth()` call that made this a dynamic page for no benefit.
 *
 * These pages are reached from three places that are not this website: the desktop app links to
 * them from its sign-up dialog, Stripe redirects a buyer to `/purchase/*`, and the app stores link
 * to `/privacy`. That is why the chrome has to make sense to someone who has never seen the
 * landing page — a nav that says what this is, and a footer with the other document in it.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-screen bg-void-0 text-ink-2">
      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      <MarketingNav />

      <main className="relative z-10 px-6 pb-16 pt-24 lg:px-10">{children}</main>

      <MarketingFooter />
    </div>
  );
}
