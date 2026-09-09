"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface SidebarItem {
    label: string;
    href: string;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
    { label: "Profile", href: "/profile" },
    { label: "Terms of Use", href: "/terms" },
    { label: "Privacy Policy", href: "/privacy" },
];

/**
 * The profile rail.
 *
 * The inline `linear-gradient(180deg, #0A0A10, #060608)` background is gone —
 * `AppBackdrop` on the route root now supplies the page's gradient, and a
 * second one scoped to a 192px column cut a visible vertical seam through it.
 * A hairline on the right is the separator, as everywhere else.
 *
 * NO "LOG OUT", BECAUSE THERE IS NOTHING TO LOG OUT OF. This build has no auth
 * at all: `useUserId` returns a fixed local id, and `auth.ts`, `middleware.ts`,
 * `/api/auth/*` and the login and register forms are absent. The button was
 * still here with `onClick: () => undefined` — a control that looked live,
 * responded to hover and focus, and did nothing when pressed. A dead control is
 * worse than a missing one: it makes the user doubt the click rather than the
 * app, and it implies an account they do not have.
 *
 * Removing it took `onClick` and `isSeparated` with it — it was the only item
 * that used either — so `href` is now required and every entry is a link.
 */
export default function ProfileSidebar() {
    const pathname = usePathname();
    const router = useRouter();

    return (
        <aside className="flex w-48 flex-shrink-0 flex-col justify-between border-r border-line py-8">
            <nav className="flex flex-col gap-1 px-3">
                {SIDEBAR_ITEMS.map((item) => {
                    const isActive = pathname === item.href;

                    return (
                        <button
                            key={item.label}
                            type="button"
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => router.push(item.href)}
                            className={cn(
                                "mt-1 w-full rounded-full px-5 py-2.5 text-center text-sm font-medium",
                                "transition-colors duration-200 ease-void",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                                "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
                                isActive
                                    ? "bg-void-3 text-ink"
                                    : "text-ink-3 hover:bg-void-2 hover:text-ink"
                            )}
                        >
                            {item.label}
                        </button>
                    );
                })}
            </nav>
        </aside>
    );
}
