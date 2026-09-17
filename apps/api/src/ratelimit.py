"""Redis-backed rate limiting.

`RATELIMIT_PEPPER` and `TRUSTED_PROXY_HOPS` have been defined in `config.py` and documented in
`.env.example` since the auth work landed, and were read by nothing. `redis_client.py` still
describes itself as being for "future rate limiting". So `/v1/auth/password-login` and
`/v1/auth/register` accepted unlimited attempts: unlimited credential stuffing against a real
password database, and unlimited account creation.

THE CLIENT IP IS THE HARD PART, AND THE LEFTMOST XFF ENTRY IS A TRAP
----------------------------------------------------------------------
`X-Forwarded-For` is a list that each proxy appends to, so the entries a client can control are on
the **left**. Taking `xff.split(",")[0]` — the obvious reading, and the common bug — means an
attacker sends `X-Forwarded-For: <random>` and gets a fresh bucket on every request. The limit then
exists, reports healthy, and stops nobody.

The trustworthy entries are the rightmost ones, appended by proxies we run. `TRUSTED_PROXY_HOPS`
says how many of those there are: 0 means trust nothing and use the socket address, which is why it
defaults to 0. Over-declaring is as bad as taking the leftmost — it hands the attacker a slot.

WHY THE KEY IS HASHED
-----------------------
`config.py:73-76` explains: Redis is an unencrypted cache whose dumps have no retention guarantee,
and an unhashed key set is a plaintext list of every address anyone has tried to log in as. The
pepper stops the hash being reversible by guessing common addresses, which a bare SHA-256 of an
email would be.

WHY IT FAILS OPEN, AND WHAT THAT COSTS
----------------------------------------
If Redis is unreachable the request is allowed, with an ERROR log. That is a real trade and worth
stating plainly rather than burying: an attacker who can take Redis down can also bypass the limit.
The alternative — failing closed — makes Redis a hard dependency for signing in at all, so a cache
outage becomes a total authentication outage. For a platform this size, availability wins and the
log is the compensating control. Revisit if Redis ever becomes highly available.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

from fastapi import HTTPException, Request

from . import config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Limit:
    """A quota. `window_seconds` is a fixed window, not a sliding one — see `check`."""

    max_requests: int
    window_seconds: int
    #: Appears in the Redis key, so two limits on one identifier do not share a counter.
    name: str


#: Deliberately strict. Credential stuffing needs volume, and a human who has typed the wrong
#: password ten times in five minutes is not being helped by an eleventh attempt.
LOGIN = Limit(max_requests=10, window_seconds=300, name="login")

#: Account creation is the expensive one to get wrong: it writes rows, and each costs an argon2id
#: hash. Per IP, since there is no prior identity to key on.
REGISTER = Limit(max_requests=5, window_seconds=3600, name="register")

#: Code execution runs untrusted code in a sandbox. The cost is CPU, not data.
EXECUTE = Limit(max_requests=60, window_seconds=60, name="execute")

#: Generation is the most expensive endpoint in the product by a wide margin — a GPU for seconds.
CHAT = Limit(max_requests=30, window_seconds=60, name="chat")

#: Redeeming a credit voucher. Far tighter than anything else here, and tighter than REGISTER.
#:
#: A voucher code is a secret with a guessable shape, and every outstanding code shares one endpoint.
#: An attacker does not need to guess a SPECIFIC code -- any hit pays -- so the thing to bound is
#: total attempts against the whole outstanding set, not attempts per code. Five an hour makes that
#: arithmetic hopeless while leaving room for somebody mistyping a code off a piece of paper.
VOUCHER = Limit(max_requests=5, window_seconds=3600, name="voucher")

#: Google and Microsoft sign-in. Looser than LOGIN because a person may genuinely cancel and retry a
#: browser consent a few times, and each attempt is bounded by a single-use provider code the
#: attacker cannot mint. It still exists because every request makes an outbound call to a provider
#: token endpoint, and an unthrottled endpoint that makes outbound calls is an amplifier.
OAUTH = Limit(max_requests=20, window_seconds=300, name="oauth")

#: Asking for a password-reset code, per email address. A separate bucket from LOGIN because the
#: thing it bounds is different: each request mails a new six-digit code, so this is what caps how
#: many codes an attacker can have live to guess at, and how many emails a stranger can send someone.
RESET_REQUEST = Limit(max_requests=3, window_seconds=3600, name="reset_request")


def client_ip(request: Request) -> str:
    """The caller's address, honouring exactly as many proxy hops as we actually run.

    Returns the socket address when `TRUSTED_PROXY_HOPS` is 0 or the header is absent or too short
    to contain the declared number of hops — a header shorter than expected means it did not come
    through the proxies we thought, so nothing in it is trustworthy.
    """
    socket_ip = request.client.host if request.client else "unknown"

    hops = config.TRUSTED_PROXY_HOPS
    if hops <= 0:
        return socket_ip

    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return socket_ip

    chain = [part.strip() for part in forwarded.split(",") if part.strip()]
    # Count from the RIGHT. `chain[-1]` was appended by the proxy nearest us; `chain[0]` is whatever
    # the client typed. See the module docstring — taking [0] is the bug that makes this decorative.
    if len(chain) < hops:
        logger.warning(
            "X-Forwarded-For has %d entries but TRUSTED_PROXY_HOPS is %d; falling back to the "
            "socket address rather than trusting a short chain.", len(chain), hops)
        return socket_ip
    return chain[-hops]


def bucket_key(limit: Limit, identifier: str) -> str:
    """`ratelimit:<name>:<hash>`. The identifier never appears in Redis in the clear."""
    digest = hashlib.sha256(
        f"{config.RATELIMIT_PEPPER}:{limit.name}:{identifier}".encode()
    ).hexdigest()[:32]
    return f"ratelimit:{limit.name}:{digest}"


async def check(limit: Limit, identifier: str) -> None:
    """Count this request against `limit`, raising 429 when the quota is spent.

    A fixed window rather than a sliding one: two counters and a Lua script buy smoother behaviour
    at a burst boundary, and the boundary case here is "an attacker gets up to 2x the quota across
    two adjacent windows", which does not change whether stuffing is viable at these numbers.

    INCR-then-EXPIRE, in that order and only on the first hit. Setting the TTL on every request
    would slide the window forward forever under sustained load, so a persistent attacker's counter
    would never reset and — more importantly — a legitimate user locked out once could never
    recover.
    """
    from .redis_client import get_redis

    key = bucket_key(limit, identifier)
    try:
        redis = get_redis()
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, limit.window_seconds)
    except Exception as exc:  # see the module docstring on failing open
        logger.error(
            "RATE LIMIT NOT ENFORCED on %r: Redis unavailable (%s). Requests are being allowed "
            "through unlimited.", limit.name, exc)
        # A log line is invisible on a dashboard, and this is the failure that most needs to be
        # visible after the fact: requests keep succeeding while nothing is limited.
        from . import metrics
        metrics.record_ratelimit_not_enforced(limit.name)
        return

    if count > limit.max_requests:
        retry_after = await _ttl(key, limit)
        logger.warning("rate limit %r exceeded (%d/%d)", limit.name, count, limit.max_requests)
        raise HTTPException(
            status_code=429,
            # No indication of whether the identifier exists — the same response for a real and a
            # made-up email, so this cannot be used to enumerate accounts.
            detail="Too many requests. Please wait and try again.",
            headers={"Retry-After": str(retry_after)},
        )


async def _ttl(key: str, limit: Limit) -> int:
    from .redis_client import get_redis

    try:
        ttl = await get_redis().ttl(key)
        return ttl if ttl and ttl > 0 else limit.window_seconds
    except Exception:
        return limit.window_seconds


async def check_ip(limit: Limit, request: Request) -> None:
    await check(limit, f"ip:{client_ip(request)}")


async def check_email_and_ip(limit: Limit, request: Request, email: str) -> None:
    """Both, because either alone is bypassable.

    Per-email only: an attacker spraying one password across thousands of accounts never trips it.
    Per-IP only: a distributed attempt on a single account never trips it. Together they cover the
    two shapes credential stuffing actually takes.
    """
    await check(limit, f"email:{email.strip().lower()}")
    await check_ip(limit, request)
