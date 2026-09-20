"""Does selling a pack make money?

WHY THIS FILE EXISTS

It was written after a pack table that lost money on every sale. The pricing row denominated a
credit as one **US cent** — RunPod bills in dollars — while the packs were priced in **ringgit**.
Nothing was arithmetically wrong anywhere: the rate was right in its own unit, the packs were right
in theirs, the ledger balanced, and the reconciliation suite passed. A RM20 pack granted about RM56
of GPU, and every figure involved was internally consistent.

That is the shape of the bug this guards. Two correct numbers in different units, with no single
place that compared them. `test_gpu_pricing.py` checks the rate against the pod; `test_credit_packs`
would check packs against themselves; neither can see the gap between them. This file is the only
place the two meet.

THE ASSERTION IS AN INEQUALITY, NOT A NUMBER

Pinning the exact credits per pack would fail on every deliberate price change and teach whoever
follows to update the expected value without thinking. What must hold is the relationship: after the
payment fee, a pack's price must cover the GPU the credits it grants can buy, with a margin left.
That stays true across repricing, and fails the moment the units drift apart again.
"""

import pytest
from src.services import credit_packs, gpu_pricing

#: Stripe's Malaysian FPX pricing: 3% plus RM1.00, in sen. Modelled explicitly rather than folded
#: into a fudge factor, because it is regressive — a fixed component is 5% of a RM20 sale and 1% of
#: a RM100 one, which is exactly why the smallest pack is the one at risk.
FEE_PERCENT = 0.03
FEE_FIXED_MINOR = 100


def payment_fee_minor(price_minor: int) -> int:
    """What the provider keeps, rounded up — never round a cost down in your own favour."""
    return -(-int(price_minor * FEE_PERCENT * 100) // 100) + FEE_FIXED_MINOR


def gpu_cost_minor_of(credits_micro: int) -> float:
    """The real GPU cost, in sen, of the credits a pack grants.

    A learner spending `credits_micro` at the live rate occupies
    `credits_micro / rate` slot-seconds, which cost the base rate — the rate before margin. So the
    cost is simply the credits divided by the margin. Stated as arithmetic rather than a constant so
    it follows the pricing row automatically.
    """
    row = gpu_pricing.rate_for()
    return (credits_micro / gpu_pricing.MICRO_PER_CREDIT) / (row.margin_bps / 10_000)


class TestEveryPackOnSaleMakesMoney:
    @pytest.mark.parametrize("pack", credit_packs.packs_on_sale(), ids=lambda p: p.code)
    def test_price_covers_the_gpu_it_grants_plus_the_payment_fee(self, pack):
        """The assertion that would have caught the currency mismatch on the day it was written."""
        gpu = gpu_cost_minor_of(pack.credits_micro)
        fee = payment_fee_minor(pack.price_minor)
        margin = pack.price_minor - fee - gpu

        assert margin > 0, (
            f"{pack.code} sells {pack.credits_micro // gpu_pricing.MICRO_PER_CREDIT} credits for "
            f"{pack.price_display}. Those credits buy about RM{gpu / 100:.2f} of GPU and the "
            f"payment fee is RM{fee / 100:.2f}, so every sale loses RM{-margin / 100:.2f}. "
            "Check that the pricing row and the pack prices are in the SAME currency."
        )

    @pytest.mark.parametrize("pack", credit_packs.packs_on_sale(), ids=lambda p: p.code)
    def test_the_margin_is_not_merely_positive(self, pack):
        """Barely breaking even is not a business.

        A third of the sale price is the floor, chosen so there is room for the FX assumption to
        move and for the pod to sit idle — neither of which the per-request margin already covers.
        """
        gpu = gpu_cost_minor_of(pack.credits_micro)
        fee = payment_fee_minor(pack.price_minor)
        margin = pack.price_minor - fee - gpu
        assert margin >= pack.price_minor * 0.33, (
            f"{pack.code} keeps only RM{margin / 100:.2f} of {pack.price_display}"
        )


class TestTheUnitsAgree:
    def test_the_pricing_row_and_the_packs_are_in_the_same_currency(self):
        """The specific check that was missing.

        There is no currency field on a pricing row — it is implied by `pod_micro_per_hour` — so
        this asserts it by magnitude instead. RunPod's A40 is about $0.49/hr; in sen that is roughly
        230, in US cents 49. If the live row looks like US cents while packs are sold in ringgit,
        the units have drifted apart again.
        """
        row = gpu_pricing.rate_for()
        currencies = {p.currency for p in credit_packs.packs_on_sale()}
        assert currencies == {"myr"}, f"packs are sold in {currencies}"

        expected_sen_per_hour = 0.49 * (gpu_pricing.USD_TO_MYR_TENTHS / 10) * 100
        actual = row.pod_micro_per_hour / gpu_pricing.MICRO_PER_CREDIT
        assert actual == pytest.approx(expected_sen_per_hour, rel=0.25), (
            f"the live pricing row says the pod costs {actual:.0f} credits/hour. For MYR-denominated "
            f"credits that should be about {expected_sen_per_hour:.0f} sen. If it looks like ~49, "
            "the row is still denominated in US cents while packs are sold in ringgit — which is "
            "the bug this file was written for."
        )


class TestTheSmallestPackIsTheOneToWatch:
    def test_the_fixed_fee_does_not_eat_the_smallest_pack(self):
        """RM1.00 fixed is 5% of RM20 and 1% of RM100.

        Anyone adding a cheaper pack later will not be thinking about that, so it is asserted rather
        than left as a comment on the pack table.
        """
        smallest = min(credit_packs.packs_on_sale(), key=lambda p: p.price_minor)
        fee_share = payment_fee_minor(smallest.price_minor) / smallest.price_minor
        assert fee_share < 0.15, (
            f"the payment fee is {fee_share:.0%} of {smallest.code} ({smallest.price_display}). "
            "Below about RM10 the fixed component makes a pack not worth selling on Stripe; a "
            "local gateway at ~1.5% with no fixed fee would change that."
        )
