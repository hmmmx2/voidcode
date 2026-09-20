"""The longest address this API accepts is 254 characters, and the desktop app agrees.

WHY THIS FILE EXISTS

The cap disagreed in three places: 255 in the desktop form's `validateEmail`, 320 in the IPC
contract's schema, and 254 here. Each was defensible alone. Together they made two ways to be
refused by something other than the thing that decides — a 255-character address passed the form,
passed the channel, reached this API and came back as a validation error with no `field` attached,
which the sign-in dialog shows as a banner rather than under the Email field.

WHY 254, AND WHY IT IS NOT THIS FILE'S CHOICE

Nothing here sets the limit. `EmailStr` defers to `email-validator`, which enforces the RFC limits:
RFC 5321 caps an SMTP forward-path at 256 octets including the angle brackets, leaving 254 for the
address. So the assertion below is a MEASUREMENT of the validator the API already uses, not a
preference — which is exactly what makes it the right number for the other two places to copy.

THE LOOP IS CLOSED FROM BOTH ENDS. `desktop/tests/account-validation.test.ts` reads
`EMAIL_MAX_LENGTH` and asserts the contract and the form both use it; this file reads the same
constant and asserts it matches what `EmailStr` does. Either half alone would let the two drift:
the TypeScript side cannot run Python, and a Python-only boundary test says nothing about what the
app sends.

NO DATABASE. These are Pydantic models, so this runs everywhere the suite runs — deliberately, since
a cap that only gets checked when Postgres happens to be up is the silent-skip problem this same
round of work went to fix.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import ValidationError
from src.routers.auth import (
    DesktopRegisterRequest,
    DesktopSessionRequest,
    ResetCodeConfirm,
    ResetCodeRequest,
)

REPO = Path(__file__).resolve().parents[3]
SHARED_LEGAL = REPO / "desktop" / "src" / "shared" / "legal.ts"

#: What RFC 5321 leaves for the address itself.
EXPECTED = 254


def address_of_length(total: int) -> str:
    """A syntactically valid address of exactly `total` characters.

    The local part is held at 64 — its own RFC limit — and the domain is padded with labels of at
    most 60, because a naive `"a" * n + "@example.com"` breaks the local-part rule long before it
    reaches the total being tested and would make this file assert the wrong refusal.
    """
    local = "a" * 64
    remaining = total - len(local) - 1
    labels: list[str] = []
    while remaining > 0:
        take = min(60, remaining if remaining <= 60 else remaining - 1)
        labels.append("b" * take)
        remaining -= take + (1 if remaining > take else 0)
    built = f"{local}@{'.'.join(labels)}"
    assert len(built) == total, f"built {len(built)} characters, wanted {total}"
    return built


def test_the_helper_builds_what_it_claims() -> None:
    """A positive control on the fixture: every assertion below is about a length."""
    for total in (200, 253, 254, 255, 300):
        built = address_of_length(total)
        assert len(built) == total
        assert len(built.split("@", 1)[0]) == 64, "the local part must stay within its own limit"


@pytest.mark.parametrize(
    "model",
    [DesktopSessionRequest, DesktopRegisterRequest, ResetCodeRequest, ResetCodeConfirm],
)
def test_every_model_that_takes_an_address_accepts_254_and_refuses_255(model) -> None:
    """All four, not just the first. A cap enforced on three of them is the same bug, smaller."""
    filler = {
        "password": "quiet-harbour-lantern-41",
        "new_password": "quiet-harbour-lantern-41",
        "name": "A Learner",
        "code": "123456",
        "terms_accepted": True,
        "terms_version": "2026-09-20",
    }
    fields = model.model_fields

    def build(email: str) -> dict[str, object]:
        payload: dict[str, object] = {"email": email}
        payload.update({k: v for k, v in filler.items() if k in fields})
        return payload

    model(**build(address_of_length(EXPECTED)))

    with pytest.raises(ValidationError) as refused:
        model(**build(address_of_length(EXPECTED + 1)))
    # The refusal must be about the ADDRESS. Without this, a model that happened to reject the
    # payload for a missing field would read as enforcing a length it does not.
    assert "email" in str(refused.value).lower()


def test_the_desktop_constant_is_the_same_number() -> None:
    """Read from `shared/legal.ts`, so the two cannot drift without one of them going red."""
    source = SHARED_LEGAL.read_text(encoding="utf-8")
    found = re.search(r"export const EMAIL_MAX_LENGTH = (\d+);", source)
    assert found is not None, f"EMAIL_MAX_LENGTH is not declared in {SHARED_LEGAL}"
    assert int(found.group(1)) == EXPECTED, (
        f"the desktop app caps addresses at {found.group(1)} and this API at {EXPECTED}; "
        "one of them will refuse something the other accepted"
    )
