"""Production refuses to start with desktop sign-in misconfigured in the ways that fail silently.

Each case is a configuration that would boot, serve, and look healthy while quietly being wrong:
reset codes hashed with a key every clone of the repository knows, or Google sign-in enabled without
the secret its token endpoint requires — which would fail every single Google sign-in at the moment
someone tried one, not at deploy time.
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


def test_google_without_its_secret_is_refused(monkeypatch):
    fresh = _reload_with(monkeypatch, **{**VALID_PRODUCTION, "OAUTH_GOOGLE_CLIENT_IDS": "id.apps.googleusercontent.com"})
    assert "OAUTH_GOOGLE_CLIENT_SECRET" in _problems(fresh)


def test_google_with_its_secret_starts(monkeypatch):
    _reload_with(monkeypatch, **{
        **VALID_PRODUCTION,
        "OAUTH_GOOGLE_CLIENT_IDS": "id.apps.googleusercontent.com",
        "OAUTH_GOOGLE_CLIENT_SECRET": "s",
    }).assert_production_config()


def test_no_provider_at_all_starts_and_says_so(monkeypatch, caplog):
    """Email and password sign-in is a complete product; the absence of Google is a warning."""
    monkeypatch.delenv("OAUTH_GOOGLE_CLIENT_IDS", raising=False)
    monkeypatch.delenv("OAUTH_MICROSOFT_CLIENT_IDS", raising=False)
    fresh = _reload_with(monkeypatch, **VALID_PRODUCTION)
    with caplog.at_level("WARNING"):
        fresh.assert_production_config()
    assert "Google or Microsoft" in caplog.text


def test_client_id_lists_are_parsed(monkeypatch):
    fresh = _reload_with(monkeypatch, OAUTH_MICROSOFT_CLIENT_IDS=" a , b ,,", OAUTH_MICROSOFT_ALLOWED_TENANTS="T1, t2")
    assert fresh.OAUTH_MICROSOFT_CLIENT_IDS == ["a", "b"]
    assert fresh.OAUTH_MICROSOFT_ALLOWED_TENANTS == ["t1", "t2"], "tenant ids compare case-insensitively"
