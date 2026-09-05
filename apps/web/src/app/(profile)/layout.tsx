import TopNavigation from "@/components/Layout/TopNavigation";
import ProfileSidebar from "@/components/Profile/ProfileSidebar";
import AppFooter from "@/components/Layout/AppFooter";
import { AppBackdrop } from "@/components/app";

/**
 * Shell for `/profile`.
 *
 * Structurally identical to `(homepage)/layout.tsx` plus the sidebar — see that
 * file for why `isolate` is load-bearing and why the scroll container stays on
 * `<main>`. The two used to differ in page background for no reason anyone
 * recorded (`#040407` here, `#0A0A0A` there); both are now `void-0` with the
 * same backdrop, which is most of what made the app feel like two products.
 *
 * `/terms` and `/privacy` used to live in this route group and no longer do.
 * They are public routes, so a signed-out visitor following the link from the
 * login page was handed the full logged-in chrome — avatar, notification bell,
 * and a sidebar with a Log Out button. They now have their own `(legal)` group.
 */
export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      <TopNavigation variant="profile" />

      <div className="relative z-10 flex flex-1 overflow-hidden">
        <ProfileSidebar />
        {/* Footer lives inside main so it scrolls naturally with page content */}
        <main className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
          <AppFooter />
        </main>
      </div>
    </div>
  );
}
