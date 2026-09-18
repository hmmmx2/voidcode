import {
  Container,
  Eyebrow,
  Lead,
  MonoLabel,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives/SectionShell";
import { Pill } from "@/components/ui/Pill";
import { Reveal } from "@/components/motion/Reveal";

/**
 * What the product costs.
 *
 * TWO THINGS ARE PRICED, AND ONLY ONE OF THEM COSTS MONEY. The application is free and open
 * source, and everything that runs on the visitor's own machine — the editor, the problems, the
 * grader, a local model — has no price and no account. The hosted VoidCode model runs on GPUs
 * somebody has to rent, so it is metered and paid for with credits. The page is laid out in that
 * order because that is the order the two facts matter in: nobody should have to read a price list
 * to find out whether the thing they just downloaded will ask them for a card.
 *
 * ── WHY THERE IS NO "X HOURS OF TUTORING FOR RM20" ON THIS PAGE ──────────────────────────────────
 *
 * The API can compute one: `routers/credits.py` divides the balance by the live rate and the app
 * shows the result beside the balance. It is deliberately not printed here, because the rate that
 * division uses is `measured=False` in `services/gpu_pricing.py` — a projection from a rented A40's
 * hourly price divided by an API semaphore count, not an observed throughput. The serving benchmark
 * has not run.
 *
 * That distinction has already cost this project once, and the note in `gpu_pricing.py` records it:
 * credits were denominated in US cents while packs were sold in ringgit, so every pack sold about
 * RM56 of GPU for RM20 — and every figure in the ledger stayed arithmetically correct the whole
 * time. A marketing page that turns an unmeasured rate into a headline number is the same class of
 * error with a wider audience, so this page states what a credit IS (one sen of GPU cost) and lets
 * the application, which knows the live rate, do the arithmetic.
 *
 * ── THE NUMBERS ARE A COPY, AND A TEST HOLDS THEM TO THE ORIGINAL ───────────────────────────────
 *
 * `PACKS` below duplicates `apps/api/src/services/credit_packs.py`. It has to: this site is static,
 * it makes no API call, and the one thing worse than a copy is a pricing page that cannot render
 * until a server answers. `tests/test_marketing_pages.py` reads both files and fails if a price, a
 * credit amount or a label drifts — which is the direction that matters, because the API's rows are
 * append-only and authoritative for what a purchase actually grants.
 */

interface Pack {
  code: string;
  label: string;
  price: string;
  credits: number;
  /** What this pack is for, in the buyer's terms. Not from the API — a pack row has no such field. */
  note: string;
}

const PACKS: Pack[] = [
  {
    code: "my-starter-20",
    label: "Starter",
    price: "RM20.00",
    credits: 1200,
    note: "Try the hosted model on a few problems.",
  },
  {
    code: "my-regular-50",
    label: "Regular",
    price: "RM50.00",
    credits: 3300,
    note: "A term of steady use alongside a local model.",
  },
  {
    code: "my-heavy-100",
    label: "Heavy",
    price: "RM100.00",
    credits: 7000,
    note: "Interview season, with the hosted model as the default.",
  },
];

/** Everything the free tier includes, phrased as what it does rather than what it lacks. */
const FREE = [
  "The editor, the problem sets and the mock interviews",
  "The grader — your Python runs inside the app, in a sandbox with no network",
  "Any model on your own machine, through Ollama or llama.cpp",
  "Your own OpenRouter key, if you would rather pay a provider directly",
  "Everything stored in one file on your disk, with no account and no telemetry",
];

export function PricingPlans() {
  return (
    <>
      <Section id="plans">
        <Container>
          <Reveal>
            <Eyebrow>Pricing</Eyebrow>
            <SectionHeading className="max-w-none">
              The application is free.
              <span className="block text-ink-3">Only our GPUs cost money.</span>
            </SectionHeading>
            {/* FULL WIDTH, to the container's own margins. `Lead` caps its measure for a
                paragraph that shares a row with something else; this one has the row to itself, so
                the cap only left empty space to the right of every line. `Container` holds the
                gutter — nothing here sets its own. */}
            <Lead className="max-w-none">
              VoidCode is open source under the Apache License 2.0, and it does not need an account
              to do its job. The one thing you can pay for is the hosted VoidCode model — a model
              far larger than a laptop can hold, running on GPUs we rent — and it is metered by the
              second it spends answering, not by the month.
            </Lead>

            <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
              {/* Free first, and it is not a "tier" — it is the product. */}
              <div className="flex flex-col rounded-cta border border-line bg-void-1 p-8 lg:p-10">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-xl font-light tracking-tight text-ink">On your machine</h3>
                  <MonoLabel>Apache-2.0</MonoLabel>
                </div>
                <p className="mt-6 text-4xl font-light tracking-tight text-ink">Free</p>
                <p className="mt-2 text-sm text-ink-3">No account. No card. No expiry.</p>

                <ul className="mt-8 space-y-3 border-t border-line pt-7">
                  {FREE.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-ink-2">
                      <span aria-hidden className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-ink-3" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-8 border-t border-line pt-7">
                  <Pill href="/download" variant="solid" size="lg">
                    Download
                  </Pill>
                </div>
              </div>

              {/* The metered side. */}
              <div className="flex flex-col rounded-cta border border-line-strong bg-void-1 p-8 lg:p-10">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-xl font-light tracking-tight text-ink">
                    The VoidCode model
                  </h3>
                  <MonoLabel>Optional</MonoLabel>
                </div>
                <p className="mt-6 text-4xl font-light tracking-tight text-ink">
                  Credits
                  <span className="ml-3 align-middle text-base font-normal text-ink-3">
                    bought in packs
                  </span>
                </p>
                <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-ink-3">
                  One credit is one sen of GPU cost. You spend credits only while the model is
                  writing an answer — there is no subscription, and nothing is charged for a
                  conversation you have with a model on your own machine.
                </p>

                <div className="mt-8 space-y-3 border-t border-line pt-7">
                  {PACKS.map((pack) => (
                    <div
                      key={pack.code}
                      // A grid, not a wrapping flex row: wrapped, the price dropped below its own
                      // note and lost the right edge it is read against. Two columns hold at every
                      // width, and the note wraps inside its own column instead.
                      className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 rounded-lg border border-line bg-void-2 px-4 py-3"
                    >
                      <div>
                        <p className="text-sm text-ink">{pack.label}</p>
                        <p className="text-xs text-ink-3">{pack.note}</p>
                      </div>
                      <p className="text-right">
                        <span className="text-base font-light tracking-tight text-ink">
                          {pack.price}
                        </span>
                        <span className="mt-0.5 block">
                          <MonoLabel>{pack.credits.toLocaleString()} credits</MonoLabel>
                        </span>
                      </p>
                    </div>
                  ))}
                </div>

                <p className="mt-6 text-xs leading-relaxed text-ink-3">
                  Packs are bought inside the application, on the Models page, after you sign in.
                  The payment itself happens on Stripe&apos;s own checkout page — card or FPX — so
                  your card details never reach us. Vouchers are redeemed on the same page.
                </p>
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>

      <Section id="how-credits-work">
        <Container>
          <Reveal>
            <Eyebrow>How credits work</Eyebrow>
            <SectionHeading className="max-w-none">
              Metered by the second, not the seat.
            </SectionHeading>

            <div className="mt-12 grid gap-10 lg:grid-cols-3">
              <div>
                <MonoLabel>01</MonoLabel>
                <h3 className="mt-3 text-base font-light tracking-tight text-ink">
                  A hold, then a settle
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">
                  When a request starts, enough credit is held to cover its worst case. When the
                  answer finishes, the hold is released and you are charged for the time actually
                  spent. A request that fails or is cancelled releases its hold.
                </p>
              </div>
              <div>
                <MonoLabel>02</MonoLabel>
                <h3 className="mt-3 text-base font-light tracking-tight text-ink">
                  The rate is dated
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">
                  Every charge records the rate that was live when it ran, so a past request settles
                  at the price it was quoted. A rate change is a new row, never an edit — the ledger
                  in your account stays reconcilable.
                </p>
              </div>
              <div>
                <MonoLabel>03</MonoLabel>
                <h3 className="mt-3 text-base font-light tracking-tight text-ink">
                  Running out changes one thing
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">
                  At zero credits the hosted model stops answering. Everything else keeps working
                  exactly as before, because it never depended on us: the editor, the grader and any
                  local model are unaffected.
                </p>
              </div>
            </div>

            {/* The two things a pricing page is most tempted to leave out. */}
            <div className="mt-14 grid gap-6 lg:grid-cols-2">
              <div className="rounded-cta border border-line-strong bg-void-2 p-8">
                <h3 className="text-base font-light tracking-tight text-ink">
                  Not switched on yet
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">
                  Metering and purchases are both off in the shipped configuration, and the rate
                  behind the estimates is a projection from what the GPU costs to rent rather than a
                  measured throughput. Nobody is being charged for anything today. When that
                  changes, the packs above are the sizes it will change to.
                </p>
              </div>
              <div className="rounded-cta border border-line bg-void-1 p-8">
                <h3 className="text-base font-light tracking-tight text-ink">
                  What the terms do not settle
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">
                  Refunds, whether credits expire, and what happens to a balance if the hosted model
                  stops being offered are not yet written down — the{" "}
                  <a
                    href="/terms"
                    className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink"
                  >
                    Terms of Use
                  </a>{" "}
                  says so in as many words rather than implying an answer. Ask us before buying if
                  any of them matter to you.
                </p>
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
