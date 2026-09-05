"""Run the registered experiment end to end. Spec §7.1/§7.2.

    python -m experiments.run            # the ranker experiment, simulated
    python -m experiments.run --degrade  # guardrail check against a deliberately worse arm

EVERY NUMBER THIS PRINTS IS SIMULATED, AND IT SAYS SO ON EVERY LINE
--------------------------------------------------------------------
The platform has 9 users and 2 submissions. Spec §7.1 permits simulating learners when real ones are
unavailable and requires the result be labelled simulated "in every artifact", so the label is
attached to the config (`Experiment.simulated`) and reprinted in the header, the footer and the
verdict rather than mentioned once at the top where it can be scrolled past.

What is real here: the bucketing, the confidence sequence, the sample-size arithmetic, the
interleaving and the guardrail logic are all exercised on data. What is not real: the outcomes.
This demonstrates a working experimentation layer, not a finding about learners.
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from experiments import bucketing, interleaving, sequential  # noqa: E402
from experiments.registry import REGISTRY  # noqa: E402

BANNER = "  [SIMULATED]"


def simulate_arm(n: int, rate: float, rng: random.Random) -> int:
    return sum(1 for _ in range(n) if rng.random() < rate)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--key", default="ranker_lambdamart_vs_difficulty")
    ap.add_argument("--learners", type=int, default=4000)
    ap.add_argument("--true-lift", type=float, default=0.04,
                    help="absolute lift the simulated treatment really has")
    ap.add_argument("--degrade", action="store_true",
                    help="make the treatment worse, to prove the guardrail fires")
    ap.add_argument("--seed", type=int, default=20260813)
    args = ap.parse_args()

    exp = REGISTRY.get(args.key)
    if exp is None:
        print(f"no experiment {args.key!r}; known: {sorted(REGISTRY)}")
        return 2

    rng = random.Random(args.seed)
    print(f"\n  experiment: {exp.key}")
    print(f"  hypothesis: {exp.hypothesis}")
    print(f"  primary:    {exp.primary_metric}")
    print(f"  guardrails: {', '.join(exp.guardrails)}")
    if exp.simulated:
        print(f"{BANNER} {exp.notes}")

    # ── feasibility, before anything is run ──────────────────────────────────
    per_arm = exp.sample_size_per_arm()
    print(f"\n  POWER: {per_arm} learners per arm to detect {exp.mde:+.3f} absolute on a "
          f"{exp.baseline_rate:.2f} baseline at {exp.power:.0%} power, alpha {exp.alpha}")
    ok, why = exp.feasible_with(9)
    print(f"  against the 9 real platform learners: {why}")
    if not ok:
        print("  -> this is why the run below is simulated, and it is arithmetic, not an excuse.")

    # ── bucketing ────────────────────────────────────────────────────────────
    ids = [f"learner-{i:05d}" for i in range(args.learners)]
    assigned = {i: bucketing.assign(i, exp.salt, exp.variants) for i in ids}
    counts: dict[str, int] = {}
    for v in assigned.values():
        counts[v] = counts.get(v, 0) + 1
    print(f"\n  BUCKETING over {args.learners} ids: "
          + ", ".join(f"{k}={v} ({v/args.learners:.1%})" for k, v in sorted(counts.items())))
    # Determinism is the requirement, so it is asserted rather than described.
    again = {i: bucketing.assign(i, exp.salt, exp.variants) for i in ids}
    assert again == assigned, "bucketing is not deterministic"
    print("  re-assignment is identical (deterministic)")

    # ── the primary metric, checked sequentially ─────────────────────────────
    lift = -abs(args.true_lift) if args.degrade else args.true_lift
    n_c, n_t = counts.get("control", 0), counts.get("lambdamart", 0)
    print(f"\n{BANNER} PRIMARY: simulating control at {exp.baseline_rate:.2f}, "
          f"treatment at {exp.baseline_rate + lift:.2f} (true lift {lift:+.3f})")
    print("  peeking after every 500 learners, which a fixed-horizon test would not permit:")
    step = max(500, (min(n_c, n_t) or 1) // 8)
    fired_at = None
    for upto in range(step, min(n_c, n_t) + 1, step):
        s_c = simulate_arm(upto, exp.baseline_rate, rng)
        s_t = simulate_arm(upto, exp.baseline_rate + lift, rng)
        ci = sequential.confidence_sequence(s_c, upto, s_t, upto, alpha=exp.alpha)
        mark = ""
        if ci.excludes_zero and fired_at is None:
            fired_at, mark = upto, "   <- excludes zero"
        print(f"    n={upto:5d}/arm  {ci}{mark}")
    print(f"  stopped at n={fired_at}/arm" if fired_at else
          "  never excluded zero: inconclusive, which is a result and not a failure")

    # ── guardrails ───────────────────────────────────────────────────────────
    print(f"\n{BANNER} GUARDRAILS:")
    for name in exp.guardrails:
        base = 0.20
        delta = 0.12 if args.degrade and name == "abandonment_rate" else rng.uniform(-0.01, 0.01)
        breached = sequential.guardrail_breached(base, base + delta, tolerance=0.05)
        flag = "BREACHED - STOP" if breached else "ok"
        print(f"    {name:34s} {base:.3f} -> {base + delta:.3f}  ({delta:+.3f})  {flag}")

    # ── interleaving ─────────────────────────────────────────────────────────
    print(f"\n{BANNER} INTERLEAVING (no live traffic needed):")
    sessions = []
    irng = random.Random(args.seed + 1)
    for _ in range(400):
        pool = [f"p{i}" for i in range(40)]
        a = irng.sample(pool, 10)
        b = irng.sample(pool, 10)
        # The better ranker's top items get engaged with more often. With --degrade, A is better.
        favoured = a if args.degrade else b
        engaged = {x for x in favoured[:4] if irng.random() < 0.5}
        sessions.append((a, b, engaged))
    result = interleaving.compare(sessions, seed=args.seed,
                                  name_a="difficulty", name_b="lambdamart")
    for k, v in result.items():
        print(f"    {k:22s} {v}")

    print(f"\n{BANNER} Every figure above is simulated. The mechanisms are real and exercised;")
    print(f"{BANNER} the outcomes are not evidence about learners. See docs/METRICS.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
