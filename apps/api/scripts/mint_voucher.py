"""Mint credit vouchers. Prints the codes once; they are not recoverable afterwards.

WHY THIS IS A SCRIPT AND NOT AN ENDPOINT

Issuing credit needs an operator, and this codebase has no way to say what an operator is.
`users.role` exists and nothing in `src/` reads it for authorization, so an admin route would mean
inventing an authorization primitive as a side effect of a payments change -- which is how
authorization bugs ship. `gpu_wallet_service.grant()` has said so in its docstring since it was
written, and this keeps that promise: the only new HTTP surface vouchers add is redemption, which is
an ordinary user action needing no new primitive.

Running this needs shell access to a host with the database credentials, which is a coarse
authorization check but an honest one -- and it is the same bar as running a migration.

THE CODE IS PRINTED ONCE AND STORED ONLY AS A HASH

There is no "show me that voucher again". A code readable back out of the database is a code that
anyone with read access can spend, which defeats the point of hashing it. Capture the output.

USAGE

    python -m scripts.mint_voucher --credits 500 --kind beta --count 10 \
        --note "cohort-1 beta invites" --expires-days 90

Run it from `apps/api` with the API's environment loaded, the same as any other script here.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta

from src.database import AsyncSessionLocal
from src.models.credit_voucher import KIND_BETA, KIND_PROMO, KIND_REFUND
from src.models.gpu_billing import MICRO_PER_CREDIT
from src.services import voucher_service

KINDS = (KIND_BETA, KIND_REFUND, KIND_PROMO)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--credits", type=int, required=True,
        help="Whole credits each voucher grants. 1 credit = 1_000_000 micro.",
    )
    parser.add_argument("--kind", choices=KINDS, required=True)
    parser.add_argument("--count", type=int, default=1, help="How many to mint.")
    parser.add_argument(
        "--note", default=None,
        help="Free text for whoever reads this later: a ticket number, a campaign. Never shown to "
             "a learner.",
    )
    parser.add_argument(
        "--expires-days", type=int, default=None,
        help="Omit for a voucher that never expires. A refund in kind should not evaporate.",
    )
    return parser.parse_args(argv)


async def _mint(args: argparse.Namespace) -> list[str]:
    expires_at = (
        datetime.now(UTC) + timedelta(days=args.expires_days)
        if args.expires_days
        else None
    )
    codes: list[str] = []
    async with AsyncSessionLocal() as session:
        for _ in range(args.count):
            _, code = await voucher_service.issue(
                session,
                amount_micro=args.credits * MICRO_PER_CREDIT,
                kind=args.kind,
                expires_at=expires_at,
                note=args.note,
            )
            codes.append(code)
        # One commit for the batch: minting nine of ten and failing is worse than minting none,
        # because the operator cannot tell which nine went out.
        await session.commit()
    return codes


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.credits <= 0:
        print("--credits must be positive", file=sys.stderr)
        return 2
    if args.count <= 0:
        print("--count must be positive", file=sys.stderr)
        return 2

    codes = asyncio.run(_mint(args))

    print(f"# {len(codes)} x {args.credits} credits, kind={args.kind}", file=sys.stderr)
    if args.expires_days:
        print(f"# expires in {args.expires_days} days", file=sys.stderr)
    print("# These are shown once. They are stored hashed and cannot be read back.", file=sys.stderr)
    # Codes to stdout, everything else to stderr, so `> codes.txt` captures exactly the codes.
    for code in codes:
        print(code)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
