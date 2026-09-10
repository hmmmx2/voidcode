"""Minting and redeeming credit vouchers.

THE ONE THING THIS FILE EXISTS TO GET RIGHT

Redemption must grant exactly once, under concurrency, forever. Everything else here is bookkeeping.

There are two guards and they are independent, both in the database:

  1. The claim is a single `UPDATE ... WHERE code_hash = ? AND redeemed_at IS NULL` and the decision
     is `rowcount`. There is no SELECT-then-check window for a second request to slip through. This
     is the shape `gpu_wallet_service._finish()` uses, and its module docstring gives the reason:
     a read-check-write is a race, and this is the one place where losing that race means giving
     away money.

  2. `gpu_wallet_service.grant()` keys the ledger and `gpu_grant_keys` on `voucher:{id}`, both of
     which are unique. So even if the claim were somehow bypassed, the grant is refused.

`token_service.redeem()` next door does the opposite -- select, check `used_at` in Python, assign --
and it is fine there only because redeeming a password-reset link twice is idempotent in effect.
Copying it here would mint money on the second click. That is the trap this file is written to
avoid, and it is worth stating plainly because the two functions otherwise look alike.

THE ERROR TAXONOMY IS DELIBERATE

"No such code" and "wrong kind" share one message: telling them apart hands somebody probing codes a
signal about which guesses were closer. "Already redeemed" is deliberately distinguishable, because
the commonest way to reach it is a learner clicking twice, and "invalid code" would send them to
support over something that worked.

REDEMPTION IS RATE LIMITED AT THE ROUTER, AND THAT IS NOT OPTIONAL

A voucher code is a secret with a guessable shape. An unlimited redeem endpoint is a brute-force
oracle against every outstanding code at once.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.credit_voucher import CreditVoucher
from . import gpu_wallet_service

logger = logging.getLogger(__name__)

#: Long enough that guessing is hopeless, short enough to read down a phone. `token_urlsafe(24)`
#: is 32 characters of base64url over 192 bits of entropy.
_CODE_BYTES = 24


class VoucherError(Exception):
    """Redemption refused. The message is safe to show a learner verbatim."""


def generate_code() -> str:
    """A new code. `secrets`, never `random` -- the latter is seeded predictably."""
    return secrets.token_urlsafe(_CODE_BYTES)


def hash_code(code: str) -> str:
    """SHA-256 hex. See the model's note on why this is not argon2id."""
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()


async def issue(
    session: AsyncSession,
    *,
    amount_micro: int,
    kind: str,
    expires_at: datetime | None = None,
    note: str | None = None,
) -> tuple[CreditVoucher, str]:
    """Mint one voucher. Returns the row and the RAW code, which is never stored and never logged.

    The caller gets exactly one chance to record the code. That is the same contract
    `token_service.issue()` has, and for the same reason: a code readable back out of the database
    is a code an operator with read access can spend.
    """
    if amount_micro <= 0:
        raise ValueError("a voucher must be worth something")

    code = generate_code()
    voucher = CreditVoucher(
        code_hash=hash_code(code),
        amount_micro=amount_micro,
        kind=kind,
        expires_at=expires_at,
        note=note,
    )
    session.add(voucher)
    await session.flush()
    return voucher, code



async def claim(
    session: AsyncSession, code_hash: str, user_id: uuid.UUID, now: datetime
) -> tuple[uuid.UUID, int] | None:
    """Mark a voucher spent, or return None. One statement; the predicate is the guard.

    SEPARATE FROM `redeem()` SO THAT IT CAN BE TESTED ALONE, AND THAT IS NOT A STYLE PREFERENCE.

    Redemption has two independent guards: this predicate, and the uniqueness of
    `voucher:{id}` in `gpu_ledger` and `gpu_grant_keys`. Either one alone is enough to stop a
    double grant -- which is the point of having two, and also the reason an end-to-end
    concurrency test cannot tell you whether THIS one works. A version of `redeem()` rewritten as
    a read-check-write still passes every test that goes through `grant()`, because the ledger's
    unique key catches what the check let through.

    That is a good property and a bad test. So the claim is exposed here and raced directly, with
    nothing behind it. `test_vouchers_postgres.py::TestTheClaimAlone` is the test that actually
    fails when this stops being a single guarded statement.

    Expiry sits in the predicate rather than being checked afterwards so an expired voucher is
    never claimed and then rolled back: a rollback would be correct, but it would leave a window
    in which a claim-then-fail looks like a redemption in the logs.

    Two concurrent callers serialise on the row lock. Under READ COMMITTED the second
    re-evaluates `redeemed_at IS NULL` against the row the first committed, matches nothing, and
    gets None.
    """
    claimed = await session.execute(
        update(CreditVoucher)
        .where(
            CreditVoucher.code_hash == code_hash,
            CreditVoucher.redeemed_at.is_(None),
            or_(CreditVoucher.expires_at.is_(None), CreditVoucher.expires_at > now),
        )
        .values(redeemed_at=now, redeemed_by=user_id)
        .returning(CreditVoucher.id, CreditVoucher.amount_micro)
    )
    return claimed.first()


async def redeem(session: AsyncSession, code: str, user_id: uuid.UUID) -> int:
    """Claim a voucher for `user_id` and credit their wallet. Returns the micro-credits granted.

    Raises `VoucherError` with a message meant for the learner.
    """
    now = datetime.now(timezone.utc)
    code_hash = hash_code(code)

    row = await claim(session, code_hash, user_id, now)

    if row is None:
        # COLD PATH ONLY. A second query, purely to say something useful, and it cannot affect
        # whether the voucher was claimed -- that was already decided above.
        await session.rollback()
        raise _explain(await _lookup(session, code_hash), now)

    voucher_id, amount_micro = row

    granted = await gpu_wallet_service.grant(
        session,
        user_id,
        amount_micro=amount_micro,
        # The second guard. Keyed on the voucher's id rather than on the code, so the key never
        # contains the secret -- `gpu_ledger.idempotency_key` is readable by anything that can read
        # the ledger, and a code sitting in it would be spendable.
        idempotency_key=f"voucher:{voucher_id}",
    )
    if not granted:
        # The claim succeeded but the grant did not, which means this exact voucher id was already
        # granted. That should be unreachable -- the claim is the thing that prevents it -- so it is
        # logged rather than swallowed. The credit is not given twice either way.
        logger.error(
            "voucher %s was claimed but its grant key already existed; no credit added",
            voucher_id,
        )
        raise VoucherError("This voucher has already been redeemed.")

    logger.info("voucher %s redeemed by %s for %s micro", voucher_id, user_id, amount_micro)
    return amount_micro


async def _lookup(session: AsyncSession, code_hash: str) -> CreditVoucher | None:
    return (
        await session.execute(
            select(CreditVoucher).where(CreditVoucher.code_hash == code_hash)
        )
    ).scalar_one_or_none()


def _explain(voucher: CreditVoucher | None, now: datetime) -> VoucherError:
    """Turn a failed claim into the most useful true thing we can say.

    See the module docstring: unknown and malformed share a message on purpose; already-redeemed
    does not, because it is usually a double click rather than an attack.
    """
    if voucher is None:
        return VoucherError("That code is not valid.")
    if voucher.is_redeemed:
        return VoucherError("This voucher has already been redeemed.")
    if voucher.is_expired(now):
        return VoucherError("This voucher has expired.")
    # Claimed by nothing, not redeemed, not expired: the predicate and this lookup disagree, which
    # means the row changed between them. Refusing is the safe answer and a retry will resolve it.
    return VoucherError("That code could not be redeemed. Please try again.")
