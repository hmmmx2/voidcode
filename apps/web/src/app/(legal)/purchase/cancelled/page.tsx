import Link from "next/link";

export const metadata = {
  title: "Payment cancelled — VoidCode AI",
  robots: { index: false, follow: false },
};

/** Stripe's `cancel_url`. Nothing happened, and the page says only that. */
export default function PurchaseCancelledPage() {
  return (
    <div className="page-content py-20">
      <h1 className="text-h2 text-ink">Payment cancelled</h1>
      <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-2">
        Nothing was charged. You can close this tab and go back to VoidCode.
      </p>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-ink-3">
        Everything except the VoidCode model keeps working without credits — the editor, the grader
        and any model running on your own machine are unaffected.
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
