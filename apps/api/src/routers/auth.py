"""
Auth Router. Every endpoint here serves the desktop application.

  POST   /v1/auth/desktop/register         create an account and sign this device in
  POST   /v1/auth/desktop/session          sign in with an email and password
  DELETE /v1/auth/desktop/session          sign this device out
  DELETE /v1/auth/desktop/sessions         sign every device out
  POST   /v1/auth/desktop/oauth/{provider} sign in (or connect) with Google or Microsoft
  POST   /v1/auth/password-reset/request   mail a 6-digit code
  POST   /v1/auth/password-reset/confirm   redeem the code and set a new password
  POST   /v1/auth/change-password          change it while signed in
  GET    /v1/auth/me                       who this session belongs to

FIVE BROWSER ENDPOINTS WERE REMOVED WITH THE WEBSITE, and each one is worth naming because
re-adding any of them would undo a property the rest of this file now has:

  * `POST /login` — find-or-create by email, UNAUTHENTICATED. It existed so the website's
    NextAuth server could turn a Google profile into a user row, and it trusted that caller
    completely: anyone who could reach it could mint or take over an account by naming an address.
    Google and Microsoft sign-in now happens at `/desktop/oauth/{provider}`, which verifies an ID
    token from the provider itself. `tests/test_web_auth_is_gone.py` fails if it comes back.
  * `POST /register` and `POST /password-login` — the web-shaped pair. They answered with a user
    row and no session, because the website minted its own cookie. `/desktop/register` and
    `/desktop/session` do the same work and return a session token that the device stores.
  * `POST /forgot-password` and `POST /reset-password` — reset by emailed LINK, which only works
    if a web page exists to receive the token. The desktop app uses `/password-reset/request` and
    `/password-reset/confirm`: a 6-digit code, redeemed inside the app that asked for it, which is
    also why there is no password-collecting page on the public internet any more.

WHY EMAIL LOOKUPS USE `lower(email)` AND NOT `email`
`ix_users_email_lower` is a UNIQUE functional index on `lower(email)`, so
`Ada@x.com` and `ada@x.com` cannot both exist. Querying by the raw column would
still miss an existing row whose stored casing differs from what was typed, and
the insert would then fail on the index instead of returning a clean 409.

WHY EMAIL LOOKUPS USE `lower(email)` AND NOT `email`
`ix_users_email_lower` is a UNIQUE functional index on `lower(email)`, so
`Ada@x.com` and `ada@x.com` cannot both exist. Querying by the raw column would
still miss an existing row whose stored casing differs from what was typed, and
the insert would then fail on the index instead of returning a clean 409.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config, identity, ratelimit
from ..database import get_db
from ..models.auth_token import PURPOSE_PASSWORD_RESET_CODE
from ..models.user import User
from ..services import email_service, token_service
from ..services.notification_service import create_welcome_notification
from ..services.password_service import (
    PasswordPolicyError,
    hash_password,
    validate_password,
    verify_password,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class UserSummary(BaseModel):
    """The account, as a signed-in device is told about it. Part of every session response."""

    id: str
    email: str
    name: str
    role: str
    is_active: bool


# ── Password auth ────────────────────────────────────────────────────────────


async def _create_password_account(
    db: AsyncSession,
    request: Request,
    *,
    name: str,
    email: str,
    password: str,
    terms_accepted: bool,
    terms_version: str | None,
) -> User:
    """Everything `/register` did, shared with `/desktop/register` so the two cannot drift.

    Rate limit, terms, policy, duplicate address, the unique-index race and the welcome notification
    are all the SAME rules on both paths; a second copy of them is how one path ends up weaker.
    """
    # Before any work, and before touching the database. Registration writes rows and each attempt
    # costs an argon2id hash, so an unthrottled endpoint is both a spam vector and a CPU one.
    # Keyed on IP alone: there is no prior identity here to key on.
    await ratelimit.check_ip(ratelimit.REGISTER, request)

    if not terms_accepted:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "terms", "detail": "You need to accept the terms to continue."},
        )

    email = email.strip().lower()
    name = name.strip()

    # Policy is enforced HERE, not only in the client. The desktop app mirrors these rules for
    # immediate feedback, but a client-side check is a convenience, never a control — this endpoint
    # is reachable with curl.
    try:
        validate_password(password, email=email, name=name)
    except PasswordPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "password", "detail": str(exc)},
        ) from exc

    existing = await db.execute(
        select(User).where(func.lower(User.email) == email)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"field": "email", "detail": "An account with that email already exists."},
        )

    user = User(
        email=email,
        name=name,
        role="student",
        is_active=True,
        password_hash=await hash_password(password),
        # Recorded, not only checked. `/register` used to require the box and discard it.
        terms_accepted_at=datetime.now(UTC),
        terms_version=terms_version,
    )
    db.add(user)

    try:
        await db.flush()
    except IntegrityError as exc:
        # Two simultaneous registrations for the same address both pass the
        # SELECT above and race to the INSERT; `ix_users_email_lower` catches
        # the loser. Without this the user sees a 500 for what is a 409.
        await db.rollback()
        logger.info("Register lost the unique-index race for %s", email)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"field": "email", "detail": "An account with that email already exists."},
        ) from exc

    await create_welcome_notification(db, user.id)
    logger.info("Registered new user %s via password", email)
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Password recovery
#
# There was none. No reset, no change, no token table, and no mail — and
# `forgot-password/page.tsx` told users they could change their password from
# their profile, which had only GET and PUT. A password-authenticated user had no
# recovery path at all.
# ─────────────────────────────────────────────────────────────────────────────


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=4096)
    new_password: str = Field(min_length=1, max_length=4096)


class MessageResponse(BaseModel):
    message: str


@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    user_id: uuid.UUID = Depends(identity.require_user),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Change the password of the signed-in account.

    Other signed-in devices are signed out; the one making the change stays signed in. A person
    changes a password because they suspect someone else has it, and every session that someone may
    have opened is the thing to end — but not the session of the person who just proved they know it.

    Requires the current password even though the caller is already
    authenticated. A session is not proof of presence — a borrowed laptop or a
    stolen cookie should not be enough to lock the real owner out of their own
    account, and re-entering the password is what turns "someone has this
    session" into "someone knows the secret".
    """
    await ratelimit.check_ip(ratelimit.LOGIN, request)

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in.")

    if user.password_hash is None:
        # OAuth-only. Setting a first password this way would need a different,
        # verified flow; refusing is honest rather than silently creating one.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account signs in with a provider and has no password to change.",
        )

    if not await verify_password(user.password_hash, payload.current_password):
        logger.info("Failed password change for %s — wrong current password", user.email)
        # 400, NOT 401. A 401 means "this session is not valid", and the desktop app acts on it by
        # signing the device out — so a mistyped current password used to end the session of the
        # person who was, by definition, signed in. The session is fine; the form field is wrong.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "field": "current_password",
                "code": "wrong_password",
                "detail": "That is not your current password.",
            },
        )

    try:
        validate_password(payload.new_password, email=user.email, name=user.name or "")
    except PasswordPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "new_password", "detail": str(exc)},
        ) from exc

    user.password_hash = await hash_password(payload.new_password)
    user.password_changed_at = datetime.now(UTC)
    await token_service.revoke_all(db, user.id, PURPOSE_PASSWORD_RESET_CODE)
    await token_service.revoke_desktop_sessions(
        db, user.id, except_hash=getattr(request.state, "session_token_hash", None)
    )
    await db.flush()

    logger.info("Password changed for %s", user.email)
    return MessageResponse(message="Your password has been changed. Other devices were signed out.")


class DesktopSessionResponse(BaseModel):
    """What a signed-in desktop client is handed. The token is shown once and stored by the client."""

    token: str
    expires_at: datetime
    user: UserSummary
    #: True when this sign-in created the account. Registration is now the only thing that does.
    created: bool = False


async def _session_response(
    db: AsyncSession, user: User, *, created: bool = False
) -> DesktopSessionResponse:
    """Issue a desktop session for `user`, COMMIT, and describe it.

    One place, because every desktop sign-in path — password, registration, reset code — must hand
    back the same shape and commit before answering. A path that returned a
    token and relied on `get_db` to commit afterwards would give the client a credential for a row a
    failed commit then threw away.
    """
    user.last_login_at = datetime.now(UTC)
    token = await token_service.issue_desktop_session(db, user)
    await db.commit()
    return DesktopSessionResponse(
        token=token,
        expires_at=datetime.utcnow() + timedelta(days=config.DESKTOP_SESSION_TTL_DAYS),
        user=UserSummary(
            id=str(user.id),
            email=user.email,
            name=user.name,
            role=user.role,
            is_active=user.is_active,
        ),
        created=created,
    )


class DesktopSessionRequest(BaseModel):
    """An email and a password, exchanged for a session token.

    This shape was `PasswordLoginRequest`, shared with the website's `/password-login`. That
    endpoint is gone, so the model is named after the one caller it has.
    """

    email: EmailStr
    password: str = Field(min_length=1, max_length=4096)


@router.post("/desktop/session", response_model=DesktopSessionResponse)
async def create_desktop_session(
    payload: DesktopSessionRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DesktopSessionResponse:
    """Sign in from the desktop app and receive a session token.

    THE ONLY WAY TO SIGN IN WITH A PASSWORD. It used to sit beside the website's `/password-login`,
    which returned a user row and nothing else because the session lived in a NextAuth cookie and
    the identity reaching this API was signed server-side. A native client has no server to sign
    for it, so it needs a credential of its own — one it can store, present on every request, and
    have revoked without changing a password. That is what this returns.

    EVERY FAILURE RETURNS THE SAME 401: anything that distinguishes "no such address" from "wrong
    password" is a membership oracle for whatever email list somebody cares to submit. The rate
    limit is per-email AND per-IP for the same reason it is there.
    """
    email = payload.email.strip().lower()
    await ratelimit.check_email_and_ip(ratelimit.LOGIN, request, email)

    result = await db.execute(select(User).where(func.lower(User.email) == email))
    user = result.scalar_one_or_none()

    # Called even when there is no user, so a made-up address is not measurably faster than a real
    # one with the wrong password: see the docstring above.
    ok = await verify_password(user.password_hash if user else None, payload.password)
    if not ok or user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    return await _session_response(db, user)


@router.delete("/desktop/session", response_model=MessageResponse)
async def end_desktop_session(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Sign out THIS device, leaving other signed-in machines alone.

    Returns the same message whether or not a live session was ended. A client signing out wants to
    forget its token either way, and reporting "there was nothing to revoke" tells an attacker
    holding a stale token that it is stale.
    """
    token = identity._bearer_from(authorization)
    if token is not None:
        await token_service.revoke_desktop_session(db, token)
        await db.commit()
    return MessageResponse(message="Signed out.")


# ─────────────────────────────────────────────────────────────────────────────
# Desktop accounts
#
# Sign-in is moving from the website into the desktop app. These are the endpoints that make that
# possible without a website in the path: registering straight into a session, resetting a password
# with a code typed into the app, Google and Microsoft sign-in, and the account itself.
# ─────────────────────────────────────────────────────────────────────────────

#: The terms version string the desktop app displays. Free-form but bounded: it is stored, not parsed.
_TERMS_VERSION = r"^[A-Za-z0-9._-]{1,32}$"


class DesktopRegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=1, max_length=4096)
    terms_accepted: bool
    terms_version: str = Field(pattern=_TERMS_VERSION)


@router.post(
    "/desktop/register",
    response_model=DesktopSessionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def desktop_register(
    payload: DesktopRegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DesktopSessionResponse:
    """Create a password account and sign this device in, in one call.

    One call rather than register-then-sign-in, because the second call can fail on its own — a rate
    limit, a dropped connection — and leave someone with an account the app still shows as signed
    out. The account and its first session commit together.
    """
    user = await _create_password_account(
        db,
        request,
        name=payload.name,
        email=payload.email,
        password=payload.password,
        terms_accepted=payload.terms_accepted,
        terms_version=payload.terms_version,
    )
    return await _session_response(db, user, created=True)


# ── Password reset by code ───────────────────────────────────────────────────


class ResetCodeRequest(BaseModel):
    email: EmailStr


class ResetCodeConfirm(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=1, max_length=4096)


_RESET_CODE_SENT = (
    "If that address has an account, we've emailed a 6-digit code. It expires in {minutes} minutes."
)
_RESET_CODE_INVALID = "That code isn't valid or has expired."


@router.post("/password-reset/request", response_model=MessageResponse)
async def request_password_reset_code(
    payload: ResetCodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Email a six-digit code, if the address has an active account.

    THE RESPONSE IS IDENTICAL IN EVERY CASE, for the reason `forgot_password` gives: anything else is
    a membership oracle.

    UNLIKE THE LINK FLOW, accounts with no password get a code too. The link flow skipped them to
    avoid "setting a password on an account that has never used one"; the result was that someone who
    signed up through Google on the website had no way to ever set one. Receiving the code proves
    control of the mailbox, which is exactly the proof setting a first password needs.
    """
    email = payload.email.strip().lower()
    await ratelimit.check_ip(ratelimit.LOGIN, request)
    # Per address, in its own bucket: this is what caps how many live codes an attacker can guess at,
    # and how many emails a stranger can make someone receive.
    await ratelimit.check(ratelimit.RESET_REQUEST, f"email:{email}")

    user = (await db.execute(
        select(User).where(func.lower(User.email) == email)
    )).scalar_one_or_none()

    if user is not None and user.is_active and user.id != identity.ANONYMOUS_USER_ID:
        code = await token_service.issue_reset_code(db, user)
        await db.commit()
        await email_service.send(email_service.password_reset_code_email(user.email, code))
        logger.info("Issued a password reset code for %s", email)
    else:
        logger.info("Password reset code requested for %s — no eligible account", email)

    return MessageResponse(
        message=_RESET_CODE_SENT.format(minutes=config.PASSWORD_RESET_CODE_TTL_MINUTES)
    )


@router.post("/password-reset/confirm", response_model=DesktopSessionResponse)
async def confirm_password_reset_code(
    payload: ResetCodeConfirm,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DesktopSessionResponse:
    """Check the code, set the new password, sign every other device out, and sign this one in.

    COMMITS BEFORE EVERY REFUSAL AFTER THE CODE IS CHECKED. `get_db` rolls back when a handler raises,
    and the wrong-guess count is written by the check itself — so a refusal raised without committing
    would undo the count, and the five-guess limit would become no limit at all. That is the one
    mistake in this endpoint that no unit test of `token_service` could catch, which is why the
    Postgres suite drives it through real HTTP requests.
    """
    email = payload.email.strip().lower()
    await ratelimit.check_email_and_ip(ratelimit.LOGIN, request, email)

    user = (await db.execute(
        select(User).where(func.lower(User.email) == email).with_for_update()
    )).scalar_one_or_none()

    if user is None or not user.is_active or user.id == identity.ANONYMOUS_USER_ID:
        # Equalise timing with the path that does real work, as `password_login` does.
        await verify_password(None, payload.new_password)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_RESET_CODE_INVALID)

    # Policy BEFORE the code check, so a rejected password does not spend one of the five guesses.
    try:
        validate_password(payload.new_password, email=user.email, name=user.name or "")
    except PasswordPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "new_password", "detail": str(exc)},
        ) from exc

    outcome = await token_service.check_reset_code(db, user, payload.code)
    if outcome != token_service.CODE_OK:
        await db.commit()  # keep the attempt that was just counted — see the docstring
        detail = (
            "Too many attempts. Request a new code."
            if outcome == token_service.CODE_LOCKED
            else _RESET_CODE_INVALID
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    now = datetime.now(UTC)
    user.password_hash = await hash_password(payload.new_password)
    user.password_changed_at = now
    if user.email_verified_at is None:
        # Receiving the code proved the mailbox.
        user.email_verified_at = now
    await token_service.revoke_all(db, user.id, PURPOSE_PASSWORD_RESET_CODE)
    await token_service.revoke_desktop_sessions(db, user.id)

    logger.info("Password reset by code completed for %s", user.email)
    return await _session_response(db, user)


# ── The account itself ───────────────────────────────────────────────────────


class AccountResponse(BaseModel):
    id: str
    email: str
    name: str
    has_password: bool
    email_verified: bool
    created_at: datetime | None


@router.get("/me", response_model=AccountResponse)
async def me(
    user_id: uuid.UUID = Depends(identity.require_user),
    db: AsyncSession = Depends(get_db),
) -> AccountResponse:
    """Who this session belongs to. Also how the desktop learns a stored session is still good.

    The desktop used to decide it was signed in by finding a token in its keychain, without ever
    asking. A session revoked elsewhere, or an account deactivated, looked signed in until the next
    hosted request failed. This is the cheap question that replaces the guess.
    """
    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in.")
    return AccountResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        has_password=user.password_hash is not None,
        email_verified=user.email_verified_at is not None,
        created_at=user.created_at,
    )


@router.delete("/desktop/sessions", response_model=MessageResponse)
async def end_every_desktop_session(
    user_id: uuid.UUID = Depends(identity.require_user),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Sign this account out of every device, this one included."""
    ended = await token_service.revoke_desktop_sessions(db, user_id)
    await db.commit()
    logger.info("Signed user %s out of %d devices", user_id, ended)
    return MessageResponse(message="Signed out of every device.")
