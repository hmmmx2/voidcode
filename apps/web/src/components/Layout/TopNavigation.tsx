"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";
import { useRouter, usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useUserProfile } from "@/lib/context/UserProfileContext";
import { Menu } from "@/components/app";
import { cn } from "@/lib/utils";
import NotificationBell from "./NotificationBell";
import { MobileMenu } from "./MobileMenu";

interface TopNavigationProps {
  /** "workspace" = problem page (question nav, VoidCode AI, settings)
   *  "profile"   = profile/settings pages (logo only left)
   *  "homepage"  = homepage + courses (logo + nav links) */
  variant?: "workspace" | "profile" | "homepage";
  /**
   * 1-based position in the curriculum sequence, or `null` for a problem that
   * has none. The catalogue and the homepage recommendations both link to
   * problems outside the 12-item sequence, and those have no position to show.
   */
  currentProblem?: number | null;
  totalProblems?: number;
  /** URL prefix for the prev/next chevrons. See WorkspaceClient. */
  basePath?: string;
  isVoidCodeAIOpen?: boolean;
  onToggleVoidCodeAI?: () => void;
}

/**
 * The five modules, in the order the curriculum is meant to be used.
 *
 * Declared once here rather than inline so the footer and the mobile sheet can
 * read the same list — three hand-maintained copies of a nav is how a link ends
 * up pointing at a route that no longer exists.
 *
 * Projects is not built yet, so it is absent: an entry is added here only once
 * its page exists, so the nav never offers a 404.
 */
export const NAV_ITEMS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/homepage", label: "Dashboard", exact: true },
  { href: "/problems", label: "Problems" },
  { href: "/interviews", label: "Interviews" },
  { href: "/research", label: "Research" },
];

// ── Shared icon components ─────────────────────────────────────────────────
//
// These are inline SVGs on `currentColor`, not `<Image>` imports, and that is a
// fix rather than a preference. `ic-settings-gear.svg` has `#3A3A3A` baked into
// the file and `ic-profile-user.svg` has `#5A2CFF` — a purple that appears
// nowhere else in the product and that no token, utility or cascade could reach,
// because an `<img>` is opaque to CSS. Inline is the only way they follow the
// button's own text colour on hover.

function ChevronDownIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={className}>
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The default avatar, replacing a `#5A2CFF` SVG asset. */
function AvatarFallback() {
  return (
    <svg viewBox="0 0 32 32" fill="none" className="h-full w-full bg-void-3 text-ink-3" aria-hidden>
      <circle cx="16" cy="12.5" r="4.75" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 26c0-4.6 4-7.5 9-7.5s9 2.9 9 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Avatar({
  url,
  name,
  size,
}: {
  url: string | null | undefined;
  name: string;
  size: number;
}) {
  return (
    <div
      className="flex-shrink-0 overflow-hidden rounded-full border border-line-strong"
      style={{ width: size, height: size }}
    >
      {url ? (
        // Remote avatars come from arbitrary OAuth CDNs; `next/image` would
        // need every one of them in `remotePatterns` and would 404 the moment
        // a provider changed host.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={name}
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <AvatarFallback />
      )}
    </div>
  );
}

// ── NavLink — active underline indicator ──────────────────────────────────

function NavLink({
  href,
  children,
  isActive,
}: {
  href: string;
  children: React.ReactNode;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative pb-0.5 text-sm font-medium transition-colors duration-200 ease-void",
        isActive ? "text-ink" : "text-ink-3 hover:text-ink-2"
      )}
    >
      {children}
      {isActive && (
        <span aria-hidden className="absolute -bottom-[19px] left-0 right-0 h-px bg-ink" />
      )}
    </Link>
  );
}

// ── IconButton — unified icon button style ────────────────────────────────

function IconButton({
  onClick,
  title,
  isActive = false,
  children,
}: {
  onClick?: () => void;
  title: string;
  isActive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={isActive || undefined}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg",
        "transition-colors duration-200 ease-void",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
        isActive
          ? "bg-white/10 text-ink"
          : "text-ink-3 hover:bg-white/5 hover:text-ink-2"
      )}
    >
      {children}
    </button>
  );
}

/** One row in the user dropdown. */
function MenuItem({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-2 text-sm text-ink-2",
        "transition-colors duration-150 ease-void hover:bg-white/5 hover:text-ink",
        "focus-visible:outline-none focus-visible:bg-white/5 focus-visible:text-ink"
      )}
    >
      <span className="text-ink-3">{icon}</span>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function TopNavigation({
  variant = "workspace",
  currentProblem = 1,
  totalProblems = 5,
  basePath = "/problems",
  isVoidCodeAIOpen = true,
  onToggleVoidCodeAI,
}: TopNavigationProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const { profile: userProfile } = useUserProfile();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const displayName = userProfile?.name ?? session?.user?.name ?? "Student";
  // Show only first name in the pill to keep it compact
  const firstName = displayName.split(" ")[0];
  const avatarUrl = userProfile?.profilePhotoUrl;

  // ── Scroll-driven transparency ─────────────────────────────────────────────
  // Layouts use overflow-y-auto on <main>, not window — so we listen there.
  // This also means `AppBackdrop` must render only <div>s: `querySelector`
  // takes the first match, so a stray <main> in the backdrop would steal it.
  useEffect(() => {
    const mainEl = document.querySelector("main");
    if (!mainEl) return;

    function onScroll() {
      setScrolled((mainEl?.scrollTop ?? 0) > 10);
    }

    mainEl.addEventListener("scroll", onScroll, { passive: true });
    return () => mainEl.removeEventListener("scroll", onScroll);
  }, [pathname]); // re-attach when route changes (new <main> may mount)

  // Close profile dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    }
    if (isProfileOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isProfileOpen]);

  // A problem outside the curriculum sequence has no position, so there is
  // nothing to count and nowhere for the chevrons to go. This used to fall back
  // to 1, which read as "Question: 1/12" on a problem that is not the first of
  // anything and aimed the next chevron at an unrelated problem in another track.
  const hasPosition = currentProblem != null;
  const canGoPrev = hasPosition && currentProblem > 1;
  const canGoNext = hasPosition && currentProblem < totalProblems;

  /**
   * THE TRANSPARENCY WAS INVERTED AND IS NOW THE RIGHT WAY ROUND.
   *
   * It used to sit at `bg-[#040407]/95` at rest and drop to `/20` once you
   * scrolled — that is, it became *more* transparent exactly when content
   * started passing underneath it, which is when a bar most needs to separate
   * itself from what it overlaps. Text collided with text.
   *
   * Now: invisible at rest, glass once there is something behind it to refract.
   * The workspace variant is always glass because it has no `<main>` to scroll
   * — it is fixed tool chrome over a tiled editor, so `scrolled` never fires.
   */
  const glassy = scrolled || variant === "workspace";

  return (
    <header
      className={cn(
        "relative z-40 flex h-14 flex-shrink-0 items-center justify-between px-6",
        "border-b transition-colors duration-300 ease-void",
        glassy
          ? [
              "border-line",
              // Opaque default, translucent enhancement — reversed, a browser
              // without backdrop-filter gets an unreadable white haze over
              // scrolling content. See `GlassSurface`.
              "bg-void-0/85",
              "supports-[backdrop-filter]:bg-white/[0.045]",
              "supports-[backdrop-filter]:backdrop-blur-md",
              "supports-[backdrop-filter]:backdrop-saturate-150",
            ]
          : "border-transparent bg-transparent"
      )}
    >
      {/* ── LEFT — Logo + nav links ────────────────────────────── */}
      <div className="flex items-center gap-7">
        {/* Logo.

            Was a 45px PNG inside this h-14 (56px) bar, leaving 5.5px of
            clearance. 22px sits properly in the optical centre. The hover is now
            a colour transition rather than a blanket opacity fade, which
            `currentColor` makes possible and an <Image> never did. */}
        <Link
          href="/homepage"
          className="flex items-center text-ink-2 transition-colors hover:text-ink"
          title="Home"
          aria-label="VoidCode AI, home"
        >
          <Mark className="h-[22px] w-[22px]" />
        </Link>

        {/* Nav links — shown on homepage + workspace; hidden on profile (sidebar handles it).

            Hidden below `lg` rather than wrapping: five entries plus the mark,
            the problem navigator and the user pill do not fit on a phone, and a
            wrapping nav pushes the workspace down. The mobile route is the
            existing sheet pattern, not a second nav component. */}
        {variant !== "profile" && (
          <nav className="hidden items-center gap-6 lg:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                /* `startsWith` on everything except Dashboard: `/problems/3`
                   must keep Problems lit while you are inside the IDE. An exact
                   match would leave nothing active on every detail page. */
                isActive={
                  item.exact
                    ? pathname === item.href
                    : pathname.startsWith(item.href)
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        {/* The same entries below `lg`, where the row above is hidden.

            Without this the app had no nav at all on a phone — the links were
            display:none and nothing replaced them, which is the exact bug the
            marketing sheet was built to fix. `breakpoint="lg"` has to match the
            `lg:flex` above or one of the two is wrong at some width. */}
        {variant !== "profile" && (
          <MobileMenu links={NAV_ITEMS} breakpoint="lg" />
        )}
      </div>

      {/* ── CENTER — variant-specific content ─────────────────── */}
      {variant === "workspace" && hasPosition ? (
        /* Problem navigator — "Question: X/Y  <  >". Hidden entirely when the
           problem is not in the sequence: a counter that cannot be correct is
           worse than no counter. */
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-ink-2">
            Question: {currentProblem}/{totalProblems}
          </span>

          <button
            type="button"
            onClick={() => canGoPrev && router.push(`${basePath}/${currentProblem - 1}`)}
            disabled={!canGoPrev}
            title="Previous problem"
            aria-label="Previous problem"
            className={cn(
              "flex h-5 w-5 items-center justify-center transition-colors",
              canGoPrev
                ? "text-ink-3 hover:text-ink"
                : "cursor-not-allowed text-ink-3/40"
            )}
          >
            <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden>
              <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => canGoNext && router.push(`${basePath}/${currentProblem + 1}`)}
            disabled={!canGoNext}
            title="Next problem"
            aria-label="Next problem"
            className={cn(
              "flex h-5 w-5 items-center justify-center transition-colors",
              canGoNext
                ? "text-ink-3 hover:text-ink"
                : "cursor-not-allowed text-ink-3/40"
            )}
          >
            <svg width="7" height="12" viewBox="0 0 7 12" fill="none" aria-hidden>
              <path d="M1 1L6 6L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      ) : variant === "profile" ? (
        /* Slim search bar */
        <div className="absolute left-1/2 w-full max-w-xs -translate-x-1/2">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden
            >
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              placeholder="Search…"
              aria-label="Search"
              /* Border-colour focus, not a ring — the house rule. An input is a
                 box you type into, so brightening its edge reads as "this box is
                 live"; a ring around a box that already has an edge reads as a
                 double outline. Buttons get rings because they have no edge. */
              className={cn(
                "w-full rounded-lg border border-line bg-void-2 py-1.5 pl-8 pr-3",
                "text-xs text-ink placeholder:text-ink-3",
                "transition-colors duration-150 ease-void",
                "hover:border-line-strong focus:border-ink-3 focus:outline-none"
              )}
            />
          </div>
        </div>
      ) : null}

      {/* ── RIGHT — Actions + user menu ───────────────────────── */}
      <div className="flex items-center gap-1">
        {/* VoidCode AI toggle — workspace only */}
        {variant === "workspace" && (
          <div className="mr-1">
            <IconButton
              onClick={onToggleVoidCodeAI}
              title={isVoidCodeAIOpen ? "Close VoidCode AI" : "Open VoidCode AI"}
              isActive={isVoidCodeAIOpen}
            >
              {/* This was `/icons/ic-voidcode-ai.svg`, which does not exist in
                  `public/icons/` — a live 404 on every workspace page. The mark
                  also picks up the button's active colour, which an <Image>
                  could not. */}
              <Mark className="h-4 w-4" />
            </IconButton>
          </div>
        )}

        {/* Settings — homepage + workspace */}
        {(variant === "homepage" || variant === "workspace") && (
          <IconButton onClick={() => router.push("/profile")} title="Settings">
            <GearIcon />
          </IconButton>
        )}

        <NotificationBell />

        <div aria-hidden className="mx-2 h-5 w-px bg-line-strong" />

        {/* User pill + dropdown */}
        <div className="relative" ref={profileRef}>
          <button
            type="button"
            onClick={() => setIsProfileOpen((prev) => !prev)}
            aria-expanded={isProfileOpen}
            className={cn(
              "flex items-center gap-2 rounded-full border py-1 pl-1 pr-2.5",
              "transition-colors duration-200 ease-void",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
              isProfileOpen
                ? "border-line-strong bg-white/5"
                : "border-line hover:border-line-strong hover:bg-white/5"
            )}
          >
            <Avatar url={avatarUrl} name={firstName} size={28} />

            <span className="text-sm font-medium leading-none text-ink">
              {firstName}
            </span>

            <ChevronDownIcon
              className={cn(
                "text-ink-3 transition-transform duration-200",
                isProfileOpen && "rotate-180"
              )}
            />
          </button>

          {/* The popover below is deliberately NOT `role="menu"`. That role
              promises the ARIA menu keyboard model — arrow-key roving focus,
              Home/End, type-ahead — and this implements none of it. Claiming it
              would make a screen reader announce navigation that does not work,
              which is worse than the plain buttons a user actually gets. */}
          {isProfileOpen && (
            <Menu width="w-52">
              {/* User info header */}
              <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
                <Avatar url={avatarUrl} name={firstName} size={32} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{displayName}</p>
                  {session?.user?.email && (
                    <p className="truncate text-[11px] text-ink-3">{session.user.email}</p>
                  )}
                </div>
              </div>

              <div className="py-1.5">
                <MenuItem
                  onClick={() => { setIsProfileOpen(false); router.push("/profile"); }}
                  icon={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  }
                >
                  Profile
                </MenuItem>

                              </div>

              {/* Sign out is NOT red any more. Red is reserved for the one
                  genuine signal in this product — a failing test — and signing
                  out is neither destructive nor irreversible. Its own section
                  under a rule already separates it from the navigation above. */}
              <div className="border-t border-line py-1.5">
                <MenuItem
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  icon={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <polyline points="16 17 21 12 16 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  }
                >
                  Sign Out
                </MenuItem>
              </div>
            </Menu>
          )}
        </div>
      </div>
    </header>
  );
}
