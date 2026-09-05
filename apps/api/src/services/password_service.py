"""
Password hashing and policy.

WHY ARGON2ID AND NOT BCRYPT

bcrypt **silently truncates at 72 bytes**. Two different 100-character
passwords sharing a 72-byte prefix hash identically and verify against each
other, with no error anywhere — the user is told their password is strong and
it is measurably not. `test_password_hashing.py` has a regression test for
exactly this so nobody swaps the algorithm back for familiarity.

Argon2id additionally is memory-hard, which is what makes GPU and ASIC attacks
expensive rather than merely slower, and it is the Password Hashing Competition
winner and OWASP's first recommendation.

WHY NOT `passlib`

It is the obvious import and it is a trap. Unmaintained since 2020, and its
bcrypt backend raises `AttributeError: module 'bcrypt' has no attribute
'__about__'` against bcrypt>=4.1 — a crash on a dependency bump, in the code
path that logs people in. `argon2-cffi` is used directly.

TWO OPERATIONAL HAZARDS, BOTH DESIGNED FOR HERE

1. **Hashing blocks the event loop.** 64 MiB across 4 lanes is ~50-80 ms of
   pure CPU with no await point. This same process serves SSE token streams from
   the LLM, so a synchronous hash stalls every open stream on the worker. Every
   hash and verify goes through `run_in_threadpool`. This is the single most
   likely production bug in the whole feature and it is invisible in testing,
   because it only shows up under concurrent load.

2. **Memory amplifies with concurrency.** N simultaneous hashes hold N x 64 MiB.
   Ten concurrent registrations is 640 MB. `_HASH_SLOTS` bounds it: excess
   callers wait rather than the container being OOM-killed.
"""

from __future__ import annotations

import asyncio
import logging
import re

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

# OWASP's recommended Argon2id parameters: m=64 MiB, t=3, p=4.
# Encoded output is ~97 chars, comfortably inside users.password_hash String(255),
# which is why this feature needs no column migration.
_hasher = PasswordHasher(
    time_cost=3,
    memory_cost=65536,  # KiB, so 64 MiB
    parallelism=4,
    hash_len=32,
    salt_len=16,
)

# Bounds peak memory to ~256 MiB of hashing regardless of request volume.
_HASH_SLOTS = asyncio.Semaphore(4)

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128

# A precomputed hash of a value nobody will ever submit.
#
# Verifying against this on the unknown-user path is what stops response time
# revealing whether an account exists. Without it, "no such user" returns in
# microseconds and "wrong password" takes 80 ms — a timing oracle that turns the
# login endpoint into an account-enumeration endpoint, regardless of how
# carefully the error *messages* are matched.
#
# Hardcoded rather than computed at import: generating it would cost 80 ms of
# startup on every worker, and it is not a secret — it is a hash of a constant
# that is written right here in the source.
# It must be a REAL hash produced by these exact parameters, not a plausible
# looking string. argon2 parses the encoding before doing any work, so a
# malformed one raises `InvalidHashError` immediately and the verify returns in
# microseconds — restoring the exact timing oracle this constant exists to
# close, while looking correct in code review. Measured: a genuine hash takes
# 30.5 ms to reject a wrong password, which is the number that has to match the
# real path. Regenerate with:
#
#     PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4,
#                    hash_len=32, salt_len=16).hash("<anything>")
DUMMY_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$"
    "HJIox6N7ZkQ80IJT0QOklA$OSEn4TDzIIh8bN3aUvbaxifUrXtAHfKJnhgoMfO30Sk"
)

# Passwords that meet every structural rule and are still worthless. Kept short
# and specific to this product deliberately — a real breach corpus belongs
# behind a k-anonymity API (HIBP), not in the repository, and a 10,000-entry
# list in source is a maintenance burden that catches barely more than this.
_BLOCKED = frozenset(
    {
        "password", "passw0rd", "password1", "password123", "password1234",
        "letmein", "welcome", "iloveyou", "admin", "administrator",
        "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm",
        "111111", "123456", "1234567", "12345678", "123456789", "1234567890",
        "voidcode", "voidcodeai", "leetcode", "interview",
        "changeme", "secret", "trustno1", "monkey", "dragon", "sunshine",
    }
)


class PasswordPolicyError(ValueError):
    """A password that structurally cannot be accepted. Message is user-facing."""


def validate_password(password: str, *, email: str = "", name: str = "") -> None:
    """
    Raise `PasswordPolicyError` if the password is unusable.

    Length first, because it does more for real-world strength than any
    composition rule. Character-class requirements are deliberately absent:
    they push people toward `Password1!` — which satisfies every class rule,
    is on every cracking list, and is weaker than four random words.

    `email` and `name` are checked because a password containing them is
    guessable by anyone who can see the account, and that is precisely the
    person attacking it.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        # Not arbitrary: unbounded input into a memory-hard function is a cheap
        # denial-of-service, and 128 characters is past any real passphrase.
        raise PasswordPolicyError(
            f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
        )

    lowered = password.lower().strip()

    if lowered in _BLOCKED:
        raise PasswordPolicyError("That password is too common. Choose something else.")

    # Collapse digit-suffix variants: `password2024` is `password`.
    if re.sub(r"\d+$", "", lowered) in _BLOCKED:
        raise PasswordPolicyError("That password is too common. Choose something else.")

    if len(set(password)) < 5:
        raise PasswordPolicyError(
            "Password must use at least 5 different characters."
        )

    local_part = email.split("@")[0].lower().strip()
    if local_part and len(local_part) >= 3 and local_part in lowered:
        raise PasswordPolicyError("Password must not contain your email address.")

    stripped_name = name.lower().strip()
    if stripped_name and len(stripped_name) >= 3 and stripped_name in lowered:
        raise PasswordPolicyError("Password must not contain your name.")


async def hash_password(password: str) -> str:
    """Hash off the event loop, under the concurrency bound."""
    async with _HASH_SLOTS:
        return await run_in_threadpool(_hasher.hash, password)


async def verify_password(stored_hash: str | None, password: str) -> bool:
    """
    Check a password against a stored hash.

    Passing `None` — an OAuth-only account with no password set — still performs
    a full verify against `DUMMY_HASH`. Returning early would make "this account
    has no password" measurably faster than "wrong password", which is the same
    enumeration oracle the unknown-user path exists to close. The caller decides
    what to *tell* the user; this function must not leak it through timing.
    """
    # LENGTH GUARD ON THE LOGIN PATH — not redundant with `validate_password`.
    #
    # `validate_password` enforces MAX_PASSWORD_LENGTH, and login NEVER CALLS IT
    # — it only runs at registration and reset, where a password is being *set*.
    # So without this, `verify_password` will hand a 10 MB string to Argon2 while
    # holding one of only four semaphore slots. Four concurrent requests take the
    # login endpoint down, from unauthenticated callers, for free.
    #
    # Pydantic `Field(max_length=...)` on the request models is the primary
    # defence and rejects before this function is reached. This is the backstop
    # for any future caller that forgets, because the cost of forgetting is an
    # outage rather than a validation error.
    #
    # Returning False rather than raising: this is the login path, and a caller
    # who submits a 10 MB password is not a legitimate user to give an error to.
    if len(password) > MAX_PASSWORD_LENGTH:
        return False

    target = stored_hash or DUMMY_HASH

    async with _HASH_SLOTS:
        try:
            await run_in_threadpool(_hasher.verify, target, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False
        except Exception:
            # A malformed stored hash must not 500 the login endpoint. Log it —
            # it means a corrupt row — and treat it as a failed attempt.
            logger.exception("Unexpected error verifying a password hash")
            return False

    # `stored_hash is None` reaching here would mean someone guessed the dummy
    # password. Belt and braces: never authenticate an account with no password.
    return stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    """
    Whether this hash was made with weaker parameters than current policy.

    Called on every *successful* verify, where the plaintext is in hand and can
    be re-hashed transparently. This is the only mechanism that raises cost
    parameters over time without forcing a password reset on everyone.
    """
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return True
