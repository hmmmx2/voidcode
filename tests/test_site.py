"""The public site: what it links to, what it loads, and what it may never say.

This is the one part of the product a visitor meets before they can run anything, and it is plain
files with no build step — so nothing else would catch a link to a page that does not exist, a font
pulled from a CDN, a legal page that has drifted from the one the app ships, or a download button
whose filename patterns no longer match what the release actually contains.

Each test states the failure it exists to prevent. Several of them cross the seam deliberately: the
site's colours are checked against the application's stylesheet, its download patterns against
`electron-builder.yml`, its Stripe return pages against `payments.py`, and its legal pages against
the components they are generated from. A copy that cannot drift is the point.
"""

from __future__ import annotations

import html
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

#: Every page the site serves. 404.html is included: it is a page a visitor sees.
PAGES = (
    "index.html",
    "terms/index.html",
    "privacy/index.html",
    "purchase/success/index.html",
    "purchase/cancelled/index.html",
    "404.html",
)


def read(relative: str) -> str:
    return (SITE / relative).read_text(encoding="utf-8")


def text_of(page: str) -> str:
    """Visible text: tags stripped, entities decoded, whitespace flattened."""
    body = re.sub(r"<!--.*?-->", " ", read(page), flags=re.DOTALL)
    body = re.sub(r"<(script|style)\b.*?</\1>", " ", body, flags=re.DOTALL | re.IGNORECASE)
    body = re.sub(r"<[^>]+>", " ", body)
    return re.sub(r"\s+", " ", html.unescape(body)).strip()


# ── It is all there ──────────────────────────────────────────────────────────


def test_every_file_the_site_needs_is_committed() -> None:
    expected = [
        *PAGES,
        "assets/site.css",
        "assets/download.js",
        "assets/fonts/inter-latin.woff2",
        "assets/fonts/jetbrains-mono-latin.woff2",
        "robots.txt",
        "_headers",
        "vercel.json",
        "README.md",
        "favicon.svg",
        "scripts/generate_legal.py",
    ]
    missing = [name for name in expected if not (SITE / name).exists()]
    assert missing == [], f"the site is missing {missing}"


def test_the_fonts_ship_with_their_licences() -> None:
    """Both faces are OFL. Shipping the files without the licence is the licence breach."""
    for face, licence in (
        ("inter-latin.woff2", "inter-LICENSE.txt"),
        ("jetbrains-mono-latin.woff2", "jetbrains-mono-LICENSE.txt"),
    ):
        assert (SITE / "assets/fonts" / face).stat().st_size > 10_000
        body = (SITE / "assets/fonts" / licence).read_text(encoding="utf-8")
        assert "SIL OPEN FONT LICENSE" in body, f"{licence} is not the OFL"
        assert body.lower().startswith("copyright"), f"{licence} carries no copyright line"


def test_vercel_and_headers_are_parseable() -> None:
    # A malformed vercel.json is accepted by git and rejected at deploy time, which is the worst
    # moment to find out.
    config = json.loads(read("vercel.json"))
    assert config["headers"], "no headers configured"
    assert "frame-ancestors 'none'" in read("_headers")


# ── Nothing loads from anywhere else ─────────────────────────────────────────


@pytest.mark.parametrize("page", PAGES)
def test_no_page_loads_a_third_party_resource(page: str) -> None:
    """A CDN font or an analytics script would make a local-first promise while phoning out.

    Only *subresources* are checked — `src`/`href` on script, link, img, iframe, and any `url()` in
    CSS. Ordinary `<a href>` links to OpenRouter, Stripe, GitHub and the OAIC are the point of
    several sentences in the legal documents and are fine.
    """
    body = read(page)
    offenders = [
        match.group(0)
        for match in re.finditer(
            r"<(?:script|link|img|iframe|source|audio|video)\b[^>]*\b(?:src|href)=\"(https?:)?//[^\"]+\"",
            body,
            re.IGNORECASE,
        )
        # A stylesheet link is matched by the same pattern; only absolute ones are offenders.
        if True
    ]
    assert offenders == [], f"{page} loads something external: {offenders}"


def test_the_stylesheet_loads_nothing_external() -> None:
    urls = re.findall(r"url\(\s*\"?([^\")]+)", read("assets/site.css"))
    external = [url for url in urls if url.startswith(("http:", "https:", "//"))]
    assert external == [], f"site.css reaches out to {external}"


@pytest.mark.parametrize("page", PAGES)
def test_every_page_carries_a_content_security_policy(page: str) -> None:
    body = read(page)
    policy = re.search(
        r'http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"', body, re.IGNORECASE
    )
    assert policy is not None, f"{page} has no CSP meta tag"
    directives = policy.group(1)
    assert "default-src 'none'" in directives, f"{page} does not deny by default"
    assert "base-uri 'none'" in directives
    assert "form-action 'none'" in directives


@pytest.mark.parametrize("page", ("purchase/success/index.html", "purchase/cancelled/index.html"))
def test_the_payment_return_pages_run_nothing(page: str) -> None:
    """Stripe sends a browser here with the checkout session id in the URL.

    No script and no connection means nothing on the page can read that id or forward it, and the
    noindex keeps the URL out of a search index.
    """
    body = read(page)
    assert "<script" not in body.lower(), f"{page} runs a script"
    policy = re.search(r'content="(default-src[^"]+)"', body)
    assert policy is not None
    assert "script-src" not in policy.group(1), f"{page} allows scripts at all"
    assert "connect-src" not in policy.group(1), f"{page} allows outbound requests"
    assert 'name="robots" content="noindex' in body
    assert "noindex" in read("_headers") and "/purchase/" in read("robots.txt")


def test_the_success_page_does_not_claim_the_credits_arrived() -> None:
    """It is a redirect target: it knows the buyer came back, not that the webhook landed.

    Saying "credits added" here would be a lie on every failed or pending payment, and the first
    thing the buyer does is go and look at a balance that has not moved.
    """
    body = text_of("purchase/success/index.html").lower()
    assert "payment received" in body
    for claim in ("credits added", "credits have been added", "your credits are ready"):
        assert claim not in body, f"the success page claims {claim!r}"
    assert "as soon as the payment confirms" in body


# ── Every link goes somewhere ────────────────────────────────────────────────


@pytest.mark.parametrize("page", PAGES)
def test_every_internal_link_resolves(page: str) -> None:
    """`/download/` was on this page for one draft, and the directory never existed.

    A dead link on a download page is the difference between a new user installing the app and
    giving up, and nothing else in the repository would notice.
    """
    body = re.sub(r"<!--.*?-->", " ", read(page), flags=re.DOTALL)
    here = (SITE / page).parent
    broken: list[str] = []

    for match in re.finditer(r'(?:href|src)="([^"#][^"]*)"', body):
        target = match.group(1)
        if target.startswith(("http:", "https:", "mailto:", "data:")):
            continue
        path = target.split("#", 1)[0].split("?", 1)[0]
        if path == "":
            continue
        base = SITE if path.startswith("/") else here
        resolved = (base / path.lstrip("/")).resolve()
        if resolved.is_dir():
            resolved = resolved / "index.html"
        if not resolved.exists():
            broken.append(target)

    assert broken == [], f"{page} links to {broken}"


@pytest.mark.parametrize("page", PAGES)
def test_every_in_page_anchor_exists(page: str) -> None:
    body = read(page)
    ids = set(re.findall(r'\bid="([^"]+)"', body))
    anchors = {m.group(1) for m in re.finditer(r'href="#([^"]+)"', body)}
    assert anchors <= ids, f"{page} links to anchors that do not exist: {sorted(anchors - ids)}"


# ── It is the same product as the application ────────────────────────────────


def test_the_colours_are_the_applications_colours() -> None:
    """The site is a copy of the app's tokens, so the copy is checked rather than trusted.

    Someone arriving from a download page should not meet a different-looking product; the failure
    mode without this is a site that slowly stops matching and nobody notices which is wrong.
    """
    app_css = (ROOT / "desktop/renderer/src/app/globals.css").read_text(encoding="utf-8")
    grays = dict(re.findall(r"--gray-(\d+):\s*(#[0-9a-f]{6})", app_css))
    aliases = dict(re.findall(r"--color-(void-\d|ink(?:-\d)?|line(?:-strong)?):\s*var\(--gray-(\d+)\)", app_css))
    assert len(grays) > 10 and len(aliases) >= 8, "globals.css no longer declares tokens this way"

    site_css = read("assets/site.css")
    for token, gray in aliases.items():
        expected = grays[gray]
        found = re.search(rf"--{token}:\s*(#[0-9a-f]{{6}})", site_css)
        assert found is not None, f"site.css has no --{token}"
        assert found.group(1) == expected, (
            f"--{token} is {found.group(1)} on the site and {expected} in the app"
        )


def test_the_download_patterns_match_what_the_builder_produces() -> None:
    """`download.js` finds installers by filename. The filenames are decided elsewhere.

    Rename the artifacts in `electron-builder.yml` and this page silently finds nothing — the
    release is published, the button says "see all downloads", and it looks like a GitHub outage.
    """
    builder = (ROOT / "desktop/electron-builder.yml").read_text(encoding="utf-8")
    pattern = re.search(r"^artifactName:\s*(.+)$", builder, re.MULTILINE)
    assert pattern is not None, "electron-builder.yml declares no artifactName"
    assert pattern.group(1).strip() == "${productName}-${version}-${os}-${arch}.${ext}", (
        "the artifact naming changed — update assets/download.js and this test together"
    )

    script = read("assets/download.js")
    for expected in (r"-mac-arm64\.dmg$", r"-mac-x64\.dmg$", r"-win-x64\.exe$", r"-win-arm64\.exe$"):
        assert expected in script, f"download.js no longer looks for {expected}"

    # The name the patterns are matched against, as electron-builder will write it.
    version = re.search(r'"version":\s*"([^"]+)"', (ROOT / "desktop/package.json").read_text(encoding="utf-8"))
    assert version is not None
    name = f"VoidCode-{version.group(1)}-mac-arm64.dmg"
    assert re.search(r"-mac-arm64\.dmg$", name), "the pattern does not match a real artifact name"


def test_stripe_is_sent_to_pages_that_exist() -> None:
    """The return URLs are built in the API from APP_BASE_URL; the paths live here.

    A trailing-slash mismatch or a renamed directory turns a completed payment into a 404, which
    reads to the buyer as a failed payment.
    """
    payments = (ROOT / "apps/api/src/services/payments.py").read_text(encoding="utf-8")
    for key in ("success_url", "cancel_url"):
        found = re.search(rf'"{key}": f"\{{config\.APP_BASE_URL\}}(/[^"]*)"', payments)
        assert found is not None, f"{key} is no longer built from APP_BASE_URL"
        path = found.group(1)
        assert (SITE / path.strip("/") / "index.html").exists(), f"{key} points at {path}, which is not on the site"

    config = (ROOT / "apps/api/src/config.py").read_text(encoding="utf-8")
    assert 'not APP_BASE_URL.startswith("https://")' in config, (
        "production no longer requires an https APP_BASE_URL, and Stripe redirects to it"
    )


def test_the_releases_repository_is_a_declared_setting() -> None:
    """Empty is correct today (there is no remote) — absent is not.

    `download.js` reads this tag to know whose releases to offer. If the tag is deleted, the page
    silently loses its download list; if it is filled in with a guess, every visitor's browser is
    sent to a stranger's repository.
    """
    assert re.search(r'<meta name="voidcode:repo" content="[^"]*"', read("index.html")) is not None
    script = read("assets/download.js")
    assert 'value !== "OWNER/REPO"' in script, "download.js would accept the placeholder as a repo"
    assert "README" in read("index.html") or "README" in script, "nothing points at the setup note"


# ── What must never be published here ────────────────────────────────────────


def test_no_exercise_content_is_published() -> None:
    """`data/catalogue.json` holds expected answers. It is the answer key, and it stays private."""
    for path in SITE.rglob("*"):
        if path.is_dir():
            continue
        name = path.name.lower()
        assert "catalogue" not in name, f"{path.relative_to(SITE)} looks like catalogue content"
        if path.suffix.lower() in {".woff2", ".png", ".jpg", ".ico"}:
            continue
        body = path.read_text(encoding="utf-8", errors="ignore")
        for marker in ('"oracle"', '"reference"', "expected_output"):
            assert marker not in body, f"{path.relative_to(SITE)} contains {marker}"


def test_the_legal_pages_are_the_applications_own() -> None:
    """Regenerate in memory and compare. A site that says less than the app is a different promise.

    This is the whole reason the pages are generated: the previous website carried its own copy of
    the Terms, and the two had already disagreed about what happens to a conversation.
    """
    result = subprocess.run(
        [sys.executable, str(SITE / "scripts/generate_legal.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert result.returncode == 0, (
        "the site's legal pages differ from the application's "
        "(run `python site/scripts/generate_legal.py`):\n" + result.stdout + result.stderr
    )


def test_the_legal_pages_carry_the_claims_that_matter() -> None:
    """Generation guarantees the pages match the components; this guards the components' substance.

    Each of these sentences is load-bearing somewhere else: the first is pinned to code by
    `desktop/tests/honest-copy.test.ts`, and the rest are the facts a person deciding whether to
    download would want on the page rather than only inside the app.
    """
    privacy = text_of("privacy/index.html")
    terms = text_of("terms/index.html")

    assert "An account is optional" in privacy
    assert "runs entirely on your machine" in privacy
    assert "An account is optional" in terms

    for claim in ("Argon2id", "Stripe", "Resend", "credential store", "Apache"):
        assert claim in privacy or claim in terms, f"neither document mentions {claim}"

    for date_bearing in (privacy, terms):
        assert "Last updated" in date_bearing


def test_no_retired_claim_reappears_on_the_site() -> None:
    """The banned phrases are read out of the app's own test, so there is one list, not two.

    `honest-copy.test.ts` keeps the application's copy honest; the same sentences must not come
    back through the website, which is exactly how the previous pair of documents diverged.
    """
    guard = (ROOT / "desktop/tests/honest-copy.test.ts").read_text(encoding="utf-8")
    block = re.search(r"for \(const claim of \[(.*?)\n    \]\) \{", guard, re.DOTALL)
    assert block is not None, "honest-copy.test.ts no longer declares the banned phrases in a list"
    # Comments inside the list quote the phrase that REPLACED a retired one ("an account is
    # optional"), so reading them as banned would forbid the sentence both documents must carry.
    entries = re.sub(r"//[^\n]*", "", block.group(1))
    banned = re.findall(r'"([^"]+)"', entries)
    assert len(banned) > 20, f"only found {len(banned)} banned phrases — the parse is wrong"

    for page in ("privacy/index.html", "terms/index.html", "index.html"):
        body = text_of(page)
        for claim in banned:
            assert claim not in body, f"{page} says {claim!r}, which the app's copy retired"


def test_the_landing_page_claims_only_what_the_app_does() -> None:
    """The site is the one place tempted to describe a product that does not exist yet.

    The research library is not in the desktop app (it is a later phase), and Google and Microsoft
    sign-in are not either. Advertising them here would be the oldest defect in this repository,
    committed on the most public page.
    """
    landing = text_of("index.html").lower()
    for unshipped in ("research paper", "research library", "sign in with google", "sign in with microsoft"):
        assert unshipped not in landing, f"the landing page advertises {unshipped!r}, which does not ship"

    # And it must say the two things that are true and load-bearing.
    assert "runs on your own machine" in landing or "runs the whole thing on your machine" in landing
    assert "apache license 2.0" in landing
