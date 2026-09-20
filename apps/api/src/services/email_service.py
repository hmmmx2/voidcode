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


# THERE IS NO RESET-LINK MAIL ANY MORE, and its absence is the safer arrangement.
#
# It built `{APP_BASE_URL}/reset-password?token=…` — a page on the public internet that collects a
# new password. Two things went with the website: that page, and the endpoint that redeemed the
# token. What replaced it is `password_reset_code_email` below: a 6-digit code, typed into the
# application that asked for it. No link to mis-click, no password-shaped page to impersonate, and
# the host-header injection this function's docstring warned about cannot rewrite a code.


def password_reset_code_email(to: str, code: str) -> Email:
    """The six-digit reset code for the desktop app.

    NO LINK, deliberately. The code is typed into the app, so there is no page for a host-header
    injection to redirect and nothing for a mail scanner to "click" and spend.

    The code is NOT bound to the app instance that requested it: anyone holding the address and the
    code can redeem it. What bounds that is the code's short life, its per-code attempt limit, and
    the per-address cap on codes issued — which is why the copy says never to share it rather than
    claiming it is useless to anyone else.

    The subject carries no code: subject lines show up in lock-screen notifications and mail-client
    previews, which is not somewhere a credential should appear.
    """
    minutes = config.PASSWORD_RESET_CODE_TTL_MINUTES
    return Email(
        to=to,
        subject="Your VoidCode password reset code",
        body=(
            "Someone asked to reset the password for this address in the VoidCode app.\n\n"
            f"Your code is: {code}\n\n"
            f"Enter it in the app. It works once and expires in {minutes} minutes.\n\n"
            "Never share this code. VoidCode will never ask you for it.\n\n"
            "If it wasn't you, ignore this message: nothing has changed and your current password "
            "still works.\n"
        ),
    )


# `email_verification_email` STOOD HERE, and it was dead twice over.
#
# Nothing called it -- no route, no service, no task -- so no account has ever received it. And the
# link it built, `{APP_BASE_URL}/verify-email?token=...`, pointed at a page that DOES NOT EXIST:
# there is no `verify-email` route on the website (`voidcode-web`). Had anything ever sent it, the person
# would have followed a link to a 404 and been left with an address the application still called
# unverified.
#
# `email_verified_at` is still set, and truthfully: redeeming a password-reset code sets it, because
# receiving the code proves control of the mailbox. That is the only way an address becomes verified
# here, and it is a real one. What is gone is a second mechanism that never ran.


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
