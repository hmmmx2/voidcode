"""Credit cannot be spent against an identity anyone can assert.

This is the one ordering mistake in a billing rollout that cannot be corrected afterwards. If
charging is switched on while `INTERNAL_AUTH_ENFORCE` is off, any caller can send an `X-User-Id`
header naming someone else and drain their credit, and every row the ledger writes about it is a
perfectly ordinary, correctly-formed charge. There is nothing in the data afterwards that
distinguishes the theft from real usage, so it cannot be reconciled away later — which is why this
is a config-time refusal rather than a runbook step.

The checks live in `config.assert_production_config`, called from the lifespan, so a misconfigured
process fails to start rather than serving a request it should not.
"""

import importlib

import pytest

from src import config


def _reload_with(monkeypatch, **env):
    """Re-import config under a given environment and return the fresh module.

    `test_identity.py` records why this is done by reload rather than by setting attributes: config
    reads env at import, and other modules hold references to the values, so patching an attribute
    leaves stale copies behind. Reloading is the honest way to test what a fresh process would see.
    """
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(config)


@pytest.fixture(autouse=True)
def _restore_config():
    """Put the module back for every other test in the session."""
    yield
    importlib.reload(config)


class TestChargingRequiresVerifiedIdentity:
    def test_billing_enforced_with_identity_unenforced_refuses_to_start(self, monkeypatch):
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="development",
            GPU_BILLING_ENFORCE="true",
            INTERNAL_AUTH_ENFORCE="false",
        )
        with pytest.raises(fresh.ConfigError) as exc:
            fresh.assert_production_config()
        message = str(exc.value)
        assert "INTERNAL_AUTH_ENFORCE" in message
        # The message has to say what the operator should do next, not merely that something is
        # wrong — this fires at boot, often during a deploy, at the least patient moment.
        assert "voidcode_unverified_identity_requests_total" in message

    def test_the_refusal_is_not_production_only(self, monkeypatch):
        """A development instance charging a spoofable identity is how the combination reaches
        production undiscovered."""
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="development",
            GPU_BILLING_ENFORCE="true",
            INTERNAL_AUTH_ENFORCE="false",
        )
        assert fresh.IS_PRODUCTION is False
        with pytest.raises(fresh.ConfigError):
            fresh.assert_production_config()

    def test_billing_enforced_with_identity_enforced_is_allowed(self, monkeypatch):
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="development",
            GPU_BILLING_ENFORCE="true",
            INTERNAL_AUTH_ENFORCE="true",
            INTERNAL_API_SECRET="a-secret-for-the-test",
        )
        fresh.assert_production_config()  # must not raise

    def test_metering_without_enforcement_is_still_allowed(self, monkeypatch):
        """Shadow mode is the whole point of having two switches.

        Measuring occupancy against an unverified identity is harmless — nothing is spent — and it
        is how the price gets chosen from observed data instead of guessed. Only *charging* needs
        the identity to be real.
        """
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="development",
            GPU_METERING_ENABLED="true",
            GPU_BILLING_ENFORCE="false",
            INTERNAL_AUTH_ENFORCE="false",
        )
        fresh.assert_production_config()  # must not raise


class TestProductionMayNotRunOnTrust:
    def test_production_refuses_to_start_with_identity_unenforced(self, monkeypatch):
        """The flag exists for a staged rollout. A rollout never completed is an open door."""
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="production",
            INTERNAL_AUTH_ENFORCE="false",
            INTERNAL_API_SECRET="a-secret",
            ALLOWED_ORIGINS="https://voidcode.example",
            APP_BASE_URL="https://voidcode.example",
            EMAIL_PROVIDER="resend",
            RESEND_API_KEY="k",
            RATELIMIT_PEPPER="not-the-default",
        )
        with pytest.raises(fresh.ConfigError) as exc:
            fresh.assert_production_config()
        assert "INTERNAL_AUTH_ENFORCE is off" in str(exc.value)

    def test_a_fully_configured_production_starts(self, monkeypatch):
        """The guard must refuse the bad case without making the good case unreachable."""
        fresh = _reload_with(
            monkeypatch,
            APP_ENV="production",
            INTERNAL_AUTH_ENFORCE="true",
            INTERNAL_API_SECRET="a-secret",
            ALLOWED_ORIGINS="https://voidcode.example",
            APP_BASE_URL="https://voidcode.example",
            EMAIL_PROVIDER="resend",
            RESEND_API_KEY="k",
            RATELIMIT_PEPPER="not-the-default",
            # Required since desktop password reset by code: see `test_desktop_auth_config.py`.
            AUTH_CODE_SECRET="x" * 48,
        )
        fresh.assert_production_config()  # must not raise
