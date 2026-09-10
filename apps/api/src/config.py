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

# How often each replica sweeps for stranded holds, and how old a hold must be before it is
# considered stranded. The age must be comfortably beyond any legitimate request, or the sweep races
# the settle it exists to back up and voids requests that were merely slow.
GPU_SWEEP_INTERVAL_SECONDS = int(os.getenv("GPU_SWEEP_INTERVAL_SECONDS", "300"))
GPU_SWEEP_MAX_AGE_SECONDS = int(os.getenv("GPU_SWEEP_MAX_AGE_SECONDS", "900"))

# ── Inference backend ────────────────────────────────────────────
#
# THESE LIVED IN `main.py` AS INLINE `os.getenv` CALLS AND WERE THEREFORE UNPOLICED.
#
# `tests/test_env_templates.py` derives the set of variables that must be documented by scanning
# THIS FILE with a regex over the getenv and flag call sites -- note that writing either call
# out literally in a comment would itself register as a variable, which is why this sentence
# describes it instead. Six variables that decide which backend
# serves every request, what address it lives at, and how many requests may hit it at once were
# invisible to that scan, absent from both `.env` templates, and discoverable only by reading
# `main.py`. Moving them here is the whole change: the guard already existed.
#
# It is also a prerequisite for making the backend address re-resolvable. Today the URL is baked
# into an `AsyncOpenAI` client built once in the lifespan, so a backend that moves is invisible
# until the process restarts.

# vLLM. Requires an AWQ-quantised model built offline (merge_lora.py then quantize_awq.py) and
# WSL2/Linux -- vLLM has no native Windows support. False falls back to HuggingFace
# `model.generate()` in-process.
USE_VLLM = _flag("USE_VLLM", default=False)

# SGLang, which delegates inference to a separate container over an OpenAI-compatible API.
# RadixAttention caches the system-prompt KV, which is worth roughly 3-4x per request after warmup,
# and it keeps GPU and torch dependencies out of this container entirely.
USE_SGLANG = _flag("USE_SGLANG", default=False)
SGLANG_BASE_URL = os.getenv("SGLANG_BASE_URL", "http://sglang-server:30000/v1")
SGLANG_MODEL_NAME = os.getenv("SGLANG_MODEL_NAME", "default")

# Client timeout for calls to SGLang. MUST exceed the longest generation any mode can ask for, or
# the request is cut off mid-answer and the learner sees an error on exactly the questions that
# needed the most explanation.
#
# The old value was 120s, which was never long enough for this config:
#   teaching  max_new_tokens=8192   debug/explain/general  4096
# Measured at 18.6 tok/s, so 8192 tokens is ~440s and 4096 is ~220s. 120s truncated every mode
# except followup (1024) and empathy (512). At a datacentre-class ~80 tok/s an 8192-token teaching
# answer still takes ~102s, and the thinking phase is spent before the visible answer begins.
#
# HOW THIS RELATES TO THE 300s IN `nginx.conf` AND `deploy/base/ingress.yaml`, BECAUSE THE THREE
# NUMBERS LOOK CONTRADICTORY AND ARE NOT:
#
#   * `proxy_read_timeout 300s` is a gap-BETWEEN-READS timeout, not a total. A streaming response
#     resets it on every token, so a stream that is producing output has no 300s ceiling. 900 here
#     is the backstop for a backend that has gone silent, which is the case nginx is also watching.
#   * A NON-streaming request is one long gap, so for that path 300s IS a hard total and the proxy
#     gives up first. Waiting 900s behind a proxy that left at 300 holds a serving slot for ten
#     minutes on behalf of nobody -- and, with metering on, bills it. That is a real defect and the
#     fix is not to shorten this: it is for the non-streaming path to refuse rather than wait, which
#     is what the queue work does.
#
# The comment in `nginx.conf` claiming "the backend's own timeout (180 s)" was simply stale. There
# has been no 180 anywhere for some time.
SGLANG_TIMEOUT_SECONDS = float(os.getenv("SGLANG_TIMEOUT_SECONDS", "900"))

# How many inference requests may be in flight IN THIS PROCESS.
#   SGLang 16 -- SGLang batches internally, so this bounds the FastAPI queue depth only.
#   vLLM    8 -- likewise.
#   HF      2 -- `model.generate()` runs in a thread and more than two risks GPU OOM on 16 GB.
#
# PER PROCESS, WHICH IS NOT THE SAME AS PER POD OR PER FLEET. `deploy/base/api-hpa.yaml` runs two to
# four replicas, so the fleet can push 32-64 concurrent requests at a backend sized for 16 while
# each replica believes it is within its limit. The semaphore cannot see the other replicas. Sizing
# a shared budget needs shared state, which is the queue work; this number stays as the per-process
# memory guard it has always been.
MAX_CONCURRENT_REQUESTS = int(
    os.getenv("MAX_CONCURRENT_REQUESTS", "0")
) or (16 if USE_SGLANG else (8 if USE_VLLM else 2))

# ── GPU serving queue ────────────────────────────────────────────
#
# OFF BY DEFAULT, like the two metering switches above and for the same reason: this changes the
# behaviour of the most expensive endpoint in the product, and the safe rollout is to deploy the
# code, watch the tables, and then flip a flag without a deploy.
#
# With it off, `/v1/chat/completions` behaves exactly as before -- a 503 the instant the in-process
# semaphore is contended. With it on, a request waits for a fleet-wide slot instead, which is what
# makes the concurrency limit mean something across replicas rather than per process.
GPU_QUEUE_ENABLED = _flag("GPU_QUEUE_ENABLED", default=False)

# How long a streaming request will wait for a slot before giving up.
#
# BOUNDED BY WHAT THE PROXIES WILL TOLERATE, not by patience. `apps/web/.../api/proxy` sets no
# timeout, so Node's default headers budget applies, and `nginx.conf` allows 300s between reads.
# Response headers are not sent until this wait finishes, so the wait plus prompt preparation must
# fit inside that -- 120s leaves a wide margin and is already longer than anyone will sit still for.
GPU_QUEUE_MAX_WAIT_SECONDS = float(os.getenv("GPU_QUEUE_MAX_WAIT_SECONDS", "120"))

# Refuse at the door past this depth rather than admitting to a queue that cannot be served inside
# the wait ceiling. Telling somebody they are 400th is a worse answer than asking them to retry,
# and they will wait for it.
GPU_QUEUE_MAX_DEPTH = int(os.getenv("GPU_QUEUE_MAX_DEPTH", "50"))

# ── GPU provider (pod lifecycle) ─────────────────────────────────
#
# A RunPod API key is ACCOUNT-WIDE. Every pod in the account is addressable by id, including ones
# that have nothing to do with this service, and RunPod offers no per-pod credential. Whatever
# protection exists has to exist in our own code, which is why `services/runpod_client.py` refuses
# to act unless it has been told exactly which pod, and offers no way to name a different one.
#
# Three values rather than one, deliberately. The key alone is not enough to do anything; the id
# alone is not enough either; and the switch means a deployment that happens to have both still
# does nothing until somebody decides.
RUNPOD_API_KEY = os.getenv("RUNPOD_API_KEY", "")

# The ONE pod this service may start or stop. Not a secret -- it is an identifier, and it appears in
# hostnames and logs -- so it must NOT go in the secret-shaped list in `test_env_templates.py`, or
# that test will demand it be empty in every template, which is the opposite of what is wanted.
RUNPOD_POD_ID = os.getenv("RUNPOD_POD_ID", "")

# Master switch, off by default, mirroring PAYMENTS_ENABLED. Off means every call raises
# PodControlDisabled before a URL is constructed.
POD_CONTROL_ENABLED = _flag("POD_CONTROL_ENABLED", default=False)

# ── Spin-down ────────────────────────────────────────────────────
#
# Off by default, and it needs POD_CONTROL_ENABLED as well -- two switches, because this one can
# take the backend away from a learner mid-session if the idle predicate is wrong, and that is the
# most user-visible failure in this subsystem.
SPINDOWN_ENABLED = _flag("SPINDOWN_ENABLED", default=False)

# How long nothing must have settled before the pod is considered idle. Generous on purpose: the
# other three clauses of the predicate are instantaneous, so this is the only one protecting a
# learner who is reading an answer before asking a follow-up. Twenty minutes of A40 is about RM0.77;
# a cold start is ~10 minutes of wall clock and a learner staring at a spinner.
SPINDOWN_IDLE_SECONDS = float(os.getenv("SPINDOWN_IDLE_SECONDS", "1200"))

# How often the idle watcher looks. No point being finer than the idle window.
SPINDOWN_CHECK_SECONDS = float(os.getenv("SPINDOWN_CHECK_SECONDS", "120"))

# ── Payments ─────────────────────────────────────────────────────
#
# Both secrets are read from the environment and never from the database or a request. They are the
# two values that, if leaked, let someone charge your account or forge a credit grant, so they are
# handled the way `INTERNAL_API_SECRET` is: env only, never logged, never returned by any endpoint.
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")

# Distinct from the secret key, and NOT interchangeable. This one verifies that a webhook body was
# written by Stripe; the secret key authenticates calls going the other way. Stripe issues it per
# endpoint, and it rotates independently.
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

# Master switch. Off means /v1/credits/checkout 503s rather than half-working, which is what a
# missing key would otherwise produce at the worst moment -- mid-purchase.
PAYMENTS_ENABLED = _flag("PAYMENTS_ENABLED", default=False)

# ── GPU credit metering ──────────────────────────────────────────
#
# Two switches, not one, and the split is the whole rollout plan.
#
# GPU_METERING_ENABLED turns on measurement: reservations are taken and settled against measured
# slot occupancy, so the `slot_ms` distribution becomes real data. GPU_BILLING_ENFORCE turns on
# refusal: without credit, a 402 before the pod runs. Measuring first is what lets a price be chosen
# from observed occupancy rather than guessed, and choosing a price from a guess is the failure this
# whole subsystem exists to avoid.
#
# Both default OFF, so the request path behaves exactly as it did until someone turns them on
# deliberately. There is no wallet for anyone yet.
GPU_METERING_ENABLED = _flag("GPU_METERING_ENABLED", default=False)
GPU_BILLING_ENFORCE = _flag("GPU_BILLING_ENFORCE", default=False)

# The ceiling a request may occupy a slot for, which is what gets held up front. A ceiling rather
# than a forecast: the settle charges measured occupancy and returns the rest, and holding the
# maximum is what makes "refuse before the pod runs" possible.
GPU_MAX_SLOT_SECONDS = int(os.getenv("GPU_MAX_SLOT_SECONDS", "180"))

# Minimum charge per request, in micro-credits. A one-token reply still occupied a slot and still
# cost a share of the pod's hour; without a floor, a flood of trivial requests runs the pod at a
# loss. Applied at the hold as well as the settle, so a learner who cannot afford the floor is
# refused up front rather than mid-generation.
GPU_FLOOR_MICRO = int(os.getenv("GPU_FLOOR_MICRO", "1000"))

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
    # CHECKED IN EVERY ENVIRONMENT, NOT ONLY PRODUCTION.
    #
    # `INTERNAL_AUTH_ENFORCE=false` means an unsigned `X-User-Id` header is accepted on trust — the
    # two-phase rollout that let the header ship before the backend started requiring it. That is a
    # reasonable trade for read paths. It is not a reasonable trade for a path that spends money:
    # with billing enforced and identity unenforced, anyone can assert any user id and drain that
    # user's credit, and the ledger will record it as a perfectly ordinary charge.
    #
    # Not production-only, deliberately. A development instance that charges a spoofable identity is
    # how the combination gets discovered in production instead of here.
    if PAYMENTS_ENABLED and not (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET):
        missing = [
            name for name, value in (
                ("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY),
                ("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET),
            ) if not value
        ]
        raise ConfigError(
            f"PAYMENTS_ENABLED is on but {' and '.join(missing)} is empty. Checkout would fail "
            "after the learner has decided to buy, which is the worst place to discover it. "
            "Both are set in the environment, never in the database."
        )
    # Same shape as the Stripe guard above, and checked in every environment for the same reason:
    # discovering that pod control is half-configured at the moment it is needed means either a
    # backend that never wakes or -- worse -- code that reaches for a pod id it does not have.
    if POD_CONTROL_ENABLED and not (RUNPOD_API_KEY and RUNPOD_POD_ID):
        missing = [
            name for name, value in (
                ("RUNPOD_API_KEY", RUNPOD_API_KEY),
                ("RUNPOD_POD_ID", RUNPOD_POD_ID),
            ) if not value
        ]
        raise ConfigError(
            f"POD_CONTROL_ENABLED is on but {' and '.join(missing)} is empty. Pod control must "
            "know exactly which pod it may touch: a RunPod key is account-wide, and a service that "
            "is allowed to stop pods without being told which one is a service that can stop any "
            "of them."
        )

    if GPU_BILLING_ENFORCE and not INTERNAL_AUTH_ENFORCE:
        raise ConfigError(
            "GPU_BILLING_ENFORCE is on while INTERNAL_AUTH_ENFORCE is off. Credit would be spent "
            "against an identity any caller can assert simply by sending an X-User-Id header. "
            "Turn on INTERNAL_AUTH_ENFORCE first, confirm "
            "voidcode_unverified_identity_requests_total is flat at zero, then enable billing."
        )

    if not IS_PRODUCTION:
        if INTERNAL_AUTH_ENFORCE and not INTERNAL_API_SECRET:
            raise ConfigError(
                "INTERNAL_AUTH_ENFORCE is on but INTERNAL_API_SECRET is empty — "
                "every /v1/auth request would be rejected and nobody could sign in."
            )
        return

    problems: list[str] = []

    # Production may not run on trust. The flag exists for a staged rollout, and a rollout that is
    # never completed is just a permanently open door: `resolve_caller` counts every unsigned
    # request it lets through, and in production that count should be structurally impossible
    # rather than merely low.
    if not INTERNAL_AUTH_ENFORCE:
        problems.append(
            "INTERNAL_AUTH_ENFORCE is off. An unsigned X-User-Id header is accepted on trust, so "
            "any caller can act as any user. The web proxy already signs every request, so the "
            "only callers this turns away are ones bypassing it."
        )

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
