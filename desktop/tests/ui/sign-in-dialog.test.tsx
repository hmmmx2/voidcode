// @vitest-environment jsdom

/**
 * The sign-in dialog, driven the way a person drives it.
 *
 * WHY THIS FILE EXISTS. `SignInDialog.tsx` is 557 lines holding three forms, a two-step forgot flow
 * and a 60-second cooldown, and until now **nothing tested any of it** — the suite is
 * `environment: "node"` with no DOM, and `account-session.test.ts` covers the main process on the
 * other side of the IPC boundary. The component in between was the untested middle.
 *
 * That matters most for `ForgotForm`. After provider sign-in is removed, "Forgot password?" is the
 * ONLY route back in for an account with no password — `apps/api/src/routers/auth.py` issues a reset
 * code to exactly those accounts, deliberately, because "receiving the code proves control of the
 * mailbox, which is exactly the proof setting a first password needs". A bug in this flow is not a
 * regression, it is a person who cannot get into their account.
 *
 * WHY A DOM AND NOT `renderToStaticMarkup`. Static markup can assert what each form renders on its
 * first frame and nothing else. Every behaviour that carries risk here needs a state update: the
 * step advancing, the cooldown counting down, a server field error landing under its field, a pasted
 * code being normalised, the password being cleared in the `finally`. `markdown-render.test.ts`
 * renders a component statically and that remains the right tool for what it checks; this is not
 * that.
 *
 * PER-FILE, NOT A GLOBAL FLIP. The docblock above applies to this file alone. `environment: "node"`
 * is load-bearing for a 140-file suite that reads sources off disk, drives real `node:sqlite` and
 * uses real `Buffer`s in the Electron stub — flipping it globally would be a large change for one
 * directory's benefit.
 *
 * WHAT THIS DOES NOT COVER: the real `<dialog>`'s top layer, focus trapping and Escape handling.
 * jsdom does not implement `showModal` at all and `tests/ui/host-stub.ts` shims it — see the honest
 * statement of the shim's limits there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SignInDialog, { type SignInView } from "@/components/Account/SignInDialog";
import { installHost, signedIn, type AccountStub } from "./host-stub";

let account: AccountStub;

/** Render the dialog on one view, with the handlers a test wants to watch. */
function open(
  view: SignInView,
  handlers: {
    onSignedIn?: (email: string) => void;
    onViewChange?: (view: SignInView) => void;
    onClose?: () => void;
  } = {}
) {
  return render(
    <SignInDialog
      view={view}
      onViewChange={handlers.onViewChange ?? (() => {})}
      onClose={handlers.onClose ?? (() => {})}
      onSignedIn={handlers.onSignedIn ?? (() => {})}
    />
  );
}

beforeEach(() => {
  account = installHost();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("signing in", () => {
  it("sends the trimmed address and reports the signed-in email", async () => {
    const user = userEvent.setup({ delay: null });
    account.signInPassword.mockResolvedValue(signedIn({ email: "learner@example.com" }));
    const onSignedIn = vi.fn();
    open("signIn", { onSignedIn });

    await user.type(screen.getByLabelText("Email"), "  learner@example.com  ");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(account.signInPassword).toHaveBeenCalledTimes(1));
    /**
     * Trimmed. A pasted address routinely carries a trailing space, and the server compares on
     * `lower(email)` with no trim of its own — so an untrimmed address is a sign-in that fails for
     * a reason the person cannot see.
     */
    expect(account.signInPassword.mock.calls[0]?.[0]).toEqual({
      email: "learner@example.com",
      password: "a-long-enough-password",
    });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith("learner@example.com"));
  });

  it("clears the password whether the sign-in succeeded or failed", async () => {
    /**
     * THE HEADER'S SECURITY CLAIM, AS A TEST. `SignInDialog.tsx` opens by saying passwords live in
     * the component "for one submit … because a password sitting in React state survives into
     * devtools and heap snapshots". That is only true because of a `setPassword("")` in a
     * `finally`, which is exactly the line a refactor drops.
     */
    const user = userEvent.setup({ delay: null });
    open("signIn");

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.type(password, "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // The refusal path — the stub's default.
    await waitFor(() => expect(password.value).toBe(""));

    account.signInPassword.mockResolvedValue(signedIn());
    await user.type(password, "another-long-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(password.value).toBe(""));
  });

  it("shows the server's refusal without inventing one of its own", async () => {
    const user = userEvent.setup({ delay: null });
    account.signInPassword.mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "Email or password is incorrect.",
    });
    open("signIn");

    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByText("Email or password is incorrect.")).toBeTruthy();
  });

  it("does not reach the network for an address that cannot be one", async () => {
    // Latency, not security — but a request that was never going to succeed is a round trip and a
    // rate-limit bucket spent on a typo.
    const user = userEvent.setup({ delay: null });
    open("signIn");

    await user.type(screen.getByLabelText("Email"), "not-an-address");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(account.signInPassword).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
  });

  it("offers a way to the other two views", async () => {
    const user = userEvent.setup({ delay: null });
    const onViewChange = vi.fn();
    open("signIn", { onViewChange });

    await user.click(screen.getByRole("button", { name: /forgot password/i }));
    expect(onViewChange).toHaveBeenCalledWith("forgot");

    await user.click(screen.getByRole("button", { name: /create an account/i }));
    expect(onViewChange).toHaveBeenCalledWith("register");
  });
});

describe("creating an account", () => {
  it("will not submit without the terms checkbox, and says so", async () => {
    const user = userEvent.setup({ delay: null });
    open("register");

    await user.type(screen.getByLabelText("Name"), "A Learner");
    await user.type(screen.getByLabelText("Email"), "learner@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(account.register).not.toHaveBeenCalled();
    // The error, not the checkbox's own label — both say "terms". `Checkbox` renders its message
    // with `role="alert"` so it is announced, which also makes it the unambiguous thing to assert.
    expect((await screen.findByRole("alert")).textContent).toMatch(/terms/i);
  });

  it("registers once the box is ticked", async () => {
    const user = userEvent.setup({ delay: null });
    account.register.mockResolvedValue(signedIn({ email: "new@example.com" }, true));
    const onSignedIn = vi.fn();
    open("register", { onSignedIn });

    await user.type(screen.getByLabelText("Name"), "A Learner");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(account.register).toHaveBeenCalledTimes(1));
    /**
     * `acceptTerms: true` is a `z.literal(true)` in the IPC contract, so an unticked box cannot
     * even be expressed on the wire — and the renderer may not send a terms VERSION at all; main
     * adds it. Both halves are asserted here because the contract's schema test cannot see whether
     * the component honours them.
     */
    const sent = account.register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.acceptTerms).toBe(true);
    expect(Object.keys(sent)).not.toContain("termsVersion");
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith("new@example.com"));
  });

  it("puts a server field error under the field it names", async () => {
    /**
     * The server answers `{field: "email"}` for an address that already has an account. Showing
     * that in the banner instead leaves the person looking at three fields with no idea which one
     * the sentence is about.
     */
    const user = userEvent.setup({ delay: null });
    account.register.mockResolvedValue({
      ok: false,
      code: "conflict",
      field: "email",
      message: "That address already has an account.",
    });
    open("register");

    await user.type(screen.getByLabelText("Name"), "A Learner");
    await user.type(screen.getByLabelText("Email"), "taken@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true")
    );
    expect(screen.getByText("That address already has an account.")).toBeTruthy();
  });
});

describe("forgotten password — the only way back in for an account with no password", () => {
  it("advances to the code step and shows the server's own sentence", async () => {
    /**
     * The server's message is identical whether or not the address has an account — it is a
     * membership oracle otherwise — so the UI must show it verbatim rather than writing its own
     * "we've sent you an email", which would be a claim it cannot make.
     */
    const user = userEvent.setup({ delay: null });
    account.requestPasswordCode.mockResolvedValue({
      ok: true,
      message: "If that address has an account, we've emailed a 6-digit code. It expires in 15 minutes.",
    });
    open("forgot");

    await user.type(screen.getByLabelText("Email"), "nopassword@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    expect(await screen.findByLabelText("6-digit code")).toBeTruthy();
    expect(
      screen.getByText(/If that address has an account, we've emailed a 6-digit code/)
    ).toBeTruthy();
  });

  it("normalises a pasted code to six digits", async () => {
    // People paste "Code: 123 456" out of the email. Six digits is what the server checks.
    const user = userEvent.setup({ delay: null });
    account.requestPasswordCode.mockResolvedValue({ ok: true, message: "sent" });
    open("forgot");

    await user.type(screen.getByLabelText("Email"), "nopassword@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    const code = (await screen.findByLabelText("6-digit code")) as HTMLInputElement;
    await user.type(code, "Code: 123 456");
    expect(code.value).toBe("123456");
  });

  it("requires six digits before spending an attempt", async () => {
    /**
     * The server allows five guesses per code and the fifth locks it. A request that cannot
     * possibly match still increments that counter — the increment happens before the comparison,
     * under `FOR UPDATE`, by design — so a short code must not leave this component.
     */
    const user = userEvent.setup({ delay: null });
    account.requestPasswordCode.mockResolvedValue({ ok: true, message: "sent" });
    open("forgot");

    await user.type(screen.getByLabelText("Email"), "nopassword@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    await user.type(await screen.findByLabelText("6-digit code"), "123");
    await user.type(screen.getByLabelText("New password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /set password and sign in/i }));

    expect(account.resetPassword).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the 6-digit code/i)).toBeTruthy();
  });

  it("sets the password and signs in", async () => {
    const user = userEvent.setup({ delay: null });
    account.requestPasswordCode.mockResolvedValue({ ok: true, message: "sent" });
    account.resetPassword.mockResolvedValue(signedIn({ email: "nopassword@example.com" }));
    const onSignedIn = vi.fn();
    open("forgot", { onSignedIn });

    await user.type(screen.getByLabelText("Email"), "nopassword@example.com");
    await user.click(screen.getByRole("button", { name: /send code/i }));

    await user.type(await screen.findByLabelText("6-digit code"), "123456");
    await user.type(screen.getByLabelText("New password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /set password and sign in/i }));

    await waitFor(() =>
      expect(account.resetPassword).toHaveBeenCalledWith({
        email: "nopassword@example.com",
        code: "123456",
        newPassword: "a-long-enough-password",
      })
    );
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith("nopassword@example.com"));
  });

  it("disables 'Send a new code' and counts it back down", async () => {
    /**
     * The server caps codes at three per address per hour, so an enabled resend button is an
     * invitation to spend that budget in four clicks and then be told to wait an hour. Fake timers,
     * because the alternative is a test that takes a real minute.
     */
    /**
     * `fireEvent`, not `userEvent`, and that is not a style choice.
     *
     * `userEvent` awaits its own internal timers between events. Under `vi.useFakeTimers()` those
     * never fire unless advanced, so the very first `await user.type(...)` hangs until vitest's
     * timeout — which presents as "the cooldown never counts down" and sent me looking at the
     * component. `fireEvent` dispatches synchronously and has nothing to wait for.
     */
    vi.useFakeTimers();
    account.requestPasswordCode.mockResolvedValue({ ok: true, message: "sent" });
    open("forgot");

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "nopassword@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    // Flush the resolved request. `findBy`/`waitFor` poll on a timer, and the poll is itself
    // frozen under fake timers.
    await act(async () => {});

    const resend = screen.getByRole("button", { name: /send a new code/i }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/\(\d+s\)/);

    /**
     * One `act` boundary per tick, not one big advance, and that is also not a style choice.
     *
     * The countdown is a SELF-RESCHEDULING effect: each second's `setTimeout` is created by the
     * effect that the *previous* tick's render ran. React only flushes a queued render — and so
     * the effect that follows it — at an `act` boundary, so a single
     * `advanceTimersByTimeAsync(61_000)` fires exactly one timeout, finds no successor scheduled,
     * and returns with the button still disabled at 59. That failure reads as "the countdown is
     * broken" and the countdown is fine.
     */
    const seconds = Number(/\((\d+)s\)/.exec(resend.textContent ?? "")?.[1]);
    expect(seconds).toBeGreaterThan(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // A real decrement, not just "it ends up enabled": a cooldown that jumped straight to zero
    // would pass the final assertion on its own.
    expect(resend.textContent).toBe(`Send a new code (${seconds - 1}s)`);
    expect(resend.disabled).toBe(true);

    for (let i = 1; i < seconds; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(resend.disabled).toBe(false);
    expect(resend.textContent).toBe("Send a new code");
  });
});

describe("the legal documents", () => {
  it("open over the form without closing it, and the typed address survives", async () => {
    /**
     * `Modal` reports EVERY close through `onClose`, including a programmatic one, so stacking the
     * document in a second modal rather than swapping the first one's contents is what keeps the
     * form — and whatever has been typed into it — alive underneath. The component's header calls
     * this load-bearing; this is the assertion behind that word.
     */
    const user = userEvent.setup({ delay: null });
    const onClose = vi.fn();
    open("register", { onClose });

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    await user.type(email, "learner@example.com");
    await user.click(screen.getByRole("button", { name: /terms of use/i }));

    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBeGreaterThan(1));
    expect(onClose, "opening a legal document closed the sign-in dialog").not.toHaveBeenCalled();
    expect(email.value).toBe("learner@example.com");
  });
});

/*
 * `describe("provider sign-in")` STOOD HERE, and deleting it is the point.
 *
 * It asserted that a build with no client ids offered no Google or Microsoft button and called
 * `signInOAuth` for nobody. It was written one commit before the removal and labelled "deliberately
 * written to be deleted", so that taking the feature out would fail a named test rather than
 * quietly shrinking a file. It did: `account.providers` is no longer a method on the host, the
 * buttons have no component left, and the assertion could not be made today.
 *
 * This note is what a deletion leaves behind. The guard that a provider button cannot come back is
 * `honest-copy.test.ts`, which now pins the legal documents to the absence of the code, in both
 * directions.
 */
