"""Turn single-word `must_mention` entries into concept groups.

A required concept has more than one correct surface form. Requiring exactly one of them tests
whether the tutor picked the author's word, which is not a property of the tutor.

Measured before this change, over 30 followup scenarios in one run: `mentions_required` failed 21 of
30 while every other check failed zero, and the failures were correct answers phrased differently.
The giveaway was the difficulty gradient running backwards — easy 0.143, hard 0.375 — because an
easy concept has more valid phrasings and exact matching punishes each one the author did not think
of.

Each group below is ONE idea. A tutor that expresses the idea in any of its forms has covered it.
Groups are deliberately narrow: they contain synonyms for the same mechanism, never a weaker
adjacent notion, because a group wide enough to always match would make the check vacuous — the same
failure the echo-keyword prune already fixed once.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: keyword -> the concept's acceptable surface forms. Only concepts with genuine alternatives are
#: widened; a term of art with no synonym (`causal`, `low-rank`, `teacher`) stays as it is.
GROUPS = {
    "anneal":     ["anneal", "decay", "reduc", "lower"],
    "mass":       ["mass", "probabilit", "total", "sum"],
    "leak":       ["leak", "contaminat", "overfit"],
    "optimistic": ["optimistic", "bias", "inflat", "overestimat", "unreliab"],
    "distance":   ["distance", "dot product", "magnitude", "euclid"],
    "early":      ["early", "beginning", "start of training", "first few"],
    "scal":       ["scal", "expect", "compensat"],
    "merge":      ["merge", "pair", "combin"],
    "decoupl":    ["decoupl", "separat", "independent"],
    "depend":     ["depend", "couple", "other examples", "across the batch"],
    "threshold":  ["threshold", "maximum", "limit", "exceed"],
    "norm":       ["norm", "magnitude", "length"],
    "divers":     ["divers", "generic", "repetit", "bland", "safe"],
    "likelihood": ["likelihood", "probabilit", "score"],
    "recomput":   ["recomput", "recalculat", "compute again", "re-run"],
    "forward":    ["forward", "activation"],
    "granular":   ["granular", "specific", "focused", "precise"],
    "dilut":      ["dilut", "average", "mix", "blur"],
    "coheren":    ["coheren", "factual", "useful", "quality"],
    "predict":    ["predict", "next token", "next-token"],
    "varian":     ["varian", "spread", "confidence", "stability"],
    "estimate":   ["estimate", "measure", "score"],
    "identity":   ["identity", "skip", "shortcut", "bypass"],
    "path":       ["path", "route", "connection"],
    "generali":   ["generali", "test set", "unseen", "flat minim"],
    "momentum":   ["momentum", "velocit"],
    "soft":       ["soft", "smooth", "distribut"],
    "calibrat":   ["calibrat", "confiden", "overconfiden"],
    "outlier":    ["outlier", "extreme", "large weight", "rare large"],
    "range":      ["range", "dynamic range", "spread of values"],
    "adapter":    ["adapter", "inject", "added matri"],
    "cumulative": ["cumulative", "running total", "adding them up", "accumulat"],
    "smooth":     ["smooth", "gradual", "continuous"],
    "underflow":  ["underflow", "round to zero", "too small", "flush"],
    "future":     ["future", "ahead", "later token", "subsequent"],
    "encod":      ["encod", "embed", "signal"],
    "position":   ["position", "order", "index"],
    "precision":  ["precision", "false positive"],
    "recall":     ["recall", "false negative", "missed positive"],
    "imbalanc":   ["imbalanc", "rare", "skew", "few positive"],
    "adaptive":   ["adaptive", "per-parameter", "second moment"],
    "inference":  ["inference", "eval", "test time", "deployment"],
    "sequence":   ["variable length", "padding", "different lengths"],
    "similar":    ["similar", "relat", "close", "nearby"],
    "dens":       ["dens", "continuous", "low-dimension"],
    "target":     ["target", "label", "outcome"],
}


def widen(entry, forbidden: str):
    """The concept's forms, minus any the scenario itself already contains.

    Groups are defined globally; validity is per scenario. A form that appears in the learner's
    question or in the prior assistant turn is satisfiable by echoing, so it must be dropped from
    THAT scenario even though it is a legitimate phrasing elsewhere — `decay` is a fine way to say
    annealing, but not when the context already said "most recipes decay it".

    This is the echo-keyword defect at group level, and widening without it would have reintroduced
    exactly what the earlier prune removed. The guard in tests/test_followup_scenarios.py caught 12
    such forms across 10 scenarios on the first attempt.
    """
    if isinstance(entry, (list, tuple)):
        candidates = [str(f) for f in entry]
    else:
        candidates = list(GROUPS.get(str(entry).lower(), [str(entry)]))
    kept = [f for f in candidates if f.lower() not in forbidden]
    if not kept:
        raise ValueError(f"every form of {entry!r} appears in the scenario's own text")
    return kept if len(kept) > 1 else kept[0]


def main() -> int:
    sys.path.insert(0, str(ROOT / "scripts"))
    import run_evals as R

    total = 0
    for _mode, val in R.GOLD_FILES.items():
        for path in ([val] if isinstance(val, Path) else val):
            if not path.exists():
                continue
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
                    if line.strip()]
            changed = False
            for row in rows:
                required = row.get("must_mention")
                if not required:
                    continue
                # Everything the scenario itself says: the learner's question and any prior
                # assistant turn. A form appearing here is echoable and cannot count.
                forbidden = (row["user_message"] + " " + " ".join(
                    m.get("content", "") for m in (row.get("messages") or [])
                    if m.get("role") == "assistant")).lower()
                try:
                    widened = [widen(e, forbidden) for e in required]
                except ValueError as exc:
                    print(f"  !! {row['id']}: {exc} — left unwidened")
                    continue
                if widened != required:
                    row["must_mention"] = widened
                    changed = True
                    total += 1
            if changed:
                path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                                encoding="utf-8")
                print(f"  {path.name}: widened")
    print(f"\n  {total} scenario(s) now carry concept groups")
    return 0


if __name__ == "__main__":
    sys.exit(main())
