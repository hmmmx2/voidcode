"""Mint a desktop session token for DEVELOPMENT. Refuses to run in production.

WHY THIS EXISTS

The desktop app's hosted model used to be exercised in development by setting `VOIDCODE_USER_ID`,
which sent a bare, unsigned `X-User-Id` header and only worked against an API with identity
enforcement switched off. That tested a path no signed-in learner takes, and it kept the hosted
provider probing the API even with no session — which is the behaviour a local-first app must not
have once a production URL is built in.

The replacement is a real session: this prints one, the desktop reads it from
`VOIDCODE_DEV_SESSION_TOKEN` (only in an unpackaged build, only when nothing is stored), and dev
traffic takes exactly the credential path production does.

WHY IT REFUSES IN PRODUCTION

It creates the account if it does not exist and signs it in without a password. That is precisely an
account-takeover primitive, so it checks `APP_ENV` before it opens a database connection, and there
is no flag to override that.

USAGE

    cd apps/api
    python -m scripts.mint_desktop_session --email you@example.com
    # then, for the desktop app or scripts/queue-e2e.mjs:
    VOIDCODE_DEV_SESSION_TOKEN=<printed token>

The token is printed once and stored only as a hash, like every other token here.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import func, select

from src import config
from src.database import AsyncSessionLocal
from src.models.user import User
from src.services import token_service


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", required=True, help="The account to sign in as. Created if absent.")
    parser.add_argument("--name", default="Dev learner", help="Used only when creating the account.")
    return parser.parse_args(argv)


async def _mint(email: str, name: str) -> tuple[str, bool]:
    async with AsyncSessionLocal() as session:
        user = (
            await session.execute(select(User).where(func.lower(User.email) == email))
        ).scalar_one_or_none()
        created = user is None
        if user is None:
            user = User(id=uuid.uuid4(), email=email, name=name, role="student", is_active=True)
            session.add(user)
            await session.flush()
        elif not user.is_active:
            raise SystemExit(f"{email} is deactivated; a session for it would not resolve.")
        token = await token_service.issue_desktop_session(session, user)
        await session.commit()
    return token, created


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Before any connection. Not overridable: see the module docstring.
    if config.IS_PRODUCTION:
        print("Refusing: APP_ENV=production. This signs in without a password.", file=sys.stderr)
        return 2

    email = args.email.strip().lower()
    if "@" not in email:
        print("--email must be an email address", file=sys.stderr)
        return 2

    token, created = asyncio.run(_mint(email, args.name))
    print(f"# {'created' if created else 'existing'} account {email}", file=sys.stderr)
    print("# Shown once; stored only as a hash. Use as VOIDCODE_DEV_SESSION_TOKEN.", file=sys.stderr)
    # Token alone on stdout so `$(python -m scripts.mint_desktop_session ...)` captures exactly it.
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
