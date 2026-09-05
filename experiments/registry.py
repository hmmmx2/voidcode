"""Experiment configuration, and the power calculation that decides whether to run at all. Spec §7.1.

An experiment declares what it is testing BEFORE it runs. That is the whole function of a registry:
a primary metric chosen after seeing the data is not a result, and guardrails added afterwards are
not guardrails. Writing them down first is what makes the analysis confirmatory.

THE SAMPLE SIZE CALCULATOR IS THE MOST USEFUL THING HERE
----------------------------------------------------------
`required_sample_size` usually answers "you cannot detect that with this much traffic", and knowing
it in advance is worth more than any analysis run afterwards. With 9 users this platform cannot run
a live experiment at all, and the calculator says so numerically rather than as an opinion.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

#: Spec §7.1 fixes the primary metric. Kept as a constant so an experiment cannot quietly redefine
#: it, which is the most common way an A/B result stops meaning what it claims.
PRIMARY_METRIC = "completion_rate_7d"

#: Also from the spec. A guardrail is a metric you are NOT trying to move and will stop for.
GUARDRAILS = ("abandonment_rate", "median_time_to_first_submission_s", "error_rate")


def _z(p: float) -> float:
    """Inverse standard normal CDF. Acklam's rational approximation, |error| < 1.15e-9.

    Written out rather than pulled from scipy because this module is imported by the API test suite,
    which does not install scipy, and a power calculation that cannot run in CI is one nobody runs.
    """
    if not 0.0 < p < 1.0:
        raise ValueError(f"p must be in (0, 1), got {p}")
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def required_sample_size(baseline_rate: float, mde: float, *,
                         power: float = 0.8, alpha: float = 0.05) -> int:
    """Learners PER ARM for a two-proportion test.

    `mde` is ABSOLUTE, not relative: 0.05 against a baseline of 0.30 means detecting 0.35. Relative
    and absolute effects get confused constantly and the difference is a factor of several in n.

    This is the FIXED-HORIZON number. The sequential test in `sequential.py` trades some efficiency
    for the right to peek, so it needs somewhat more data at the same power — use this as the floor,
    not as the stopping rule.
    """
    if not 0.0 < baseline_rate < 1.0:
        raise ValueError(f"baseline_rate must be in (0, 1), got {baseline_rate}")
    if mde <= 0:
        raise ValueError("mde must be positive")
    treated = baseline_rate + mde
    if not 0.0 < treated < 1.0:
        raise ValueError(f"baseline_rate + mde = {treated} is outside (0, 1)")
    z_a = _z(1 - alpha / 2)
    z_b = _z(power)
    var = baseline_rate * (1 - baseline_rate) + treated * (1 - treated)
    return math.ceil((z_a + z_b) ** 2 * var / (mde ** 2))


@dataclass(frozen=True)
class Experiment:
    """One declared experiment. Frozen: a config that changes mid-run invalidates the analysis."""

    key: str
    hypothesis: str
    variants: dict[str, float]
    primary_metric: str = PRIMARY_METRIC
    guardrails: tuple[str, ...] = GUARDRAILS
    mde: float = 0.05
    baseline_rate: float = 0.30
    power: float = 0.8
    alpha: float = 0.05
    #: Set when the arms are served by a behaviour model rather than by learners. Spec §7.1 permits
    #: simulation and requires it be labelled "in every artifact" — carrying the flag on the config
    #: is how that label reaches every downstream report without anyone remembering to add it.
    simulated: bool = False
    notes: str = ""
    _: dict = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if len(self.variants) < 2:
            raise ValueError(f"{self.key}: an experiment needs at least two variants")
        total = sum(self.variants.values())
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"{self.key}: traffic split sums to {total}, not 1.0")
        if "control" not in self.variants:
            raise ValueError(f"{self.key}: no variant named 'control'; the comparison needs a base")
        if self.primary_metric in self.guardrails:
            raise ValueError(
                f"{self.key}: {self.primary_metric!r} is both the primary metric and a guardrail. "
                "A metric you are trying to move cannot also be one you stop for.")

    @property
    def salt(self) -> str:
        return f"experiment:{self.key}"

    def sample_size_per_arm(self) -> int:
        return required_sample_size(self.baseline_rate, self.mde,
                                    power=self.power, alpha=self.alpha)

    def feasible_with(self, available_learners: int) -> tuple[bool, str]:
        """Can this run at all on the traffic available? Returns (verdict, reason).

        Called before an experiment starts. An experiment run under its required sample size does
        not produce a weak answer, it produces a coin flip dressed as an answer.
        """
        need = self.sample_size_per_arm() * len(self.variants)
        if available_learners >= need:
            return True, f"{available_learners} learners available, {need} needed"
        return False, (
            f"NOT FEASIBLE: needs {need} learners ({self.sample_size_per_arm()} per arm x "
            f"{len(self.variants)} arms) to detect a {self.mde:+.3f} absolute change on a "
            f"{self.baseline_rate:.2f} baseline at {self.power:.0%} power; {available_learners} "
            "are available.")


#: The experiment spec §7.1 names: LambdaMART against the difficulty-sorted baseline.
RANKER_EXPERIMENT = Experiment(
    key="ranker_lambdamart_vs_difficulty",
    hypothesis=("LambdaMART ranking raises 7-day problem completion rate over a difficulty-sorted "
                "baseline."),
    variants={"control": 0.5, "lambdamart": 0.5},
    mde=0.05,
    baseline_rate=0.30,
    simulated=True,
    notes=("SIMULATED. The platform has 9 users and 2 submissions, so no live arm is possible. "
           "Spec §7.1 permits simulating learners from a behaviour model fitted on the public "
           "corpus and requires the result be labelled simulated in every artifact."),
)

REGISTRY: dict[str, Experiment] = {RANKER_EXPERIMENT.key: RANKER_EXPERIMENT}
