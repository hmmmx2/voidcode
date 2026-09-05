"""Always-valid confidence sequences, so peeking is allowed. Spec §7.1.

WHY NOT JUST RUN A T-TEST EVERY MORNING
-----------------------------------------
A fixed-horizon 95% interval is valid at ONE pre-committed sample size. Checking it repeatedly and
stopping when it excludes zero inflates the false positive rate badly — with continuous monitoring
the rate tends toward 1, because a random walk crosses any fixed boundary eventually if you keep
looking.

The honest options are to never look until the planned n, or to use a bound that holds at every n
simultaneously. Nobody manages the first, so this implements the second.

A confidence sequence (CS) is a sequence of intervals with

    P( theta lies in CI_t for ALL t >= 1 ) >= 1 - alpha

Note where the "for all" sits: the guarantee covers the whole trajectory, not each look separately.
That is what makes "stop as soon as it excludes zero" a valid decision rule, and it is bought by
intervals that are wider than a fixed-horizon interval at the same n. The width is the price of the
right to peek, and it is a real price — expect to need noticeably more data.

THE BOUND
-----------
Robbins' normal mixture. For observations with variance proxy `sigma^2`, mixing the likelihood ratio
over a normal prior on the effect with tuning parameter `rho` gives a closed-form boundary:

    radius(t) = sigma * sqrt( 2 * (t*rho + 1) / (t^2 * rho) * ln( sqrt(t*rho + 1) / alpha ) )

`rho` sets which sample size the sequence is tightest at; it does not affect validity, only where
the width is spent. Tightness is bought somewhere and paid for elsewhere.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Interval:
    """An always-valid interval for the difference in rates, treatment minus control."""

    estimate: float
    lower: float
    upper: float
    n_control: int
    n_treatment: int

    @property
    def excludes_zero(self) -> bool:
        return self.lower > 0.0 or self.upper < 0.0

    @property
    def verdict(self) -> str:
        """What this interval licenses saying. Deliberately blunt.

        "inconclusive" is the honest default and the most common real outcome. An experiment that
        cannot distinguish its arms has not shown they are equivalent — that needs a bound tight
        enough to exclude the effect you would care about, which is a different claim.
        """
        if self.lower > 0:
            return "treatment better"
        if self.upper < 0:
            return "treatment worse"
        return "inconclusive"

    def __str__(self) -> str:
        return (f"{self.estimate:+.4f} [{self.lower:+.4f}, {self.upper:+.4f}] "
                f"n={self.n_control}/{self.n_treatment} -> {self.verdict}")


def radius(n: int, sigma: float, *, alpha: float = 0.05, rho: float = 1.0) -> float:
    """Half-width of the Robbins normal-mixture boundary at sample size `n`.

    Grows without bound as n -> 0, which is correct: two observations license nothing.
    """
    if n <= 0:
        return float("inf")
    inner = math.sqrt(n * rho + 1.0) / alpha
    if inner <= 1.0:
        return float("inf")
    return sigma * math.sqrt(2.0 * (n * rho + 1.0) / (n * n * rho) * math.log(inner))


def confidence_sequence(control_successes: int, control_n: int,
                        treatment_successes: int, treatment_n: int,
                        *, alpha: float = 0.05, rho: float = 1.0) -> Interval:
    """Always-valid interval for (treatment rate - control rate).

    Safe to call after every observation. The variance proxy is the pooled Bernoulli variance of the
    difference; Bernoulli outcomes are bounded in [0,1] so this is a legitimate sub-Gaussian proxy
    rather than an assumption about normality of the data.
    """
    if control_n < 0 or treatment_n < 0:
        raise ValueError("counts cannot be negative")
    if control_successes > control_n or treatment_successes > treatment_n:
        raise ValueError("successes cannot exceed trials")
    if control_n == 0 or treatment_n == 0:
        return Interval(0.0, -float("inf"), float("inf"), control_n, treatment_n)

    p_c = control_successes / control_n
    p_t = treatment_successes / treatment_n
    diff = p_t - p_c

    var = p_c * (1 - p_c) / control_n + p_t * (1 - p_t) / treatment_n
    # A degenerate arm (every outcome identical) has zero sample variance, which would produce a
    # zero-width interval and a confident verdict from no information. Floor it at the variance of
    # a fair coin scaled by n, which is the most uninformative assumption available.
    floor = 0.25 / control_n + 0.25 / treatment_n
    sigma = math.sqrt(max(var, floor * 1e-6))

    n_eff = min(control_n, treatment_n)
    r = radius(n_eff, sigma * math.sqrt(n_eff), alpha=alpha, rho=rho)
    return Interval(diff, diff - r, diff + r, control_n, treatment_n)


def guardrail_breached(control_rate: float, treatment_rate: float, *,
                       tolerance: float = 0.05, higher_is_worse: bool = True) -> bool:
    """Has a guardrail moved beyond tolerance in the bad direction?

    Separate from the primary test on purpose. A guardrail is not a hypothesis under test — the
    question is not "did it move significantly" but "did it move enough to stop", and holding it to
    a significance bar means a real regression is tolerated until it is provable.
    """
    delta = treatment_rate - control_rate
    return delta > tolerance if higher_is_worse else delta < -tolerance
