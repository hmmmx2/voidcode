"""Google and Microsoft sign-in for the desktop app: redeem the code, verify the ID token.

THE FLOW, AND WHO DOES WHICH HALF

The desktop app runs the browser half (RFC 8252): it opens the system browser with PKCE, a `state`
and a `nonce`, and receives the authorization code on a loopback listener. It then relays
`{code, code_verifier, redirect_uri, nonce}` here. This module redeems the code at the provider's
token endpoint and verifies the ID token that comes back.

WHY THE CODE IS RELAYED RATHER THAN THE APP SENDING AN ID TOKEN

  * No secret ships in the installer. Google's "Desktop app" client type still requires a
    client_secret at its token endpoint; redeeming here keeps it in server config only.
  * The ID token arrives from the provider over TLS in response to OUR request, so a client cannot
    hand us a token it obtained elsewhere. The code is single-use at the provider and PKCE binds it
    to the process that started the flow.
  * Verification stays entirely server-side, where it can be tested and changed without shipping an
    app. The checks below still run in full — defence in depth, and the fallback if a provider ever
    stops allowing server-side redemption for native clients is to accept the ID token directly,
    through exactly the same verifier.

WHAT IS VERIFIED, AND THE ATTACK EACH CHECK STOPS

  * `alg` is RS256 and nothing else  — `alg: none`, and HS256 signed with the public key as secret.
  * signature against the provider's JWKS — a forged token.
  * `aud` is one of OUR client ids — a real token issued to somebody else's app.
  * `iss` exactly matches the provider — a token from a different issuer. For Microsoft the issuer
    is bound to the token's OWN `tid`: accepting any `login.microsoftonline.com/*/v2.0` would let a
    token claim one tenant in `iss` and another in `tid`.
  * `exp`, and `iat` no older than ten minutes — replay of a token captured earlier.
  * `nonce` equals the one this sign-in generated — a token minted for a different sign-in.

WHAT IS NOT DECIDED HERE

Whether a verified identity may attach to an existing account is `account_linking.py`'s job. This
module reports whether the provider's email assertion is TRUSTWORTHY (`email_trusted`), because that
depends on provider-specific claims only this module reads; it never decides who the user is.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt

from .. import config

logger = logging.getLogger(__name__)

GOOGLE = "google"
MICROSOFT = "microsoft"
PROVIDERS = (GOOGLE, MICROSOFT)

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})

MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MICROSOFT_JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys"
#: The tenant every personal Microsoft account (Outlook, Hotmail, Live, Xbox) belongs to.
MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
MICROSOFT_CONSUMER_DOMAINS = frozenset({"outlook.com", "hotmail.com", "live.com", "msn.com"})

#: Clock skew tolerated on `exp`/`iat`/`nbf`, in seconds.
LEEWAY_SECONDS = 120
#: How old an ID token may be. It was minted seconds ago by the redemption this module just made, so
#: anything older is a token from somewhere else.
MAX_TOKEN_AGE_SECONDS = 600
HTTP_TIMEOUT_SECONDS = 10.0

_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class OidcError(Exception):
    """Why a provider sign-in was refused. `code` is stable and safe to return to the client.

    codes: `provider_unavailable` (not configured, or the provider's keys cannot be fetched),
    `expired` (the code was already used or has expired), `rejected` (the provider refused the code
    for another reason), `upstream` (the provider could not be reached), `invalid_token` (the ID
    token failed verification).
    """

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code


@dataclass(frozen=True)
class VerifiedIdentity:
    provider: str
    #: Google `sub`; Microsoft `"{tid}:{oid}"`. See `subject_for`.
    subject: str
    tenant_id: str | None
    #: Lower-cased and stripped, or None when the token carried no address.
    email: str | None
    #: Whether the provider's email assertion is strong enough to attach to an existing account.
    email_trusted: bool
    name: str | None


def client_ids(provider: str) -> list[str]:
    if provider == GOOGLE:
        return list(config.OAUTH_GOOGLE_CLIENT_IDS)
    if provider == MICROSOFT:
        return list(config.OAUTH_MICROSOFT_CLIENT_IDS)
    return []


def is_configured(provider: str) -> bool:
    """Enough config to complete a sign-in. Google additionally needs its secret to redeem a code."""
    if provider == GOOGLE:
        return bool(config.OAUTH_GOOGLE_CLIENT_IDS) and bool(config.OAUTH_GOOGLE_CLIENT_SECRET)
    if provider == MICROSOFT:
        return bool(config.OAUTH_MICROSOFT_CLIENT_IDS)
    return False


# ── JWKS ─────────────────────────────────────────────────────────────────────


class JwksCache:
    """The provider's signing keys, cached, with a bounded refetch for unknown key ids.

    Providers rotate keys, and a token signed with a new key arrives before any cache TTL expires, so
    an unknown `kid` must trigger a refetch. Unbounded, that turns every forged token with a random
    `kid` into an outbound request: at most one refetch per `REFETCH_INTERVAL` stops a flood of junk
    tokens becoming a flood of requests to Google.

    If a fetch FAILS, keys already held are used for up to `STALE_GRACE` beyond their TTL. A provider
    outage should not sign everybody out; the keys were valid when fetched, and a rotated-out key can
    only verify tokens the provider really signed.
    """

    MIN_TTL = 300
    MAX_TTL = 86_400
    REFETCH_INTERVAL = 60
    STALE_GRACE = 86_400

    def __init__(self, url: str):
        self.url = url
        self._keys: dict[str, Any] = {}
        self._entries: dict[str, dict] = {}
        self._fetched_at = 0.0
        self._ttl = 0.0
        self._last_attempt = 0.0
        self._lock = asyncio.Lock()

    async def key_for(self, kid: str, *, now: float | None = None) -> tuple[Any, dict]:
        """(verification key, raw JWK entry) for `kid`, or raise `OidcError`."""
        now = time.time() if now is None else now
        fresh = self._fetched_at and now < self._fetched_at + self._ttl
        if kid in self._keys and fresh:
            return self._keys[kid], self._entries[kid]

        async with self._lock:
            # Re-check under the lock: a concurrent caller may have just refetched.
            fresh = self._fetched_at and now < self._fetched_at + self._ttl
            if kid in self._keys and fresh:
                return self._keys[kid], self._entries[kid]

            may_fetch = (not fresh) or (now - self._last_attempt >= self.REFETCH_INTERVAL)
            if may_fetch:
                self._last_attempt = now
                try:
                    await self._fetch(now)
                except OidcError:
                    within_grace = self._fetched_at and now < self._fetched_at + self._ttl + self.STALE_GRACE
                    if not (kid in self._keys and within_grace):
                        raise

        if kid not in self._keys:
            raise OidcError("invalid_token", "the token was signed with a key the provider does not publish")
        return self._keys[kid], self._entries[kid]

    async def _fetch(self, now: float) -> None:
        try:
            async with http_client() as client:
                response = await client.get(self.url)
        except httpx.HTTPError as exc:
            logger.error("could not fetch signing keys from %s: %s", self.url, exc)
            raise OidcError("provider_unavailable", "the provider's signing keys could not be fetched") from exc
        if response.status_code != 200:
            logger.error("signing keys %s answered %s", self.url, response.status_code)
            raise OidcError("provider_unavailable", "the provider's signing keys could not be fetched")

        keys: dict[str, Any] = {}
        entries: dict[str, dict] = {}
        for entry in (response.json() or {}).get("keys", []):
            kid = entry.get("kid")
            if not kid or entry.get("kty") != "RSA":
                continue
            try:
                keys[kid] = jwt.PyJWK(entry, algorithm="RS256").key
                entries[kid] = entry
            except jwt.PyJWKError:
                logger.warning("ignoring an unusable key %s from %s", kid, self.url)
        if not keys:
            raise OidcError("provider_unavailable", "the provider published no usable signing keys")

        self._keys, self._entries = keys, entries
        self._fetched_at = now
        self._ttl = _max_age(response.headers.get("cache-control"), self.MIN_TTL, self.MAX_TTL)


def _max_age(cache_control: str | None, low: int, high: int) -> float:
    match = re.search(r"max-age=(\d+)", cache_control or "")
    seconds = int(match.group(1)) if match else low
    return float(min(max(seconds, low), high))


_JWKS: dict[str, JwksCache] = {}


def jwks_for(provider: str) -> JwksCache:
    url = GOOGLE_JWKS_URL if provider == GOOGLE else MICROSOFT_JWKS_URL
    if url not in _JWKS:
        _JWKS[url] = JwksCache(url)
    return _JWKS[url]


def _reset_caches() -> None:
    """For tests: forget every cached key set."""
    _JWKS.clear()


def http_client() -> httpx.AsyncClient:
    """The client every outbound provider call uses. One seam, so tests can substitute a transport."""
    return httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS)


# ── Code redemption ──────────────────────────────────────────────────────────


async def redeem_code(
    provider: str, *, client_id: str, code: str, code_verifier: str, redirect_uri: str
) -> str:
    """Exchange an authorization code for an ID token. Returns the raw ID token.

    Request and response bodies are never logged: the code is a credential until spent, and the
    response carries tokens. Only the status and the provider's `error` value are.
    """
    if provider == GOOGLE:
        url = GOOGLE_TOKEN_URL
        form = {
            "client_id": client_id,
            "client_secret": config.OAUTH_GOOGLE_CLIENT_SECRET,
            "code": code,
            "code_verifier": code_verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
    else:
        url = MICROSOFT_TOKEN_URL
        # No client_secret: a public client must not send one, and Microsoft rejects the request if
        # it does.
        form = {
            "client_id": client_id,
            "code": code,
            "code_verifier": code_verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
            "scope": "openid profile email",
        }

    try:
        async with http_client() as client:
            response = await client.post(url, data=form, headers={"accept": "application/json"})
    except httpx.HTTPError as exc:
        logger.error("%s token endpoint unreachable: %s", provider, type(exc).__name__)
        raise OidcError("upstream", "the sign-in provider could not be reached") from exc

    try:
        body = response.json()
    except ValueError:
        body = {}

    if response.status_code != 200:
        error = body.get("error") if isinstance(body, dict) else None
        logger.info("%s refused a code: status=%s error=%s", provider, response.status_code, error)
        if response.status_code >= 500:
            raise OidcError("upstream", "the sign-in provider is having trouble")
        if error == "invalid_grant":
            raise OidcError("expired", "that sign-in has expired or was already used")
        raise OidcError("rejected", "the sign-in provider refused this sign-in")

    id_token = body.get("id_token") if isinstance(body, dict) else None
    if not isinstance(id_token, str) or not id_token:
        raise OidcError("rejected", "the sign-in provider returned no identity")
    return id_token


# ── ID-token verification ────────────────────────────────────────────────────


async def verify_id_token(
    provider: str, id_token: str, *, nonce: str, now: float | None = None
) -> VerifiedIdentity:
    """Verify `id_token` completely, or raise `OidcError("invalid_token")`. See the module docstring."""
    now = time.time() if now is None else now
    audiences = client_ids(provider)
    if not audiences:
        raise OidcError("provider_unavailable", f"{provider} sign-in is not configured")

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError as exc:
        raise OidcError("invalid_token", "the identity token is malformed") from exc
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise OidcError("invalid_token", "the identity token is not signed the way the provider signs")

    key, entry = await jwks_for(provider).key_for(header["kid"], now=now)

    try:
        claims = jwt.decode(
            id_token,
            key=key,
            algorithms=["RS256"],
            audience=audiences,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "sub"], "verify_iat": False},
        )
    except jwt.PyJWTError as exc:
        logger.info("rejected a %s identity token: %s", provider, type(exc).__name__)
        raise OidcError("invalid_token", "the identity token did not verify") from exc

    # PyJWT checks `exp` against the wall clock; the age check below uses `now`, so a test can pin
    # time. `verify_iat` is off because it rejects future `iat`, which the bounded check below covers.
    iat = claims.get("iat")
    if not isinstance(iat, (int, float)) or iat > now + LEEWAY_SECONDS or now - iat > MAX_TOKEN_AGE_SECONDS + LEEWAY_SECONDS:
        raise OidcError("invalid_token", "the identity token is too old or from the future")

    presented = claims.get("nonce")
    if not isinstance(presented, str) or not hmac.compare_digest(presented, nonce):
        raise OidcError("invalid_token", "the identity token belongs to a different sign-in")

    if provider == GOOGLE:
        return _google_identity(claims)
    return _microsoft_identity(claims, entry)


def _google_identity(claims: dict) -> VerifiedIdentity:
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise OidcError("invalid_token", "the identity token was not issued by Google")
    azp = claims.get("azp")
    if azp is not None and azp != claims.get("aud"):
        raise OidcError("invalid_token", "the identity token was issued to a different application")

    email = _normalised_email(claims.get("email"))
    return VerifiedIdentity(
        provider=GOOGLE,
        subject=str(claims["sub"]),
        tenant_id=None,
        email=email,
        email_trusted=google_email_is_trusted(claims, email),
        name=_name(claims),
    )


def _microsoft_identity(claims: dict, entry: dict) -> VerifiedIdentity:
    if claims.get("ver") != "2.0":
        raise OidcError("invalid_token", "the identity token is not a v2.0 Microsoft token")

    tid = str(claims.get("tid", "")).lower()
    if not _GUID.match(tid):
        raise OidcError("invalid_token", "the identity token names no tenant")

    # Bound to THIS token's tenant. Accepting any tenant's issuer would let `iss` and `tid` disagree.
    expected_issuer = f"https://login.microsoftonline.com/{tid}/v2.0"
    if claims.get("iss") != expected_issuer:
        raise OidcError("invalid_token", "the identity token's issuer does not match its tenant")
    # Microsoft's common key set states which issuer each key signs for; honour it when present.
    template = entry.get("issuer")
    if isinstance(template, str) and template.replace("{tenantid}", tid) != expected_issuer:
        raise OidcError("invalid_token", "the identity token was signed by a key for another issuer")

    if config.OAUTH_MICROSOFT_ALLOWED_TENANTS and tid not in config.OAUTH_MICROSOFT_ALLOWED_TENANTS:
        raise OidcError("invalid_token", "this Microsoft organisation is not permitted to sign in")

    oid = str(claims.get("oid", "")).lower()
    if not _GUID.match(oid):
        raise OidcError("invalid_token", "the identity token names no account")

    email = _normalised_email(claims.get("email"))
    return VerifiedIdentity(
        provider=MICROSOFT,
        subject=subject_for_microsoft(tid, oid),
        tenant_id=tid,
        email=email,
        email_trusted=microsoft_email_is_trusted(claims, tid, email),
        name=_name(claims),
    )


def subject_for_microsoft(tid: str, oid: str) -> str:
    """`"{tid}:{oid}"`, not Microsoft's `sub`.

    Microsoft's `sub` is pairwise: it differs per client id. Replacing the app registration — which
    happens (a lost admin, a tenant move) — would change every user's `sub` and orphan every linked
    account. `oid` is the account's id within its tenant and does not depend on the app.
    """
    return f"{tid}:{oid}"


def google_email_is_trusted(claims: dict, email: str | None) -> bool:
    """Google says it verified this address AND it is Google's to vouch for.

    `email_verified` alone is not enough. For an address on someone else's domain it means Google
    confirmed it at some point — not that this Google account still controls that mailbox. Google's
    own guidance is to trust it only for Gmail addresses, or when the `hd` claim shows the domain is a
    Workspace domain Google administers for that account.
    """
    if email is None or claims.get("email_verified") not in (True, "true"):
        return False
    domain = email.rsplit("@", 1)[-1]
    if domain == "gmail.com":
        return True
    hd = claims.get("hd")
    return isinstance(hd, str) and hd.strip().lower() == domain


def microsoft_email_is_trusted(claims: dict, tid: str, email: str | None) -> bool:
    """Microsoft vouches for this address — which the bare `email` claim NEVER does on its own.

    In a work or school tenant the `email` claim is whatever that tenant's administrator typed, and
    anybody can create a tenant: this is the "nOAuth" takeover, where a token saying
    `ceo@victim.com` is issued to an attacker's own tenant. So the claim is trusted only when
    Microsoft marks the domain verified (`xms_edov`, an optional claim the app registration must
    request) or when it is a personal account on one of Microsoft's own consumer domains.
    """
    if email is None:
        return False
    if claims.get("xms_edov") in (True, "true", "True", 1, "1"):
        return True
    domain = email.rsplit("@", 1)[-1]
    return tid == MICROSOFT_CONSUMER_TENANT and domain in MICROSOFT_CONSUMER_DOMAINS


def _normalised_email(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    return email if "@" in email and len(email) <= 255 else None


def _name(claims: dict) -> str | None:
    name = claims.get("name")
    return name.strip()[:200] if isinstance(name, str) and name.strip() else None


async def sign_in(
    provider: str, *, client_id: str, code: str, code_verifier: str, redirect_uri: str, nonce: str
) -> VerifiedIdentity:
    """Redeem and verify in one call. What the router uses."""
    if provider not in PROVIDERS or not is_configured(provider):
        raise OidcError("provider_unavailable", f"{provider} sign-in is not available")
    if client_id not in client_ids(provider):
        # Checked before any outbound call. The id is public, but redeeming a code on behalf of a
        # client that is not ours would make this endpoint a redemption service for anyone's app.
        raise OidcError("rejected", "that application is not recognised")
    id_token = await redeem_code(
        provider,
        client_id=client_id,
        code=code,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
    )
    return await verify_id_token(provider, id_token, nonce=nonce)
