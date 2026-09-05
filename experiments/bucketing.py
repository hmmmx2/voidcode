"""Deterministic variant assignment. Spec §7.1.

The requirement is one sentence — "the same learner must always land in the same variant for a given
experiment" — and it rules out most of the obvious implementations.

NEVER USE PYTHON'S `hash()`
----------------------------
`hash()` on a str is **salted per process** (PYTHONHASHSEED, on by default since 3.3). Bucketing on
it reassigns every learner on every restart and on every worker independently, so a learner sees
variant A on one request and B on the next, an experiment's arms silently mix, and the effect
measured is diluted toward zero by an unknown amount.

It fails in the most expensive possible way: the code looks right, the split looks 50/50, and only
the effect size is wrong. `sha256` is stable across processes, machines and Python versions.

THE SALT IS PER EXPERIMENT, AND THAT IS THE POINT
---------------------------------------------------
Hashing the learner id alone would put the same learners in the same arm of every experiment
forever. Any learner-level quirk then correlates across experiments, so a fluke in one shows up
again in the next and looks like replication.

Mixing an experiment-specific salt decorrelates the assignments, which is what makes two experiments
independent rather than merely separate.
"""
from __future__ import annotations

import hashlib

#: Resolution of the bucket space. 10,000 lets a traffic split be specified to a basis point, which
#: is finer than any split this platform will need and costs nothing.
BUCKETS = 10_000


def bucket_of(learner_id: str, salt: str, *, buckets: int = BUCKETS) -> int:
    """Stable bucket in [0, buckets). Pure, and identical on every machine.

    The digest is read as a big-endian integer rather than via `hash()`; see the module docstring.
    """
    if not learner_id:
        raise ValueError("learner_id must be non-empty; an empty id would collapse to one bucket")
    if not salt:
        raise ValueError("salt must be non-empty; without it every experiment shares an assignment")
    digest = hashlib.sha256(f"{salt}:{learner_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % buckets


def assign(learner_id: str, salt: str, split: dict[str, float], *,
           buckets: int = BUCKETS) -> str:
    """The variant this learner belongs to, for this experiment.

    `split` maps variant name to its share of traffic and must sum to 1. Variants are sorted by name
    before the ranges are laid out, so the assignment does not depend on dict insertion order —
    otherwise re-declaring the same config in a different order would silently reassign everyone.
    """
    if not split:
        raise ValueError("split is empty")
    total = sum(split.values())
    if abs(total - 1.0) > 1e-9:
        raise ValueError(f"traffic split must sum to 1.0, got {total}")
    if any(v < 0 for v in split.values()):
        raise ValueError("traffic split has a negative share")

    b = bucket_of(learner_id, salt, buckets=buckets)
    edge = 0.0
    for name in sorted(split):                      # sorted: order-independent, see docstring
        edge += split[name]
        if b < edge * buckets:
            return name
    return sorted(split)[-1]                        # float dust at the top edge


def holdout(learner_id: str, salt: str, fraction: float, *, buckets: int = BUCKETS) -> bool:
    """Is this learner in a global holdout, excluded from every experiment?

    Uses a fixed salt of its own so membership is stable no matter which experiments exist, which is
    what makes a holdout a long-run baseline rather than a per-experiment control.
    """
    if not 0.0 <= fraction <= 1.0:
        raise ValueError(f"fraction must be in [0, 1], got {fraction}")
    return bucket_of(learner_id, f"holdout:{salt}", buckets=buckets) < fraction * buckets
