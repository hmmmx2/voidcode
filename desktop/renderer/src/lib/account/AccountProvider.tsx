"use client";

/**
 * The VoidCode account, for every component in every window.
 *
 * AN ACCOUNT IS OPTIONAL, AND NOTHING HERE MAY MAKE IT FEEL OTHERWISE. No route requires a session,
 * nothing opens the sign-in dialog on its own, and signed out this provider makes no request beyond
 * asking main, which answers from the keychain. Sign-in is reached from something that needs it —
 * the VoidCode model, credits — and closing the dialog always leaves you where you were.
 *
 * ONE SOURCE OF TRUTH, PUSHED. Main owns the session (`src/main/account/session.ts`) and broadcasts
 * every change to every window. A component that cached "signed in" itself would disagree with the
 * title bar the moment a session ended on the server — which is discovered by whichever request hits
 * it, often in another window.
 *
 * THE DIALOG LIVES HERE, not at each call site, so "sign in" means the same thing from the title bar,
 * the Models page and a failed chat, and there is never more than one open.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/app";
import SignInDialog, { type SignInView } from "@/components/Account/SignInDialog";

interface AccountContextValue {
  /** `null` until main has answered, and always `null` outside the desktop app. */
  state: HostAccountState | null;
  /** Whether this build can sign in at all — false in the web preview, where there is no host. */
  available: boolean;
  openSignIn(view?: SignInView): void;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({
  state: null,
  available: false,
  openSignIn: () => {},
  signOut: async () => {},
  refresh: async () => {},
});

/** How often returning to the window re-checks the session with the server, at most. */
const REFRESH_ON_FOCUS_MS = 5 * 60 * 1000;

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const notify = useToast();
  const [state, setState] = useState<HostAccountState | null>(null);
  const [dialog, setDialog] = useState<SignInView | null>(null);
  const lastRefresh = useRef(0);
  // Decided after mount, never during render. The pages are prerendered to static HTML where there
  // is no `window.host`, so reading it during render drew the dialog on the client but not in the
  // HTML — a hydration mismatch (React #418) that the screenshot smoke caught on every route.
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(window.host?.account !== undefined);
  }, []);

  const refresh = useCallback(async () => {
    const account = window.host?.account;
    if (account === undefined) return;
    lastRefresh.current = Date.now();
    setState(await account.refresh());
  }, []);

  // First read: from the keychain, no network. Only a signed-in device goes on to ask the server.
  useEffect(() => {
    const account = window.host?.account;
    if (account === undefined) return;
    let cancelled = false;
    void account.session().then((initial) => {
      if (cancelled) return;
      setState(initial);
      if (initial.signedIn) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.host?.onAccountChanged?.((event) => {
      setState(event.state);
      if (event.reason === "expired") {
        notify("Your VoidCode session ended.", {
          detail: "Sign in again to keep using the VoidCode model.",
          tone: "warn",
        });
      }
    });
    return () => unsubscribe?.();
  }, [notify]);

  // Coming back to the window after a while is the natural moment to notice a session that ended
  // elsewhere. Rate-limited, and skipped entirely when signed out.
  useEffect(() => {
    const onFocus = () => {
      if (state?.signedIn !== true) return;
      if (Date.now() - lastRefresh.current < REFRESH_ON_FOCUS_MS) return;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [state?.signedIn, refresh]);

  const signOut = useCallback(async () => {
    const account = window.host?.account;
    if (account === undefined) return;
    await account.signOut();
    // The broadcast updates `state`; this is only the confirmation.
    notify("Signed out of VoidCode.");
  }, [notify]);

  const value = useMemo<AccountContextValue>(
    () => ({
      state,
      available,
      openSignIn: (view = "signIn") => setDialog(view),
      signOut,
      refresh,
    }),
    [state, available, signOut, refresh]
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {available && (
        <SignInDialog
          view={dialog}
          onViewChange={setDialog}
          onClose={() => setDialog(null)}
          onSignedIn={(email) => {
            setDialog(null);
            notify(`Signed in as ${email}`);
          }}
        />
      )}
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  return useContext(AccountContext);
}
