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

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import config, identity, ratelimit
from ..database import get_db
from ..models.auth_token import PURPOSE_PASSWORD_RESET, PURPOSE_PASSWORD_RESET_CODE
from ..models.user import User
from ..models.user_identity import UserIdentity
from ..services import account_linking, email_service, oidc, token_service
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
    user = await _create_password_account(
        db,
        request,
        name=payload.name,
        email=payload.email,
        password=payload.password,
        terms_accepted=payload.terms_accepted,
        terms_version=None,
    )
    return LoginResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        is_active=user.is_active,
    )


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
        terms_accepted_at=datetime.now(timezone.utc),
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
    user.password_changed_at = datetime.now(timezone.utc)
    # Every other reset link in flight dies here. `redeem` already spent the one
    # used; this kills the rest, so a link an attacker obtained earlier does not
    # survive the action taken to lock them out.
    await token_service.revoke_password_resets(db, user.id)
    await token_service.revoke_all(db, user.id, PURPOSE_PASSWORD_RESET_CODE)
    # And every signed-in device. A reset is what someone does after losing a laptop; leaving that
    # laptop signed in for the rest of its 90 days defeats the reason they reset.
    await token_service.revoke_desktop_sessions(db, user.id)
    await db.flush()

    logger.info("Password reset completed for %s", user.email)
    return MessageResponse(message="Your password has been changed. You can sign in with it now.")


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
    user.password_changed_at = datetime.now(timezone.utc)
    await token_service.revoke_password_resets(db, user.id)
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
    user: LoginResponse
    #: True when this sign-in created the account (registration, or a first Google/Microsoft sign-in).
    created: bool = False
    #: True when linking a provider removed a password that was set on this address without the
    #: address ever being proven — see `services/account_linking.py`. The app explains it.
    password_cleared: bool = False


async def _session_response(
    db: AsyncSession, user: User, *, created: bool = False, password_cleared: bool = False
) -> DesktopSessionResponse:
    """Issue a desktop session for `user`, COMMIT, and describe it.

    One place, because every desktop sign-in path — password, registration, reset code, Google,
    Microsoft — must hand back the same shape and commit before answering. A path that returned a
    token and relied on `get_db` to commit afterwards would give the client a credential for a row a
    failed commit then threw away.
    """
    user.last_login_at = datetime.now(timezone.utc)
    token = await token_service.issue_desktop_session(db, user)
    await db.commit()
    return DesktopSessionResponse(
        token=token,
        expires_at=datetime.utcnow() + timedelta(days=config.DESKTOP_SESSION_TTL_DAYS),
        user=LoginResponse(
            id=str(user.id),
            email=user.email,
            name=user.name,
            role=user.role,
            is_active=user.is_active,
        ),
        created=created,
        password_cleared=password_cleared,
    )


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

    now = datetime.now(timezone.utc)
    user.password_hash = await hash_password(payload.new_password)
    user.password_changed_at = now
    if user.email_verified_at is None:
        # Receiving the code proved the mailbox.
        user.email_verified_at = now
    await token_service.revoke_password_resets(db, user.id)
    await token_service.revoke_all(db, user.id, PURPOSE_PASSWORD_RESET_CODE)
    await token_service.revoke_desktop_sessions(db, user.id)

    logger.info("Password reset by code completed for %s", user.email)
    return await _session_response(db, user)


# ── Google and Microsoft ─────────────────────────────────────────────────────


class OAuthSignInRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=255)
    code: str = Field(min_length=1, max_length=4096)
    # RFC 7636: 43-128 characters from the unreserved set.
    code_verifier: str = Field(pattern=r"^[A-Za-z0-9\-._~]{43,128}$")
    # Only a loopback listener, the only redirect a desktop client can receive. Anything else is a
    # code intercepted from some other flow being relayed here.
    redirect_uri: str = Field(
        pattern=r"^http://(127\.0\.0\.1|localhost):\d{2,5}/oauth/callback$"
    )
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    terms_version: str | None = Field(default=None, pattern=_TERMS_VERSION)


class LinkedResponse(BaseModel):
    linked: bool
    provider: str


# No 401 for a provider token that fails verification. 401 means "the session you sent is not
# valid", and the desktop app signs the device out on it — so in connect mode, where the request
# carries a perfectly good session, a rejected Google token would have ended it. The caller's own
# credential is judged separately, above, and that one does answer 401.
_OIDC_STATUS = {
    "provider_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
    "expired": status.HTTP_400_BAD_REQUEST,
    "rejected": status.HTTP_400_BAD_REQUEST,
    "upstream": status.HTTP_502_BAD_GATEWAY,
    "invalid_token": status.HTTP_400_BAD_REQUEST,
}
_LINK_STATUS = {
    "unverified_email": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "terms_required": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "conflict": status.HTTP_409_CONFLICT,
    "inactive": status.HTTP_401_UNAUTHORIZED,
}


@router.post("/desktop/oauth/{provider}", response_model=DesktopSessionResponse | LinkedResponse)
async def desktop_oauth(
    provider: str,
    payload: OAuthSignInRequest,
    request: Request,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Sign in (or, with a Bearer session, connect) with Google or Microsoft.

    See `services/oidc.py` for what is verified and `services/account_linking.py` for which account a
    verified identity belongs to. This handler only maps their refusals to HTTP.

    Errors carry `{code, message}`: `code` is stable for the app to branch on, `message` is written to
    be shown as-is.
    """
    if provider not in oidc.PROVIDERS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown sign-in provider.")

    # Before any outbound call to the provider: this endpoint makes one per request.
    await ratelimit.check_ip(ratelimit.OAUTH, request)

    # Link mode is decided by the credential, not by a flag in the body — a body flag could ask to
    # link without proving who is asking.
    link_user: User | None = None
    if identity._bearer_from(authorization) is not None:
        caller = await identity.resolve_caller(request, None, None, authorization)
        link_user = await db.get(User, caller.user_id)
        if link_user is None or not link_user.is_active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in.")

    try:
        verified = await oidc.sign_in(
            provider,
            client_id=payload.client_id,
            code=payload.code,
            code_verifier=payload.code_verifier,
            redirect_uri=payload.redirect_uri,
            nonce=payload.nonce,
        )
    except oidc.OidcError as exc:
        raise HTTPException(
            status_code=_OIDC_STATUS.get(exc.code, status.HTTP_400_BAD_REQUEST),
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    if link_user is not None:
        try:
            await account_linking.link(db, link_user, verified)
        except account_linking.AccountLinkError as exc:
            raise HTTPException(
                status_code=_LINK_STATUS[exc.code], detail={"code": exc.code, "message": exc.message}
            ) from exc
        await db.commit()
        return LinkedResponse(linked=True, provider=provider)

    async def registration_limit() -> None:
        await ratelimit.check_ip(ratelimit.REGISTER, request)

    for attempt in (1, 2):
        try:
            outcome = await account_linking.sign_in(
                db, verified, terms_version=payload.terms_version, before_create=registration_limit
            )
            break
        except account_linking.AccountLinkError as exc:
            raise HTTPException(
                status_code=_LINK_STATUS[exc.code], detail={"code": exc.code, "message": exc.message}
            ) from exc
        except IntegrityError:
            # Two first sign-ins for the same provider account raced to insert the same identity
            # row. The loser rolls back and resolves again, and the second pass finds the winner's
            # row under rule 1. A third collision is not a race.
            await db.rollback()
            if attempt == 2:
                raise

    return await _session_response(
        db, outcome.user, created=outcome.created, password_cleared=outcome.password_cleared
    )


# ── The account itself ───────────────────────────────────────────────────────


class AccountResponse(BaseModel):
    id: str
    email: str
    name: str
    has_password: bool
    email_verified: bool
    providers: list[str]
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
    providers = (await db.execute(
        select(UserIdentity.provider).where(UserIdentity.user_id == user.id).order_by(UserIdentity.provider)
    )).scalars().all()
    return AccountResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        has_password=user.password_hash is not None,
        email_verified=user.email_verified_at is not None,
        providers=list(providers),
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
