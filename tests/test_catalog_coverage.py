"""Assert what the catalog actually contains, so the claim cannot go stale unnoticed.

`docs/KNOWLEDGE_ARCHITECTURE.md` said "zero ML, DL, LLM, VLM, or CUDA content exists. Catalog is
five easy DSA problems." **91 authored items exist and all of them are ML.** The audit was written
once, trusted, and never re-checked, and a four-to-eight-week authoring plan was built on top of a
premise that had already decayed. Two of its other load-bearing claims decayed the same way — see
`docs/AUDIT_CORRECTIONS.md`.

Prose cannot detect its own staleness. A test can. These fail the moment the catalog stops matching
what the docs claim, which is the only kind of documentation that stays honest.

Thresholds are set at the *current measured* values, not at V1's targets. A test pinned to an
aspiration fails from the day it is written and gets skipped; one pinned to reality fails only on
regression, and is raised deliberately as content lands.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SCRIPTS = Path(__file__).resolve().parents[1] / "apps" / "api" / "scripts"
# Excludes `%s`, because scripts/merge_authored.py uses '"slug": "%s"' as a SEARCH format string
# rather than as content, and matching it would report the sprawl as returning when it has not.
SLUG = re.compile(r"""['"]slug['"]\s*:\s*['"]((?!%s)[^'"]+)""")

#: Subject markers per V1 area. Deliberately keyword-based rather than a hand-maintained list:
#: a new problem about paged attention should count toward LLM coverage without anyone updating
#: this file, and a rename that drops the subject from the slug SHOULD fail here.
AREAS = {
    "llm": ("attention", "kv", "bpe", "subword", "perplexity", "decode", "top", "flashattention",
            "residual", "layer", "scaled"),
    "cuda": ("coalescing", "occupancy", "thread", "warp", "arithmetic", "roofline", "parallel"),
    "vlm": ("vit", "patch", "modality", "iou", "interpolate"),
    "python_ml": ("logsumexp", "broadcast", "stable", "matrix", "eigenvalues", "expectation",
                  "resampling", "bayes"),
    "systems": ("activation", "memory", "pipeline", "fp16", "compute", "batchnorm", "sgd",
                "warmup", "kl", "bias", "cross"),
}


@pytest.fixture(scope="module")
def slugs() -> set[str]:
    """Read from the loader, not by grepping scripts.

    This originally swept `apps/api/scripts/*.py` for slug literals, because that was the only way
    to count the catalog when content lived in five Python modules. Those are now deleted and
    content lives in content/problems/*.yaml, so the grep found nothing and every coverage
    assertion failed — a test measuring the old storage layout rather than the catalog.
    """
    from features.content import load_raw

    return set(load_raw())       # drop format-string artefacts


def test_the_catalog_is_not_five_dsa_problems(slugs: set[str]) -> None:
    """The audit's headline claim, pinned. It was wrong by a factor of eighteen."""
    # Raised as content lands: 85 -> 140. These thresholds exist to be raised, and a
# threshold left below reality stops catching a regression.
    assert len(slugs) >= 140, (
        f"catalog has {len(slugs)} authored items; docs/AUDIT_CORRECTIONS.md records 91. "
        "If this dropped, content was lost — if it rose, raise the threshold."
    )


@pytest.mark.parametrize("area", sorted(AREAS))
def test_every_v1_area_has_content(area: str, slugs: set[str]) -> None:
    """V1 names five areas. Each must be represented, or the platform's positioning is a claim its
    catalog does not support — which the plan calls out as needing descoping, not tolerating."""
    markers = AREAS[area]
    hits = {s for s in slugs if any(m in s for m in markers)}
    assert hits, f"no catalog content for V1 area {area!r}"


def test_content_is_not_spread_across_more_scripts_than_it_was(slugs: set[str]) -> None:
    """V1 asks for one file per item behind a single loader. Content currently lives in five
    scripts, which is why the item count was hard to establish at all — no single place knew how
    many problems existed. This fails if the sprawl grows before the loader lands.
    """
    with_slugs = [p.name for p in SCRIPTS.glob("*.py")
                  if SLUG.search(p.read_text(encoding="utf-8", errors="ignore"))]
    # Was <= 6 while five content scripts existed. They are deleted and content lives in
    # content/problems/*.yaml, so the correct bound is now zero: any script growing slug literals
    # again is the sprawl coming back.
    assert with_slugs == [], (
        f"slug literals reappearing in scripts: {sorted(with_slugs)}. "
        "Content belongs in content/problems/*.yaml behind the loader."
    )


def test_hidden_test_cases_are_actually_used(slugs: set[str]) -> None:
    """The audit claimed all fifteen cases were client-visible, making every evaluation number
    meaningless. They are not: the seed data sets is_hidden per case. Pinned because it is the
    single assumption every downstream evaluation and reward number depends on.
    """
    from features.content import load_raw

    hidden_true = hidden_false = 0
    for row in load_raw().values():
        for case in row.get("test_cases") or []:
            if case.get("is_hidden"):
                hidden_true += 1
            else:
                hidden_false += 1
    assert hidden_true > 0, "no hidden test cases: there is no held-out grading signal"
    assert hidden_false > 0, "no visible test cases: learners get no worked examples"
    assert hidden_true > hidden_false, (
        f"{hidden_true} hidden vs {hidden_false} visible — V1 wants one or two visible per "
        "problem and the rest hidden"
    )


#: Client-side content authored per problem and keyed by slug. The API never sends hidden cases
#: (`routers/problems.py` filters them, `execution.py:redact_for_response` strips them), but these
#: files are compiled into a bundle and bypass all of it.
#:
#: EVERY COPY, NOT ONE. This used to name only the web copy. The desktop renderer carries its own,
#: the two drifted, and the leak this test was written for was fixed on the web and kept shipping
#: inside the desktop installer — with this test green the whole time, because it never opened the
#: file that still had it. `test_every_visualization_copy_is_guarded` stops a copy going unwatched.
_ROOT = Path(__file__).resolve().parents[1]
VIZ_COPIES = (
    _ROOT / "desktop" / "renderer" / "src" / "lib" / "visualizations" / "index.ts",
    _ROOT / "apps" / "web" / "src" / "lib" / "visualizations" / "index.ts",
)
_SLUG_BLOCK = re.compile(r'^  "([a-z0-9][a-z0-9-]*)":\s*\{', re.M)


def _slug_blocks(text: str) -> dict[str, str]:
    """The file's per-problem sections, so a value is only checked against ITS OWN problem.

    Checking every hidden value against the whole file reports nine false positives and one real
    leak: `1.414214` is root two, `0.333333` is a third, and one match was inside an SVG path
    (`M-0.000124323...`). Those are coincidences between unrelated problems, and a check that cries
    wolf nine times out of ten is a check that gets deleted.
    """
    starts = [(m.group(1), m.start()) for m in _SLUG_BLOCK.finditer(text)]
    return {slug: text[pos: starts[i + 1][1] if i + 1 < len(starts) else len(text)]
            for i, (slug, pos) in enumerate(starts)}


def _leaked(blocks: dict[str, str], raw: dict) -> list[tuple[str, str]]:
    found = []
    for slug, body in blocks.items():
        cases = (raw.get(slug) or {}).get("test_cases") or []
        visible = {str(c.get("expected_output")) for c in cases if not c.get("is_hidden")}
        for case in cases:
            if not case.get("is_hidden"):
                continue
            value = str(case.get("expected_output") or "")
            # A value that is ALSO a visible expectation is not a leak -- the learner already has
            # it. Digit boundaries stop `0.3333` matching inside `0.333333`.
            if len(value) < 3 or value in visible:
                continue
            if re.search(r"(?<![\d.])" + re.escape(value) + r"(?![\d])", body):
                found.append((slug, value))
    return found


@pytest.mark.parametrize("viz", VIZ_COPIES, ids=["desktop", "web"])
def test_no_hidden_expected_output_reaches_the_client(viz: Path) -> None:
    """A hidden case's answer in the bundle is the held-out grading signal, published.

    `cross-entropy-loss` rendered its only hidden expected output, to six decimals, in a caption
    teaching the 1e-12 clamp — the visible cases for that problem are three other values, and it is
    a single-row batch, so the number shown WAS the answer. The lesson (the clamp turns a crash
    into a number) survives without it.

    The decoy below is the point. This assertion passes trivially the moment the detector stops
    detecting, and a green test that checks nothing is how the leak survived authoring in the first
    place — so the same detector must be shown firing on the value that was actually there.

    A missing copy FAILS rather than skips. A guard that quietly skips the file it cannot find is
    the same guard that quietly read the wrong file for as long as the desktop leak shipped.
    """
    from features.content import load_raw

    assert viz.is_file(), (
        f"{viz} is gone. If that copy was deliberately deleted, remove it from VIZ_COPIES in the "
        "same change — do not let this test go quiet about a file it can no longer see.")

    raw = load_raw()
    blocks = _slug_blocks(viz.read_text(encoding="utf-8"))
    assert blocks, f"no slug-keyed blocks parsed from {viz}; the detector reads nothing"

    leaked = _leaked(blocks, raw)
    assert not leaked, (
        f"hidden expected_output in client-side content: {leaked}. This ships in the bundle; "
        "teach the mechanism without printing the answer.")

    decoy = dict(blocks)
    decoy["cross-entropy-loss"] = decoy["cross-entropy-loss"].replace(
        '"large, and finite"', '"27.631021"')
    assert _leaked(decoy, raw) == [("cross-entropy-loss", "27.631021")], (
        "the detector no longer catches the leak it was written for, so the assertion above "
        "proves nothing")


def test_every_visualization_copy_is_guarded() -> None:
    """Any `lib/visualizations/index.ts` in the tree must be in VIZ_COPIES.

    The leak survived in the desktop copy because nothing said a second copy existed. Found by
    walking the tree rather than listing expected paths, so a third copy added next quarter fails
    here on the day it lands instead of being discovered in a shipped bundle.
    """
    import os

    # Pruned walk, not `rglob`: rglob descends into every node_modules before a filter can reject
    # it, which on Windows turns a sub-second check into minutes.
    skip = {"node_modules", ".next", "out", "dist", "release", ".git", "vendor", "__pycache__"}
    found = set()
    for dirpath, dirnames, filenames in os.walk(_ROOT):
        dirnames[:] = [d for d in dirnames if d not in skip]
        here = Path(dirpath)
        if "index.ts" in filenames and here.name == "visualizations" and here.parent.name == "lib":
            found.add((here / "index.ts").resolve())
    guarded = {p.resolve() for p in VIZ_COPIES}
    assert found, "found no visualization copies at all; the walk is broken"
    assert found == guarded, (
        f"unguarded: {sorted(map(str, found - guarded))}; "
        f"listed but absent: {sorted(map(str, guarded - found))}")


MOCK_DATA = Path(__file__).resolve().parents[1] / "apps" / "web" / "src" / "lib" / "mock-data.ts"
_DEFAULT_CODE = re.compile(r"export const defaultCode = `(.*?)`;", re.S)


def test_the_editors_default_code_still_matches_the_catalogue() -> None:
    """`defaultCode` is a copy of `stable-softmax`'s template, and copies in this file rot.

    It has to be a copy: it renders before any request resolves, so it cannot be fetched. But the
    exports that used to sit beside it drifted badly enough that `mockProblem` ended up with the ML
    curriculum's title on Two Sum's body — a problem no longer in the catalogue at all. Those had no
    importers and are deleted; this one is imported by `Editor/MonacoWrapper.tsx` and is the first
    thing a new learner sees, so it gets an assertion instead of a comment asking nicely.
    """
    from features.content import load_raw

    match = _DEFAULT_CODE.search(MOCK_DATA.read_text(encoding="utf-8"))
    assert match, "defaultCode is no longer a plain template literal; this check reads nothing"
    template = load_raw()["stable-softmax"]["code_templates"][0]["template_code"]
    assert match.group(1) == template, (
        "apps/web's defaultCode has drifted from content/problems/stable-softmax.yaml. The learner "
        "sees one thing and the grader another.")
