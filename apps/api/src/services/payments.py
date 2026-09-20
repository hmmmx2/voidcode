"""Taking money, behind an adapter, with Stripe as the first implementation.

WHY AN ADAPTER FOR A SINGLE PROVIDER

Not speculative generality. This product targets Malaysia, and Stripe is the one gateway there that
does **not** carry Touch 'n Go or DuitNow QR, while charging 3% + RM1 for FPX against roughly 1.5%
locally. On a RM20 pack that fee is 8% of the sale. A move to a Malaysian gateway is a question of
when rather than whether, so the provider sits behind two functions and the ledger never learns its
name.

WHY NOT THE STRIPE SDK

The surface needed is one POST to create a Checkout Session and one signature verification. The SDK
brings a dependency, a global API-key singleton and its own HTTP stack for that. `httpx` is already
a dependency here, and the signature scheme is documented and small. The trade is stated so it can
be revisited: if this grows to refunds, disputes and subscription lifecycle, the SDK earns its place.

THE TWO RULES THAT MATTER MORE THAN THE CODE

**Credit is granted only by the webhook, never by the browser redirect.** The redirect is a URL the
buyer's browser is sent to; it can be visited directly, replayed, or never happen at all because
they closed the tab. Crediting there both hands out free credit and loses real payments. The
redirect exists to show a page, and this module gives it nothing to grant with.

**The credit amount comes from the pack, never from the money.** The webhook reads which pack was
bought and grants that pack's `credits_micro` verbatim. Dividing an amount paid by a price would
compute credit from a number that discounts, partial captures and currency conversion can all move.
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from dataclasses import dataclass

import httpx

from .. import config
from . import credit_packs

logger = logging.getLogger(__name__)

STRIPE_API = "https://api.stripe.com/v1"

#: How far a webhook's timestamp may be from now. Stripe's own default, and the reason it exists is
#: replay: without it a captured request stays valid forever, and its signature is genuine.
SIGNATURE_TOLERANCE_SECONDS = 300


class PaymentError(Exception):
    """A payment could not be started. Maps to 502 -- the fault is not the caller's."""


class SignatureInvalid(Exception):
    """A webhook did not verify. Maps to 400, and nothing is credited.

    Deliberately NOT 401/403: those invite a retry with credentials, and there are none to supply.
    A failing signature means the body was not written by the provider, or was tampered with.
    """


@dataclass(frozen=True)
class CheckoutSession:
    provider_reference: str
    redirect_url: str


@dataclass(frozen=True)
class PaymentEvent:
    """A provider-neutral, already-verified payment. The ledger only ever sees this."""

    #: The provider's own event id. Becomes the ledger idempotency key, so a provider that delivers
    #: the same event twice -- which every provider does, by design, on retry -- credits once.
    event_id: str
    pack_code: str
    user_id: uuid.UUID
    amount_minor: int
    currency: str
    #: For reconciliation only. Never used to compute credit.
    provider_reference: str


def _require(name: str, value: str) -> str:
    if not value:
        raise PaymentError(
            f"{name} is not configured, so payments cannot be taken. Set it in the environment; "
            "it is never read from the database or a request."
        )
    return value


async def create_checkout(
    *, pack: credit_packs.CreditPack, user_id: uuid.UUID, idempotency_key: str
) -> CheckoutSession:
    """Start a hosted checkout and return where to send the buyer.

    The user id and pack code travel in `metadata`, which the provider returns unchanged on the
    webhook. That is what lets the webhook credit the right wallet with the right amount without
    trusting anything the browser sends back.

    `payment_method_types` names `fpx` explicitly alongside cards. FPX is how most Malaysian buyers
    pay for something in this price range, and leaving it to the dashboard default means a config
    change elsewhere can silently remove it.
    """
    secret = _require("STRIPE_SECRET_KEY", config.STRIPE_SECRET_KEY)

    form = {
        "mode": "payment",
        # Two pages on the public static site (`site/purchase/…`), not a route in an app.
        #
        # A buyer finishes a payment in their own browser, and after the desktop app replaced the
        # website there is nothing for the browser to come back to — the old `/credits?purchase=…`
        # was a page in a web app that is being deleted. These two pages are deliberately
        # script-free and say nothing about the balance: this is a redirect target, so it knows the
        # buyer returned and not that the webhook has landed. The app shows the credits.
        "success_url": f"{config.APP_BASE_URL}/purchase/success/",
        "cancel_url": f"{config.APP_BASE_URL}/purchase/cancelled/",
        "client_reference_id": str(user_id),
        "payment_method_types[0]": "card",
        "payment_method_types[1]": "fpx",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": pack.currency,
        "line_items[0][price_data][unit_amount]": str(pack.price_minor),
        "line_items[0][price_data][product_data][name]": pack.label,
        # Both keys are read back on the webhook. `client_reference_id` alone would be enough for
        # the user, but not for the pack, and the pack is what decides the credit.
        "metadata[pack_code]": pack.code,
        "metadata[user_id]": str(user_id),
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                f"{STRIPE_API}/checkout/sessions",
                data=form,
                auth=(secret, ""),
                # Stripe's own idempotency, distinct from the ledger's: a retried create must not
                # produce two checkout pages for one intent to buy.
                headers={"Idempotency-Key": idempotency_key},
            )
    except httpx.HTTPError as exc:
        raise PaymentError(f"could not reach the payment provider: {exc}") from exc

    if response.status_code >= 400:
        # Log the provider's message, return a generic one: their errors can quote request details.
        logger.error("stripe checkout failed %s: %s", response.status_code, response.text[:500])
        raise PaymentError("the payment provider rejected the checkout request")

    body = response.json()
    return CheckoutSession(provider_reference=body["id"], redirect_url=body["url"])


def verify_and_parse(payload: bytes, signature_header: str, *, now: float | None = None) -> PaymentEvent | None:
    """Verify a webhook and return the payment it describes, or None if it is not a payment.

    RAW BYTES, NOT PARSED JSON. The signature covers the exact body sent. Re-serialising parsed JSON
    changes key order and whitespace and the signature stops matching -- for correct requests, which
    is the worst way to discover it.

    Returns None for events that are genuine but not a completed payment. Stripe sends many event
    types; treating an unknown one as an error would make the endpoint reject deliveries it should
    simply acknowledge, and Stripe would keep retrying them.
    """
    secret = _require("STRIPE_WEBHOOK_SECRET", config.STRIPE_WEBHOOK_SECRET)
    now = now if now is not None else time.time()

    timestamp, signatures = _parse_signature_header(signature_header)

    # Age is checked BEFORE the comparison. A replayed request carries a genuine signature, so
    # signature validity alone cannot reject it -- only the timestamp can.
    if abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS:
        raise SignatureInvalid(
            f"webhook timestamp is {abs(now - timestamp):.0f}s away from now, outside the "
            f"{SIGNATURE_TOLERANCE_SECONDS}s tolerance"
        )

    expected = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode() + payload,
        hashlib.sha256,
    ).hexdigest()

    # `compare_digest`, never `==`: a short-circuiting comparison leaks the signature a byte at a
    # time to anyone who can measure the response. `identity.py` makes the same choice.
    if not any(hmac.compare_digest(expected, candidate) for candidate in signatures):
        raise SignatureInvalid("no signature in the header matched the payload")

    event = json.loads(payload)
    if event.get("type") != "checkout.session.completed":
        return None

    session = event["data"]["object"]

    # Completed is not paid. A session can complete with an asynchronous method still pending, and
    # crediting then gives away credit for money that may never arrive.
    if session.get("payment_status") != "paid":
        logger.info(
            "stripe session %s completed with payment_status=%s; not crediting",
            session.get("id"), session.get("payment_status"),
        )
        return None

    metadata = session.get("metadata") or {}
    pack_code = metadata.get("pack_code")
    raw_user = metadata.get("user_id") or session.get("client_reference_id")
    if not pack_code or not raw_user:
        raise SignatureInvalid(
            "the event verified but carries no pack_code or user_id; it was not created by this "
            "application's checkout"
        )

    try:
        user_id = uuid.UUID(raw_user)
    except ValueError as exc:
        raise SignatureInvalid(f"user_id in metadata is not a UUID: {raw_user!r}") from exc

    return PaymentEvent(
        event_id=event["id"],
        pack_code=pack_code,
        user_id=user_id,
        amount_minor=session.get("amount_total") or 0,
        currency=session.get("currency") or "",
        provider_reference=session.get("id") or "",
    )


def _parse_signature_header(header: str) -> tuple[int, list[str]]:
    """`t=1614556800,v1=abc,v1=def` -> (1614556800, ['abc', 'def']).

    More than one `v1` is normal during a signing-secret rotation, and both are valid. Taking only
    the first would fail every webhook for the duration of a rotation.
    """
    if not header:
        raise SignatureInvalid("no Stripe-Signature header")

    timestamp: int | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError as exc:
                raise SignatureInvalid(f"unparseable timestamp {value!r}") from exc
        elif key == "v1":
            signatures.append(value)

    if timestamp is None or not signatures:
        raise SignatureInvalid("Stripe-Signature header has no timestamp or no v1 signature")
    return timestamp, signatures
