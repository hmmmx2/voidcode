"""Concept co-failure association rules. Spec §4.3a.

Run:  VC_WAREHOUSE=... python -m features.mine

Which concepts fail together? A rule like `backpropagation -> autograd` with lift above 1 says a
learner failing the first is likelier than chance to fail the second, which is exactly the signal
`features/candidates.py`'s prerequisite walk is built on — and until now that walk rested entirely on
a hand-written DAG with nothing measured behind it.

WHY EXHAUSTIVE PAIRS RATHER THAN FP-GROWTH
--------------------------------------------
Spec §4.3a names FP-Growth. FP-Growth is an efficiency algorithm: it avoids enumerating candidate
itemsets when there are thousands of items and the lattice is intractable. There are **67 observed
concepts** here, so all 2,211 pairs fit in memory and compute exactly in seconds.

Running FP-Growth on 67 items would be slower to write, slower to verify, and would produce the same
rules — with the added cost of a pyspark dependency that is not installed. The honest version is the
exact computation plus this paragraph, rather than the named algorithm and a claim that it was
necessary. If the concept count ever reaches the thousands, swap the enumeration for
`pyspark.ml.fpm.FPGrowth`; the metrics and thresholds below are unchanged by that.

WHY THE OUTPUT IS A REVIEW FILE AND NOT A DAG EDIT
----------------------------------------------------
`features/taxonomy.py` validates that `data/concepts.yaml` is acyclic and the prerequisite edges are
hand-curated and reviewed. Auto-inserting mined edges would silently change what every learner sees,
could introduce a cycle the validator would then reject at load, and would mix measured correlation
with intended pedagogy in one file nobody can untangle afterwards.

So this emits rules grouped against the existing DAG — agrees, contradicts, or is absent — following
the `docs/TAG_REVIEW.md` pattern. Correlation is not prerequisite: two concepts fail together because
one needs the other, OR because both are hard, OR because they appear in the same problems. Only a
person can tell those apart.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: Spec §4.3a's threshold. Lift is P(B|A) / P(B): above 1 means A raises the odds of B, and 1.5 is
#: "half again as likely", which is a real effect rather than a rounding artefact.
MIN_LIFT = 1.5

#: A rule needs to describe enough learners to act on. 0.5% of ~59k learners is ~300 — below that the
#: confidence estimate is noise.
MIN_SUPPORT = 0.005

#: A learner needs some failures for their failure SET to mean anything. With one failed concept there
#: is no co-occurrence to observe.
MIN_FAILED_CONCEPTS = 2


def _utf8_stdout() -> None:
    """See analysis/calibration.py — cp1252 makes an em dash fatal under a redirected stdout."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def failed_concept_sets(warehouse: str, max_pass_rate: float = 0.5) -> pd.DataFrame:
    """One row per (learner, concept) the learner is FAILING at.

    "Failing" is a pass rate at or below `max_pass_rate` on a concept they have actually attempted —
    not "never attempted", which is absence of evidence rather than failure. That distinction is the
    same one `mastery_known` encodes in the ranker, and collapsing it here would fill every rule with
    concepts the learner has simply not reached.
    """
    mastery = pd.read_parquet(
        os.path.join(warehouse, "gold_learner_concept_mastery"),
        columns=["learner_id", "concept_id", "pass_rate", "attempt_count"])
    failing = mastery[(mastery.attempt_count >= 1) & (mastery.pass_rate <= max_pass_rate)]
    sizes = failing.groupby("learner_id").size()
    keep = sizes[sizes >= MIN_FAILED_CONCEPTS].index
    return failing[failing.learner_id.isin(keep)][["learner_id", "concept_id"]]


def association_rules(sets: pd.DataFrame) -> pd.DataFrame:
    """Support, confidence and lift for every ordered concept pair.

    Computed from a co-occurrence matrix rather than by iterating learners: 59k learners x 2,211 pairs
    in Python is minutes, and one matrix multiply is milliseconds for the identical answer.
    """
    codes = sets.concept_id.astype("category")
    concepts = list(codes.cat.categories)
    learners = sets.learner_id.astype("category")

    # Learner x concept indicator, then X^T X gives every pair's co-occurrence count at once.
    indicator = np.zeros((len(learners.cat.categories), len(concepts)), dtype=np.float32)
    indicator[learners.cat.codes.to_numpy(), codes.cat.codes.to_numpy()] = 1.0
    n_learners = indicator.shape[0]

    co = indicator.T @ indicator
    counts = np.diag(co).copy()
    support_single = counts / n_learners

    rows = []
    for i, a in enumerate(concepts):
        for j, b in enumerate(concepts):
            if i == j or counts[i] == 0:
                continue
            support = co[i, j] / n_learners
            if support < MIN_SUPPORT:
                continue
            confidence = co[i, j] / counts[i]
            # Lift compares confidence against B's base rate. Without dividing by it, every rule
            # pointing at a commonly-failed concept looks strong purely because that concept is common.
            lift = confidence / support_single[j] if support_single[j] > 0 else np.nan
            rows.append({"antecedent": a, "consequent": b, "support": float(support),
                         "confidence": float(confidence), "lift": float(lift)})
    return pd.DataFrame(rows).sort_values("lift", ascending=False).reset_index(drop=True)


def compare_to_dag(rules: pd.DataFrame) -> pd.DataFrame:
    """Label each rule against the hand-curated prerequisite graph.

    `agrees`      the DAG already has this edge, in this direction
    `inverted`    the DAG has the edge the OTHER way — worth a look, because a mined rule pointing
                  against a curated prerequisite is either a mis-curated edge or a symmetric
                  difficulty pair, and those need different fixes
    `absent`      no edge either way
    """
    from features.taxonomy import get_taxonomy

    taxonomy = get_taxonomy()
    edges = {(c.id, p) for c in taxonomy.concepts.values() for p in c.prerequisites}

    def label(row) -> str:
        if (row.antecedent, row.consequent) in edges:
            return "agrees"
        if (row.consequent, row.antecedent) in edges:
            return "inverted"
        return "absent"

    return rules.assign(vs_dag=rules.apply(label, axis=1))


def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warehouse", default=os.environ.get(
        "VC_WAREHOUSE",
        os.path.join(os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")), "warehouse")))
    parser.add_argument("--write-review", action="store_true",
                        help="write docs/CONCEPT_RULES_REVIEW.md")
    args = parser.parse_args()
    if not os.path.isdir(args.warehouse):
        print(f"no warehouse at {args.warehouse}. Set VC_WAREHOUSE or VC_DATA.")
        return 2

    sets = failed_concept_sets(args.warehouse)
    print(f"  {sets.learner_id.nunique():,} learners with >={MIN_FAILED_CONCEPTS} failed concepts, "
          f"{sets.concept_id.nunique()} concepts")

    rules = compare_to_dag(association_rules(sets))
    strong = rules[rules.lift >= MIN_LIFT]
    print(f"  {len(rules):,} pairs above support {MIN_SUPPORT:.1%}; "
          f"{len(strong):,} with lift >= {MIN_LIFT}\n")

    if strong.empty:
        # A real and reportable outcome, not an empty run. It would mean concept failures are
        # independent given how common each concept is — which is itself a finding about the taxonomy.
        print("  NO rules clear the lift threshold. Concept failures are close to independent once")
        print("  each concept's base failure rate is accounted for, so co-failure carries no signal")
        print("  the prerequisite walk could use.")
        return 0

    print(f"  {'antecedent':26} {'consequent':26} {'lift':>6} {'conf':>6} {'supp':>6}  vs DAG")
    for _, r in strong.head(20).iterrows():
        print(f"  {r.antecedent:26} {r.consequent:26} {r.lift:>6.2f} {r.confidence:>6.2f} "
              f"{r.support:>6.3f}  {r.vs_dag}")

    breakdown = strong.vs_dag.value_counts().to_dict()
    undirected = len({frozenset((r.antecedent, r.consequent)) for _, r in strong.iterrows()})
    print(f"\n  against the hand-curated DAG: {breakdown}")
    # LIFT IS SYMMETRIC. lift(A->B) == lift(B->A) by construction, so every association appears twice
    # with the same lift and different confidence, and `agrees`/`inverted` are the two ends of the
    # SAME pair. Reporting 946 rules without saying this reads as twice as many findings as exist.
    print(f"  that is {undirected} UNDIRECTED pairs — lift is symmetric, so each appears twice, and")
    print("  the agrees/inverted split is the same pairs from both ends, not separate findings.")
    print()
    print("  ALL of these are classic-DSA concepts: this is the research corpus, not the product's")
    print("  64 ML concepts. It validates the DSA half of data/concepts.yaml and says nothing about")
    print("  the ML half the platform teaches. See docs/RANKING_DESIGN.md on the two worlds.")
    print("\n  These are CORRELATIONS. Two concepts fail together because one needs the other, OR")
    print("  because both are hard, OR because they share problems. Only a person can tell which,")
    print("  which is why nothing here edits data/concepts.yaml.")

    if args.write_review:
        out = ROOT / "docs" / "CONCEPT_RULES_REVIEW.md"
        lines = ["# Mined concept co-failure rules — for review",
                 "",
                 f"Generated by `python -m features.mine`. {len(strong)} rules with lift >= "
                 f"{MIN_LIFT} and support >= {MIN_SUPPORT:.1%}.",
                 "",
                 "**Nothing here has been applied.** A mined rule is a correlation; a prerequisite is a",
                 "claim about what must be learned first. Two concepts co-fail because one needs the",
                 "other, because both are hard, or because they share problems — and only the first is",
                 "a prerequisite. Tick a row only if you believe the dependency.",
                 "",
                 "| antecedent | consequent | lift | confidence | support | vs DAG |",
                 "|---|---|---|---|---|---|"]
        for _, r in strong.iterrows():
            lines.append(f"| `{r.antecedent}` | `{r.consequent}` | {r.lift:.2f} | "
                         f"{r.confidence:.2f} | {r.support:.3f} | {r.vs_dag} |")
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"\n  wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
