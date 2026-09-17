"""Who is making this request.

WHAT WAS WRONG
-----------------
Every protected router derived identity from a raw `X-User-Id` header — nine near-identical copies of
the same six lines, in `chat.py`, `dashboard.py`, `drafts.py`, `execution.py`, `interviews.py`,
`notifications.py`, `papers.py`, `profile.py` and `recommendations.py`. The header was unsigned and
unchecked, and `NEXT_PUBLIC_API_URL` is public, so the browser talks to this API directly:

    curl $API/v1/chat/sessions -H "X-User-Id: <somebody-else's-uuid>"

read and wrote that person's chat history, drafts, submissions and profile. `interviews.py:184-194`
already recorded it as "the separate, still-open X-User-Id trust problem".

THE FIX, AND WHY IT IS A SIGNATURE RATHER THAN A TOKEN THE BROWSER HOLDS
--------------------------------------------------------------------------
`config.py:59-61` fixed the design before this module existed: Next.js holds `INTERNAL_API_SECRET`
and **the browser never sees it**. Browser calls go through a Next.js route handler, which reads the
session server-side and signs the identity it resolved. This API trusts `X-User-Id` only when it
arrives with a valid signature over that same id.

The alternative — mint a token and let the browser carry it — puts a bearer credential in reach of
any XSS on the page. Signing server-side means a compromised browser can still only ask for what
its own session already permits.

WHY THIS SHIPS PERMISSIVE FIRST
----------------------------------
`config.py:63-67` spells out the rollout: the header must ship in the web app **before** this API
starts rejecting requests without it, or every sign-in breaks in the window between two deploys.

So `INTERNAL_AUTH_ENFORCE=false` (the default) allows unsigned requests **and logs every one**. That
log is the deploy gate: when it reaches zero, flip the flag — no code change. It is not a permanent
resting state, and `unverified_request_count()` exists so that "have we finished?" is a number rather
than an impression.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request

from . import config

logger = logging.getLogger(__name__)

#: The shared anonymous identity. Reads are harmless; it exists so an unauthenticated visitor can
#: browse the catalog. Every router used to fall back to it, which is why a *missing* header was
#: indistinguishable from a *forged* one.
ANONYMOUS_USER_ID = uuid.UUID("00000000-0000-4000-a000-000000000001")

#: How stale a signature may be. Sixty seconds is generous for a server-to-server hop on the same
#: network and short enough that a captured header is not a lasting credential. A client replaying
#: its OWN signature gains nothing — it already has that identity — so this bounds the window in
#: which a captured signature for SOMEONE ELSE is useful.
MAX_SIGNATURE_AGE_SECONDS = 60

#: Counts requests that arrived without a valid signature while enforcement is off. The rollout
#: gate: flip INTERNAL_AUTH_ENFORCE when this stops rising in production.
_unverified_requests = 0


def unverified_request_count() -> int:
    """How many unsigned requests have been served since boot. Surfaced on /health."""
    return _unverified_requests


def sign_identity(user_id: str, issued_at: int | None = None) -> str:
    """Produce an `X-Internal-Auth` value. Used by tests, and mirrored in the Next.js proxy.

    Kept here so the two implementations can be compared side by side. If they ever disagree, every
    request fails closed rather than silently authenticating the wrong person.
    """
    issued_at = int(time.time()) if issued_at is None else issued_at
    message = f"{user_id}\n{issued_at}".encode()
    digest = hmac.new(config.INTERNAL_API_SECRET.encode(), message, hashlib.sha256).hexdigest()
    return f"{issued_at}.{digest}"


def _signature_is_valid(user_id: str, header: str | None) -> bool:
    if not header or not config.INTERNAL_API_SECRET:
        # No secret configured means nothing can be verified. Returning False rather than True is
        # the difference between "unconfigured is unauthenticated" and "unconfigured is trusted";
        # `assert_production_config()` refuses to boot production without one.
        return False
    issued_at_raw, _, provided = header.partition(".")
    if not provided:
        return False
    try:
        issued_at = int(issued_at_raw)
    except ValueError:
        return False
    if abs(int(time.time()) - issued_at) > MAX_SIGNATURE_AGE_SECONDS:
        return False
    expected = sign_identity(user_id, issued_at).partition(".")[2]
    # Constant-time: a timing-comparable check leaks the signature a byte at a time.
    return hmac.compare_digest(expected, provided)


@dataclass(frozen=True)
class Caller:
    user_id: uuid.UUID
    #: True when a valid signature accompanied the id. False means the id was taken on trust
    #: because enforcement is still off — a write path may want to refuse on that basis.
    verified: bool

    @property
    def is_anonymous(self) -> bool:
        return self.user_id == ANONYMOUS_USER_ID


async def resolve_caller(
    request: Request,
    x_user_id: str | None = Header(default=None),
    x_internal_auth: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> Caller:
    """FastAPI dependency. Replaces nine hand-rolled `_get_user_id` copies.

    A malformed UUID is treated as absent rather than raising, matching the behaviour every router
    had. That is deliberate: the header is optional, and a garbled one should land an anonymous
    visitor on the catalog rather than on a 422.

    TWO WAYS TO BE SOMEBODY, FOR TWO KINDS OF CLIENT.

    The web app is a server talking to a server: Next.js holds the shared secret, signs the user id
    it already authenticated, and this verifies the HMAC with no database work at all. That secret
    can never be given to a desktop client, because shipping it inside an installable application
    hands every user the key to assert any identity.

    So a native client presents `Authorization: Bearer <token>` instead — a per-user, per-device
    credential minted by `/v1/auth/desktop/session` and revocable on its own. Checked second,
    because the signature path is the hot one and costs nothing.

    IT OPENS ITS OWN SHORT-LIVED SESSION RATHER THAN TAKING `get_db`.

    A dependency-injected session lives for the whole request, and this dependency runs on the chat
    endpoint, where a request can stream for several minutes. With roughly fourteen spare database
    connections fleet-wide, pinning one per in-flight stream is the outage the queue work was built
    to avoid. This borrows a connection for one indexed lookup and gives it straight back.
    """
    global _unverified_requests

    bearer = _bearer_from(authorization)
    if bearer is not None:
        user_id = await _user_for_bearer(bearer)
        if user_id is not None:
            return Caller(user_id=user_id, verified=True)
        # A token that does not resolve is a decision, not an absence: the client sent a
        # credential and it is not good. Falling through to anonymous would silently downgrade a
        # signed-out desktop app into a free anonymous one.
        raise HTTPException(
            status_code=401,
            detail="This session has expired or been signed out. Please sign in again.",
        )

    if not x_user_id:
        return Caller(user_id=ANONYMOUS_USER_ID, verified=True)

    try:
        user_id = uuid.UUID(x_user_id)
    except ValueError:
        return Caller(user_id=ANONYMOUS_USER_ID, verified=True)

    if _signature_is_valid(x_user_id, x_internal_auth):
        return Caller(user_id=user_id, verified=True)

    if config.INTERNAL_AUTH_ENFORCE:
        # Deliberately does not say whether the signature was missing, stale or wrong. The caller
        # can fix all three the same way, and distinguishing them helps only an attacker.
        raise HTTPException(
            status_code=401,
            detail="X-User-Id requires a valid X-Internal-Auth signature.",
        )

    _unverified_requests += 1
    from . import metrics
    metrics.record_unverified_identity()
    logger.warning(
        "UNVERIFIED identity on %s %s (user %s). Anyone can send this header — see src/identity.py. "
        "Total unverified since boot: %d",
        request.method, request.url.path, x_user_id, _unverified_requests,
    )
    return Caller(user_id=user_id, verified=False)



def _bearer_from(authorization: str | None) -> str | None:
    """The token out of an `Authorization` header, or None.

    Case-insensitive on the scheme because clients differ and the RFC says it is. Anything that is
    not a bearer -- a Basic header, a bare token with no scheme -- is treated as absent rather than
    rejected, so an unrelated proxy adding a header does not lock everybody out.
    """
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


async def _user_for_bearer(token: str) -> uuid.UUID | None:
    """Resolve a desktop session token. Opens and closes its own session — see `resolve_caller`."""
    from .database import AsyncSessionLocal
    from .services import token_service

    try:
        async with AsyncSessionLocal() as db:
            return await token_service.user_id_for_session(db, token)
    except Exception as exc:  # pragma: no cover - a database failure must not 500 every route
        logger.error("could not verify a desktop session token: %s", exc)
        return None


def current_user_id(caller: Caller = Depends(resolve_caller)) -> uuid.UUID:
    """Just the id, for the handlers that need nothing else.

    Use as `user_id: uuid.UUID = Depends(current_user_id)` — a drop-in for the nine `_get_user_id`
    functions, so adopting this is a one-line change per router rather than a signature change per
    handler.
    """
    return caller.user_id


def require_user(caller: Caller = Depends(resolve_caller)) -> uuid.UUID:
    """The id of a real, authenticated person — or 401. For writes that belong to one account.

    `current_user_id` hands back the shared anonymous user for a caller with no credential, which is
    right for reading a public catalogue and wrong for anything that WRITES per-person state: every
    signed-out caller then writes into the same row, and every other signed-out caller reads it
    back. That is how reading progress became a single progress record shared by everyone.

    BOTH CHECKS, in this order, for the reason `routers/credits.py` spells out: an anonymous caller is
    `verified=True` (there is no id to forge), so `verified` alone would admit them; and a
    non-anonymous caller may be unverified (an unsigned `X-User-Id`), which names somebody without
    proving it.
    """
    if caller.is_anonymous:
        raise HTTPException(status_code=401, detail="Sign in to do this.")
    if not caller.verified:
        raise HTTPException(status_code=401, detail="This request could not be authenticated.")
    return caller.user_id
