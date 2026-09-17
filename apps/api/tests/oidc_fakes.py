"""A fake Google and Microsoft, for the verifier tests and the endpoint tests.

Tokens are signed with a locally generated RSA key and that key is served from a mocked JWKS
endpoint, so `services/oidc.py` runs its real verification end to end with no network. The token
endpoint signs whatever claims the test queued, at request time, echoing the nonce the endpoint was
given — which is how a real provider behaves and what lets a test change exactly one claim.
"""

from __future__ import annotations

import time

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

GOOGLE_ID = "google-desktop-client.apps.googleusercontent.com"
MICROSOFT_ID = "3f1c0d6e-0000-4000-8000-00000000abcd"
NONCE = "n" * 43
VERIFIER = "v" * 43
REDIRECT = "http://127.0.0.1:53682/oauth/callback"
KID = "test-key-1"
WORK_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47"
OTHER_TENANT = "11111111-2222-4333-8444-555555555555"
OID = "00000000-0000-4000-a000-0000000000aa"

#: Marks a claim to leave out entirely, as distinct from setting it to None.
DROP = object()


def new_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


SIGNING_KEY = new_key()
IMPOSTOR_KEY = new_key()


def jwk(private_key, kid=KID, **extra):
    public = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    return {**public, "kid": kid, "use": "sig", "alg": "RS256", **extra}


def sign(claims, key=SIGNING_KEY, kid=KID, alg="RS256"):
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


def google_claims(**overrides):
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com",
        "aud": GOOGLE_ID,
        "azp": GOOGLE_ID,
        "sub": "110169484474386276334",
        "email": "Learner@Gmail.com",
        "email_verified": True,
        "name": "A Learner",
        "iat": now,
        "exp": now + 3600,
        "nonce": NONCE,
    }
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not DROP}


def microsoft_claims(tid=WORK_TENANT, **overrides):
    now = int(time.time())
    claims = {
        "ver": "2.0",
        "iss": f"https://login.microsoftonline.com/{tid}/v2.0",
        "aud": MICROSOFT_ID,
        "sub": "pairwise-sub-that-must-not-be-used",
        "tid": tid,
        "oid": OID,
        "email": "someone@contoso.com",
        "xms_edov": True,
        "name": "Someone",
        "iat": now,
        "exp": now + 3600,
        "nonce": NONCE,
    }
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not DROP}


class FakeProvider:
    """Serves JWKS and a token endpoint, and records what it was asked."""

    def __init__(self):
        self.keys = [jwk(SIGNING_KEY)]
        self.jwks_fetches = 0
        self.token_requests: list[dict] = []
        #: Raw (status, body) for the token endpoint. Overrides `next_claims` when set.
        self.token_response: tuple[int, dict] | None = None
        #: Claims signed into the next ID token. The nonce in them is kept as given.
        self.next_claims: dict | None = None
        self.jwks_down = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(("/certs", "/keys")):
            self.jwks_fetches += 1
            if self.jwks_down:
                return httpx.Response(503)
            return httpx.Response(
                200, json={"keys": self.keys}, headers={"cache-control": "max-age=3600"}
            )
        if request.url.path.endswith("/token"):
            self.token_requests.append(dict(httpx.QueryParams(request.content.decode())))
            if self.token_response is not None:
                status, body = self.token_response
                return httpx.Response(status, json=body)
            if self.next_claims is None:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"id_token": sign(self.next_claims)})
        return httpx.Response(404)

    def install(self, monkeypatch, oidc_module, config_module) -> None:
        oidc_module._reset_caches()
        monkeypatch.setattr(
            oidc_module,
            "http_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(self.handler)),
        )
        monkeypatch.setattr(config_module, "OAUTH_GOOGLE_CLIENT_IDS", [GOOGLE_ID])
        monkeypatch.setattr(config_module, "OAUTH_GOOGLE_CLIENT_SECRET", "google-secret")
        monkeypatch.setattr(config_module, "OAUTH_MICROSOFT_CLIENT_IDS", [MICROSOFT_ID])
        monkeypatch.setattr(config_module, "OAUTH_MICROSOFT_ALLOWED_TENANTS", [])
