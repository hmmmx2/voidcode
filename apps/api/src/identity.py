"""Who is calling.

ONE CREDENTIAL, AND IT IS A BEARER TOKEN. A request either carries a desktop session in
`Authorization: Bearer …`, which names a user, or it carries nothing and is anonymous. There is no
third case, and that is the point of this file.

WHAT WENT WITH THE WEBSITE'S SERVER-SIDE PROXY, because re-adding any of it reopens a hole:

  * `X-User-Id`, UNSIGNED. The proxy put the signed-in user's id in a header and the API believed
    it. Anyone who could reach the API could therefore *be* anyone by setting one header; the only
    thing in front of it was that the proxy was the sole documented caller. Its replacement is not
    a better header — it is a token this server issued and can revoke.
  * `X-Internal-Auth`, an HMAC over that id and a timestamp, with `INTERNAL_AUTH_ENFORCE` deciding
    whether an unsigned request was still accepted. It existed to make the header above
    trustworthy, so it goes with it, along with the shared `INTERNAL_API_SECRET` it needed.
  * The unverified-request counter and its Prometheus metric, which measured how much traffic still
    arrived unsigned during that rollout. A gauge of something that can no longer happen reads as a
    live risk to whoever next opens the dashboard.
  * `Caller.verified`. With the unsigned path gone it had one value, and five `if not
    caller.verified` branches that could never run. A guard that cannot fire reads like protection
    and provides none.

`tests/test_web_auth_is_gone.py` fails if any of it returns.

IT OPENS ITS OWN SHORT-LIVED SESSION RATHER THAN TAKING `get_db`.

A dependency-injected session lives for the whole request, and `resolve_caller` runs on the chat
endpoint, where a request can stream for several minutes. With roughly fourteen spare database
connections fleet-wide, pinning one per in-flight stream is the outage the queue work was built to
avoid. This borrows a connection for one indexed lookup and gives it straight back.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request

logger = logging.getLogger(__name__)

#: The shared anonymous identity. Reads are harmless; it exists so an unauthenticated visitor can
#: browse the catalog. Every router used to fall back to it, which is why a *missing* header was
#: indistinguishable from a *forged* one.
ANONYMOUS_USER_ID = uuid.UUID("00000000-0000-4000-a000-000000000001")

@dataclass(frozen=True)
class Caller:
    """A real user id, or the shared anonymous one. See the module header for what was removed."""

    user_id: uuid.UUID

    @property
    def is_anonymous(self) -> bool:
        return self.user_id == ANONYMOUS_USER_ID


async def resolve_caller(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Caller:
    """FastAPI dependency. Replaces nine hand-rolled `_get_user_id` copies.

    A malformed UUID is treated as absent rather than raising, matching the behaviour every router
    had. That is deliberate: the header is optional, and a garbled one should land an anonymous
    visitor on the catalog rather than on a 422.

    A malformed or absent credential is anonymous rather than an error: reading the public
    catalogue needs no account, and a garbled header should land a visitor on it rather than on
    a 422. A Bearer token that does not resolve is the one exception — see below.
    """

    bearer = _bearer_from(authorization)
    if bearer is not None:
        user_id = await _user_for_bearer(bearer)
        if user_id is not None:
            # Which session this is, for the handlers that act on "every session but this one" —
            # changing a password signs out other devices and keeps the one the person is using.
            # The hash, never the token: request state ends up in error reports.
            from .services import token_service

            request.state.session_token_hash = token_service.hash_token(bearer)
            return Caller(user_id=user_id)
        # A token that does not resolve is a decision, not an absence: the client sent a
        # credential and it is not good. Falling through to anonymous would silently downgrade a
        # signed-out desktop app into a free anonymous one.
        raise HTTPException(
            status_code=401,
            detail="This session has expired or been signed out. Please sign in again.",
        )

    # No credential at all: the shared anonymous identity.
    return Caller(user_id=ANONYMOUS_USER_ID)



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

    ONE CHECK. A caller is either a bearer session, which names a user and proves it, or anonymous —
    and `resolve_caller` already answers 401 for a token it cannot resolve. The only thing left to
    refuse here is the anonymous identity.
    """
    if caller.is_anonymous:
        raise HTTPException(status_code=401, detail="Sign in to do this.")
    return caller.user_id
