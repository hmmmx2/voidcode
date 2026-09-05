"use client";

import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";

interface SidebarItem {
    label: string;
    href?: string;
    onClick?: () => void;
    /** Renders in its own group, below a gap. Not a colour. */
    isSeparated?: boolean;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
    { label: "Profile", href: "/profile" },
    { label: "Terms of Use", href: "/terms" },
    { label: "Privacy Policy", href: "/privacy" },
    {
        label: "Log Out",
        onClick: () => signOut({ callbackUrl: "/login" }),
        isSeparated: true,
    },
];

/**
 * The profile rail.
 *
 * The inline `linear-gradient(180deg, #0A0A10, #060608)` background is gone —
 * `AppBackdrop` on the route root now supplies the page's gradient, and a
 * second one scoped to a 192px column cut a visible vertical seam through it.
 * A hairline on the right is the separator, as everywhere else.
 *
 * "Log Out" is no longer red on hover. Red is reserved for the one genuine
 * signal in this product — a failing test — and signing out is neither
 * destructive nor irreversible. The gap above it already marks it as separate
 * from the navigation, which is the distinction that actually matters.
 */
export default function ProfileSidebar() {
    const pathname = usePathname();
    const router = useRouter();

    return (
        <aside className="flex w-48 flex-shrink-0 flex-col justify-between border-r border-line py-8">
            <nav className="flex flex-col gap-1 px-3">
                {SIDEBAR_ITEMS.map((item) => {
                    const isActive = item.href ? pathname === item.href : false;

                    return (
                        <button
                            key={item.label}
                            type="button"
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => {
                                if (item.onClick) {
                                    item.onClick();
                                } else if (item.href) {
                                    router.push(item.href);
                                }
                            }}
                            className={cn(
                                "w-full rounded-full px-5 py-2.5 text-center text-sm font-medium",
                                "transition-colors duration-200 ease-void",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
                                "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
                                item.isSeparated ? "mt-10" : "mt-1",
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
