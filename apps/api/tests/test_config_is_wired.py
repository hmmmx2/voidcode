"""`config.py` is correct and was never called. These tests are about the CALL, not the logic.

Every guardrail in `apps/api/src/config.py` was written, reviewed, and inert: nothing in the
application imported the module, so `assert_production_config()` never ran and `cors_settings()`
never chose the production branch. `main.py` hardcoded a CORS regex that grants a credentialed
cross-origin allowance to any `*.trycloudflare.com` host — the exact configuration `config.py`
itself describes as "genuinely dangerous in production".

A unit test of `assert_production_config()` would have passed the whole time. So these assert two
different things:

  * the function behaves correctly (cheap, and it did already), and
  * `main.py` actually calls it, and actually uses `cors_settings()`

The second is the one that was missing, and it is checked against `main.py`'s source rather than by
importing it — importing `main` pulls in torch and transformers, which is why `conftest.py` builds
the test app without it.
"""
from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest

MAIN = Path(__file__).resolve().parents[1] / "src" / "main.py"


def _config(monkeypatch, **env):
    """Reimport config with a fresh environment — it reads os.environ at import time.

    `.env` LOADING IS DISABLED HERE, and that is required rather than tidy. config.py now calls
    `load_dotenv()` at import, so a plain reload repopulates every variable this helper just deleted
    from the developer's real `apps/api/.env` — and the two "misconfigured production" tests started
    passing on a machine with a fully configured file and failing on one without. A test whose result
    depends on an untracked local file is not a test.
    """
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    for key in ("APP_ENV", "ALLOWED_ORIGINS", "INTERNAL_API_SECRET", "APP_BASE_URL",
                "EMAIL_PROVIDER", "RESEND_API_KEY", "RATELIMIT_PEPPER", "INTERNAL_AUTH_ENFORCE"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import src.config as config
    return importlib.reload(config)


# ── the call sites, which is what was actually broken ────────────────────────

def test_main_calls_assert_production_config() -> None:
    """The guardrail is worthless if nothing invokes it, and for months nothing did."""
    source = MAIN.read_text(encoding="utf-8")
    assert "config.assert_production_config()" in source


def test_main_reads_the_backend_settings_from_config() -> None:
    """Six variables that decide which backend serves every request were inline in `main.py`.

    `test_env_templates.py` derives what must be documented by scanning `config.py` only, so an
    inline `os.getenv` here is exempt from every template check by construction -- which is how
    `SGLANG_BASE_URL` came to be undocumented in both `.env` templates while deciding where every
    inference request goes.

    Asserted against the source rather than by import, per the module docstring: importing `main`
    pulls in torch.
    """
    source = MAIN.read_text(encoding="utf-8")
    for name in (
        "USE_VLLM", "USE_SGLANG", "SGLANG_BASE_URL", "SGLANG_MODEL_NAME",
        "SGLANG_TIMEOUT_SECONDS", "MAX_CONCURRENT_REQUESTS",
    ):
        assert f'os.getenv("{name}"' not in source, (
            f"`{name}` is read inline in main.py again. Put it in config.py, or it is invisible to "
            "test_env_templates.py and will go undocumented."
        )


def test_main_uses_cors_settings_and_hardcodes_no_tunnel_regex() -> None:
    """The specific regression: an inline CORS block with the dev tunnel regex and no env branch.

    Matching on the tunnel hostnames rather than on `allow_origin_regex` in general, because
    `cors_settings()` legitimately passes a regex in development — the fault was the literal in
    `main.py`, which applied in every environment including production.
    """
    source = MAIN.read_text(encoding="utf-8")
    assert "config.cors_settings()" in source

    code = "\n".join(line for line in source.splitlines()
                     if not line.lstrip().startswith("#"))
    for tunnel in ("trycloudflare", "ngrok", "loca.lt"):
        assert tunnel not in code, (
            f"{tunnel!r} is hardcoded in main.py again. Tunnel origins belong in "
            "config.cors_settings(), which drops them when APP_ENV=production.")


def test_developer_account_is_not_seeded_in_production() -> None:
    """It was seeded unconditionally — a real personal account created on every production boot."""
    source = MAIN.read_text(encoding="utf-8")
    seed_index = source.index("alwintay.edu@gmail.com")
    guard_index = source.index("if not config.IS_PRODUCTION:")
    assert guard_index < seed_index, "the developer seed is no longer behind the production guard"


# ── the behaviour, so a later edit cannot quietly relax it ───────────────────

def test_production_refuses_to_start_when_misconfigured(monkeypatch) -> None:
    config = _config(monkeypatch, APP_ENV="production")
    with pytest.raises(config.ConfigError) as exc:
        config.assert_production_config()
    message = str(exc.value)
    # Every problem at once, so one fix does not merely reveal the next on the next deploy.
    for expected in ("ALLOWED_ORIGINS", "INTERNAL_API_SECRET", "APP_BASE_URL",
                     "EMAIL_PROVIDER", "RATELIMIT_PEPPER"):
        assert expected in message


def test_a_correctly_configured_production_starts(monkeypatch) -> None:
    # `INTERNAL_AUTH_ENFORCE` joined this list when credit metering landed. It was always the
    # intended end state of the two-phase identity rollout -- ship the header, then require it --
    # and production had simply never been made to insist on it. Charging made the gap load-bearing:
    # without enforcement an unsigned `X-User-Id` is accepted on trust, so any caller can spend any
    # user's credit and the ledger records an ordinary charge. See
    # `test_billing_requires_real_identity.py`.
    config = _config(
        monkeypatch, APP_ENV="production", ALLOWED_ORIGINS="https://voidcode.example",
        INTERNAL_API_SECRET="x" * 32, APP_BASE_URL="https://voidcode.example",
        EMAIL_PROVIDER="resend", RESEND_API_KEY="re_test", RATELIMIT_PEPPER="not-the-default",
        INTERNAL_AUTH_ENFORCE="true",
        # Required since desktop password reset by code: see `test_desktop_auth_config.py`.
        AUTH_CODE_SECRET="x" * 48)
    config.assert_production_config()          # must not raise


def test_production_cors_drops_the_tunnel_regex(monkeypatch) -> None:
    """The whole point. In production there is an allowlist and no regex at all."""
    config = _config(monkeypatch, APP_ENV="production",
                     ALLOWED_ORIGINS="https://voidcode.example")
    settings = config.cors_settings()
    assert "allow_origin_regex" not in settings
    assert settings["allow_origins"] == ["https://voidcode.example"]


def test_development_cors_keeps_the_regex(monkeypatch) -> None:
    """Free tunnel hostnames rotate on every restart, so development cannot pin them."""
    settings = _config(monkeypatch, APP_ENV="development").cors_settings()
    assert re.search(r"trycloudflare", settings["allow_origin_regex"])


def test_cors_never_allows_arbitrary_headers_or_methods(monkeypatch) -> None:
    """`allow_methods=["*"]` + `allow_headers=["*"]` + credentials was the old inline block."""
    for env in ("development", "production"):
        settings = _config(monkeypatch, APP_ENV=env,
                           ALLOWED_ORIGINS="https://a.example").cors_settings()
        assert "*" not in settings["allow_methods"]
        assert "*" not in settings["allow_headers"]
        # Headers no browser should ever send must not be advertised as acceptable.
        assert "X-Internal-Auth" not in settings["allow_headers"]


def test_enforcing_internal_auth_without_a_secret_fails_even_in_development(monkeypatch) -> None:
    """Otherwise every sign-in breaks and the reason is a blank env var."""
    config = _config(monkeypatch, APP_ENV="development", INTERNAL_AUTH_ENFORCE="true")
    with pytest.raises(config.ConfigError, match="INTERNAL_API_SECRET"):
        config.assert_production_config()


# ── the deepest failure of all: the file was never read ──────────────────────

def test_config_loads_the_env_file() -> None:
    """`os.getenv` only sees the environment, and nothing put `.env` into it.

    This is the root cause that made three earlier controls inert. Measured against a `.env` that set
    all of them, the running app saw:

        INTERNAL_API_SECRET     empty    -> signature checks always returned False, so identity
                                            enforcement could not work even with the flag on
        INTERNAL_AUTH_ENFORCE   false    -> could not be enabled at all
        EMAIL_PROVIDER          console  -> reset mail logged instead of sent, with a valid Resend
                                            key unread in the file
        RATELIMIT_PEPPER        default  -> rate-limit keys guessable from a known email

    The database hid it: `os.getenv("DATABASE_URL", <local default>)` has a fallback matching the
    local container, so the app connected and looked configured.
    """
    source = (Path(__file__).resolve().parents[1] / "src" / "config.py").read_text(encoding="utf-8")
    assert "load_dotenv" in source, "config.py no longer loads .env — every value in it is ignored"
    assert "_load_env_file()" in source, ".env loading is defined but never called"


def test_the_env_file_never_overrides_a_real_environment_variable() -> None:
    """`override=False` is load-bearing, not a default someone left alone.

    A container passes real environment variables via `env_file`/`environment`, and those must win
    over a `.env` that may also be baked into the image or bind-mounted. Flipping this to True means a
    stale file silently overrides the deployment's own configuration — and the symptom would be a
    production service using development secrets.
    """
    source = (Path(__file__).resolve().parents[1] / "src" / "config.py").read_text(encoding="utf-8")
    assert "override=False" in source, (
        "config.py lets .env override real environment variables — a container's own settings "
        "would lose to a file in the image")
