"use client";

/**
 * The account button in the title bar, and what it opens.
 *
 * It used to navigate straight to `/profile`, which was the whole of "the account" when there was
 * no account — only a local profile. Now there are two different things and the menu keeps them
 * apart on purpose: your VoidCode account (on our server, optional) and your local profile (on this
 * computer, always). Folding one into the other would suggest that signing out touches local work,
 * or that a local profile sends anything anywhere. Neither is true.
 *
 * PORTALLED, like the notification bell beside it, for the same reason: the title bar is
 * `backdrop-blur` glass, which creates a stacking context a dropdown cannot climb out of. See
 * `Menu`'s `anchor` prop.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "@/components/app";
import { IconAccount } from "@/components/icons";
import { useAccount } from "@/lib/account/AccountProvider";
import { cn } from "@/lib/utils";

export default function AccountMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const { state, available, openSignIn, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (wrapper.current === null || target === null) return;
      if (wrapper.current.contains(target)) return;
      // The panel is portalled out of this wrapper; see `NotificationBell` for why this test exists.
      if (target.closest("[data-menu-portal]") !== null) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signedIn = state?.signedIn === true;
  const onAccountPage = pathname.startsWith("/account") || pathname.startsWith("/profile");

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Account"
        aria-label={signedIn ? "Account, signed in" : "Account"}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "relative flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-ide-raised",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
          onAccountPage || open ? "text-ink" : "text-ink-3 hover:text-ink"
        )}
      >
        <IconAccount size={16} />
        {signedIn && (
          // A dot, not a colour change: presence is carried by shape so it reads without colour.
          <span aria-hidden className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-ink" />
        )}
      </button>

      {open && (
        <Menu width="w-64" anchor={wrapper}>
          <div role="menu" aria-label="Account" className="py-1.5 text-[13px]">
            {signedIn ? (
              <>
                <div className="px-3.5 pb-2 pt-1.5">
                  <p className="truncate text-ink">{state?.user?.name || "Signed in"}</p>
                  <p className="truncate text-xs text-ink-3">
                    {state?.user?.email ?? (state?.offline ? "Signed in (offline)" : "Checking your account…")}
                  </p>
                </div>
                <Separator />
                <Item onSelect={() => go("/account")}>Account</Item>
                <Item onSelect={() => go("/models")}>Credits and the VoidCode model</Item>
                <Item onSelect={() => go("/profile")}>Local profile</Item>
                <Separator />
                <Item
                  onSelect={() => {
                    setOpen(false);
                    void signOut();
                  }}
                >
                  Sign out
                </Item>
              </>
            ) : (
              <>
                {available && (
                  <>
                    <Item
                      onSelect={() => {
                        setOpen(false);
                        openSignIn("signIn");
                      }}
                    >
                      Sign in…
                    </Item>
                    <Item
                      onSelect={() => {
                        setOpen(false);
                        openSignIn("register");
                      }}
                    >
                      Create account…
                    </Item>
                    <p className="px-3.5 pb-1.5 pt-0.5 text-[11px] leading-relaxed text-ink-3">
                      Optional — for the VoidCode model and credits.
                    </p>
                    <Separator />
                  </>
                )}
                <Item onSelect={() => go("/profile")}>Local profile</Item>
              </>
            )}
          </div>
        </Menu>
      )}
    </div>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center px-3.5 py-1.5 text-left text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:bg-white/[0.06] focus-visible:text-ink focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
