// @vitest-environment jsdom

/**
 * The sentence a person is shown after signing in, and why it needed a test of its own.
 *
 * `sign-in-dialog.test.tsx` asserts that the dialog calls `onSignedIn(email, created)` with the
 * right `created` on all three paths. That is the producer. THIS IS THE CONSUMER, and the two are
 * separately breakable: deleting the branch in `AccountProvider` leaves every dialog assertion
 * green while every new account is told "Signed in as …" — which is exactly the defect that was
 * shipped, because `created` was being reported by the API and thrown away here.
 *
 * Proven rather than assumed: with the branch removed, every test in the dialog's file still
 * passed. This file is what fails.
 *
 * It renders the REAL `ToastProvider` around the real `AccountProvider`, so the assertion is on
 * text that reached the DOM rather than on a mocked `notify` having been called. A spy would pass
 * against a toast that never renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { ToastProvider } from "@/components/app";
import { AccountProvider, useAccount } from "@/lib/account/AccountProvider";
import { installHost, signedIn, type AccountStub } from "./host-stub";

let account: AccountStub;

/** A button that opens the dialog, since nothing opens it on its own — by design. */
function OpenRegister() {
  const { openSignIn } = useAccount();
  return <button onClick={() => openSignIn("register")}>open</button>;
}

function mount() {
  return render(
    <ToastProvider>
      <AccountProvider>
        <OpenRegister />
      </AccountProvider>
    </ToastProvider>
  );
}

/** Fill the register form and submit it. */
async function register(email: string) {
  fireEvent.click(await screen.findByRole("button", { name: "open" }));
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "A Learner" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "quiet-harbour-lantern-41" },
  });
  // By role: the checkbox's own label and its error message both say "terms".
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

beforeEach(() => {
  account = installHost();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("what the toast says", () => {
  it("tells a new account that it was created", async () => {
    account.register.mockResolvedValue(signedIn({ email: "new@example.com" }, true));

    mount();
    await register("new@example.com");

    // The whole sentence. "Signed in as new@example.com" is a SUBSTRING of the created form, so a
    // `toContain` on the shorter one would pass against either and this assertion would be vacuous.
    expect(await screen.findByText("Account created. Signed in as new@example.com")).toBeTruthy();
  });

  it("does not claim to have created an account that already existed", async () => {
    // Same form, same submit, `created: false` — which is what the API returns when the address
    // already has an account and the server signs it in rather than creating one.
    account.register.mockResolvedValue(signedIn({ email: "known@example.com" }, false));

    mount();
    await register("known@example.com");

    expect(await screen.findByText("Signed in as known@example.com")).toBeTruthy();
    expect(screen.queryByText(/Account created/)).toBeNull();
  });

  it("closes the dialog on success, so the toast is not behind it", async () => {
    account.register.mockResolvedValue(signedIn({ email: "new@example.com" }, true));

    mount();
    await register("new@example.com");

    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });
});
