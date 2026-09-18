"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface SidebarItem {
    label: string;
    href: string;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
    { label: "Profile", href: "/profile" },
    { label: "Account", href: "/account" },
    { label: "Credits", href: "/account/credits" },
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
 * NO "LOG OUT" IN THE RAIL. There was once a button here with
 * `onClick: () => undefined` — a control that looked live and did nothing. The
 * VoidCode account is optional and separate from the local profile these pages
 * edit, so signing out lives with that account, on the Account page and in the
 * title-bar menu. A "Log out" beside "Profile" would suggest it touched the
 * local profile, and it does not.
 *
 * Every entry is a link, so `href` is required.
 */
export default function ProfileSidebar() {
    const pathname = usePathname();
    const router = useRouter();

    return (
        <aside className="flex w-48 flex-shrink-0 flex-col justify-between border-r border-line py-8">
            <nav className="flex flex-col gap-1 px-3">
                {SIDEBAR_ITEMS.map((item) => {
                    /**
                     * Exact, so the deepest page is the one highlighted.
                     *
                     * A first attempt also lit the parent whenever a child route was open, on the
                     * theory that Account should not look inactive while one of its own pages was.
                     * It lit BOTH rows at once on `/account/credits`, which the screenshot showed
                     * immediately: these are four sibling pages in a list, not a section with a
                     * landing page, so "which one am I on" has exactly one answer.
                     */
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
