"""
Environment configuration, read once at import.

WHY THIS EXISTS NOW, WHEN EVERYTHING ELSE USES INLINE `os.getenv`

The rest of this codebase reads env vars inline at the point of use, and that
is fine for `JUDGE0_BASE_URL` — a wrong value produces an obvious connection
error. It stops being fine for auth. A missing `INTERNAL_API_SECRET` is not a
crash, it is an open endpoint; a missing `APP_BASE_URL` is not a crash, it is a
password-reset link pointing somewhere unintended. Those failures are silent and
they are security failures, so they get a module that can assert.

Deliberately NOT pydantic-settings: a new dependency for ~15 constants, on a
container that already fights image size because of torch. A plain module with a
`require()` helper does the same job.

WHY IMPORT-TIME AND NOT LAZY

So a misconfigured deployment fails at startup with a named variable, rather
than at 3 a.m. on the first password reset. `assert_production_config()` is
called from the lifespan for the checks that only matter in production.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def _load_env_file() -> None:
    """Read `apps/api/.env` into the environment before anything below is evaluated.

    NOTHING IN THIS APPLICATION LOADED .env, AND THAT MADE SEVERAL CONTROLS INERT.

    Every constant in this module comes from `os.getenv`, and `os.getenv` only sees variables that
    are actually in the environment. Running `uvicorn src.main:app` locally does not put a `.env`
    into it, so measured against a `.env` that set all of them:

        INTERNAL_API_SECRET     empty   -> every signature check returned False, so identity
                                           enforcement could not work even with the flag on
        INTERNAL_AUTH_ENFORCE   false   -> could not be turned on at all
        EMAIL_PROVIDER          console -> password-reset mail logged instead of sending, with a
                                           valid Resend key sitting unread in the file
        RATELIMIT_PEPPER        default -> rate-limit keys guessable from a known email

    The database masked it: `os.getenv("DATABASE_URL", <local default>)` happens to have a fallback
    that matches the local container, so the app connected and looked configured.

    `override=False` is deliberate and load-bearing. A container sets real environment variables via
    `env_file`/`environment`, and those must WIN over a `.env` that may also be present in the image
    or a mount. Precedence: real environment first, `.env` only for what it does not define.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - declared in requirements.txt
        logger.warning("python-dotenv is not installed; .env will be ignored.")
        return

    # apps/api/.env — two levels up from src/config.py.
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.is_file():
        load_dotenv(env_path, override=False)


_load_env_file()


class ConfigError(RuntimeError):
    """A configuration problem that must stop the process. Never caught."""


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ── Environment ──────────────────────────────────────────────────

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"

# The origin the FRONTEND is served from. Every emailed link is built from this.
#
# Never from the request `Host` header: `nginx.conf` does
# `proxy_set_header Host $host`, forwarding whatever the client sent, so a
# host-header injection would rewrite password-reset links to an attacker's
# domain — a classic, and trivially exploitable behind this proxy config.
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")


# ── Auth ─────────────────────────────────────────────────────────

# Shared secret for the server-to-server calls Next.js makes into /v1/auth.
# The browser never sees it — those endpoints are never called from client JS.
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET", "")

# Two-phase rollout switch. See the plan's §F.3: the header must ship in the web
# app BEFORE the backend starts rejecting requests without it, or every sign-in
# breaks in the window between two deploys. Phase 1 runs with this false and
# counts unheadered requests; phase 2 flips it with no code deploy.
INTERNAL_AUTH_ENFORCE = _flag("INTERNAL_AUTH_ENFORCE", default=False)

# Master switch for the whole password-auth surface. Off means the endpoints
# 404 and the UI hides the fields — OAuth is unaffected.
ENABLE_PASSWORD_AUTH = _flag("ENABLE_PASSWORD_AUTH", default=True)

# Salts the email before it becomes a Redis rate-limit key. Redis is an
# unencrypted cache whose dumps have no retention guarantee; it must not hold a
# plaintext list of every address anyone has tried to log in as.
RATELIMIT_PEPPER = os.getenv("RATELIMIT_PEPPER", "voidcode-dev-pepper")

# How many proxy hops we control, for resolving the real client IP out of
# X-Forwarded-For. 0 means "trust nothing, use the socket address".
TRUSTED_PROXY_HOPS = int(os.getenv("TRUSTED_PROXY_HOPS", "0"))

VERIFY_TOKEN_TTL_HOURS = int(os.getenv("VERIFY_TOKEN_TTL_HOURS", "24"))
RESET_TOKEN_TTL_MINUTES = int(os.getenv("RESET_TOKEN_TTL_MINUTES", "60"))


# ── Email ────────────────────────────────────────────────────────

# "console" logs the link at INFO instead of sending — the default, so local
# development needs no account and no API key.
EMAIL_PROVIDER = os.getenv("EMAIL_PROVIDER", "console").strip().lower()
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", "VoidCode AI <onboarding@resend.dev>")


# ── CORS ─────────────────────────────────────────────────────────

ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
]

_DEV_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]

# Matches any localhost port and any free-tunnel hostname.
#
# This is a DEVELOPMENT-ONLY convenience and it is genuinely dangerous in
# production: combined with `allow_credentials=True`, anyone can stand up a free
# cloudflared tunnel in thirty seconds and get a credentialed cross-origin
# allowance against this API. `cors_settings()` drops it entirely when
# APP_ENV=production.
_DEV_ORIGIN_REGEX = (
    r"(http://(localhost|127\.0\.0\.1):\d+"
    r"|https://.*\.(ngrok(-free)?\.(app|io|dev)|trycloudflare\.com|loca\.lt))"
)


def cors_settings() -> dict:
    """
    CORS kwargs for `CORSMiddleware`, differing by environment.

    Production gets an exact allowlist and no regex. Development keeps the
    tunnel regex, because free cloudflared hostnames rotate on every restart and
    pinning them is impossible.

    `allow_headers` is an explicit list rather than `*`. `X-Internal-Auth` and
    `X-Client-IP` are deliberately absent: no browser should ever send either,
    and listing them would advertise that trying is worthwhile.
    """
    common = {
        "allow_credentials": True,
        "allow_methods": ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-User-Id", "Accept"],
        # Carried over from the inline block this replaced, which called it "required for SSE
        # streaming through tunnels". Kept so the swap changes nothing observable — but note the
        # wildcard is already inert: the CORS spec forbids `*` when `allow_credentials` is true,
        # so browsers have never honoured it here. The notification stream reads the body via
        # fetch + ReadableStream and needs no exposed response header, so this is belt and braces.
        "expose_headers": ["*"],
    }

    if IS_PRODUCTION:
        return {"allow_origins": ALLOWED_ORIGINS, **common}

    logger.warning(
        "CORS is in DEVELOPMENT mode: any localhost port and any "
        "ngrok/cloudflare/loca.lt tunnel origin is allowed with credentials. "
        "Set APP_ENV=production before exposing this service."
    )
    return {
        "allow_origins": ALLOWED_ORIGINS or _DEV_ORIGINS,
        "allow_origin_regex": _DEV_ORIGIN_REGEX,
        **common,
    }


# ── Startup validation ───────────────────────────────────────────


def assert_production_config() -> None:
    """
    Refuse to start a production process that is misconfigured.

    Called from the lifespan. Raising is the point: the alternative to a loud
    crash here is a service that boots happily with an unauthenticated auth
    router or reset links pointing at localhost. Silently falling back to a
    development default in production is exactly how this drifts back.
    """
    if not IS_PRODUCTION:
        if INTERNAL_AUTH_ENFORCE and not INTERNAL_API_SECRET:
            raise ConfigError(
                "INTERNAL_AUTH_ENFORCE is on but INTERNAL_API_SECRET is empty — "
                "every /v1/auth request would be rejected and nobody could sign in."
            )
        return

    problems: list[str] = []

    if not ALLOWED_ORIGINS:
        problems.append(
            "ALLOWED_ORIGINS is empty. In production there is no localhost "
            "fallback, so CORS would reject the real frontend."
        )
    if not INTERNAL_API_SECRET:
        problems.append(
            "INTERNAL_API_SECRET is empty. Generate one with "
            "`python -c \"import secrets; print(secrets.token_urlsafe(32))\"`."
        )
    if APP_BASE_URL.startswith("http://localhost"):
        problems.append(
            f"APP_BASE_URL is still {APP_BASE_URL!r} — every verification and "
            "password-reset link would point at localhost."
        )
    if EMAIL_PROVIDER == "console":
        problems.append(
            "EMAIL_PROVIDER is 'console', which only logs. Verification and "
            "password-reset emails would never be delivered."
        )
    if EMAIL_PROVIDER == "resend" and not RESEND_API_KEY:
        problems.append("EMAIL_PROVIDER is 'resend' but RESEND_API_KEY is empty.")
    if RATELIMIT_PEPPER == "voidcode-dev-pepper":
        problems.append(
            "RATELIMIT_PEPPER is still the shipped default, so rate-limit keys "
            "are guessable from a known-plaintext email."
        )

    if problems:
        raise ConfigError(
            "Refusing to start with APP_ENV=production:\n  - " + "\n  - ".join(problems)
        )
