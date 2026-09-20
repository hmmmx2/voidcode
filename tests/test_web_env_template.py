"""The website's env template documents exactly what the website reads — no more, no less.

WHY THIS FILE EXISTS

`apps/api/tests/test_env_templates.py` derives the API's required variables from `config.py` and
fails if a template omits one. Its own docstring says why: "a template that documents a subset is
worse than no template: it implies the missing variables do not exist."

The website's template was checked only for being tracked by git and for not containing a real
secret. Nothing compared its contents to what the site reads — and it drifted all the way to
documenting TEN variables, of which the site read ONE. `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`,
`INTERNAL_API_SECRET`, `AUTH_SECRET`, `AUTH_TRUST_HOST` and five OAuth provider credentials all
belonged to a server-side auth proxy and a NextAuth session that were removed when sign-in moved
into the desktop application. `src/auth.ts` does not exist.

THE OVER-DOCUMENTING DIRECTION IS THE ONE THAT BITES HERE. A template that asks for a secret implies
something uses it, so the next person generates one and sets it in a deployment, believing the site
holds a credential. It holds none. That is a worse state than a missing variable, which at least
fails loudly the first time something reads it.

WHAT HAPPENS AT THE SPLIT. This travels to the website's own repository, where it is the same check
against the same two files — it needs nothing from this tree. Written here while the website is
still in the monorepo so the rule is in force before the move rather than after it.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps/web"
TEMPLATE = WEB / ".env.example"

#: Set by the platform, never by a person, so a template documenting them would be misleading in the
#: other direction. `NODE_ENV` is Next's own; the `VERCEL_*` family is Vercel's.
PLATFORM_SUPPLIED = {"NODE_ENV"}


def read_by_the_site() -> set[str]:
    """Every environment variable `apps/web/src` reads. Derived, so a new one cannot be forgotten."""
    names: set[str] = set()
    for path in (WEB / "src").rglob("*.ts*"):
        names |= set(re.findall(r"process\.env\.([A-Z_0-9]+)", path.read_text(encoding="utf-8")))
    return {n for n in names if not n.startswith("VERCEL_")} - PLATFORM_SUPPLIED


def documented() -> set[str]:
    """Variable names the template assigns, ignoring prose. Commented-out lines count as documented."""
    names: set[str] = set()
    for line in TEMPLATE.read_text(encoding="utf-8").splitlines():
        found = re.match(r"^#?\s*([A-Z_0-9]+)=", line.strip())
        if found is not None:
            names.add(found.group(1))
    return names


def test_the_deriving_actually_finds_something() -> None:
    """A positive control. Two empty sets agree perfectly and prove nothing."""
    read = read_by_the_site()
    assert read, "no process.env reads were found in apps/web/src — the pattern has stopped matching"
    assert documented(), "no variables were parsed out of the template"


def test_the_template_documents_everything_the_site_reads() -> None:
    missing = sorted(read_by_the_site() - documented())
    assert not missing, (
        f"apps/web/.env.example does not document: {missing}. "
        "A template that documents a subset implies the rest do not exist."
    )


def test_the_template_documents_nothing_the_site_does_not_read() -> None:
    """The direction that let ten dead variables accumulate.

    If a variable genuinely needs documenting without being read by `src/` — something consumed by
    the build rather than the app — say so where it is set, and add it here with the reason.
    """
    extra = sorted(documented() - read_by_the_site())
    assert not extra, (
        f"apps/web/.env.example documents variables nothing in apps/web/src reads: {extra}. "
        "A template that asks for a secret implies something uses it."
    )


def test_no_auth_variable_has_come_back() -> None:
    """Named explicitly, because these are the ones whose absence is load-bearing.

    The website has no session, signs nothing, and holds no credential. A template offering an
    `AUTH_SECRET` or a provider client id describes a system that was deliberately removed — and
    the provider pair is one this project no longer offers anywhere, in the application either.
    """
    text = TEMPLATE.read_text(encoding="utf-8")
    for gone in (
        "AUTH_SECRET=",
        "AUTH_TRUST_HOST=",
        "INTERNAL_API_SECRET=",
        "AUTH_GOOGLE_ID=",
        "AUTH_MICROSOFT_ENTRA_ID_ID=",
    ):
        assert gone not in text, f"apps/web/.env.example offers {gone} again"
