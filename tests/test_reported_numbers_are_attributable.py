"""Guards for the three defects a CV fact-check turned up in the published numbers.

Each exists because a real number was misread, not because a rule sounded good:

1.  0.813 was published with no interval, beside a [0.695, 0.898] belonging to a different pool of
    the same metric, so the two could be -- and were -- quoted welded together.
2.  eval_stream_v6_run*.json carried a `summary` written before the CHECK_SURFACE rescore. It read
    9/51 where its own records read 43/51, which made the headline look unreproducible.
3.  docs/RANKING_DESIGN.md holds a measured NDCG@10 of 0.0059 with the verdict "NOT MET", and
    docs/METRICS.md holds 0.2143 for the same metric. They are the nine- and eleven-feature
    models, and nothing said so.

These read files as data. Nothing imports `main`.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
READINESS = ROOT / "docs" / "READINESS.md"
EVIDENCE = ROOT / "docs" / "evidence"

INTERVAL = re.compile(r"\[\s*0?\.\d+\s*,\s*0?\.\d+\s*\]")
# A run count -- "9 runs", including inside "51 x **9 runs**" -- or a cell listing three or more
# per-run tallies. No multiplication-sign branch: the digit-space-runs form already matches it.
RUN_COUNT = re.compile(r"\b\d+\s+runs\b")
PER_RUN_CELL = re.compile(r"\|\s*\d+(?:,\s*\d+){2,}\s*\|")
SCALES = ("per-scenario", "run-to-run")


def multi_run_rows_with_intervals(text: str) -> list[tuple[int, str]]:
    """Table rows reporting an interval on a figure averaged over more than one run."""
    rows = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.startswith("|") or not INTERVAL.search(line):
            continue
        if RUN_COUNT.search(line) or PER_RUN_CELL.search(line):
            rows.append((number, line))
    return rows


class TestEveryMultiRunIntervalStatesItsScale:
    """A bare interval beside a multi-run mean does not say what it bounds, and the two candidate
    answers differ by more than the gap between PASS and FAIL."""

    def test_the_readiness_rows_are_all_labelled(self):
        rows = multi_run_rows_with_intervals(READINESS.read_text(encoding="utf-8"))
        assert rows, "found no multi-run rows with intervals -- the detector has stopped working"
        unlabelled = [(n, ln) for n, ln in rows if not any(s in ln for s in SCALES)]
        assert not unlabelled, "\n".join(
            f"READINESS.md:{n} reports an interval on a multi-run mean without saying whether it "
            f"bounds rerun stability (run-to-run) or generalisation (per-scenario):\n    {ln}"
            for n, ln in unlabelled)

    def test_the_detector_catches_a_stripped_label_on_every_row(self):
        """The mutant, applied one row at a time.

        Stripping a single label globally is NOT a valid mutant here: the first match sits on a row
        carrying both scales, so the row stays labelled and the guard correctly survives. That
        reads as a dead detector when it is a weak mutation. Unlabelling each row in turn is the
        mutation that actually tests the property.
        """
        text = READINESS.read_text(encoding="utf-8")
        rows = multi_run_rows_with_intervals(text)
        assert rows, "nothing to mutate"
        for number, line in rows:
            stripped = line
            for scale in SCALES:
                stripped = stripped.replace(scale, "")
            assert stripped != line, f"READINESS.md:{number} carries no label to strip"
            mutated = text.replace(line, stripped, 1)
            surviving = multi_run_rows_with_intervals(mutated)
            assert any(not any(s in ln for s in SCALES) for _, ln in surviving), (
                f"unlabelling READINESS.md:{number} did not make it detectable, so the guard "
                f"does not cover that row")

    def test_the_legend_explaining_both_scales_is_present(self):
        text = READINESS.read_text(encoding="utf-8")
        assert "Reading the intervals" in text
        # The legend must say why pooling runs x scenarios is wrong, not just name the two scales.
        assert "not independent trials" in text


def scored_runs() -> list[Path]:
    """The {summary, results} files. A/B and hardware probes in the same directory are not runs."""
    out = []
    for path in sorted(EVIDENCE.glob("eval_*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        if (isinstance(doc, dict) and isinstance(doc.get("summary"), dict)
                and isinstance(doc.get("results"), list)):
            out.append(path)
    return out


def tally_from_records(doc: dict) -> dict[str, tuple[int, int]]:
    """Recompute per-check pass counts from the records, the way run_evals.summarise does."""
    out: dict[str, list[bool]] = {}
    for row in doc["results"]:
        for name, result in ((row.get("score") or {}).get("checks") or {}).items():
            if result.get("applicable"):
                out.setdefault(name, []).append(bool(result.get("passed")))
    return {name: (sum(values), len(values)) for name, values in out.items()}


def summarise_records(doc: dict) -> dict:
    """What `run_evals.summarise` produces from this file's own records.

    Deferred so importing this module does not depend on `scripts/` resolving; `run_evals` itself
    is light (argparse, json) and pulls no model code.
    """
    sys.path.insert(0, str(ROOT / "scripts"))
    from run_evals import summarise
    return summarise(doc["results"])


class TestStoredSummariesAgreeWithTheirOwnRecords:
    """The defect: a rescore updated every per-record score and left the summary behind, so the
    file contradicted itself and the summary was the half people read."""

    @pytest.mark.parametrize("path", scored_runs(), ids=lambda p: p.name)
    def test_summary_matches_records(self, path: Path):
        """Both blocks, not just `by_check`.

        `by_bucket` is derived from `all_passed`, which contains every check -- so one check moving
        moves the per-mode rates with it. In v6 the stale `bug_localisation` dragged five debug
        bucket rows with it (debug/ALL read 3/51 where the records said 30/51), and a by_check-only
        comparison would have called that file half-repaired.
        """
        doc = json.loads(path.read_text(encoding="utf-8"))
        fresh = summarise_records(doc)
        drift = []
        for block in ("by_check", "by_bucket"):
            stored = doc["summary"].get(block) or {}
            for name, row in sorted(fresh[block].items()):
                was = stored.get(name)
                if was is None:
                    drift.append(f"{block}/{name}: missing from summary, "
                                 f"records say {row['passed']}/{row['n']}")
                elif (was.get("passed"), was.get("n")) != (row["passed"], row["n"]):
                    drift.append(f"{block}/{name}: summary {was.get('passed')}/{was.get('n')}, "
                                 f"records {row['passed']}/{row['n']}")
        assert not drift, (
            f"{path.name} contradicts itself. Regenerate with "
            f"`python scripts/resummarise_evidence.py {path.as_posix()} --write`:\n  "
            + "\n  ".join(drift))

    def test_the_debug_bucket_matches_what_readiness_published(self):
        """Corroboration from outside the artifacts.

        `READINESS.md` publishes `debug, all checks | 30, 32, 28, 35, 30, 26`. The first three are
        v6. They match the records and did NOT match the stale summary (3, 4, 5) -- which is how we
        know the document was written from correctly rescored data and only the stored blocks had
        drifted.
        """
        published = [30, 32, 28]
        stored = []
        for run in (1, 2, 3):
            doc = json.loads((EVIDENCE / f"eval_stream_v6_run{run}.json")
                             .read_text(encoding="utf-8"))
            stored.append(doc["summary"]["by_bucket"]["('debug', 'ALL')"]["passed"])
        assert stored == published, (
            f"v6 debug/ALL reads {stored}; READINESS.md publishes {published}")
        assert "30, 32, 28, 35, 30, 26" in READINESS.read_text(encoding="utf-8"), (
            "READINESS no longer publishes the per-run debug figures this cross-check anchors to")

    def test_the_detector_catches_a_perturbed_tally(self):
        """The mutant: move one stored count and the comparison must notice."""
        path = EVIDENCE / "eval_stream_v6_run1.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["summary"]["by_check"]["bug_localisation"]["passed"] = 9
        fresh = tally_from_records(doc)
        assert doc["summary"]["by_check"]["bug_localisation"]["passed"] != \
            fresh["bug_localisation"][0], (
            "perturbing the stored tally did not diverge from the records, so this guard would "
            "not have caught the stale v6 summary")

    def test_the_nine_run_localisation_pool_is_still_373_of_459(self):
        """The published 0.813, recomputed from the summary fields the repair rebuilt."""
        files = sorted(EVIDENCE.glob("eval_stream_v[678]_run*.json"))
        assert len(files) == 9, f"expected the 9-run pool, found {len(files)}"
        rows = [json.loads(p.read_text(encoding="utf-8"))["summary"]["by_check"]["bug_localisation"]
                for p in files]
        passed, n = sum(r["passed"] for r in rows), sum(r["n"] for r in rows)
        assert (passed, n) == (373, 459), f"the pool moved: {passed}/{n}"
        assert round(passed / n, 3) == 0.813
        assert min(r["passed"] for r in rows) == 37
        assert max(r["passed"] for r in rows) == 45


class TestTheSupersededRankingTableSaysSo:
    """Two measured NDCG@10 tables, thirtyfold apart, of two different models. Without a marker
    they read as contradictory readings of one model."""

    def _design(self) -> str:
        return (ROOT / "docs" / "RANKING_DESIGN.md").read_text(encoding="utf-8")

    def test_the_nine_feature_table_is_marked_superseded(self):
        text = self._design()
        preamble = text[:text.index("| LambdaMART | 0.0060 | **0.0059**")][-1400:]
        assert "SUPERSEDED" in preamble, "the 0.0059 table has no supersession marker above it"
        # The marker must name what replaces it, or a reader cannot act on it.
        assert "0.2143" in preamble
        assert "eleven" in preamble.lower()

    def test_the_not_met_verdict_is_scoped_to_the_nine_feature_model(self):
        text = self._design()
        assert "§5.4 WAS NOT MET AT NINE FEATURES" in text
        assert "§5.4 IS NOT MET:" not in text, (
            "the unscoped verdict still reads as the current state of the ranker")

    def test_state_cites_the_document_that_holds_the_current_figure(self):
        text = (ROOT / "docs" / "STATE.md").read_text(encoding="utf-8")
        start = text.index("**§5.2 is met on the research corpus only.**")
        para = text[start:start + 700]
        assert "0.2143" in para
        assert "docs/METRICS.md" in para, "0.2143 is still sourced to the superseded document"

    def test_the_detector_catches_a_removed_marker(self):
        mutated = self._design().replace("SUPERSEDED", "", 1)
        preamble = mutated[:mutated.index("| LambdaMART | 0.0060 | **0.0059**")][-1400:]
        assert "SUPERSEDED" not in preamble, (
            "removing the marker left the guard passing, so it does not guard anything")
