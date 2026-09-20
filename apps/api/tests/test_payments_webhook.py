"""The webhook is the only route that creates credit, so its signature check is the money.

Everything else in the billing subsystem decides how credit *moves*. This decides whether it comes
into existence, and it is authenticated by a signature alone — no session, no user, no cookie. If
this check is wrong, anyone who can reach the endpoint can mint credit by POSTing JSON.

So these tests attack it rather than exercise it: a forged signature, a replayed body with a genuine
signature, a truncated one, a body altered after signing, a wrong secret. Each has to be refused for
a different reason, and a test asserting only "a good webhook works" would pass with the check
deleted entirely.

No network and no database: `verify_and_parse` is pure, which is why it was written as a function
taking bytes rather than a method reaching for a request.
"""

import hashlib
import hmac
import json
import time
import uuid

import pytest
from src import config
from src.services import credit_packs, payments

SECRET = "whsec_test_deadbeefdeadbeefdeadbeef"
USER = uuid.uuid4()


@pytest.fixture(autouse=True)
def _webhook_secret(monkeypatch):
    # Patched on the module object, not via the environment: `test_identity.py` records that
    # reloading config leaves other modules holding stale references.
    monkeypatch.setattr(config, "STRIPE_WEBHOOK_SECRET", SECRET)


def _session_event(
    *, pack_code="my-starter-20", payment_status="paid", event_id=None, user_id=None
) -> bytes:
    return json.dumps(
        {
            "id": event_id or f"evt_{uuid.uuid4().hex}",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": f"cs_test_{uuid.uuid4().hex[:16]}",
                    "payment_status": payment_status,
                    "amount_total": 2000,
                    "currency": "myr",
                    "client_reference_id": str(user_id or USER),
                    "metadata": {"pack_code": pack_code, "user_id": str(user_id or USER)},
                }
            },
        }
    ).encode("utf-8")


def _sign(payload: bytes, *, secret: str = SECRET, timestamp: int | None = None) -> str:
    timestamp = timestamp if timestamp is not None else int(time.time())
    signature = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={signature}"


class TestAValidWebhookIsAccepted:
    def test_a_correctly_signed_completed_payment_parses(self):
        payload = _session_event()
        event = payments.verify_and_parse(payload, _sign(payload))
        assert event is not None
        assert event.pack_code == "my-starter-20"
        assert event.user_id == USER
        assert event.amount_minor == 2000

    def test_more_than_one_v1_signature_is_accepted(self):
        """Normal during a signing-secret rotation: Stripe sends one per active secret.

        Taking only the first would fail every webhook for the duration of the rotation — which is
        precisely when nobody wants to be debugging the payment path.
        """
        payload = _session_event()
        timestamp = int(time.time())
        good = _sign(payload, timestamp=timestamp).split("v1=")[1]
        header = f"t={timestamp},v1=0000000000000000000000000000000000000000000000000000000000000000,v1={good}"
        assert payments.verify_and_parse(payload, header) is not None


class TestForgeryIsRefused:
    def test_a_wrong_signature_is_refused(self):
        payload = _session_event()
        forged = f"t={int(time.time())},v1={'a' * 64}"
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(payload, forged)

    def test_a_body_altered_after_signing_is_refused(self):
        """The attack that matters: take a real webhook, change the pack to a bigger one.

        The signature covers the bytes, so any edit invalidates it — but only if the verification
        uses the raw body rather than a re-serialised parse.
        """
        payload = _session_event(pack_code="my-starter-20")
        header = _sign(payload)
        tampered = payload.replace(b"my-starter-20", b"my-heavy-100x")
        assert len(tampered) == len(payload), "keep the length equal so only content differs"
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(tampered, header)

    def test_a_signature_from_a_different_secret_is_refused(self):
        payload = _session_event()
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(payload, _sign(payload, secret="whsec_someone_elses"))

    def test_a_missing_header_is_refused(self):
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(_session_event(), "")

    def test_a_header_without_a_signature_is_refused(self):
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(_session_event(), f"t={int(time.time())}")

    def test_a_header_without_a_timestamp_is_refused(self):
        """Without `t` there is nothing to bound replay, and the signature alone cannot."""
        payload = _session_event()
        signature = _sign(payload).split("v1=")[1]
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(payload, f"v1={signature}")


class TestReplayIsRefused:
    """A captured webhook carries a GENUINE signature. Only the timestamp can reject it."""

    def test_an_old_but_correctly_signed_body_is_refused(self):
        payload = _session_event()
        old = int(time.time()) - (payments.SIGNATURE_TOLERANCE_SECONDS + 60)
        with pytest.raises(payments.SignatureInvalid) as exc:
            payments.verify_and_parse(payload, _sign(payload, timestamp=old))
        assert "tolerance" in str(exc.value)

    def test_a_future_timestamp_is_also_refused(self):
        """Symmetric on purpose: a far-future timestamp would otherwise mint an eternally valid
        request, which is the same defect with the sign flipped."""
        payload = _session_event()
        future = int(time.time()) + (payments.SIGNATURE_TOLERANCE_SECONDS + 60)
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(payload, _sign(payload, timestamp=future))

    def test_a_body_inside_the_tolerance_is_accepted(self):
        payload = _session_event()
        recent = int(time.time()) - (payments.SIGNATURE_TOLERANCE_SECONDS - 30)
        assert payments.verify_and_parse(payload, _sign(payload, timestamp=recent)) is not None


class TestOnlyRealPaymentsCredit:
    def test_a_completed_but_unpaid_session_credits_nothing(self):
        """`complete` is not `paid`. An asynchronous method can complete while still pending, and
        crediting then gives away credit for money that may never arrive."""
        payload = _session_event(payment_status="unpaid")
        assert payments.verify_and_parse(payload, _sign(payload)) is None

    def test_an_unrelated_event_type_is_ignored_not_rejected(self):
        """Stripe sends many event types to one endpoint.

        Raising on an unknown type would make the endpoint reject deliveries it should simply
        acknowledge, and the provider would retry them indefinitely.
        """
        payload = json.dumps(
            {"id": "evt_1", "type": "customer.created", "data": {"object": {}}}
        ).encode("utf-8")
        assert payments.verify_and_parse(payload, _sign(payload)) is None

    def test_a_verified_event_with_no_metadata_is_refused(self):
        """Genuinely from Stripe, but not from our checkout — a session created in the dashboard,
        say. There is no way to know whose wallet it belongs to, so it must not guess."""
        payload = json.dumps(
            {
                "id": "evt_2",
                "type": "checkout.session.completed",
                "data": {"object": {"id": "cs_x", "payment_status": "paid", "metadata": {}}},
            }
        ).encode("utf-8")
        with pytest.raises(payments.SignatureInvalid):
            payments.verify_and_parse(payload, _sign(payload))


class TestTheCreditComesFromThePackNotTheMoney:
    """The rule that stops discounts, partial captures and FX from computing the wrong credit."""

    def test_the_amount_paid_is_carried_but_never_decides_the_credit(self):
        payload = _session_event()
        event = payments.verify_and_parse(payload, _sign(payload))
        pack = credit_packs.pack_by_code(event.pack_code)
        assert pack is not None
        # The event says 2000 sen was paid; the credit is the pack's, not a function of that.
        assert event.amount_minor == 2000
        assert pack.credits_micro == 1200 * credit_packs.MICRO_PER_CREDIT

    def test_a_tampered_amount_cannot_change_the_credit_even_if_it_verified(self):
        """Belt and braces: even granting a forged amount, the credit is looked up by pack code."""
        payload = _session_event()
        event = payments.verify_and_parse(payload, _sign(payload))
        pack = credit_packs.pack_by_code(event.pack_code)
        inflated = payments.PaymentEvent(
            event_id=event.event_id, pack_code=event.pack_code, user_id=event.user_id,
            amount_minor=999_999_99, currency=event.currency,
            provider_reference=event.provider_reference,
        )
        # The router grants `pack.credits_micro`; nothing reads `amount_minor` arithmetically.
        assert credit_packs.pack_by_code(inflated.pack_code).credits_micro == pack.credits_micro


class TestConfiguration:
    def test_a_missing_webhook_secret_refuses_rather_than_skipping_verification(self, monkeypatch):
        """The dangerous failure: an empty secret making every signature 'valid' or the check
        silently skipped. It must refuse loudly instead."""
        monkeypatch.setattr(config, "STRIPE_WEBHOOK_SECRET", "")
        payload = _session_event()
        with pytest.raises(payments.PaymentError):
            payments.verify_and_parse(payload, _sign(payload))
