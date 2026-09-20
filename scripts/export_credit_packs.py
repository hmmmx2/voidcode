"""Publish the on-sale credit packs as a file another repository can read.

WHY THIS EXISTS

`tests/test_marketing_pages.py` compared the pricing page's numbers with
`apps/api/src/services/credit_packs.py`, and its own docstring said why that was the test that
mattered most:

    "A page that says RM20 buys 1,200 credits while the webhook grants something else is a false
    price published to the public internet, and the person who finds out is the one who paid."

The website is a separate repository now, so that comparison cannot run — there is no second tree.
This is the same answer as the legal documents' digest: ONE PUBLISHED ARTEFACT, verified on both
sides. `contracts/credit-packs.json` is generated here and checked against `credit_packs.py` by
`tests/test_credit_packs_contract.py`; the website carries a copy and checks its pricing page
against it in its own CI.

WHY A FILE RATHER THAN A DIGEST

The legal documents needed only "is this the same text", so a hash was enough. Prices need the
VALUES: the website has to render "RM20.00" and "1,200 credits" from something, and a hash cannot
tell it what to render. So the contract carries the data, and the digest-style check is that the
data still matches the source.

WHY PARSED RATHER THAN IMPORTED

Importing `src.services.credit_packs` pulls the API's dependency tree into a script that needs four
fields from a table of frozen dataclasses. The parse is the same one `test_marketing_pages.py` used,
and `tests/test_credit_packs_contract.py` re-derives it independently so a wrong parse here fails
there rather than being baked into the artefact.

RETIRED PACKS ARE EXCLUDED, AND THAT IS NOT A SIMPLIFICATION. `credit_packs.py` is append-only
because a pack's credit amount is baked into completed purchases — a retired row must stay readable
so an old receipt still means something, and must not be offered for sale. `on_sale=False` is the
line between those two, so the export keeps it.
"""

from __future__ import annotations

import ast
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS_PY = ROOT / "apps/api/src/services/credit_packs.py"
TARGET = ROOT / "contracts/credit-packs.json"


def on_sale_packs() -> list[dict[str, object]]:
    """Every pack a visitor can buy, in the order `credit_packs.py` lists them.

    Order is preserved rather than sorted: the pricing page shows them cheapest first because that
    is the order of the table, and a sorted export would quietly re-order the page.
    """
    source = PACKS_PY.read_text(encoding="utf-8")
    assert "PACKS: tuple[CreditPack, ...] = (" in source, f"{PACKS_PY} has no PACKS table"
    body = source.split("PACKS: tuple[CreditPack, ...] = (", 1)[1]

    packs: list[dict[str, object]] = []
    for block in re.findall(r"CreditPack\((.*?)\n    \),", body, flags=re.DOTALL):
        code = re.search(r'code="([^"]+)"', block)
        price = re.search(r"price_minor=(\d+)", block)
        credits = re.search(r"credits_micro=(\d+) \* MICRO_PER_CREDIT", block)
        label = re.search(r'label="([^"]+)"', block)
        currency = re.search(r'currency="([^"]+)"', block)
        assert code and price and credits and label and currency, block[:160]
        if "on_sale=False" in block:
            continue
        minor = int(price.group(1))
        assert currency.group(1) == "myr", (
            f"{code.group(1)} is priced in {currency.group(1)}; `price_display` below writes RM and "
            "would be wrong. Decide how the page should render it before exporting."
        )
        packs.append(
            {
                "code": code.group(1),
                "label": label.group(1),
                "currency": currency.group(1),
                "price_minor": minor,
                # `price_display` in credit_packs.py: RM plus the minor unit over 100, two decimals.
                # Exported rather than left to the consumer, so the two cannot disagree about
                # rounding for a price that does not divide evenly.
                "price_display": f"RM{minor / 100:.2f}",
                "credits": int(credits.group(1)),
            }
        )

    assert packs, "no on-sale packs parsed — check the table's shape before writing the contract"
    return packs


def serving_rate() -> dict[str, object]:
    """Whether the live GPU rate is MEASURED, and the row it comes from.

    WHY THIS IS IN THE CONTRACT. The pricing page carries a sentence about what the rate behind its
    estimates is, and that is a claim about this code. `test_marketing_pages.py` guarded it with
    `"measured=False" in gpu_pricing.py` -- which passed for ten days after the claim stopped being
    true, because THE TABLE IS APPEND-ONLY and still contains two superseded rows that say exactly
    that. A substring search over a file that keeps its history cannot answer a question about the
    present.

    So the live row is resolved the way the API resolves it, and exported. `rate_for()` takes the
    LAST row at or before now; the last row in an append-only table is the newest, so the export
    takes the last row and then checks it is already effective. A future-dated row would make
    "last" and "live" different, and this fails loudly rather than exporting the wrong one.
    """
    source = (PACKS_PY.parent / "gpu_pricing.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    rows = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "PricingRow"
    ]
    assert rows, "no PricingRow entries found in gpu_pricing.py"

    last = {kw.arg: kw.value for kw in rows[-1].keywords if kw.arg is not None}

    effective = last.get("effective_from")
    assert isinstance(effective, ast.Call), "effective_from is not a datetime(...) call"
    parts = [a.value for a in effective.args if isinstance(a, ast.Constant)]
    when = datetime(*parts, tzinfo=timezone.utc)  # type: ignore[arg-type]
    assert when <= datetime.now(timezone.utc), (
        f"the last pricing row is dated {when.isoformat()}, which is in the future. The live row is "
        "therefore an earlier one, and exporting the last would publish a rate nobody is being "
        "charged at yet."
    )

    measured = last.get("measured")
    assert isinstance(measured, ast.Constant) and isinstance(measured.value, bool), (
        "`measured` is not a boolean literal on the last pricing row"
    )
    return {"measured": measured.value, "effective_from": when.isoformat()}


HEADER = {
    "//": (
        "GENERATED by scripts/export_credit_packs.py from apps/api/src/services/credit_packs.py. "
        "Do not edit. This is the published contract the website renders its pricing page from: a "
        "page that advertises a price the webhook does not charge is a false price published to the "
        "public, and the person who finds out is the one who paid. This repository checks the file "
        "against the API; the website checks its page against its copy of the file."
    ),
    "//serving_rate": (
        "Whether the LIVE GPU rate is measured, resolved the way the API resolves it rather than by "
        "searching the file: gpu_pricing.py is append-only and still contains superseded rows marked "
        "measured=False, so a substring search answered a question about the past. The pricing page "
        "makes a claim about this, and its own check compares the two."
    ),
    "//retired": (
        "Packs with on_sale=False are excluded. credit_packs.py is append-only because a pack's "
        "credit amount is baked into completed purchases, so a retired row stays readable for old "
        "receipts and must not be offered for sale."
    ),
}


def export() -> Path:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    body = dict(HEADER)
    body["packs"] = on_sale_packs()
    body["serving_rate"] = serving_rate()
    TARGET.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8", newline="\n")
    return TARGET


if __name__ == "__main__":
    written = export()
    print(f"wrote {written.relative_to(ROOT).as_posix()}")
    for pack in json.loads(written.read_text(encoding="utf-8"))["packs"]:
        print(f"  {pack['code']:16} {pack['price_display']:>9}  {pack['credits']:>6} credits")
