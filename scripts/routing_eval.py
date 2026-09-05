"""Routing, measured offline in seconds. No GPU, no server, no model call.

WHY THIS EXISTS
---------------
Routing is the joint rate's first stage and the whole current deficit: 0.61, entirely debug leaking
to other modes. It is also **deterministic** — `decide_mode` is a pure function of the message — so
it needs none of the apparatus the generation evals need. Every routing experiment should cost
seconds, not a two-hour GPU arm.

It was previously measured by parsing `[route]` lines out of an API log and aligning them to
scenarios by order. That produced **48/75, which was wrong**; the true figure is 55/75. The
alignment was off and the per-mode picture was wrong with it — empathy read 4/9 when it is 9/9.
Computing from the function removes that entire class of error.

WHY A CONFUSION MATRIX AND NOT A RATE
--------------------------------------
"debug 31/51" says how often it fails. It does not say where the mass goes, and the destination
determines the remedy: leaking to `explain` is a keyword-precedence problem, leaking to `teaching`
is `detect_problem_paste` firing above the debug gate, leaking to `followup` is an ungated anaphoric
starter. Three different fixes hiding inside one number.

Each misroute is therefore printed with the signals that decide its path, so a rule can be designed
against evidence rather than guessed at.

    python scripts/routing_eval.py                 # matrix + misroute detail
    python scripts/routing_eval.py --quiet         # matrix only, for quick iteration
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (ROOT, ROOT / "scripts", ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(_p))

#: Conditional localisation, measured over 5 streaming runs: P(correct line | correct mode).
#: Used only to project what a routing change is worth. Stated as a constant so the projection
#: cannot drift away from the measurement it came from.
CONDITIONAL_LOCALISATION = 0.735


def load_scenarios() -> list[dict]:
    import run_evals as R

    out = []
    for name, val in R.GOLD_FILES.items():
        for p in ([val] if isinstance(val, Path) else val):
            if not p.exists():
                continue
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    row.setdefault("mode", name)
                    out.append(row)
    return out


def enriched(scenario: dict) -> tuple[str, bool]:
    """The message shape the FRONTEND actually sends, which is not the one the eval harness sends.

    `VoidCodeAIPanel.tsx` composes `[USER REQUEST]` + `[SOURCE CODE (lang) — N lines total]`
    (+ `[TEST CASE DETAILS]`). `run_evals.build_messages` instead appends a bare fenced block. Those
    are different inputs to `decide_mode`, because `_extract_user_intent` strips everything after
    `[USER REQUEST]` up to the next `[SECTION]` — so the frontend shape hides the code from mode
    detection and the harness shape does not. Measured: **53/75 on the production shape, 55/75 on
    the harness shape.**

    Routing is the small half of this. `PE_DEBUG_PROMPT` tells the model to "Read [SOURCE CODE] line
    by line" and to consult [TEST CASE DETAILS] — blocks the harness never sends — so the prompt's
    own navigation instructions refer to structure that is absent from every scenario measured so
    far. This function is the production shape; `tests/test_routing.py` uses the same one.
    """
    words = scenario["user_message"]
    src = scenario.get("source_code")
    if src and "```" in words:
        words = words.split("```")[0].strip()
    if not src:
        return words, False
    return (f"[USER REQUEST]\n{words}\n\n"
            f"[SOURCE CODE (python)]\n```python\n{src}\n```"), True


def signals(text: str) -> dict:
    """The inputs the precedence chain actually branches on, for one message.

    Not a reimplementation of `detect_mode` -- a readout of the conditions that decide which of its
    exits is taken, so a misroute can be attributed to a rule rather than to bad luck.
    """
    import prompts as P
    from src.main import _has_code_context

    low = (text or "").lower()
    return {
        "code": _has_code_context(text),
        "paste": P.detect_problem_paste(text),
        "anaphoric": low.lstrip().startswith(
            ("so ", "and ", "but ", "wait ", "then ", "that ", "this ",
             "those ", "these ", "there ", "here ")),
        "words": len(low.split()),
        "frustrated": P.detect_frustration(text),
    }


def evaluate(scenarios: list[dict], turns: int | None = None) -> tuple[dict, list[dict]]:
    """`turns=None` uses each scenario's real turn count — the FIRST-turn rate, which is what the
    joint-rate funnel describes.

    Passing an explicit `turns` simulates a conversation position, and the number moves:
    `decide_mode` reroutes short `general` messages to `followup` once `n_user_messages > 2`. At
    turns=3 the same 75 scenarios give **53/75** rather than 55/75, which is what
    `tests/test_routing.py::ROUTING_FLOOR` guards. Two real numbers for two different questions;
    neither is "the routing rate" without saying which turn it describes.
    """
    from src.main import decide_mode

    matrix: dict[str, Counter] = defaultdict(Counter)
    misroutes = []
    for s in scenarios:
        text, _ = enriched(s)
        n_users = len(s.get("messages") or []) or 1
        got, intent = decide_mode(text, turns if turns is not None else n_users)
        want = s.get("mode")
        matrix[want][got] += 1
        if got != want:
            misroutes.append({"id": s["id"], "want": want, "got": got,
                              "intent": (intent or "")[:70].replace("\n", " "),
                              **signals(text)})
    return matrix, misroutes


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true", help="matrix only")
    ap.add_argument("--turns", type=int, default=None,
                    help="simulate a conversation position; default is each scenario's real one")
    args = ap.parse_args(argv[1:])

    scenarios = load_scenarios()
    matrix, misroutes = evaluate(scenarios, args.turns)
    total = len(scenarios)
    correct = sum(matrix[m][m] for m in matrix)

    label = "first turn" if args.turns is None else f"turns={args.turns}"
    print(f"\n  ROUTING {correct}/{total} = {correct/total:.3f}   [{label}]   "
          "(deterministic — no run-to-run spread)")
    if args.turns is None:
        mid, _ = evaluate(scenarios, turns=3)
        midc = sum(mid[m][m] for m in mid)
        print(f"  mid-conversation (turns=3): {midc}/{total} = {midc/total:.3f} — a different "
              "number for a different question, guarded by tests/test_routing.py\n")
    modes = sorted(set(matrix) | {g for c in matrix.values() for g in c})
    print(f"  {'expected':10} {'n':>3} {'correct':>8} {'rate':>7}   routed as")
    print(f"  {'-'*10} {'-'*3} {'-'*8} {'-'*7}   {'-'*46}")
    for want in sorted(matrix, key=lambda m: -sum(matrix[m].values())):
        n = sum(matrix[want].values())
        dist = ", ".join(f"{k}:{v}" for k, v in matrix[want].most_common() if k != want)
        print(f"  {want:10} {n:>3} {matrix[want][want]:>8} {matrix[want][want]/n:>6.1%}   {dist or '—'}")

    # Precision matters too: a mode that swallows others is a different defect from one that leaks.
    print(f"\n  {'mode':10} {'received':>9} {'of which correct':>17}   precision")
    for m in modes:
        got = sum(matrix[w][m] for w in matrix)
        if not got:
            continue
        print(f"  {m:10} {got:>9} {matrix[m][m]:>17}   {matrix[m][m]/got:.1%}")

    # The joint rate is about DEBUG scenarios, so it is debug's recall that multiplies -- not the
    # all-mode rate. Using the latter overstates it: 0.707 x 0.735 = 0.519 against a measured 0.447.
    dbg_n = sum(matrix["debug"].values()) or 1
    dbg_recall = matrix["debug"]["debug"] / dbg_n
    print("\n  PROJECTED JOINT RATE = debug recall x conditional localisation")
    print(f"    {matrix['debug']['debug']}/{dbg_n} = {dbg_recall:.3f}  x  {CONDITIONAL_LOCALISATION}"
          f"  =  {dbg_recall * CONDITIONAL_LOCALISATION:.3f}     (gate 0.80)")
    print(f"    perfect debug routing would give {CONDITIONAL_LOCALISATION:.3f} — still short of the "
          "gate, so localisation work is required regardless")

    if not args.quiet and misroutes:
        print(f"\n  THE {len(misroutes)} MISROUTES, with the signals that decide their path")
        print(f"    {'want->got':18} {'code':>5} {'paste':>6} {'anaph':>6} {'words':>6}  intent")
        for m in sorted(misroutes, key=lambda x: (x["want"], x["got"])):
            print(f"    {m['want']+'->'+m['got']:18} {m['code']!s:>5} {m['paste']!s:>6} "
                  f"{m['anaphoric']!s:>6} {m['words']:>6}  {m['intent'][:52]!r}")
        agg = Counter((m["want"], m["got"]) for m in misroutes)
        print("\n  by destination — each of these is a DIFFERENT remedy:")
        for (w, g), n in agg.most_common():
            print(f"    {w} -> {g}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
