"""The website's three pages: what they claim, and what they link to.

`apps/web` is five static pages now — overview, pricing, download, and the two legal documents (plus
Stripe's two return pages). Nothing on them is rendered from a database, so nothing else in this
repository would notice if a price stopped matching the one the API charges, a link pointed at a
route that no longer exists, or the page started advertising a feature that does not ship.

THE PRICING TEST IS THE ONE THAT MATTERS. A static page cannot ask the API what a pack costs, so the
numbers are a copy — and `apps/api/src/services/credit_packs.py` is append-only precisely because a
pack's credit amount is baked into completed purchases. A page that says RM20 buys 1,200 credits
while the webhook grants something else is a false price published to the public internet, and the
person who finds out is the one who paid.
"""

from __future__ import annotations

import html
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps/web/src"
PACKS_PY = ROOT / "apps/api/src/services/credit_packs.py"

#: Every page the site serves, by route, with the file that renders it.
PAGES = {
    "/": WEB / "app/(marketing)/page.tsx",
    "/pricing": WEB / "app/(marketing)/pricing/page.tsx",
    "/download": WEB / "app/(marketing)/download/page.tsx",
    "/terms": WEB / "app/(legal)/terms/page.tsx",
    "/privacy": WEB / "app/(legal)/privacy/page.tsx",
    "/purchase/success": WEB / "app/(legal)/purchase/success/page.tsx",
    "/purchase/cancelled": WEB / "app/(legal)/purchase/cancelled/page.tsx",
}

PRICING = WEB / "components/marketing/sections/PricingPlans.tsx"


def text_of(path: Path) -> str:
    """Rendered text: JSX tags stripped, entities decoded, whitespace flattened."""
    source = re.sub(r"/\*.*?\*/", " ", path.read_text(encoding="utf-8"), flags=re.DOTALL)
    source = re.sub(r"^\s*//.*$", " ", source, flags=re.MULTILINE)
    source = re.sub(r"<[^>]+>", " ", source)
    return re.sub(r"\s+", " ", html.unescape(source))


# ── The prices are the API's prices ──────────────────────────────────────────


def api_packs() -> dict[str, dict[str, object]]:
    """Every on-sale pack from the API, as `{code: {price, credits, label}}`.

    Parsed rather than imported: this suite does not import `src` (that pulls in the API's whole
    dependency tree), and a regex over an append-only table of frozen dataclasses is stable.
    """
    source = PACKS_PY.read_text(encoding="utf-8")
    body = source.split("PACKS: tuple[CreditPack, ...] = (", 1)[1]
    packs: dict[str, dict[str, object]] = {}
    for block in re.findall(r"CreditPack\((.*?)\n    \),", body, flags=re.DOTALL):
        code = re.search(r'code="([^"]+)"', block)
        price = re.search(r"price_minor=(\d+)", block)
        credits = re.search(r"credits_micro=(\d+) \* MICRO_PER_CREDIT", block)
        label = re.search(r'label="([^"]+)"', block)
        currency = re.search(r'currency="([^"]+)"', block)
        retired = "on_sale=False" in block
        assert code and price and credits and label and currency, block[:120]
        if retired:
            continue
        packs[code.group(1)] = {
            "price_minor": int(price.group(1)),
            "credits": int(credits.group(1)),
            "label": label.group(1),
            "currency": currency.group(1),
        }
    assert packs, "no packs parsed from credit_packs.py"
    return packs


def page_packs() -> dict[str, dict[str, object]]:
    """The packs as the pricing page prints them."""
    source = PRICING.read_text(encoding="utf-8")
    body = source.split("const PACKS: Pack[] = [", 1)[1].split("\n];", 1)[0]
    packs: dict[str, dict[str, object]] = {}
    for block in re.findall(r"\{(.*?)\},", body, flags=re.DOTALL):
        code = re.search(r'code:\s*"([^"]+)"', block)
        label = re.search(r'label:\s*"([^"]+)"', block)
        price = re.search(r'price:\s*"([^"]+)"', block)
        credits = re.search(r"credits:\s*(\d+)", block)
        assert code and label and price and credits, block[:120]
        packs[code.group(1)] = {
            "label": label.group(1),
            "price": price.group(1),
            "credits": int(credits.group(1)),
        }
    assert packs, "no packs parsed from PricingPlans.tsx"
    return packs


def test_the_pricing_page_offers_exactly_the_packs_on_sale() -> None:
    """Both directions. A pack the page omits is one nobody can find; a pack the page invents is
    one the checkout will refuse, after the buyer has decided to pay for it."""
    assert set(page_packs()) == set(api_packs())


@pytest.mark.parametrize("code", sorted(api_packs()))
def test_each_price_and_credit_amount_matches_the_api(code: str) -> None:
    api = api_packs()[code]
    page = page_packs()[code]

    assert api["currency"] == "myr", (
        f"{code} is priced in {api['currency']}; the page writes prices as RM and would be wrong"
    )
    # `price_display` in credit_packs.py: "RM" plus the minor unit divided by 100, two decimals.
    expected = f"RM{api['price_minor'] / 100:.2f}"
    assert page["price"] == expected, f"{code}: page says {page['price']}, API charges {expected}"
    assert page["credits"] == api["credits"], (
        f"{code}: page promises {page['credits']} credits, the webhook grants {api['credits']}"
    )
    assert page["label"] == api["label"], f"{code}: label drifted from the API's row"


def test_the_page_does_not_turn_an_unmeasured_rate_into_a_headline() -> None:
    """The failure this guards is in `gpu_pricing.py`'s own notes.

    Credits were denominated in US cents while packs were sold in ringgit, so a RM20 pack granted
    about RM56 of GPU — and every figure in the ledger stayed arithmetically correct. The live
    pricing row is still `measured=False`: a projection from a rented A40's hourly price divided by
    an API semaphore count. The application may divide a balance by it and call the result an
    estimate; a price list may not print it as a promise.
    """
    rendered = text_of(PRICING)
    assert "measured=False" in PACKS_PY.with_name("gpu_pricing.py").read_text(encoding="utf-8"), (
        "the serving rate is measured now — this page may quote hours, and this test should say so"
    )
    for invented in ("hours of tutoring", "hours of answers", "unlimited", "per month", "/month"):
        assert invented.lower() not in rendered.lower(), f"the pricing page claims {invented!r}"
    # And it must say the honest thing instead.
    assert "one sen of GPU cost" in rendered
    assert "Nobody is being charged" in rendered


def test_the_pricing_page_says_what_is_free() -> None:
    rendered = text_of(PRICING)
    assert "Apache" in rendered
    for included in ("grader", "local model", "no account"):
        assert included.lower() in rendered.lower(), f"the free column does not mention {included}"


# ── The three pages exist, and everything points at something ───────────────


@pytest.mark.parametrize("route", sorted(PAGES))
def test_every_page_has_a_file(route: str) -> None:
    assert PAGES[route].is_file(), f"{route} has no page.tsx"


def test_every_internal_link_resolves() -> None:
    """`/login` was linked from the footer for one commit after the page was deleted.

    Literal hrefs only: a template literal is not statically checkable, and pretending otherwise
    means either false failures or a check nobody trusts.
    """
    routes = set(PAGES)
    broken: list[str] = []
    for path in sorted(WEB.rglob("*.tsx")):
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r'href[:=]\s*"(/[^"#]*)"', source):
            href = match.group(1).rstrip("/") or "/"
            if href.startswith("/api/"):
                continue
            if href not in routes:
                broken.append(f"{href} ({path.relative_to(WEB)})")
    assert broken == [], f"links to routes that do not exist: {sorted(set(broken))}"


def test_the_nav_offers_the_three_pages_and_nothing_stale() -> None:
    """The nav renders on every page, so an anchor in it works on one and does nothing on four."""
    nav = (WEB / "components/marketing/sections/MarketingNav.tsx").read_text(encoding="utf-8")
    block = nav.split("export const NAV_LINKS = [", 1)[1].split("];", 1)[0]
    hrefs = re.findall(r'href:\s*"([^"]+)"', block)
    assert hrefs == ["/", "/pricing", "/download"], hrefs
    assert "#" not in "".join(hrefs), "the page nav carries an anchor again"


def test_nothing_advertises_an_unshipped_feature() -> None:
    """The most public place in the product is the one most tempted to describe a plan.

    The research library is a later phase, and Google and Microsoft sign-in are not in the desktop
    app yet either.
    """
    for route, path in PAGES.items():
        if route in {"/terms", "/privacy"}:
            continue  # the legal documents are generated from the app's own copies
        rendered = text_of(path).lower()
        for unshipped in ("research paper", "research library", "sign in with google", "sign in with microsoft"):
            assert unshipped not in rendered, f"{route} advertises {unshipped!r}"


def test_the_container_probes_a_page_that_exists() -> None:
    """The Docker `HEALTHCHECK` probed `/login` for as long as that route had been deleted.

    Measured rather than reasoned about: `docker build`, `docker run`, and `docker ps` reported
    `(unhealthy)` while curl returned 200 on all seven routes. Nothing else would have caught it,
    because the image builds, starts and serves correctly -- what fails is the orchestrator's
    opinion of it, which matters the moment anything waits on `service_healthy`.

    The three Kubernetes probes on the same deployment had the same path and a worse consequence;
    `apps/api/tests/test_deploy_manifests.py` covers those.
    """
    dockerfile = (ROOT / "apps/web/Dockerfile").read_text(encoding="utf-8")
    probed = re.search(r"HEALTHCHECK.*?fetch\('http://127\.0\.0\.1:3000([^']*)'\)", dockerfile, re.S)
    assert probed is not None, "the HEALTHCHECK no longer fetches a URL this test can read"

    path = probed.group(1) or "/"
    assert path in PAGES, (
        f"the HEALTHCHECK probes {path!r}, which is not a page this site builds: {sorted(PAGES)}. "
        "A health check on a 404 reports unhealthy forever."
    )


def test_the_web_image_copies_only_manifests_that_exist() -> None:
    """A `COPY` of a deleted path fails the build, and it fails it three minutes in.

    `packages/shared/package.json` was copied here until `@voidcode/shared` was deleted. Checking
    it costs a millisecond and the alternative costs a CI run -- and the same line will need
    deleting again the next time a workspace package goes.
    """
    dockerfile = (ROOT / "apps/web/Dockerfile").read_text(encoding="utf-8")
    copied = re.findall(r"^COPY ((?:[\w./-]+ )+)[\w./]+/?$", dockerfile, re.M)
    sources = [src for group in copied for src in group.split() if "/" in src or src.endswith(".json") or src.endswith(".yaml")]

    assert sources, "no COPY sources were parsed, so this assertion is vacuous"
    missing = [src for src in sources if not (ROOT / src).exists()]
    assert not missing, f"apps/web/Dockerfile copies paths that do not exist: {missing}"


def test_the_payment_return_pages_stay_out_of_search_results() -> None:
    """They are reached with a Stripe session id in the URL and say nothing useful out of context."""
    for route in ("/purchase/success", "/purchase/cancelled"):
        source = PAGES[route].read_text(encoding="utf-8")
        assert "robots" in source and "index: false" in source, f"{route} is indexable"


# ── The legal documents are the application's own ───────────────────────────

DESKTOP_LEGAL = ROOT / "desktop/renderer/src/components/Legal"
WEB_LEGAL = WEB / "components/Legal"


def sections_of(path: Path) -> str:
    """The SECTIONS array — the document itself, without the page chrome around it."""
    source = path.read_text(encoding="utf-8")
    assert "const SECTIONS: Section[] = [" in source, f"{path.name} has no SECTIONS array"
    body = source.split("const SECTIONS: Section[] = [", 1)[1].split("// ── Sub-components", 1)[0]
    # Line endings differ between the two checkouts of the same text; the words do not.
    return body.replace(chr(13), "")


@pytest.mark.parametrize("name", ["PrivacyClient.tsx", "TermsClient.tsx"])
def test_the_website_publishes_the_applications_legal_text(name: str) -> None:
    """Two copies, and they may not differ by a word.

    Both places have to publish these: the desktop app shows them where a person accepts them, so
    they ship inside the binary and work offline; Stripe and any app store need a public URL, and a
    reader deciding whether to install anything wants to read the terms before downloading. Neither
    package can import from the other.

    The website's copy was dated 1 January 2025 and described OAuth sign-in, session cookies,
    90-day analytics retention and staff reviewing conversations — none of which ever existed. The
    application's copy had been rewritten twice by then. The public was reading the wrong one, which
    is the only copy that matters for consent.

    If this fails: edit `desktop/renderer/src/components/Legal/<file>`, then run
    `python scripts/sync_web_legal.py` to bring this copy across.
    """
    desktop = sections_of(DESKTOP_LEGAL / name)
    web = sections_of(WEB_LEGAL / name)
    assert web == desktop, f"{name}: the website's text has drifted from the application's"


@pytest.mark.parametrize("name", ["PrivacyClient.tsx", "TermsClient.tsx"])
def test_both_copies_carry_the_version_the_app_records(name: str) -> None:
    """Registration records which terms version was accepted; a document dated differently from
    that constant records consent to something nobody was shown."""
    legal_ts = (ROOT / "desktop/src/shared/legal.ts").read_text(encoding="utf-8")
    display = re.search(r'TERMS_DISPLAY_DATE = "([^"]+)"', legal_ts)
    assert display is not None, "TERMS_DISPLAY_DATE is gone from src/shared/legal.ts"

    for path in (DESKTOP_LEGAL / name, WEB_LEGAL / name):
        source = path.read_text(encoding="utf-8")
        shown = re.search(r'Last updated</span>\s*(?:\{/\*.*?\*/\}\s*)?<span[^>]*>([^<]+)</span>', source, re.DOTALL)
        assert shown is not None, f"{path.name} shows no Last updated date"
        assert shown.group(1).strip() == display.group(1), (
            f"{path.parent.parent.name}/{path.name} is dated {shown.group(1)!r}, "
            f"TERMS_VERSION says {display.group(1)!r}"
        )
