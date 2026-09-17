import Link from "next/link";

export const metadata = {
  title: "Payment received — VoidCode AI",
  // Reached with a Stripe checkout session id in the URL, and it says nothing useful out of
  // context. It should not be in a search index.
  robots: { index: false, follow: false },
};

/**
 * Where Stripe sends a buyer's browser after a successful checkout.
 *
 * `apps/api/src/services/payments.py` builds this URL from `APP_BASE_URL`, so the path here and
 * the one there have to agree — `tests/test_site.py` used to check that when this page lived in a
 * static site; the API's own test does it now.
 *
 * IT DOES NOT SAY THE CREDITS ARE THERE. This page is a redirect target: it knows the buyer came
 * back, not that the payment cleared. Credits are added when Stripe's webhook reaches the API,
 * usually within a minute, and the desktop app's Models page is the thing that can actually tell.
 * Saying "credits added" here would be a lie on every failed or pending payment, and the first
 * thing the buyer would do is go and look at a balance that had not moved.
 */
export default function PurchaseSuccessPage() {
  return (
    <div className="page-content py-20">
      <h1 className="text-h2 text-ink">Payment received</h1>
      <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-2">
        You can close this tab and go back to VoidCode. Your credits appear there as soon as the
        payment confirms, usually within a minute — the Models page shows the balance.
      </p>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-ink-3">
        If the balance has not moved after a few minutes, the payment did not complete. Nothing is
        charged twice if you try again.
      </p>
      <p className="mt-10 text-sm">
        <Link
          href="/"
          className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink"
        >
          Back to voidcode.ai
        </Link>
      </p>
    </div>
  );
}
