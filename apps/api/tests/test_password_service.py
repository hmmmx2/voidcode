"""
Password hashing and policy — pure, no database, no network.

No `requires_postgres` marker: none of this touches a database, so it runs
everywhere including a bare CI container. That matters because these are the
tests guarding the two mistakes that are invisible in code review.
"""

import time

import pytest
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from src.services.password_service import (
    DUMMY_HASH,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    PasswordPolicyError,
    hash_password,
    needs_rehash,
    validate_password,
    verify_password,
)

# Marked per-test rather than module-wide: most of this file is the sync
# policy table, and a blanket asyncio mark makes pytest-asyncio warn on every
# one of them under `asyncio_mode = strict`.


GOOD = "correct horse battery staple"


# ── The two regression guards ───────────────────────────────────


def test_dummy_hash_costs_the_same_as_a_real_verify():
    """
    THE constant-time guard, asserted on TIMING rather than on exception class.

    `DUMMY_HASH` exists so that logging in as a non-existent user costs the same
    as logging in as a real one. If it is not a genuine argon2 encoding, argon2
    rejects it while *parsing* — in microseconds, before any hashing — and the
    account-enumeration oracle it exists to close is silently restored. The
    function still returns False, and every other test in this file still passes.

    An earlier version of this test asserted the exception TYPE, on the
    assumption that a malformed hash raises `InvalidHashError`. Measured: it
    raises `VerificationError`, which is also the parent of the
    `VerifyMismatchError` a *correct* hash raises — so that assertion was both
    wrong and, once loosened to the parent, unable to tell the two cases apart.
    It was then loosened all the way to `Exception`, which asserts nothing at
    all. The types below are as tight as they can honestly be — a mismatch can
    only be `VerifyMismatchError`, and a malformed encoding fails at parse time
    so it can never reach a comparison — but the SEPARATION between the two is
    still carried by the timing assertions, not by the types.

    Timing is the property that actually matters, and it cannot be satisfied by
    a plausible-looking constant. A real verify at m=64MiB is tens of
    milliseconds; parse-failure is sub-millisecond. The 5 ms floor sits far below
    the real cost (~30 ms measured) and far above parse-failure, so it is not
    flaky on a slow CI box.
    """
    ph = PasswordHasher(
        time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16
    )

    with pytest.raises(VerifyMismatchError):
        ph.verify(DUMMY_HASH, "definitely not the dummy password")

    start = time.perf_counter()
    with pytest.raises(VerifyMismatchError):
        ph.verify(DUMMY_HASH, "definitely not the dummy password")
    real_ms = (time.perf_counter() - start) * 1000

    start = time.perf_counter()
    with pytest.raises(VerificationError):
        ph.verify("$argon2id$not-a-real-hash", "x")
    malformed_ms = (time.perf_counter() - start) * 1000

    assert real_ms > 5, (
        f"verifying DUMMY_HASH took only {real_ms:.2f} ms — it is being rejected "
        "at parse time, not hashed. The constant is not a valid argon2 encoding, "
        "and the timing oracle on unknown users is wide open."
    )
    assert real_ms > malformed_ms * 5, (
        f"DUMMY_HASH ({real_ms:.2f} ms) is not meaningfully more expensive than "
        f"a malformed string ({malformed_ms:.2f} ms)"
    )


@pytest.mark.asyncio
async def test_long_passwords_sharing_a_72_byte_prefix_do_not_cross_verify():
    """
    THE reason this codebase uses argon2id and not bcrypt.

    bcrypt silently truncates at 72 bytes. Two different passwords sharing a
    72-byte prefix hash identically and verify against each other, with no
    error anywhere — the user is told their long password is strong and it
    measurably is not.

    If someone ever swaps the algorithm back "because bcrypt is more familiar",
    this is the test that fails.
    """
    prefix = "A" * 72
    stored = await hash_password(prefix + "-tail-one")

    assert await verify_password(stored, prefix + "-tail-one") is True
    assert await verify_password(stored, prefix + "-COMPLETELY-DIFFERENT") is False
    assert await verify_password(stored, prefix) is False


# ── Hash / verify round trip ────────────────────────────────────


@pytest.mark.asyncio
async def test_hash_verify_round_trip():
    stored = await hash_password(GOOD)
    assert stored.startswith("$argon2id$")
    # Must fit users.password_hash String(255) — this is why no migration was
    # needed for the column.
    assert len(stored) <= 255
    assert await verify_password(stored, GOOD) is True
    assert await verify_password(stored, GOOD + "x") is False


@pytest.mark.asyncio
async def test_same_password_hashes_differently():
    """A per-hash salt, i.e. two users with the same password are not linkable."""
    assert await hash_password(GOOD) != await hash_password(GOOD)


@pytest.mark.asyncio
async def test_oauth_only_account_never_authenticates():
    """
    `password_hash IS NULL` means the account was created through Google or
    Microsoft. No password may ever open it, whatever is submitted.
    """
    assert await verify_password(None, GOOD) is False
    assert await verify_password(None, "") is False


@pytest.mark.asyncio
async def test_corrupt_stored_hash_returns_false_rather_than_raising():
    """A corrupt row must not 500 the login endpoint for that one user."""
    assert await verify_password("not-a-hash-at-all", GOOD) is False


@pytest.mark.asyncio
async def test_oversized_password_is_rejected_without_hashing():
    """
    The login-path DoS guard. `validate_password` enforces the maximum but the
    login path never calls it, so `verify_password` needs its own check — a
    10 MB string would otherwise occupy one of four semaphore slots for as long
    as Argon2 takes to chew through it.

    Timing is the assertion: rejection must be immediate, not ~30 ms.
    """
    stored = await hash_password(GOOD)
    huge = "x" * (MAX_PASSWORD_LENGTH + 1_000_000)

    start = time.perf_counter()
    assert await verify_password(stored, huge) is False
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms < 10, (
        f"rejection took {elapsed_ms:.1f} ms — the oversized password reached "
        "the hasher instead of being rejected by the length guard"
    )


def test_needs_rehash_flags_weaker_parameters():
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash(GOOD)
    assert needs_rehash(weak) is True

    with pytest.raises(InvalidHashError):
        PasswordHasher().verify("garbage", GOOD)
    assert needs_rehash("garbage") is True


# ── Policy ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "password, because",
    [
        ("short", "under the minimum"),
        ("a" * (MAX_PASSWORD_LENGTH + 1), "over the maximum"),
        ("password1234", "on the blocklist"),
        ("Password2024", "blocklist entry with a digit suffix stripped"),
        ("aaaaaaaaaaaaaaa", "too few distinct characters"),
    ],
)
def test_policy_rejects(password, because):
    with pytest.raises(PasswordPolicyError):
        validate_password(password)


def test_policy_rejects_password_containing_the_account_email():
    with pytest.raises(PasswordPolicyError):
        validate_password("alice.smith-2026!", email="alice.smith@example.com")


def test_policy_rejects_password_containing_the_account_name():
    with pytest.raises(PasswordPolicyError):
        validate_password("bartholomew-1234", name="Bartholomew")


def test_policy_accepts_a_reasonable_passphrase():
    validate_password(GOOD, email="alice@example.com", name="Alice")


def test_policy_has_no_character_class_requirement():
    """
    Deliberate: composition rules push people toward `Password1!`, which
    satisfies every class rule, sits on every cracking list, and is far weaker
    than four random words. Length plus a blocklist does more real work.
    """
    validate_password("purple monkey dishwasher")
    assert MIN_PASSWORD_LENGTH == 12
