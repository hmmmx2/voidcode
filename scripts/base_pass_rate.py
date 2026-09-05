"""Which of the 60 problems can GRPO actually learn from?

GRPO's gradient comes from *variance within a group*. A problem the policy always solves and one it
never solves teach exactly the same amount: nothing. So before any training, sample G completions
per problem, grade them, and keep only the problems whose base pass rate lands in a usable band —
the plan's figure is 10-90%.

This is also the first time the reward harness grades a live model rather than a fixture, so it is
the real test of P1's work as well as the input to P3a.

**The output may be discouraging, and that is the point of running it first.** If very few problems
land in the band, the constraint is the corpus rather than the method, and the plan already names
the fallback: train on a public verifiable corpus and hold all 60 of these out for evaluation.
Discovering that now costs an evening; discovering it after a training run costs the run.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reward.limits import run_isolated

FENCE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.S)


def build_prompt(problem: dict) -> str:
    """Title, starter template and the visible cases. Hidden cases are never shown — that is what
    makes the reward ungameable by prompt-reading."""
    visible = [c for c in problem.get("cases", []) if c.get("visible")][:3]
    examples = "\n".join(f"  {problem['entry']}({', '.join(map(repr, c['args']))})" for c in visible)
    allowed = problem.get("allowedImports") or []
    imports = f"You may import: {', '.join(allowed)}.\n" if allowed else ""
    return (
        f"Complete this Python function.\n\n"
        f"# {problem['title']}\n\n"
        f"```python\n{problem.get('template', '')}\n```\n\n"
        f"{imports}"
        f"Example calls:\n{examples}\n\n"
        f"Return the complete function in a single ```python code block. No explanation."
    )


def extract_code(text: str, entry: str) -> str:
    """Pull the code out of a completion. A model that emits no parseable code scores zero, which
    is correct — an unparseable answer is a wrong answer, not a missing measurement."""
    blocks = FENCE.findall(text)
    for block in blocks:
        if f"def {entry}" in block:
            return block
    return blocks[0] if blocks else text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--group", type=int, default=8)
    ap.add_argument("--max-new", type=int, default=512)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--limit", type=int, default=0, help="first N problems, 0 for all")
    ap.add_argument("--lo", type=float, default=0.10)
    ap.add_argument("--hi", type=float, default=0.90)
    ap.add_argument("--grade-timeout", type=float, default=10.0,
                    help="wall-clock cap per graded completion; a timeout scores zero")
    ap.add_argument("--out")
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    catalogue = json.loads((Path(__file__).resolve().parents[1] / "data" / "catalogue.json")
                           .read_text(encoding="utf-8"))
    problems = catalogue["problems"][: args.limit] if args.limit else catalogue["problems"]

    tok = AutoTokenizer.from_pretrained(args.model)
    tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.bfloat16).cuda().eval()

    results = []
    for i, problem in enumerate(problems):
        chat = [{"role": "user", "content": build_prompt(problem)}]
        text = tok.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
        batch = tok([text] * args.group, return_tensors="pt", padding=True).to("cuda")

        with torch.no_grad():
            out = model.generate(**batch, max_new_tokens=args.max_new, do_sample=True,
                                 temperature=args.temperature, top_p=0.95,
                                 pad_token_id=tok.pad_token_id)
        completions = tok.batch_decode(out[:, batch["input_ids"].shape[1]:],
                                       skip_special_tokens=True)

        passed = 0
        partial = 0.0
        timeouts = 0
        for completion in completions:
            # `grade` returning a Verdict whose submission crashed is a *result*: that attempt
            # scored zero. `grade` itself raising is a *bug in this script*, and must not be
            # swallowed — an earlier version caught everything here and reported 0/4 on problems
            # the model had actually solved, because Verdict.passed is a list of case ids and
            # `int()` of it raised TypeError. A blanket except turns a harness bug into a
            # plausible measurement, which is the worst thing a measurement script can do.
            # run_isolated, not grade: `grader.run_cases` is documented as unsandboxed, and calling
            # it directly on generated code hung this script for 25 minutes on a non-terminating
            # bpe-merge loop. A timeout is a result here, scoring zero.
            verdict = run_isolated(problem, extract_code(completion, problem["entry"]),
                                   timeout_s=args.grade_timeout)
            passed += int(verdict.solved)
            partial += verdict.case_fraction
            if verdict.outcome == "timeout":
                timeouts += 1
        rate = passed / args.group
        results.append({"id": problem["id"], "title": problem["title"],
                        "passed": passed, "group": args.group, "pass_rate": rate,
                        # Partial credit is what the GRPO reward will actually use: it varies even
                        # when every completion fails outright, which is where some otherwise-dead
                        # groups get their gradient back.
                        "mean_case_fraction": round(partial / args.group, 4),
                        "timeouts": timeouts})
        band = "USABLE" if args.lo <= rate <= args.hi else ("all-pass" if rate > args.hi else "all-fail")
        print(f"[{i+1:2d}/{len(problems)}] {problem['id'][:38]:<38} {passed}/{args.group}  {band}",
              flush=True)

    usable = [r for r in results if args.lo <= r["pass_rate"] <= args.hi]
    solved = [r for r in results if r["pass_rate"] > args.hi]
    unsolved = [r for r in results if r["pass_rate"] < args.lo]

    summary = {
        "model": args.model, "group": args.group, "temperature": args.temperature,
        "problems": len(results), "band": [args.lo, args.hi],
        "usable": len(usable), "always_solved": len(solved), "never_solved": len(unsolved),
        "mean_pass_rate": round(sum(r["pass_rate"] for r in results) / max(len(results), 1), 4),
        "dead_group_fraction": round(1 - len(usable) / max(len(results), 1), 4),
        "results": results,
    }
    print("\n" + "=" * 60)
    print(f"  usable ({args.lo:.0%}-{args.hi:.0%}) : {len(usable):3d} / {len(results)}")
    print(f"  always solved            : {len(solved):3d}  (dead: no variance)")
    print(f"  never solved             : {len(unsolved):3d}  (dead: no variance)")
    print(f"  mean pass rate           : {summary['mean_pass_rate']:.3f}")
    print(f"  dead-group fraction      : {summary['dead_group_fraction']:.1%}")

    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
