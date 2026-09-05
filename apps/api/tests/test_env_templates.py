"""The env templates must stay a complete inventory of what `config.py` reads.

Three separate failures had accumulated here, none of them visible from the code:

  * NEITHER `.env.example` was tracked by git. `.gitignore`'s `.env*` swallowed both, so
    `apps/api/.env.example` existed only on one machine and `apps/web/.env.example` did not exist
    at all — a fresh clone had to reverse-engineer every variable from `config.py` and `auth.ts`.
  * `.env.docker.example` documented `SECRET_KEY` and `NEXTAUTH_SECRET`, which **no code in this
    repo reads**, while omitting every auth and email variable that it does. An operator setting
    those two would reasonably believe the service was configured.
  * A template that documents a subset is worse than no template: it implies the missing variables
    do not exist.

So this derives the required set from `config.py` itself rather than from a hand-kept list.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "apps" / "api" / "src" / "config.py"
API_ENV = ROOT / "apps" / "api" / ".env.example"
DOCKER_ENV = ROOT / "apps" / "api" / ".env.docker.example"
WEB_ENV = ROOT / "apps" / "web" / ".env.example"


def config_variables() -> set[str]:
    """Every env var `config.py` reads. Derived, so a new one cannot be forgotten."""
    source = CONFIG.read_text(encoding="utf-8")
    return set(re.findall(r'os\.getenv\("([A-Z_0-9]+)"', source)) | set(
        re.findall(r'_flag\("([A-Z_0-9]+)"', source))


@pytest.mark.parametrize("template", [API_ENV, DOCKER_ENV], ids=["env.example", "env.docker.example"])
def test_every_config_variable_is_documented(template: Path) -> None:
    documented = {
        line.split("=", 1)[0].lstrip("# ").strip()
        for line in template.read_text(encoding="utf-8").splitlines()
        if "=" in line
    }
    missing = sorted(config_variables() - documented)
    assert not missing, f"{template.name} does not document: {missing}"


def test_no_template_documents_a_variable_nothing_reads() -> None:
    """SECRET_KEY and NEXTAUTH_SECRET were the originals — cargo-culted from another stack."""
    dead = {"SECRET_KEY", "NEXTAUTH_SECRET"}
    for template in (API_ENV, DOCKER_ENV):
        text = template.read_text(encoding="utf-8")
        for name in dead:
            # Allowed in a comment explaining the removal, not as a settable line.
            settable = [line for line in text.splitlines()
                        if line.strip().startswith(name + "=")]
            assert not settable, f"{template.name} still sets {name}, which no code reads"


def test_the_templates_are_tracked_by_git() -> None:
    """`.gitignore`'s `.env*` silently swallowed all three. Untracked templates are why the web one
    never existed: every attempt to add it vanished without an error."""
    import subprocess

    tracked = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, timeout=60,
    ).stdout.splitlines()
    for template in (API_ENV, DOCKER_ENV, WEB_ENV):
        relative = template.relative_to(ROOT).as_posix()
        assert relative in tracked, f"{relative} is not tracked — check the .gitignore negation"


def test_no_template_carries_a_real_secret() -> None:
    """A template that ships a working value is a template someone deploys unchanged — and one that
    ends up in git history, which is not something you can take back."""
    patterns = [
        (r"re_[A-Za-z0-9_]{16,}", "a Resend API key"),
        (r"sk-[A-Za-z0-9]{16,}", "an OpenAI-style key"),
        (r"ghp_[A-Za-z0-9]{16,}", "a GitHub token"),
        (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
    ]
    for template in (API_ENV, DOCKER_ENV, WEB_ENV):
        text = template.read_text(encoding="utf-8")
        for pattern, what in patterns:
            assert not re.search(pattern, text), f"{template.name} contains {what}"


def test_secret_shaped_variables_are_empty_in_every_template() -> None:
    secretish = ("INTERNAL_API_SECRET", "RESEND_API_KEY", "RATELIMIT_PEPPER", "AUTH_SECRET",
                 "JUDGE0_AUTH_TOKEN", "JUDGE0_ADMIN_TOKEN", "AUTH_GOOGLE_SECRET")
    for template in (API_ENV, DOCKER_ENV, WEB_ENV):
        for line in template.read_text(encoding="utf-8").splitlines():
            if "=" not in line or line.strip().startswith("#"):
                continue
            name, _, value = line.partition("=")
            if name.strip() in secretish:
                assert value.strip() in ("", "<replace-me>"), (
                    f"{template.name} ships a value for {name.strip()}")
