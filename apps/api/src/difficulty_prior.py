"""A cold-start P(solve) for platform problems. V4.

WHY NOT THE CODEFORCES MODEL, WHICH IS THE OBVIOUS THING TO REACH FOR
-----------------------------------------------------------------------
The warehouse holds a fitted Rasch model — 117,453 learner abilities, 11,284 problem difficulties,
and an isotonic calibration map that takes out-of-fold ECE from 0.0138 to 0.0001. All of it is
**World A**: competitive DSA problems from Codeforces.

The platform catalogue is **World B**: ML, CUDA, VLM and transformer items. The two share no
identifier, and no Codeforces problem corresponds to "implement FlashAttention in Triton". Assigning
one would invent the input, and P(solve) would come back as a confident, plausible, wrong float that
nothing downstream could detect — this project's signature failure applied to a number learners act
on.

So this module derives difficulty from what the platform **actually has**.

THIS IS A PRIOR. IT IS NOT A MEASUREMENT, AND THE DIFFERENCE IS NOT COSMETIC
------------------------------------------------------------------------------
The logit spacing below is **chosen, not fitted**. Nothing in this repo measures how much harder a
`hard` item is than a `medium` one, because that needs platform submissions and there are two.

What that means in practice: the ORDER these probabilities induce is trustworthy (a hard problem
ranks below an easy one for the same learner, monotonically), and the ABSOLUTE values are a
placeholder with the right shape. Present them as "likely / stretch", never as "you have a 27%
chance" — the second claim requires the fit in `platform_irt_ready()` below, which needs data that
does not exist yet.

WHY THE WORLD A CALIBRATION MAP MUST NOT BE APPLIED HERE
-----------------------------------------------------------
`apps/api/data/calibration_map.json` corrects `sigmoid(theta - beta)` for the Codeforces fit, and it
is a *good* map — measured out-of-fold over 1.32M rows. Applying it to these numbers would be the
same transfer error in a subtler costume: it encodes how the Codeforces Rasch fit is miscalibrated,
which says nothing about how a chosen ML difficulty spacing is miscalibrated. `test_world_a_map_is_
not_applied` pins this so a later refactor cannot quietly reintroduce it.
"""
from __future__ import annotations

import math

#: Difficulty on the logit scale. One unit per step, so each step multiplies the odds by e (~2.7).
#:
#: CHOSEN, NOT FITTED. Equal spacing is the assumption you make when you have no evidence about the
#: real gaps — it asserts only "hard is harder than medium is harder than easy", which is the one
#: thing the enum genuinely tells us. Fitting these needs platform submissions; see
#: `platform_irt_ready`.
BETA_BY_DIFFICULTY = {"easy": -1.0, "medium": 0.0, "hard": 1.0}

#: Mastery of exactly 0 or 1 would make theta infinite. Clamping caps ability at roughly +/-3.9
#: logits, which is already past the range any of this data can support.
_MASTERY_FLOOR, _MASTERY_CEIL = 0.02, 0.98

#: Below this many observations a per-problem difficulty cannot be estimated, so the prior stands.
#: Same threshold as `quality/contracts.MIN_OBSERVATIONS_FOR_BETA`, deliberately — one number, one
#: meaning, across the Python contracts and the serving path.
MIN_OBSERVATIONS_FOR_FIT = 7


def theta_from_mastery(mastery: float | None) -> float:
    """Learner ability on the logit scale, from their per-concept mastery.

    `None` means the learner has never attempted this concept, and maps to **0.0 — the population
    midpoint, not zero ability**. Those are opposite claims: 0.0 says "no evidence, assume typical",
    while low ability would say "measured, and weak". A new learner must not be told every problem
    is beyond them.
    """
    if mastery is None:
        return 0.0
    m = min(max(float(mastery), _MASTERY_FLOOR), _MASTERY_CEIL)
    return math.log(m / (1.0 - m))


def beta_for(difficulty: str | None) -> float:
    """Problem difficulty on the logit scale. Unknown difficulty falls back to `medium`."""
    return BETA_BY_DIFFICULTY.get((difficulty or "").strip().lower(), 0.0)


def solve_probability(mastery: float | None, difficulty: str | None) -> float:
    """Prior P(solve) = sigmoid(theta - beta). Always a float in [0, 1].

    A useful identity for reading these numbers: on a **medium** problem beta is 0, so the result is
    exactly the learner's mastery. `easy` and `hard` shift it by one logit either way. That is the
    whole model, and stating it plainly is the point — anyone reading a number here can reconstruct
    where it came from without opening the code.
    """
    z = theta_from_mastery(mastery) - beta_for(difficulty)
    return 1.0 / (1.0 + math.exp(-max(min(z, 30.0), -30.0)))


def platform_irt_ready(observations_by_problem: dict | None) -> bool:
    """Is there enough platform evidence to replace the prior with a fitted Rasch difficulty?

    Takes the observation counts rather than reading a table so it stays pure and testable, and so
    the caller decides what an observation is.

    The switch must be **visible in the API response**, never silent: a learner's probability moving
    because the model changed underneath them is exactly the kind of change that is impossible to
    debug after the fact.
    """
    if not observations_by_problem:
        return False
    return any(n >= MIN_OBSERVATIONS_FOR_FIT for n in observations_by_problem.values())


def status() -> dict:
    """What this module is doing, for the diagnostics endpoint.

    `basis` is the field that matters. It says `"prior"` today and must say `"platform_irt"` before
    any absolute probability is quoted to a learner.
    """
    return {
        "basis": "prior",
        "calibrated": False,
        "beta_by_difficulty": dict(BETA_BY_DIFFICULTY),
        "min_observations_for_fit": MIN_OBSERVATIONS_FOR_FIT,
        "reason": ("difficulty spacing is chosen, not fitted -- the platform has too few "
                   "submissions to estimate it. Ranking order is meaningful; absolute values "
                   "are a placeholder. World A (Codeforces) parameters are deliberately not used."),
    }
