"""`contracts/credit-packs.json` still describes the packs the API actually sells.

WHY THIS FILE EXISTS

`tests/test_marketing_pages.py` compared the website's pricing page with
`apps/api/src/services/credit_packs.py`, and its own docstring named that as the test that mattered
most: a page saying RM20 buys 1,200 credits while the webhook grants something else is a false price
published to the public internet, and the person who finds out is the one who paid.

The website is a separate repository now, so that comparison has no second tree to read. The claim
is split in two, like the legal documents' digest:

  * HERE: the published contract matches the API. That is this file.
  * THERE: the pricing page matches the contract. That is `scripts/check-pricing.mjs` in the
    website's repository, run in its CI and before every build.

Neither half is sufficient alone. Without this one the contract could drift from the API and the
website would faithfully publish the drift; without the other, the contract could be right and the
page wrong.

WHY THE PACKS ARE RE-DERIVED HERE RATHER THAN COMPARED FIELD BY FIELD TO THE EXPORTER

`scripts/export_credit_packs.py` parses `credit_packs.py` with a regex. If this file imported that
parser, a wrong parse would produce a wrong contract and a passing test — the checksum-of-its-own-
output failure. So the parse is written again, differently: this one walks the module's AST, which
cannot agree with a broken regex by coincidence.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS_PY = ROOT / "apps/api/src/services/credit_packs.py"
CONTRACT = ROOT / "contracts/credit-packs.json"
EXPORTER = ROOT / "scripts/export_credit_packs.py"


def _literal(node: ast.AST) -> object:
    """A keyword's value, for the four shapes this table uses.

    `credits_micro=1200 * MICRO_PER_CREDIT` is a BinOp, not a constant — the only arithmetic in the
    table, and the field a miscount would hurt most, so it is unpacked explicitly rather than
    evaluated.
    """
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        if isinstance(node.left, ast.Constant) and isinstance(node.right, ast.Name):
            assert node.right.id == "MICRO_PER_CREDIT", f"unexpected multiplier {node.right.id}"
            return node.left.value
    raise AssertionError(f"cannot read {ast.dump(node)[:120]} as a literal")


def packs_from_ast() -> list[dict[str, object]]:
    """The on-sale packs, read from the module's syntax tree."""
    tree = ast.parse(PACKS_PY.read_text(encoding="utf-8"))

    table = None
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "PACKS":
            table = node.value
            break
    assert isinstance(table, ast.Tuple), "PACKS is not a tuple literal any more"

    packs: list[dict[str, object]] = []
    for call in table.elts:
        assert isinstance(call, ast.Call), "a PACKS entry is not a CreditPack(...) call"
        # ONLY THE FIELDS THE CONTRACT CARRIES. Reading every keyword tripped on
        # `effective_from=datetime(2026, 9, 10, tzinfo=timezone.utc)` — a field the website has no
        # use for. Narrowing to what is published also means a new field on the dataclass does not
        # break this test for no reason, while a change to one of these five still does.
        wanted = {"code", "label", "currency", "price_minor", "credits_micro", "on_sale"}
        fields = {
            kw.arg: _literal(kw.value)
            for kw in call.keywords
            if kw.arg is not None and kw.arg in wanted
        }
        if fields.get("on_sale") is False:
            continue
        minor = int(fields["price_minor"])  # type: ignore[arg-type]
        packs.append(
            {
                "code": fields["code"],
                "label": fields["label"],
                "currency": fields["currency"],
                "price_minor": minor,
                "price_display": f"RM{minor / 100:.2f}",
                "credits": int(fields["credits_micro"]),  # type: ignore[arg-type]
            }
        )
    return packs


def contract_packs() -> list[dict[str, object]]:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))["packs"]


def test_the_ast_walk_finds_packs_at_all() -> None:
    """A positive control. Two empty lists agree perfectly and would prove nothing."""
    found = packs_from_ast()
    assert found, "the AST walk found no on-sale packs — it has stopped matching the table's shape"
    assert len(found) >= 3, f"only {len(found)} pack(s) parsed, which is fewer than ever shipped"


def test_the_contract_matches_the_api() -> None:
    """Order included: the page shows packs cheapest first because that is the table's order."""
    assert contract_packs() == packs_from_ast(), (
        "contracts/credit-packs.json disagrees with apps/api/src/services/credit_packs.py. "
        "Run `python scripts/export_credit_packs.py` and commit the result — and if a price "
        "changed, the website's copy has to be updated too, or it will keep publishing the old one."
    )


def test_the_exporter_really_excludes_a_retired_pack(tmp_path, monkeypatch) -> None:
    """The retired-pack filter, ARMED, against a table that has one.

    THIS TEST EXISTS BECAUSE A MUTANT SURVIVED. Disabling the exporter's `on_sale=False` check
    changes nothing today — no pack has been retired yet — so the live table cannot tell a working
    filter from a deleted one. The test below it would return early and report success either way.

    A synthetic table is what arms it. The expected answer comes from this file, not from the
    exporter, so using the exporter's own parser here is not the checksum-of-its-own-output problem
    the module docstring warns about: the input is known and the answer is written down.
    """
    # Loaded by PATH, not by name. `import scripts.export_credit_packs` fails here: there is a
    # `scripts` package at the repository root AND one under `apps/api`, and which one wins depends
    # on the working directory pytest was started from. `test_tunnel.py` loads its subject the same
    # way for the same reason.
    import importlib.util

    spec = importlib.util.spec_from_file_location("_voidcode_pack_exporter", EXPORTER)
    assert spec is not None and spec.loader is not None
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)

    fake = tmp_path / "credit_packs.py"
    fake.write_text(
        """MICRO_PER_CREDIT = 1_000_000
PACKS: tuple[CreditPack, ...] = (
    CreditPack(
        code="live-one",
        price_minor=2000,
        currency="myr",
        credits_micro=1200 * MICRO_PER_CREDIT,
        label="Live",
    ),
    CreditPack(
        code="retired-one",
        price_minor=3000,
        currency="myr",
        credits_micro=2000 * MICRO_PER_CREDIT,
        label="Retired",
        on_sale=False,
    ),
)
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(exporter, "PACKS_PY", fake)

    codes = [pack["code"] for pack in exporter.on_sale_packs()]
    assert codes == ["live-one"], (
        f"the exporter published {codes}; `retired-one` has on_sale=False and would be offered to "
        "a buyer whose checkout then refuses it"
    )


def test_the_contract_excludes_retired_packs() -> None:
    """The same property against the LIVE table, which today has nothing retired.

    Kept alongside the armed test above rather than replaced by it: this one is what starts checking
    the real thing on the day a pack is retired, and the early return says plainly that it is not
    checking anything yet. An empty check is not a failure; claiming it passed would be.
    """
    source = PACKS_PY.read_text(encoding="utf-8")
    retired = source.count("on_sale=False")
    if retired == 0:
        return
    published = {pack["code"] for pack in contract_packs()}
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "CreditPack"):
            continue
        fields = {
            kw.arg: _literal(kw.value)
            for kw in node.keywords
            if kw.arg is not None and kw.arg in {"code", "on_sale"}
        }
        if fields.get("on_sale") is False:
            assert fields["code"] not in published, f"{fields['code']} is retired and still published"


def test_the_contract_reports_the_live_rate_and_not_a_superseded_one() -> None:
    """The live row's `measured` flag, checked against the API's own selector.

    THIS EXISTS BECAUSE THE OLD GUARD WAS PASSING ON A STALE STRING.
    `test_marketing_pages.py` asserted `"measured=False" in gpu_pricing.py` to justify a constraint
    on the pricing page's copy. `gpu_pricing.py` is APPEND-ONLY and still contains two superseded
    rows marked `measured=False`, so the substring was present for ten days after the live row
    became `measured=True` — and the test's own failure message said what should have happened:
    "the serving rate is measured now — this page may quote hours, and this test should say so".

    A substring search over a file that keeps its history cannot answer a question about the
    present. So this compares the contract with `rate_for()`, the function the API itself uses.
    """
    import importlib.util
    import sys

    api = ROOT / "apps/api"
    added = str(api) not in sys.path
    if added:
        sys.path.insert(0, str(api))
    try:
        spec = importlib.util.find_spec("src.services.gpu_pricing")
        assert spec is not None, "the API's gpu_pricing module is not importable from apps/api"
        from src.services.gpu_pricing import rate_for  # type: ignore[import-not-found]

        live = rate_for()
    finally:
        if added:
            sys.path.remove(str(api))

    published = json.loads(CONTRACT.read_text(encoding="utf-8"))["serving_rate"]
    assert published["measured"] == live.measured, (
        f"the contract says measured={published['measured']} and the live row says "
        f"{live.measured}. Run `python scripts/export_credit_packs.py`."
    )
    assert published["effective_from"] == live.effective_from.isoformat(), (
        f"the contract names the row dated {published['effective_from']} and the live row is "
        f"{live.effective_from.isoformat()} — the export took a row that is not the live one."
    )


def test_the_exporter_is_idempotent_and_the_committed_file_is_its_output() -> None:
    """Regenerating must not change the file, or "committed" and "generated" have come apart.

    Run in a subprocess rather than imported: the exporter writes to a path derived from its own
    location, and importing it here would make this test depend on that resolution being correct
    rather than checking it.
    """
    before = CONTRACT.read_bytes()
    result = subprocess.run(
        [sys.executable, str(EXPORTER)], capture_output=True, text=True, cwd=str(ROOT)
    )
    assert result.returncode == 0, f"the exporter failed:\n{result.stdout}\n{result.stderr}"
    after = CONTRACT.read_bytes()
    assert after == before, (
        "contracts/credit-packs.json was not the exporter's current output — it has been edited by "
        "hand, or the source changed without the file being regenerated. The file has now been "
        "rewritten; check `git diff` and commit it if the change is intended."
    )
