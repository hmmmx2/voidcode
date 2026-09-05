"""Tests for apps/api/src/calibration.py.

The theme is that every failure must produce None rather than a number. `sigmoid(theta - beta)` is
miscalibrated in every decile before the map is applied, so a fallback to the raw value would serve a
wrong probability that looks exactly like a right one — the failure mode this project keeps finding.
So the refusals get more tests than the happy path.

`load_map` is `lru_cache`d, so every test that swaps the artifact must clear it. A stale cached map
would make these pass in isolation and fail in a different order, or worse, pass for the wrong reason.
"""
from __future__ import annotations

import json
import math
from itertools import pairwise
from pathlib import Path

import pytest
from src import calibration

SHIPPED = Path(__file__).resolve().parents[1] / "data" / "calibration_map.json"


@pytest.fixture(autouse=True)
def _clear_cache():
    calibration.load_map.cache_clear()
    yield
    calibration.load_map.cache_clear()


def write_map(tmp_path: Path, **overrides) -> str:
    body = {
        "schema_version": calibration.SUPPORTED_SCHEMA_VERSION,
        "model": "test", "domain": "test", "n_observations": 100,
        "measured": {"ece_before": 0.02, "ece_after": 0.001},
        "knots": {"x": [0.0, 0.5, 1.0], "y": [0.1, 0.4, 0.9]},
    }
    body.update(overrides)
    path = tmp_path / "map.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return str(path)


# ── the shipped artifact ─────────────────────────────────────────────────────

@pytest.mark.skipif(not SHIPPED.exists(), reason="calibration map not exported")
def test_shipped_map_loads_and_improves_calibration():
    """The artifact in the tree must be loadable and must record a real improvement.

    `ece_after < ece_before` is asserted because the exporter's first version shipped knots whose
    interpolation made MCE twice as bad while still recording an improved ECE. This is the check that
    a regenerated artifact is not silently worse.
    """
    cal = calibration.load_map(str(SHIPPED))
    assert cal is not None
    assert cal.ece_after < cal.ece_before
    assert len(cal.xs) >= 2


@pytest.mark.skipif(not SHIPPED.exists(), reason="calibration map not exported")
def test_shipped_map_is_monotone_so_it_cannot_reorder_recommendations():
    """The property behind "applying calibration changes no ranking". Asserted on the shipped file,
    not just on the fitter, because the file is hand-editable and is what actually gets applied."""
    cal = calibration.load_map(str(SHIPPED))
    probs = [cal.apply(i / 200) for i in range(201)]
    # `pairwise`, matching calibration.py: a zip over one sequence has mismatched
    # lengths by construction, so `strict=True` on it would raise unconditionally.
    assert all(b >= a - 1e-9 for a, b in pairwise(probs))


# ── refusals: each must yield None, never a number ───────────────────────────

def test_missing_file_yields_none_not_a_raw_sigmoid(monkeypatch, tmp_path):
    """The central guard. A missing map must not degrade to the uncalibrated probability."""
    monkeypatch.setenv("VC_CALIBRATION_PATH", str(tmp_path / "nope.json"))
    assert calibration.load_map() is None
    assert calibration.solve_probability(0.0) is None      # raw sigmoid(0) would be 0.5
    assert calibration.solve_probability(3.0) is None
    assert calibration.status()["available"] is False


def test_unknown_schema_version_is_refused(monkeypatch, tmp_path):
    """A map written under different semantics is worse than none, because it applies cleanly."""
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path, schema_version=999))
    assert calibration.load_map() is None


def test_non_monotone_map_is_refused(monkeypatch, tmp_path):
    """A decreasing segment would reorder recommendations and invalidate the measured NDCG."""
    monkeypatch.setenv("VC_CALIBRATION_PATH",
                       write_map(tmp_path, knots={"x": [0.0, 0.5, 1.0], "y": [0.1, 0.9, 0.4]}))
    assert calibration.load_map() is None


def test_unsorted_x_knots_are_refused(monkeypatch, tmp_path):
    """bisect assumes a sorted sequence; unsorted knots would interpolate against the wrong segment
    and produce plausible garbage rather than an error."""
    monkeypatch.setenv("VC_CALIBRATION_PATH",
                       write_map(tmp_path, knots={"x": [0.0, 1.0, 0.5], "y": [0.1, 0.4, 0.9]}))
    assert calibration.load_map() is None


@pytest.mark.parametrize("knots", [
    {"x": [0.5], "y": [0.5]},                    # too few to interpolate
    {"x": [0.0, 1.0], "y": [0.5]},               # mismatched lengths
    {"x": [], "y": []},
], ids=["single-knot", "length-mismatch", "empty"])
def test_malformed_knots_are_refused(monkeypatch, tmp_path, knots):
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path, knots=knots))
    assert calibration.load_map() is None


def test_corrupt_json_is_refused_without_raising(monkeypatch, tmp_path):
    """A truncated deploy must not 500 the recommendations endpoint."""
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("VC_CALIBRATION_PATH", str(bad))
    assert calibration.load_map() is None


# ── applying the map ─────────────────────────────────────────────────────────

def test_apply_interpolates_linearly_between_knots(monkeypatch, tmp_path):
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path))
    cal = calibration.load_map()
    assert cal.apply(0.0) == pytest.approx(0.1)
    assert cal.apply(0.5) == pytest.approx(0.4)
    assert cal.apply(0.25) == pytest.approx(0.25)          # midway between 0.1 and 0.4
    assert cal.apply(0.75) == pytest.approx(0.65)


def test_apply_clamps_outside_the_fitted_range(monkeypatch, tmp_path):
    """Matches the `out_of_bounds="clip"` the map was fitted with. Extrapolating a monotone fit past
    its support would invent behaviour the data never showed."""
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path))
    cal = calibration.load_map()
    assert cal.apply(-5.0) == pytest.approx(0.1)
    assert cal.apply(5.0) == pytest.approx(0.9)


def test_solve_probability_applies_the_sigmoid_then_the_map(monkeypatch, tmp_path):
    """The function takes theta - beta, not a probability, so the sigmoid and the correction cannot
    be applied separately or skipped."""
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path))
    diff = 0.7
    expected = calibration.load_map().apply(1.0 / (1.0 + math.exp(-diff)))
    assert calibration.solve_probability(diff) == pytest.approx(expected)
    assert calibration.solve_probability(None) is None


def test_solve_probability_survives_extreme_inputs(monkeypatch, tmp_path):
    """The clamp at +-30 exists so a runaway beta cannot raise OverflowError in math.exp."""
    monkeypatch.setenv("VC_CALIBRATION_PATH", write_map(tmp_path))
    for diff in (-1e6, -50.0, 50.0, 1e6):
        assert 0.0 <= calibration.solve_probability(diff) <= 1.0


# ── the World A / World B boundary ───────────────────────────────────────────

def test_no_platform_identifier_resolves_into_world_a():
    """The honest state, asserted rather than left as a comment.

    theta/beta are keyed by Codeforces handles and problem ids. If this ever starts returning a value
    for an arbitrary platform slug, someone has invented a mapping, and every solve probability
    downstream became a fabricated number.
    """
    assert calibration.warehouse_ids("iq-compute-metrics-from-confusion", "some-uuid") is None
    assert calibration.warehouse_ids("two-sum", "another-uuid") is None


@pytest.mark.skipif(not SHIPPED.exists(), reason="calibration map not exported")
def test_status_separates_loaded_from_actually_served():
    """`available` and `probabilities_served` must not collapse into one field: the map is loaded and
    correct while no request receives a number, and reporting that as success is how a wired-but-inert
    feature gets mistaken for a working one."""
    st = calibration.status()
    assert st["available"] is True
    assert st["probabilities_served"] is False
    assert "codeforces" in st["reason"].lower()
