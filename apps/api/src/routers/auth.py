"""
Auth Router.

Six endpoints. The first three are called server-side by Next.js, never by the
browser:

  POST /v1/auth/login            find-or-create by email, for OAuth sign-in
  POST /v1/auth/register         create an account with a password
  POST /v1/auth/password-login   verify an email + password pair
  POST /v1/auth/forgot-password  mail a single-use reset link
  POST /v1/auth/reset-password   consume a reset token, set a new password
  POST /v1/auth/change-password  change it while signed in

The last three did not exist, and neither did the token table or any mail
delivery, so a password-authenticated user had NO recovery path whatsoever — while
`forgot-password/page.tsx` told them to change it from their profile, which had
only GET and PUT.

The last two are what made `/register` and the email/password form work at all.
Both forms had been shipped against endpoints that did not exist: the browser
POSTed to `/api/auth/register`, which is swallowed by NextAuth's `[...nextauth]`
catch-all and answers `400 "Bad request."`, and `signIn("credentials", …)` was
called with no Credentials provider registered. The failure surfaced as the
generic "We couldn't create your account" with nothing in any log.

WHY EMAIL LOOKUPS USE `lower(email)` AND NOT `email`
`ix_users_email_lower` is a UNIQUE functional index on `lower(email)`, so
`Ada@x.com` and `ada@x.com` cannot both exist. Querying by the raw column would
still miss an existing row whose stored casing differs from what was typed, and
the insert would then fail on the index instead of returning a clean 409.
"""

import logging
import uuid

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config, identity, ratelimit
from ..database import get_db
from ..models.auth_token import PURPOSE_PASSWORD_RESET
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


class LoginRequest(BaseModel):
    email: str
    name: str
    provider: str  # "google" | "microsoft-entra-id"
    avatar_url: str | None = None  # OAuth profile photo URL


class LoginResponse(BaseModel):
    id: str
    email: str
    name: str
    role: str
    is_active: bool


@router.post("/login", response_model=LoginResponse)
async def find_or_create_user(
    payload: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    """
    Look up user by email. If found, return them.
    If not found, create a new student account.
    """
    result = await db.execute(
        select(User).where(User.email == payload.email)
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            email=payload.email,
            name=payload.name,
            role="student",
            is_active=True,
            profile_photo_url=payload.avatar_url,
        )
        db.add(user)
        await db.flush()
        # Create a welcome notification for the new user
        await create_welcome_notification(db, user.id)
        logger.info(f"Created new user: {payload.email} via {payload.provider}")
    else:
        # Update OAuth avatar if user hasn't set a custom one
        if user.profile_photo_url is None and payload.avatar_url:
            user.profile_photo_url = payload.avatar_url
            await db.flush()
        logger.info(f"Existing user signed in: {payload.email} via {payload.provider}")

    return LoginResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        is_active=user.is_active,
    )


# ── Password auth ────────────────────────────────────────────────────────────


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=1, max_length=4096)
    terms_accepted: bool


class PasswordLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=4096)


@router.post(
    "/register",
    response_model=LoginResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register(
    payload: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    """
    Create an account with a password.

    THIS ENDPOINT DELIBERATELY LEAKS WHETHER AN EMAIL IS REGISTERED, and the
    sign-in endpoint below deliberately does not. That asymmetry is the accepted
    trade: a registration form must be able to say "that email is already in
    use", because the alternative — silently pretending to succeed — leaves the
    real owner unable to sign in and the new user with no idea why. Attackers can
    enumerate through any registration form, which is why the *login* path is the
    one hardened against it.
    """
    # Before any work, and before touching the database. Registration writes rows and each attempt
    # costs an argon2id hash, so an unthrottled endpoint is both a spam vector and a CPU one.
    # Keyed on IP alone: there is no prior identity here to key on.
    await ratelimit.check_ip(ratelimit.REGISTER, request)

    if not payload.terms_accepted:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "terms", "detail": "You need to accept the terms to continue."},
        )

    email = payload.email.strip().lower()
    name = payload.name.strip()

    # Policy is enforced HERE, not only in the browser. `lib/validation/auth.ts`
    # mirrors these rules for immediate feedback, but a client-side check is a
    # convenience, never a control — this endpoint is reachable with curl.
    try:
        validate_password(payload.password, email=email, name=name)
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
        password_hash=await hash_password(payload.password),
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

    return LoginResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        is_active=user.is_active,
    )


@router.post("/password-login", response_model=LoginResponse)
async def password_login(
    payload: PasswordLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    """
    Verify an email and password.

    EVERY FAILURE RETURNS THE SAME 401 WITH THE SAME BODY. Unknown address,
    wrong password, OAuth-only account, deactivated account — one response.
    Distinguishing them turns this endpoint into a membership oracle for any
    email list someone cares to submit.

    `verify_password` is called even when there is no user and even when the
    account has no password, because returning early on those paths would make
    them measurably faster than a wrong password and reopen the same oracle
    through timing. That is why it takes `str | None`: the dummy-hash verify is
    part of its contract, not a caller-side workaround.
    """
    email = payload.email.strip().lower()

    # Per-email AND per-IP, because either alone is bypassable: an attacker spraying one password
    # across thousands of accounts never trips a per-email limit, and a distributed attempt on one
    # account never trips a per-IP one.
    #
    # Before the lookup, so a throttled request costs no query and no argon2 verify. The 429 body
    # is identical for a real and a made-up address, so this does not undo the enumeration
    # resistance the 401 path above is careful about.
    await ratelimit.check_email_and_ip(ratelimit.LOGIN, request, email)

    result = await db.execute(select(User).where(func.lower(User.email) == email))
    user = result.scalar_one_or_none()

    ok = await verify_password(
        user.password_hash if user else None,
        payload.password,
    )

    if user is None or not ok or not user.is_active:
        logger.info("Failed password sign-in for %s", email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    user.last_login_at = func.now()
    await db.flush()

    return LoginResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        is_active=user.is_active,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Password recovery
#
# There was none. No reset, no change, no token table, and no mail — and
# `forgot-password/page.tsx` told users they could change their password from
# their profile, which had only GET and PUT. A password-authenticated user had no
# recovery path at all.
# ─────────────────────────────────────────────────────────────────────────────


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=1, max_length=4096)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=4096)
    new_password: str = Field(min_length=1, max_length=4096)


class MessageResponse(BaseModel):
    message: str


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Mail a single-use reset link, if the address belongs to a password account.

    THE RESPONSE IS IDENTICAL IN EVERY CASE. Unknown address, OAuth-only account,
    deactivated account, mail provider down — one message. Anything else turns
    this into a membership oracle for whatever email list someone submits, which
    is the same reason `password_login` returns one 401 for every failure.

    That is also why the send result is ignored: "we couldn't send it" only
    happens for addresses that exist. The cost is that a user whose mail genuinely
    failed is told to check their inbox, and the compensating control is the ERROR
    log in `email_service`.
    """
    await ratelimit.check_email_and_ip(ratelimit.LOGIN, request, payload.email)

    email = payload.email.strip().lower()
    user = (await db.execute(
        select(User).where(func.lower(User.email) == email)
    )).scalar_one_or_none()

    # OAuth-only accounts have no password to reset. Mailing them a reset link
    # would be actively confusing — the link would set a password on an account
    # that has never used one.
    if user is not None and user.is_active and user.password_hash is not None:
        token = await token_service.issue_password_reset(db, user)
        await db.flush()
        await email_service.send(email_service.password_reset_email(user.email, token))
        logger.info("Issued password reset for %s", email)
    else:
        logger.info("Password reset requested for %s — no eligible account", email)

    return MessageResponse(
        message="If that address has a password account, a reset link is on its way."
    )


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Consume a reset token and set a new password.

    The policy check runs against the SAME `validate_password` the register
    endpoint uses. A weaker rule here would make the reset flow the cheapest way
    to get a weak password onto an account.
    """
    await ratelimit.check_ip(ratelimit.LOGIN, request)

    try:
        user = await token_service.redeem(db, payload.token, PURPOSE_PASSWORD_RESET)
    except token_service.TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    try:
        validate_password(payload.password, email=user.email, name=user.name or "")
    except PasswordPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "password", "detail": str(exc)},
        ) from exc

    user.password_hash = await hash_password(payload.password)
    # Every other reset link in flight dies here. `redeem` already spent the one
    # used; this kills the rest, so a link an attacker obtained earlier does not
    # survive the action taken to lock them out.
    await token_service.revoke_password_resets(db, user.id)
    await db.flush()

    logger.info("Password reset completed for %s", user.email)
    return MessageResponse(message="Your password has been changed. You can sign in with it now.")


@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    user_id: uuid.UUID = Depends(identity.current_user_id),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Change the password of the signed-in account.

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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="That is not your current password.",
        )

    try:
        validate_password(payload.new_password, email=user.email, name=user.name or "")
    except PasswordPolicyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "new_password", "detail": str(exc)},
        ) from exc

    user.password_hash = await hash_password(payload.new_password)
    await token_service.revoke_password_resets(db, user.id)
    await db.flush()

    logger.info("Password changed for %s", user.email)
    return MessageResponse(message="Your password has been changed.")


class DesktopSessionResponse(BaseModel):
    """What a signed-in desktop client is handed. The token is shown once and stored by the client."""

    token: str
    expires_at: datetime
    user: LoginResponse


@router.post("/desktop/session", response_model=DesktopSessionResponse)
async def create_desktop_session(
    payload: PasswordLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DesktopSessionResponse:
    """Sign in from the desktop app and receive a session token.

    SEPARATE FROM `/password-login`, WHICH RETURNS A USER AND NOTHING ELSE. That endpoint serves
    the web app, where the session lives in a NextAuth cookie and the identity reaching this API is
    signed server-side. A native client has no server to sign for it, so it needs a credential of
    its own — and it needs one it can store, present on every request, and have revoked without
    changing a password.

    EVERY FAILURE RETURNS THE SAME 401, for the reason `/password-login` gives at length: anything
    that distinguishes "no such address" from "wrong password" is a membership oracle for whatever
    email list somebody cares to submit. The rate limit is per-email AND per-IP for the same reason
    it is there.
    """
    email = payload.email.strip().lower()
    await ratelimit.check_email_and_ip(ratelimit.LOGIN, request, email)

    result = await db.execute(select(User).where(func.lower(User.email) == email))
    user = result.scalar_one_or_none()

    # Called even when there is no user, so a made-up address is not measurably faster than a real
    # one with the wrong password. Same contract as `/password-login`.
    ok = await verify_password(user.password_hash if user else None, payload.password)
    if not ok or user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    token = await token_service.issue_desktop_session(db, user)
    await db.commit()

    return DesktopSessionResponse(
        token=token,
        expires_at=datetime.utcnow() + timedelta(days=config.DESKTOP_SESSION_TTL_DAYS),
        # `LoginResponse` rather than a new shape: the desktop needs exactly what the web
        # login returns, and a second user schema is a second thing to keep in step.
        user=LoginResponse(
            id=str(user.id),
            email=user.email,
            name=user.name,
            role=user.role,
            is_active=user.is_active,
        ),
    )


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
