"""Apply the frozen isotonic calibration map. Produced by `features/export_calibration.py`.

Pure standard library on purpose: `bisect` and `json`, no numpy and no scikit-learn. The map is a
non-decreasing step function, so applying it is a binary search and a linear interpolation, and the
API image does not need to carry a modelling stack to serve a probability.

WHAT THIS MODULE REFUSES TO DO
--------------------------------
`sigmoid(theta - beta)` is not a probability until it has been through this map. Measured out-of-fold
over 1,320,382 rows, the raw value is miscalibrated in EVERY decile — ECE 0.0138, and all ten buckets
sit outside their own 2*se — and after the map none of them do (ECE 0.0001).

So when the map is missing, or the caller has no theta/beta to feed it, `solve_probability` returns
`None`. It does NOT fall back to the raw sigmoid. That fallback is the tempting one and it is the
project's dominant failure mode: a plausible number served confidently, indistinguishable from a
correct one, with nothing downstream able to tell. A null propagates to the client as an absent field
and the UI shows nothing, which is recoverable.

WHY IT CURRENTLY RESOLVES FOR NOBODY, WHICH IS THE HONEST STATE AND NOT A BUG
------------------------------------------------------------------------------
theta and beta are fitted on World A: Codeforces handles and Codeforces problem ids. The product
catalogue is World B, whose `difficulty` is the enum easy|medium|hard. **No platform problem has a
Codeforces id and no platform user has a handle**, so `warehouse_ids()` finds nothing and every
`solve_probability` call returns None today.

That is deliberate. The alternative is to map "medium" onto a beta from the Codeforces distribution,
which invents the input; docs/STATE.md records that no model fitted on World A transfers to World B.
This module is wired into the live request path so the guard is exercised and tested rather than
sitting in a branch nobody runs — and the day platform problems carry an estimated beta, the only
change needed is in `warehouse_ids()`.
"""
from __future__ import annotations

import json
import logging
import math
import os
from bisect import bisect_right
from dataclasses import dataclass
from functools import lru_cache
from itertools import pairwise
from pathlib import Path

log = logging.getLogger(__name__)

#: Must match `features.export_calibration.SCHEMA_VERSION`. A map written under a different version
#: had a different meaning, so it is refused rather than applied — a silently-applied stale mapping
#: would look exactly like a working one.
SUPPORTED_SCHEMA_VERSION = 1

_DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "calibration_map.json"


@dataclass(frozen=True)
class CalibrationMap:
    """A non-decreasing step function plus the provenance needed to audit what it is."""

    xs: tuple[float, ...]
    ys: tuple[float, ...]
    model: str
    domain: str
    n_observations: int
    ece_before: float
    ece_after: float

    def apply(self, raw: float) -> float:
        """Map a raw sigmoid(theta - beta) to a calibrated probability.

        Linear interpolation between knots. Inputs outside the fitted range clamp to the end knots,
        matching the `out_of_bounds="clip"` the map was fitted with — extrapolating a monotone fit
        past its support invents behaviour the data never showed.
        """
        x = min(max(float(raw), 0.0), 1.0)
        i = bisect_right(self.xs, x)
        if i == 0:
            return self.ys[0]
        if i >= len(self.xs):
            return self.ys[-1]
        x0, x1 = self.xs[i - 1], self.xs[i]
        y0, y1 = self.ys[i - 1], self.ys[i]
        if x1 == x0:
            return y1
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


@lru_cache(maxsize=1)
def load_map(path: str | None = None) -> CalibrationMap | None:
    """Load and validate the artifact. Returns None — never raises — if it is absent or unusable.

    Cached: the file is a few KB of immutable configuration, so re-reading it per request would be
    waste. A deploy that replaces it restarts the process.

    Every failure is logged at WARNING with the reason. A silent None here would be indistinguishable
    from "this learner has no data", and those need different fixes.
    """
    target = Path(path or os.environ.get("VC_CALIBRATION_PATH") or _DEFAULT_PATH)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        log.warning("calibration map absent at %s; solve probabilities will be omitted", target)
        return None
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("calibration map at %s is unreadable (%s); omitting probabilities", target, exc)
        return None

    version = raw.get("schema_version")
    if version != SUPPORTED_SCHEMA_VERSION:
        log.warning("calibration map schema %r != supported %d; refusing to apply it",
                    version, SUPPORTED_SCHEMA_VERSION)
        return None

    xs = [float(v) for v in raw.get("knots", {}).get("x", [])]
    ys = [float(v) for v in raw.get("knots", {}).get("y", [])]
    if len(xs) < 2 or len(xs) != len(ys):
        log.warning("calibration map has %d x and %d y knots; refusing to apply it", len(xs), len(ys))
        return None
    # Monotonicity is the property that makes this safe to apply to anything that RANKS on these
    # values: a non-monotone map would reorder recommendations and silently invalidate the measured
    # NDCG. Checked on load rather than assumed, because the file is hand-editable.
    # `pairwise`, not `zip(xs, xs[1:])`. The zip form once carried `strict=True`, which raises
    # ValueError UNCONDITIONALLY here — the two arguments differ in length by one by construction —
    # and because nothing catches ValueError the exception escaped load_map and would have 500'd the
    # endpoint instead of degrading to a null probability, the opposite of this module's purpose.
    # Removing `strict=` fixed it but left a zip that a linter will keep asking to make strict.
    # `pairwise` says "successive pairs" outright, so the question cannot be asked again.
    if any(b < a for a, b in pairwise(xs)):
        log.warning("calibration map x knots are not sorted; refusing to apply it")
        return None
    if any(b < a - 1e-9 for a, b in pairwise(ys)):
        log.warning("calibration map is not monotone; refusing to apply it (it would reorder ranks)")
        return None

    measured = raw.get("measured", {})
    return CalibrationMap(
        xs=tuple(xs), ys=tuple(ys),
        model=str(raw.get("model", "unknown")),
        domain=str(raw.get("domain", "unknown")),
        n_observations=int(raw.get("n_observations", 0)),
        ece_before=float(measured.get("ece_before", float("nan"))),
        ece_after=float(measured.get("ece_after", float("nan"))),
    )


def warehouse_ids(problem_slug: str, user_id: str) -> tuple[int, int] | None:
    """Resolve a platform (problem, user) to the World A indices theta/beta are keyed by.

    Returns None for everything today, and that is the correct answer rather than a stub: the
    platform catalogue carries no Codeforces problem id and platform users carry no handle. See the
    module docstring — inventing the mapping is the one thing that must not happen here.

    This is the single place to change when platform problems gain an estimated difficulty. Keeping
    it as a named function rather than an inline `return None` is what makes that reachable.
    """
    return None


def solve_probability(raw_logit_difference: float | None) -> float | None:
    """Calibrated P(solve) from (theta - beta), or None when it cannot be computed honestly.

    Takes the DIFFERENCE rather than a raw probability so the sigmoid and the calibration stay in one
    place; a caller that computed its own sigmoid would be free to skip the map.
    """
    if raw_logit_difference is None:
        return None
    cal = load_map()
    if cal is None:
        return None
    return cal.apply(1.0 / (1.0 + math.exp(-max(min(raw_logit_difference, 30.0), -30.0))))


def status() -> dict:
    """Machine-readable state of the calibration, for the diagnostics endpoint.

    Exists so "is calibration live?" is answerable from outside the process. Eleven make targets and
    a whole `.env` file in this project were configured and never read; a loaded-or-not flag that can
    be queried is the cheap defence against this becoming the twelfth.
    """
    cal = load_map()
    if cal is None:
        return {"available": False,
                "reason": "calibration map missing, stale, or not monotone; see server logs",
                "probabilities_served": False}
    return {
        "available": True,
        "model": cal.model,
        "domain": cal.domain,
        "n_observations": cal.n_observations,
        "ece_before": cal.ece_before,
        "ece_after": cal.ece_after,
        "knots": len(cal.xs),
        # Distinguishes "the map is loaded" from "this map produced the number you are reading",
        # which are different and would otherwise both read as success.
        "probabilities_served": False,
        "reason": ("theta/beta and this map are fitted on Codeforces (World A) identifiers, and no "
                   "platform problem or user resolves to one. Platform solve probabilities come "
                   "from difficulty_prior instead, and this map is deliberately NOT applied to "
                   "them — it encodes how the Codeforces Rasch fit is miscalibrated, which says "
                   "nothing about a chosen ML difficulty spacing"),
    }
