"""One committed number per legal document, checked against both copies while both still exist.

WHY THIS FILE EXISTS

`test_marketing_pages.py::test_the_website_publishes_the_applications_legal_text` compares the
application's copy of each document with the website's, character for character. It is a good test
and it is about to become impossible: the website is being extracted into its own repository, and
there will be no second tree to read. Not "harder" — absent.

What replaces it is a digest. `desktop/src/shared/legal.ts` commits one SHA-256 per document, and
each repository hashes its own copy against it. Editing the text without bumping the constant fails
in the repository that holds the source; a copy that has drifted fails in its own CI.

THIS FILE IS DELIBERATELY WRITTEN BEFORE THE SPLIT, and it checks BOTH trees against the same
number. That ordering is the point: after the split, nothing can ever again demonstrate that the
digest mechanism and the comparison agree. Right now it can, and does — so the mechanism is proven
against the thing it is replacing rather than trusted to be equivalent.

It also asserts the two rules agree. `sections_of` here reads through Python's universal newlines
and then strips CR; `desktop/tests/legal-digest.test.ts` strips CR from raw bytes. Those produce the
same string only while no document contains a lone CR, which is checked below rather than assumed.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DESKTOP_LEGAL = ROOT / "desktop/renderer/src/components/Legal"
WEB_LEGAL = ROOT / "apps/web/src/components/Legal"
LEGAL_TS = ROOT / "desktop/src/shared/legal.ts"
WEB_LEGAL_TS = ROOT / "apps/web/src/lib/legal.ts"

OPEN = "const SECTIONS: Section[] = ["
CLOSE = "// ── Sub-components"

#: document file -> the constant that pins it
DOCUMENTS = {
    "PrivacyClient.tsx": "PRIVACY_SECTIONS_SHA256",
    "TermsClient.tsx": "TERMS_SECTIONS_SHA256",
}


def sections_of(path: Path) -> str:
    """The SECTIONS array — the document itself, without the page chrome around it.

    THE SAME RULE AS `test_marketing_pages.py`, restated rather than imported, because after the
    split each repository carries its own copy in its own language and the digest means nothing
    unless they agree on which characters it covers. Three copies is the cost of independence; each
    one says so.
    """
    source = path.read_text(encoding="utf-8")
    assert OPEN in source, f"{path.name} has no SECTIONS array"
    body = source.split(OPEN, 1)[1].split(CLOSE, 1)[0]
    # Line endings differ between checkouts of the same text; the words do not.
    return body.replace(chr(13), "")


def committed(name: str, source_file: Path) -> str:
    source = source_file.read_text(encoding="utf-8")
    # Prettier may wrap a 64-character string onto its own line, so the newline is optional.
    found = re.search(name + r'\s*=\s*\n?\s*"([0-9a-f]{64})"', source)
    assert found is not None, f"{name} is not declared as a 64-hex constant in {source_file}"
    return found.group(1)


def test_no_document_holds_a_lone_carriage_return() -> None:
    """What makes the Python and TypeScript rules equivalent, checked rather than assumed.

    Python's `read_text` turns a lone CR into LF; the TypeScript side deletes it. One survivor and
    the two sides hash different strings, which would present as "the website's copy has drifted"
    with the files byte-identical.
    """
    for name in DOCUMENTS:
        for path in (DESKTOP_LEGAL / name, WEB_LEGAL / name):
            raw = path.read_bytes()
            assert raw.replace(b"\r\n", b"").count(b"\r") == 0, f"{path} holds a lone CR"


@pytest.mark.parametrize("name", sorted(DOCUMENTS))
def test_the_application_copy_hashes_to_its_committed_digest(name: str) -> None:
    actual = hashlib.sha256(sections_of(DESKTOP_LEGAL / name).encode("utf-8")).hexdigest()
    expected = committed(DOCUMENTS[name], LEGAL_TS)
    assert actual == expected, (
        f"{name}'s text has changed and its digest has not.\n"
        f"  If the change was intended, put this in desktop/src/shared/legal.ts:\n"
        f"    {actual}\n"
        "  then run `python scripts/sync_web_legal.py`."
    )


@pytest.mark.parametrize("name", sorted(DOCUMENTS))
def test_the_website_copy_hashes_to_the_same_digest(name: str) -> None:
    """The half that survives the split, running here against the tree that is about to leave."""
    actual = hashlib.sha256(sections_of(WEB_LEGAL / name).encode("utf-8")).hexdigest()
    assert actual == committed(DOCUMENTS[name], LEGAL_TS), (
        f"the website's {name} does not hash to the committed digest — "
        "run `python scripts/sync_web_legal.py`"
    )


@pytest.mark.parametrize("name", sorted(DOCUMENTS))
def test_the_digest_agrees_with_the_comparison_it_replaces(name: str) -> None:
    """The one assertion that cannot be made after the split, made now.

    Two documents hashing to the same number is not, on its own, proof that they are the same
    document — it is proof that they hash the same, and a digest computed by a rule that returned
    the empty string would satisfy every test above. So while both trees are here: the extracted
    text is non-trivial, the two copies are equal as strings, AND that equal string is what the
    digest covers.
    """
    desktop = sections_of(DESKTOP_LEGAL / name)
    web = sections_of(WEB_LEGAL / name)

    assert len(desktop) > 5_000, f"{name}: the extraction rule returned almost nothing"
    assert web == desktop, f"{name}: the website's text has drifted from the application's"
    assert hashlib.sha256(desktop.encode("utf-8")).hexdigest() == committed(
        DOCUMENTS[name], LEGAL_TS
    )


def test_the_extraction_excludes_what_the_two_copies_disagree_about() -> None:
    """The breadcrumb must fall OUTSIDE the digest, or the mechanism cannot work at all.

    The application's document links to its Settings screen; the website's links to the site root,
    because that screen does not exist there. If that markup fell inside the range the digest
    covers, the two copies could never hash the same however carefully they were synced.
    """
    desktop = sections_of(DESKTOP_LEGAL / "PrivacyClient.tsx")
    web = sections_of(WEB_LEGAL / "PrivacyClient.tsx")

    assert 'href="/profile"' not in desktop, "the application's breadcrumb is inside the digest"
    assert 'href="/"' not in web, "the website's breadcrumb is inside the digest"
    # And the generated header the website carries, which is also outside by construction.
    assert "A COPY, AND THE COPY IS THE POINT" not in web


def test_the_website_carries_its_own_copy_of_the_numbers() -> None:
    """Generated by `sync_web_legal.py`, because the website cannot import from `desktop/`.

    Without this file the extracted repository has nothing to check itself against, and the parity
    mechanism becomes one-sided the moment it is on its own.
    """
    assert WEB_LEGAL_TS.exists(), (
        f"{WEB_LEGAL_TS.relative_to(ROOT).as_posix()} is missing — "
        "run `python scripts/sync_web_legal.py`"
    )
    for constant in DOCUMENTS.values():
        assert committed(constant, WEB_LEGAL_TS) == committed(constant, LEGAL_TS), (
            f"the website's {constant} disagrees with the application's"
        )

    version = re.search(r'TERMS_VERSION = "([^"]+)"', LEGAL_TS.read_text(encoding="utf-8"))
    assert version is not None
    assert f'TERMS_VERSION = "{version.group(1)}"' in WEB_LEGAL_TS.read_text(encoding="utf-8")
