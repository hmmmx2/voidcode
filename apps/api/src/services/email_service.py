"""Transactional email.

`config.py` has defined `EMAIL_PROVIDER`, `RESEND_API_KEY` and `EMAIL_FROM` since the auth work
landed, `.env.example` documented all three, and no module ever read them. This is the reader.

WHY `console` IS THE DEFAULT AND NOT AN ERROR
------------------------------------------------
Local development should need no account and no API key, so the default provider logs the link at
INFO instead of sending it. That is a genuinely useful mode — you copy the link out of the terminal
and click it — and it is why `assert_production_config()` treats `EMAIL_PROVIDER=console` as a
refusal-to-start in production: the mode is correct locally and silently breaks every reset in a
deployment.

WHY SENDING FAILURES DO NOT REACH THE CALLER
-----------------------------------------------
`request_password_reset` must return the same response whether or not the address exists, or it
becomes a membership oracle for any email list someone cares to submit — the same reasoning that
gives `password_login` a single 401 for every failure. A send failure that propagated would break
that: "we couldn't send it" only happens for addresses that exist.

So `send` returns a bool and logs its own failures, and the caller ignores it. The cost is real and
worth naming: a user whose reset mail genuinely failed to send is told to check their inbox. The
compensating control is the ERROR log, and the alternative leaks account existence to anyone who
asks.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from .. import config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    #: Plain text only. An HTML password-reset mail is a phishing lesson nobody needs, and plain
    #: text renders identically everywhere without a template pipeline.
    body: str


def password_reset_email(to: str, token: str) -> Email:
    """The reset mail.

    The link is built from `config.APP_BASE_URL` and never from the request's `Host` header.
    `config.py:48-53` explains why: nginx forwards whatever the client sent, so a host-header
    injection would rewrite this link to an attacker's domain — and the user would be typing their
    new password into it. That is the single most dangerous line in this file.
    """
    link = f"{config.APP_BASE_URL}/reset-password?token={token}"
    minutes = config.RESET_TOKEN_TTL_MINUTES
    return Email(
        to=to,
        subject="Reset your VoidCode password",
        body=(
            "Someone asked to reset the password for this address.\n\n"
            f"{link}\n\n"
            f"The link works once and expires in {minutes} minutes.\n\n"
            "If it wasn't you, nothing has happened to your account and you can ignore this "
            "message. Your current password still works.\n"
        ),
    )


def email_verification_email(to: str, token: str) -> Email:
    link = f"{config.APP_BASE_URL}/verify-email?token={token}"
    return Email(
        to=to,
        subject="Confirm your VoidCode email address",
        body=(
            "Confirm this address to finish setting up your account.\n\n"
            f"{link}\n\n"
            f"The link works once and expires in {config.VERIFY_TOKEN_TTL_HOURS} hours.\n"
        ),
    )


async def send(email: Email) -> bool:
    """Deliver, or log why not. Never raises — see the module docstring on the oracle.

    Returns True when the provider accepted it. Callers on the auth path deliberately ignore the
    result; a caller that surfaces it to the user reintroduces the enumeration leak.
    """
    provider = config.EMAIL_PROVIDER

    if provider == "console":
        # The whole body, so the link is copyable out of the terminal. Safe because this mode is
        # refused in production by assert_production_config().
        logger.info(
            "EMAIL (console provider, not sent)\n  to: %s\n  subject: %s\n%s",
            email.to, email.subject, email.body,
        )
        return True

    if provider == "resend":
        return await _send_via_resend(email)

    logger.error(
        "EMAIL NOT SENT to %s: EMAIL_PROVIDER=%r is not a provider this build knows. "
        "Expected 'console' or 'resend'.", email.to, provider)
    return False


async def _send_via_resend(email: Email) -> bool:
    """Resend's REST API over httpx, rather than the `resend` SDK.

    The SDK is synchronous, and one blocking HTTP call inside an async handler stalls the event loop
    for every other request on the worker. httpx is already a dependency for Judge0.
    """
    if not config.RESEND_API_KEY:
        logger.error("EMAIL NOT SENT to %s: EMAIL_PROVIDER=resend but RESEND_API_KEY is empty.",
                     email.to)
        return False

    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {config.RESEND_API_KEY}"},
                json={
                    "from": config.EMAIL_FROM,
                    "to": [email.to],
                    "subject": email.subject,
                    "text": email.body,
                },
            )
        if response.status_code >= 400:
            # Body, not just the status: Resend's 422 for an unverified sending domain is the
            # commonest failure and the status alone does not say so.
            logger.error("EMAIL NOT SENT to %s: Resend returned %d — %s",
                         email.to, response.status_code, response.text[:300])
            return False
        return True
    except Exception as exc:  # a send failure must not become a 500 on the auth path
        logger.error("EMAIL NOT SENT to %s: %s", email.to, exc)
        return False
