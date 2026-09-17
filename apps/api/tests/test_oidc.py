"""The ID-token verifier, attacked one claim at a time.

Every test here mints a token with a locally generated RSA key and serves that key from a mocked JWKS
endpoint, so the verifier runs exactly as in production with no network. Each rejection test changes
ONE thing about an otherwise valid token, which is what makes a pass mean that specific check works:
a test that broke two things at once would still pass with either check deleted.
"""

from __future__ import annotations

import time
import uuid

import jwt
import pytest
from oidc_fakes import (
    DROP as _DROP,
)
from oidc_fakes import (
    GOOGLE_ID,
    IMPOSTOR_KEY,
    KID,
    MICROSOFT_ID,
    NONCE,
    OID,
    OTHER_TENANT,
    SIGNING_KEY,
    WORK_TENANT,
    FakeProvider,
    google_claims,
    microsoft_claims,
    sign,
)
from oidc_fakes import jwk as _jwk
from oidc_fakes import new_key as _rsa
from src import config
from src.services import oidc

pytestmark = pytest.mark.asyncio


@pytest.fixture
def provider(monkeypatch):
    fake = FakeProvider()
    fake.token_response = (200, {"id_token": "unused"})
    fake.install(monkeypatch, oidc, config)
    yield fake
    oidc._reset_caches()


async def rejected(provider_name, token, nonce=NONCE):
    with pytest.raises(oidc.OidcError) as exc:
        await oidc.verify_id_token(provider_name, token, nonce=nonce)
    return exc.value.code


class TestAValidTokenVerifies:
    async def test_google(self, provider):
        identity = await oidc.verify_id_token("google", sign(google_claims()), nonce=NONCE)
        assert identity.subject == "110169484474386276334"
        assert identity.email == "learner@gmail.com"
        assert identity.email_trusted is True

    async def test_microsoft_subject_is_tenant_and_object_id_not_sub(self, provider):
        identity = await oidc.verify_id_token("microsoft", sign(microsoft_claims()), nonce=NONCE)
        assert identity.subject == f"{WORK_TENANT}:{OID}"
        assert identity.tenant_id == WORK_TENANT
        assert "pairwise" not in identity.subject


class TestSignatureAndAlgorithm:
    async def test_signed_by_a_key_the_provider_did_not_publish(self, provider):
        assert await rejected("google", sign(google_claims(), key=IMPOSTOR_KEY)) == "invalid_token"

    async def test_alg_none(self, provider):
        token = jwt.encode(google_claims(), key=None, algorithm="none", headers={"kid": KID})
        assert await rejected("google", token) == "invalid_token"

    async def test_hs256_signed_with_the_public_key_as_the_secret(self, provider):
        """The classic algorithm-confusion forgery: HMAC-SHA256 keyed with the provider's PUBLIC key,
        which anyone can download, in the hope the verifier uses that key as an HMAC secret.

        Built by hand rather than with `jwt.encode`. Newer PyJWT refuses to CREATE this token, which
        is a guard in the attacker's tooling, not in our verifier — an attacker simply does not use
        PyJWT. Relying on it would make this test depend on the library version installed.
        """
        import base64
        import hashlib
        import hmac as _hmac
        import json

        from cryptography.hazmat.primitives import serialization

        def b64(raw: bytes) -> str:
            return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

        public_pem = SIGNING_KEY.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        signing_input = (
            f"{b64(json.dumps({'alg': 'HS256', 'typ': 'JWT', 'kid': KID}).encode())}."
            f"{b64(json.dumps(google_claims()).encode())}"
        )
        signature = _hmac.new(public_pem, signing_input.encode(), hashlib.sha256).digest()
        token = f"{signing_input}.{b64(signature)}"
        assert await rejected("google", token) == "invalid_token"

    async def test_no_key_id(self, provider):
        token = jwt.encode(google_claims(), SIGNING_KEY, algorithm="RS256")
        assert await rejected("google", token) == "invalid_token"


class TestClaims:
    async def test_issued_to_somebody_elses_application(self, provider):
        token = sign(google_claims(aud="someone-else.apps.googleusercontent.com", azp=_DROP))
        assert await rejected("google", token) == "invalid_token"

    async def test_google_azp_for_a_different_client(self, provider):
        assert await rejected("google", sign(google_claims(azp="other-client"))) == "invalid_token"

    async def test_google_wrong_issuer(self, provider):
        assert await rejected("google", sign(google_claims(iss="https://evil.example"))) == "invalid_token"

    async def test_expired(self, provider):
        past = int(time.time()) - 7200
        assert await rejected("google", sign(google_claims(iat=past, exp=past + 600))) == "invalid_token"

    async def test_issued_too_long_ago(self, provider):
        """Still inside `exp`, but twenty minutes old — a captured token being replayed."""
        old = int(time.time()) - 1200
        assert await rejected("google", sign(google_claims(iat=old, exp=old + 3600))) == "invalid_token"

    async def test_issued_in_the_future(self, provider):
        future = int(time.time()) + 3600
        assert await rejected("google", sign(google_claims(iat=future, exp=future + 3600))) == "invalid_token"

    async def test_nonce_from_a_different_sign_in(self, provider):
        assert await rejected("google", sign(google_claims()), nonce="x" * 43) == "invalid_token"

    async def test_no_nonce_at_all(self, provider):
        assert await rejected("google", sign(google_claims(nonce=_DROP))) == "invalid_token"


class TestMicrosoftIssuerIsBoundToTheTokensOwnTenant:
    async def test_issuer_names_one_tenant_and_tid_another(self, provider):
        token = sign(microsoft_claims(
            tid=OTHER_TENANT, iss=f"https://login.microsoftonline.com/{WORK_TENANT}/v2.0"))
        assert await rejected("microsoft", token) == "invalid_token"

    async def test_the_common_endpoint_as_issuer(self, provider):
        token = sign(microsoft_claims(iss="https://login.microsoftonline.com/common/v2.0"))
        assert await rejected("microsoft", token) == "invalid_token"

    async def test_a_v1_token(self, provider):
        assert await rejected("microsoft", sign(microsoft_claims(ver="1.0"))) == "invalid_token"

    async def test_no_object_id(self, provider):
        assert await rejected("microsoft", sign(microsoft_claims(oid=_DROP))) == "invalid_token"

    async def test_a_key_published_for_another_issuer(self, provider):
        provider.keys = [_jwk(SIGNING_KEY, issuer="https://login.microsoftonline.com/{tenantid}/v1.0")]
        assert await rejected("microsoft", sign(microsoft_claims())) == "invalid_token"

    async def test_a_tenant_outside_the_allowlist(self, provider, monkeypatch):
        monkeypatch.setattr(config, "OAUTH_MICROSOFT_ALLOWED_TENANTS", [OTHER_TENANT])
        assert await rejected("microsoft", sign(microsoft_claims())) == "invalid_token"


class TestWhenAnEmailIsTrusted:
    """Trust decides whether a first sign-in may attach to an existing account, so these are the
    account-takeover tests."""

    async def test_google_unverified(self, provider):
        identity = await oidc.verify_id_token(
            "google", sign(google_claims(email_verified=False)), nonce=NONCE)
        assert identity.email_trusted is False

    async def test_google_verified_but_on_a_domain_google_does_not_run(self, provider):
        identity = await oidc.verify_id_token(
            "google", sign(google_claims(email="ceo@victim.com")), nonce=NONCE)
        assert identity.email_trusted is False

    async def test_google_workspace_domain_it_administers(self, provider):
        identity = await oidc.verify_id_token(
            "google", sign(google_claims(email="dev@school.edu", hd="school.edu")), nonce=NONCE)
        assert identity.email_trusted is True

    async def test_google_hd_for_a_different_domain(self, provider):
        identity = await oidc.verify_id_token(
            "google", sign(google_claims(email="ceo@victim.com", hd="attacker.com")), nonce=NONCE)
        assert identity.email_trusted is False

    async def test_microsoft_work_tenant_without_a_verified_domain_claim(self, provider):
        """nOAuth: any tenant admin can set `email` to anything."""
        identity = await oidc.verify_id_token(
            "microsoft", sign(microsoft_claims(email="ceo@victim.com", xms_edov=_DROP)), nonce=NONCE)
        assert identity.email_trusted is False

    async def test_microsoft_verified_domain(self, provider):
        identity = await oidc.verify_id_token("microsoft", sign(microsoft_claims()), nonce=NONCE)
        assert identity.email_trusted is True

    async def test_microsoft_personal_account_on_a_consumer_domain(self, provider):
        identity = await oidc.verify_id_token(
            "microsoft",
            sign(microsoft_claims(tid=oidc.MICROSOFT_CONSUMER_TENANT, email="me@outlook.com", xms_edov=_DROP)),
            nonce=NONCE)
        assert identity.email_trusted is True

    async def test_microsoft_personal_account_claiming_a_foreign_domain(self, provider):
        identity = await oidc.verify_id_token(
            "microsoft",
            sign(microsoft_claims(tid=oidc.MICROSOFT_CONSUMER_TENANT, email="ceo@victim.com", xms_edov=_DROP)),
            nonce=NONCE)
        assert identity.email_trusted is False


class TestTheKeyCache:
    async def test_an_unknown_key_id_refetches_at_most_once_a_minute(self, provider):
        """Otherwise every junk token with a random kid is an outbound request to Google.

        The interval counts from the LAST fetch, successful or not, so junk arriving right after a
        fetch causes none at all. That is correct rather than merely cheap: providers publish a key
        before they sign with it, so a set fetched under a minute ago already holds every key in use.
        """
        await oidc.verify_id_token("google", sign(google_claims()), nonce=NONCE)
        assert provider.jwks_fetches == 1
        for i in range(5):
            assert await rejected("google", sign(google_claims(), kid=f"junk-{i}")) == "invalid_token"
        assert provider.jwks_fetches == 1, "junk key ids drove fetches inside the interval"

        cache = oidc.jwks_for("google")
        cache._last_attempt -= oidc.JwksCache.REFETCH_INTERVAL  # a minute passes
        for i in range(5):
            assert await rejected("google", sign(google_claims(), kid=f"more-junk-{i}")) == "invalid_token"
        assert provider.jwks_fetches == 2, "after the interval, junk earns exactly one refetch"

    async def test_a_rotated_key_is_picked_up(self, provider):
        await oidc.verify_id_token("google", sign(google_claims()), nonce=NONCE)
        new_key = _rsa()
        provider.keys = [_jwk(SIGNING_KEY), _jwk(new_key, kid="rotated")]
        cache = oidc.jwks_for("google")
        cache._last_attempt -= oidc.JwksCache.REFETCH_INTERVAL  # a minute has passed
        identity = await oidc.verify_id_token("google", sign(google_claims(), key=new_key, kid="rotated"), nonce=NONCE)
        assert identity.subject

    async def test_a_provider_outage_does_not_sign_everybody_out(self, provider):
        await oidc.verify_id_token("google", sign(google_claims()), nonce=NONCE)
        provider.jwks_down = True
        cache = oidc.jwks_for("google")
        cache._fetched_at -= cache._ttl + 10  # keys are now stale, and refetch fails
        cache._last_attempt -= oidc.JwksCache.REFETCH_INTERVAL
        identity = await oidc.verify_id_token("google", sign(google_claims()), nonce=NONCE)
        assert identity.subject

    async def test_no_keys_ever_fetched_is_unavailable_not_invalid(self, provider):
        provider.jwks_down = True
        assert await rejected("google", sign(google_claims())) == "provider_unavailable"


class TestRedeemingTheCode:
    async def test_google_sends_its_secret_and_microsoft_does_not(self, provider):
        provider.token_response = (200, {"id_token": sign(google_claims())})
        await oidc.redeem_code("google", client_id=GOOGLE_ID, code="c", code_verifier="v" * 43,
                               redirect_uri="http://127.0.0.1:5555/oauth/callback")
        assert provider.token_requests[-1]["client_secret"] == "google-secret"

        provider.token_response = (200, {"id_token": sign(microsoft_claims())})
        await oidc.redeem_code("microsoft", client_id=MICROSOFT_ID, code="c", code_verifier="v" * 43,
                               redirect_uri="http://127.0.0.1:5555/oauth/callback")
        assert "client_secret" not in provider.token_requests[-1]

    @pytest.mark.parametrize(
        ("status", "body", "code"),
        [(400, {"error": "invalid_grant"}, "expired"), (400, {"error": "invalid_client"}, "rejected"),
         (503, {}, "upstream"), (200, {}, "rejected")],
    )
    async def test_refusals_map_to_stable_codes(self, provider, status, body, code):
        provider.token_response = (status, body)
        with pytest.raises(oidc.OidcError) as exc:
            await oidc.redeem_code("google", client_id=GOOGLE_ID, code="c", code_verifier="v" * 43,
                                   redirect_uri="http://127.0.0.1:5555/oauth/callback")
        assert exc.value.code == code

    async def test_a_client_id_that_is_not_ours_makes_no_outbound_call(self, provider):
        with pytest.raises(oidc.OidcError) as exc:
            await oidc.sign_in("google", client_id="not-ours", code="c", code_verifier="v" * 43,
                               redirect_uri="http://127.0.0.1:5555/oauth/callback", nonce=NONCE)
        assert exc.value.code == "rejected"
        assert provider.token_requests == []

    async def test_an_unconfigured_provider_is_unavailable(self, provider, monkeypatch):
        monkeypatch.setattr(config, "OAUTH_GOOGLE_CLIENT_SECRET", "")
        with pytest.raises(oidc.OidcError) as exc:
            await oidc.sign_in("google", client_id=GOOGLE_ID, code="c", code_verifier="v" * 43,
                               redirect_uri="http://127.0.0.1:5555/oauth/callback", nonce=NONCE)
        assert exc.value.code == "provider_unavailable"
        assert provider.token_requests == []

    async def test_end_to_end(self, provider):
        provider.token_response = (200, {"id_token": sign(google_claims())})
        identity = await oidc.sign_in("google", client_id=GOOGLE_ID, code="c", code_verifier="v" * 43,
                                      redirect_uri="http://127.0.0.1:5555/oauth/callback", nonce=NONCE)
        assert identity.provider == "google" and identity.email_trusted


def test_ids_used_here_are_not_accidentally_real():
    """Guard against pasting a real client id into a test fixture."""
    assert uuid.UUID(MICROSOFT_ID)
    assert GOOGLE_ID.startswith("google-desktop-client")
