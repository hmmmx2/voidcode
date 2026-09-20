"""One committed number per legal document, checked against both copies while both still exist.

WHY THIS FILE EXISTS

`test_marketing_pages.py::test_the_website_publishes_the_applications_legal_text` compares the
application's copy of each document with the website's, character for character. It is a good test
and it is about to become impossible: the website is being extracted into its own repository, and
there will be no second tree to read. Not "harder" — absent.

What replaces it is a digest. `desktop/src/shared/legal.ts` commits one SHA-256 per document, and
each repository hashes its own copy against it. Editing the text without bumping the constant fails
in the repository that holds the source; a copy that has drifted fails in its own CI.

THIS FILE WAS WRITTEN BEFORE THE SPLIT, AND CHECKED BOTH TREES. That ordering was the point:
after the split nothing can demonstrate that the digest mechanism and the comparison agree. It did,
on both documents, before the website was extracted — see the note at the end of this file, which is
where that result is now recorded.

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
LEGAL_TS = ROOT / "desktop/src/shared/legal.ts"

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
        raw = (DESKTOP_LEGAL / name).read_bytes()
        assert raw.replace(b"\r\n", b"").count(b"\r") == 0, f"{name} holds a lone CR"


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


# ── The website's half is not here any more ──────────────────────────────────
#
# Three tests stood below this line and all three read `apps/web`:
#
#   * the website's copy hashes to the same digest;
#   * the digest agrees with the character-for-character comparison it replaces;
#   * the extraction excludes what the two copies disagree about (the breadcrumb).
#
# THE SECOND ONE IS THE LOSS, AND IT IS THE REASON THEY WERE WRITTEN BEFORE THE SPLIT RATHER THAN
# AFTER. While both trees were present, this file could prove that hashing the extracted text and
# comparing the two texts gave the same answer. That demonstration is not available to either
# repository now, and cannot be reconstructed — which is exactly why it was made while it could be,
# and why its result is recorded here rather than only in a commit message: the digest mechanism and
# the comparison it replaced agreed on both documents, character for character, on 2026-09-20.
#
# What remains here is the application's half: the text still hashes to its committed constant.
# `voidcode-web`'s `scripts/check-legal-digest.mjs` is the other half, run in its CI and before every
# build of the site, against its own copy.
#
# `desktop/tests/legal-digest.test.ts` additionally asserts the constants keep the SHAPE that
# repository's `sync-from-app.mjs` reads them with, because a rename here breaks a pull there and
# nothing in either repository would otherwise notice.
