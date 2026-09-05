"""The migrated YAML must lose nothing from the source scripts.

The first version of `scripts/migrate_content_to_yaml.py` wrote six fields and silently dropped
six others, including **test_cases**. That is not a cosmetic loss. `execution.py:75` records that
an empty test list was once graded as a *pass*, because `passed == len(test_cases)` is vacuously
true for an empty list — a bug this codebase already found and fixed. Pointing the API at a loader
built on those files would have reintroduced it through the back door, and every problem would
have passed silently.

Nothing about that failure is visible from the YAML. The files parse, the loader accepts them, the
item count is right, and 50 problems have quietly lost their grading. So the check has to compare
against the source, and it has to keep running until the source scripts are retired.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))

CONTENT = ROOT / "content" / "problems"

#: Fields whose loss changes behaviour rather than presentation. Called out separately so a
#: failure names the consequence, not just the diff.
LOAD_BEARING = ("test_cases", "code_templates")


def source_rows() -> list[dict]:
    rows: list[dict] = []
    for module, attr in (("scripts.interview_problems", "INTERVIEW_PROBLEMS"),
                         ("scripts.interview_content", "INTERVIEW_QUESTIONS"),
                         ("scripts.problem_content", "PROBLEMS"),
                         ("scripts.paper_content", "PAPERS")):
        mod = pytest.importorskip(module, reason=f"{module} retired — this test can go too")
        data = getattr(mod, attr, None)
        if data is None:
            continue
        items = list(data.values()) if isinstance(data, dict) else list(data)
        rows += [r for r in items if isinstance(r, dict) and r.get("slug")]
    return rows


@pytest.fixture(scope="module")
def pairs() -> list[tuple[dict, dict]]:
    out = []
    for row in source_rows():
        path = CONTENT / f"{row['slug']}.yaml"
        assert path.exists(), f"{row['slug']} was never migrated"
        out.append((row, yaml.safe_load(path.read_text(encoding="utf-8"))))
    return out


def test_every_source_item_was_migrated(pairs: list[tuple[dict, dict]]) -> None:
    assert len(pairs) >= 91


def test_no_field_is_dropped(pairs: list[tuple[dict, dict]]) -> None:
    losses = {src["slug"]: sorted(set(src) - set(dst)) for src, dst in pairs
              if set(src) - set(dst)}
    assert losses == {}, f"fields dropped in migration: {losses}"


def test_test_cases_survive_with_the_same_count(pairs: list[tuple[dict, dict]]) -> None:
    """The load-bearing one. A problem that loses its tests does not fail loudly — it passes
    everything, because `passed == len(test_cases)` holds vacuously at zero."""
    bad = [(src["slug"], len(src["test_cases"]), len(dst.get("test_cases") or []))
           for src, dst in pairs if src.get("test_cases")
           and len(dst.get("test_cases") or []) != len(src["test_cases"])]
    assert bad == [], f"test case count changed (slug, source, migrated): {bad}"


def test_hidden_flags_survive(pairs: list[tuple[dict, dict]]) -> None:
    """Hidden cases are the held-out grading signal. If migration flattened is_hidden, every
    evaluation number downstream becomes meaningless and nothing would say so."""
    for src, dst in pairs:
        if not src.get("test_cases"):
            continue
        want = [bool(c.get("is_hidden")) for c in src["test_cases"] if isinstance(c, dict)]
        got = [bool(c.get("is_hidden")) for c in (dst.get("test_cases") or [])
               if isinstance(c, dict)]
        assert want == got, f"{src['slug']}: is_hidden pattern changed"


@pytest.mark.parametrize("field", LOAD_BEARING)
def test_load_bearing_fields_are_present_wherever_the_source_had_them(
    field: str, pairs: list[tuple[dict, dict]]
) -> None:
    missing = [src["slug"] for src, dst in pairs if src.get(field) and not dst.get(field)]
    assert missing == [], f"{field} lost for: {missing}"


def test_load_raw_reproduces_every_source_item_exactly() -> None:
    """The precondition for deleting the source scripts.

    `features.content.load_raw()` is the bridge the three seeders will import instead of
    `scripts.*_content`. Switching them is only safe if every value round-trips, so this asserts
    value equality across all 91 items rather than field presence — a `test_cases` list that
    survived but lost a case, or an `is_hidden` that flipped, would pass the presence checks above
    and still break grading.

    When this passes and the seeders have switched, the scripts can go and this whole module
    retires itself via the importorskip in `source_rows`.
    """
    from features.content import load_raw

    raw = load_raw()
    mismatches: dict[str, list[str]] = {}
    for src in source_rows():
        dst = raw.get(src["slug"])
        assert dst is not None, f"{src['slug']} missing from load_raw()"
        differing = [k for k, v in src.items() if dst.get(k) != v]
        if differing:
            mismatches[src["slug"]] = differing
    assert mismatches == {}, f"values changed in migration: {mismatches}"


def test_every_reference_solution_survived() -> None:
    """The highest-value content in the repository, and the first migration left all 50 behind.

    They live in SEPARATE module-level dicts, not on the problem rows, so a migration that reads
    rows alone misses them entirely. Worse, the interview ones are keyed by the container's key
    (`implement-auc`) rather than the item's slug (`iq-implement-auc`), so a slug-keyed lookup
    recovered 12 of 50 and the other 38 looked exactly like items that simply have no reference
    solution.

    A wrong reference solution on an interview-prep platform is worse than a missing question. A
    silently absent one is worse still, because nothing downstream can tell it was ever there.
    """
    from features.content import load_raw

    # importorskip, not import_module: once the source scripts are deleted this whole module has
    # done its job and should retire itself rather than fail. A migration check that outlives the
    # thing it was checking against is just a broken test.
    pc = pytest.importorskip("scripts.problem_content", reason="source retired")
    ip = pytest.importorskip("scripts.interview_problems", reason="source retired")

    raw = load_raw()
    expected: dict[str, str] = {}
    expected.update(getattr(pc, "REFERENCE_SOLUTIONS", {}))

    key_to_slug = {k: v["slug"] for k, v in getattr(ip, "INTERVIEW_PROBLEMS", {}).items()}
    for key, sol in getattr(ip, "INTERVIEW_REFERENCE_SOLUTIONS", {}).items():
        expected[key_to_slug.get(key, key)] = sol

    assert len(expected) == 50, f"expected 50 reference solutions in the source, found {len(expected)}"
    missing = [s for s in expected if not raw.get(s, {}).get("reference_solution")]
    assert missing == [], f"reference solutions lost for: {missing}"
    changed = [s for s, v in expected.items() if raw[s]["reference_solution"] != v]
    assert changed == [], f"reference solutions altered for: {changed}"
