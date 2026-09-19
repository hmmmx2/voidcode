/**
 * What a renderer component needs before it can be rendered into a DOM here.
 *
 * Two things, and they are different in kind: a `<dialog>` that behaves enough like the real one,
 * and a `window.host` that answers the way the preload does.
 *
 * WHY A `<dialog>` SHIM AT ALL — jsdom 26.1 DOES NOT IMPLEMENT `showModal`. Verified, not assumed:
 * `new JSDOM("<dialog>").querySelector("dialog").showModal` is `undefined`, and calling it throws
 * `el.showModal is not a function`. `app/Overlay.tsx`'s `Modal` calls it from an effect on every
 * open, so without this every test that renders a dialog dies before its first assertion.
 *
 * **THIS IS A SHIM AND IT DOES NOT COVER THE TOP LAYER.** It reproduces exactly two behaviours the
 * component depends on — the `open` property, and the `close` event `Modal` subscribes to — and
 * nothing else. It does NOT reproduce the top layer, the backdrop, focus trapping, inertness of the
 * page behind, or Escape-to-close. A test passing here says the component's own logic is right; it
 * says nothing about whether the real dialog traps focus. Do not read it as more than that.
 */
import { vi } from "vitest";

/** Install the two `HTMLDialogElement` methods jsdom lacks. Idempotent. */
export function installDialogShim(): void {
  const proto = globalThis.HTMLDialogElement?.prototype as
    | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
    | undefined;
  if (proto === undefined) return;

  proto.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close ??= function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    // `Modal` reports every close through this event, including a programmatic one. That is the
    // behaviour `SignInDialog`'s header calls load-bearing, so the shim has to fire it.
    this.dispatchEvent(new Event("close"));
  };
}

/** The signed-in user `/auth/me` and every successful sign-in return. */
export interface StubUser {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  emailVerified: boolean;
  providers: string[];
  createdAt: string;
}

export function stubUser(over: Partial<StubUser> = {}): StubUser {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: "learner@example.com",
    name: "A Learner",
    hasPassword: true,
    emailVerified: false,
    providers: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** Every account method the dialog can call, as vitest mocks. */
export interface AccountStub {
  signInPassword: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  requestPasswordCode: ReturnType<typeof vi.fn>;
  resetPassword: ReturnType<typeof vi.fn>;
  changePassword: ReturnType<typeof vi.fn>;
  providers: ReturnType<typeof vi.fn>;
  signInOAuth: ReturnType<typeof vi.fn>;
  cancelOAuth: ReturnType<typeof vi.fn>;
  reopenOAuth: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  signOutEverywhere: ReturnType<typeof vi.fn>;
}

/**
 * Put a `window.host` on the page and return the mocks.
 *
 * DEFAULTS THAT REFUSE RATHER THAN SUCCEED. Every method rejects the request by default, so a test
 * that forgets to arrange the call it depends on fails loudly instead of passing on a stub that
 * happened to say yes. The one exception is `providers`, which answers "none configured" — the
 * state this build actually ships in.
 */
export function installHost(): AccountStub {
  installDialogShim();

  const refuse = (message: string) =>
    vi.fn().mockResolvedValue({ ok: false, code: "refused", message });

  const account: AccountStub = {
    signInPassword: refuse("Email or password is incorrect."),
    register: refuse("That address already has an account."),
    requestPasswordCode: refuse("Something went wrong."),
    resetPassword: refuse("That code isn't valid or has expired."),
    changePassword: refuse("Something went wrong."),
    providers: vi.fn().mockResolvedValue({
      providers: [
        { id: "google", label: "Google", configured: false },
        { id: "microsoft", label: "Microsoft", configured: false },
      ],
      timeoutSeconds: 300,
    }),
    signInOAuth: vi.fn().mockResolvedValue({ ok: false, code: "not_configured", message: "" }),
    cancelOAuth: vi.fn().mockResolvedValue({ cancelled: true }),
    reopenOAuth: vi.fn().mockResolvedValue({ reopened: false }),
    session: vi.fn().mockResolvedValue({ signedIn: false }),
    refresh: vi.fn().mockResolvedValue({ signedIn: false }),
    signOut: vi.fn().mockResolvedValue({ ok: true }),
    signOutEverywhere: vi.fn().mockResolvedValue({ ok: true }),
  };

  Object.assign(globalThis, {
    window: Object.assign(globalThis.window as Window, {
      host: { account, onAccountChanged: () => () => {} },
    }),
  });

  return account;
}

/** A successful sign-in, as `outcomes.ts` shapes it. */
export function signedIn(over: Partial<StubUser> = {}, created = false) {
  return { ok: true as const, user: stubUser(over), created, passwordCleared: false };
}
