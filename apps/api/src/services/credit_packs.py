"""What a learner can buy, and for how much.

DATED ROWS, LIKE THE PRICING TABLE, AND FOR THE SAME REASON

A pack's credit amount is baked into a completed purchase. If packs were mutable constants, changing
one would retroactively change what a past buyer is recorded as having bought, and a receipt would
stop matching the ledger. Packs are therefore dated and append-only: raise a price by adding a row,
never by editing one.

THE CREDIT AMOUNT COMES FROM THE PACK, NEVER FROM THE MONEY PAID

This is the rule that stops a whole family of bugs. The obvious implementation divides the amount
the provider says was paid by a price-per-credit — and then a partial capture, a currency
conversion, a promotional discount or a refund produces a fractional or wrong credit amount, computed
from a number the buyer can influence. Instead the checkout records WHICH pack was bought, and the
webhook grants that pack's `credits_micro` verbatim. The money paid is recorded for reconciliation
and never used arithmetically.

CURRENCY

Prices are in the smallest unit of the currency (sen for MYR), matching how Stripe and every other
provider take amounts. Credits are a separate unit from money on purpose: the ledger is
currency-agnostic, so selling the same pack in a second currency later means another pack row, not a
migration.

A NOTE ON WHAT THESE PRICES ARE WORTH

`gpu_pricing` currently ships an unmeasured rate, so the credits-per-ringgit here cannot yet be
checked against what a request actually costs to serve. Sizing is deliberately conservative until
the serving benchmark lands. `test_pack_economics.py` asserts the relationship rather than the
numbers, so when a measured rate arrives the sizing can be re-derived without rewriting the tests.
"""

from dataclasses import dataclass
from datetime import datetime, timezone

MICRO_PER_CREDIT = 1_000_000


@dataclass(frozen=True)
class CreditPack:
    """One purchasable pack. Immutable; supersede by adding a newer row."""

    #: Stable identifier that goes into the provider's metadata and comes back on the webhook.
    #: Never reuse a code for different credits -- a replayed or late webhook would grant the new
    #: amount for an old purchase.
    code: str
    effective_from: datetime
    #: Price in the currency's smallest unit. 2000 = RM20.00.
    price_minor: int
    currency: str
    #: What the buyer receives. Authoritative: the webhook grants exactly this.
    credits_micro: int
    label: str
    #: False retires a pack from sale without deleting it, so past purchases still resolve.
    on_sale: bool = True

    #: How each currency is written where the buyer lives. Not `currency.upper()`: "MYR 20.00" is
    #: how a bank statement reads, and "RM20.00" is how a price is written on anything a Malaysian
    #: is asked to buy. Getting this wrong makes a real product look like an export of a database.
    _SYMBOLS = {"myr": "RM", "usd": "$", "sgd": "S$"}

    @property
    def price_display(self) -> str:
        symbol = self._SYMBOLS.get(self.currency)
        if symbol is None:
            # An unknown currency prints its ISO code rather than guessing a symbol wrong.
            return f"{self.currency.upper()} {self.price_minor / 100:.2f}"
        return f"{symbol}{self.price_minor / 100:.2f}"


#: Append-only, newest last. RM-denominated: the product is aimed at Malaysia.
#:
#: Sizing note: 1 credit is defined as 1 sen of *GPU cost* in `gpu_pricing`, and the packs sell
#: credits at a markup over that on top of the pricing row's own margin. Both layers are deliberate
#: -- the pricing margin covers idle GPU and FX, the pack markup covers the payment fee and leaves
#: something over. Stripe FPX at 3% + RM1 takes RM1.60 of a RM20 sale, which is why the smallest
#: pack is not smaller: below about RM10 the fee eats the margin entirely.
PACKS: tuple[CreditPack, ...] = (
    CreditPack(
        code="my-starter-20",
        effective_from=datetime(2026, 9, 10, tzinfo=timezone.utc),
        price_minor=2000,
        currency="myr",
        credits_micro=1200 * MICRO_PER_CREDIT,
        label="Starter",
    ),
    CreditPack(
        code="my-regular-50",
        effective_from=datetime(2026, 9, 10, tzinfo=timezone.utc),
        price_minor=5000,
        currency="myr",
        credits_micro=3300 * MICRO_PER_CREDIT,
        label="Regular",
    ),
    CreditPack(
        code="my-heavy-100",
        effective_from=datetime(2026, 9, 10, tzinfo=timezone.utc),
        price_minor=10000,
        currency="myr",
        credits_micro=7000 * MICRO_PER_CREDIT,
        label="Heavy",
    ),
)


def pack_by_code(code: str) -> CreditPack | None:
    """Resolve a pack for a webhook, INCLUDING retired ones.

    A purchase started before a pack was retired must still credit when its webhook lands, which can
    be minutes later or -- after a provider outage and replay -- days. Filtering to on-sale packs
    here would silently drop those payments: money taken, no credit given, and nothing in the logs
    saying why.
    """
    for pack in reversed(PACKS):
        if pack.code == code:
            return pack
    return None


def packs_on_sale(when: datetime | None = None) -> list[CreditPack]:
    """What to show a buyer now. Retired and future-dated rows are excluded."""
    when = when or datetime.now(timezone.utc)
    return [p for p in PACKS if p.on_sale and p.effective_from <= when]
