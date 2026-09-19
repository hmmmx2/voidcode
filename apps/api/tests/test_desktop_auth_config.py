"""Production refuses to start with desktop sign-in misconfigured in the ways that fail silently.

Each case is a configuration that would boot, serve, and look healthy while quietly being wrong —
above all reset codes hashed with a key every clone of the repository knows.

The second example used to be "Google sign-in enabled without the secret its token endpoint
requires". That whole family of checks is gone with provider sign-in, and what is asserted now is
that its settings cannot come back: see the two tests at the end of this file.
"""

import importlib

import pytest

from src import config

#: A production environment with every other check satisfied, so each test varies exactly one thing.
VALID_PRODUCTION = {
    "APP_ENV": "production",
    "ALLOWED_ORIGINS": "https://voidcode.example",
    "APP_BASE_URL": "https://voidcode.example",
    "EMAIL_PROVIDER": "resend",
    "RESEND_API_KEY": "k",
    "RATELIMIT_PEPPER": "not-the-default",
    "AUTH_CODE_SECRET": "x" * 48,
}


def _reload_with(monkeypatch, **env):
    """Reload config under an environment — see `test_billing_requires_real_identity.py` for why."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(config)


@pytest.fixture(autouse=True)
def _restore_config():
    yield
    importlib.reload(config)


def _problems(fresh) -> str:
    with pytest.raises(fresh.ConfigError) as exc:
        fresh.assert_production_config()
    return str(exc.value)


def test_the_baseline_is_actually_valid(monkeypatch):
    """Without this, every refusal below could be caused by something other than the one variable."""
    _reload_with(monkeypatch, **VALID_PRODUCTION).assert_production_config()


def test_the_shipped_reset_code_key_is_refused(monkeypatch):
    env = {**VALID_PRODUCTION}
    env.pop("AUTH_CODE_SECRET")
    monkeypatch.delenv("AUTH_CODE_SECRET", raising=False)
    assert "AUTH_CODE_SECRET" in _problems(_reload_with(monkeypatch, **env))


def test_a_short_reset_code_key_is_refused(monkeypatch):
    fresh = _reload_with(monkeypatch, **{**VALID_PRODUCTION, "AUTH_CODE_SECRET": "short"})
    assert "AUTH_CODE_SECRET" in _problems(fresh)


def test_the_provider_settings_are_gone_and_setting_them_does_nothing() -> None:
    """Four tests stood here, and their subject was deleted rather than their assertions relaxed.

    They covered `OAUTH_GOOGLE_CLIENT_IDS` without its secret being refused, the pair starting
    together, the "no provider configured" warning, and comma-list parsing with case-insensitive
    tenant ids. All four were about Google and Microsoft sign-in, which this build does not offer:
    `services/oidc.py` is deleted, the endpoint is unregistered, and `user_identities` is dropped.

    WHAT REPLACES THEM IS AN ABSENCE CHECK, because the failure mode of a removal like this is a
    setting left readable that no longer does anything. An operator who sets `OAUTH_GOOGLE_CLIENT_IDS`
    in production would, with the old code still in place, get a startup warning about a feature
    that cannot exist — or worse, no warning and a quiet belief that provider sign-in is configured.
    """
    for gone in (
        "OAUTH_GOOGLE_CLIENT_IDS",
        "OAUTH_GOOGLE_CLIENT_SECRET",
        "OAUTH_MICROSOFT_CLIENT_IDS",
        "OAUTH_MICROSOFT_ALLOWED_TENANTS",
    ):
        assert not hasattr(config, gone), f"config.{gone} is back"


def test_setting_a_provider_variable_does_not_change_startup(monkeypatch):
    """The behavioural half: production starts, says nothing about providers, and is unaffected."""
    fresh = _reload_with(
        monkeypatch,
        **{
            **VALID_PRODUCTION,
            "OAUTH_GOOGLE_CLIENT_IDS": "id.apps.googleusercontent.com",
            "OAUTH_MICROSOFT_CLIENT_IDS": "an-id",
        },
    )
    fresh.assert_production_config()
    assert not hasattr(fresh, "OAUTH_GOOGLE_CLIENT_IDS")
