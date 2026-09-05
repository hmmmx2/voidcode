"""GRPO on the filtered DeepCoder band, evaluated on the 60 local problems.

This is the piece `rl/grpo.py` was always missing. That module has the objective — group-relative
advantages, the k3 KL estimator, the clipped surrogate — and seven tests pinning it, but nothing
ever called `grpo_loss` outside those tests. The loop is here.

WHAT THE REWARD IS, AND WHY IT IS NOT BINARY
---------------------------------------------
`case_fraction`, not solved/not-solved. Measured on the 60 local problems, a binary reward leaves
**7 of 60** with any gradient; counting the fraction of cases passed leaves **27**. Nearly four
times the usable corpus from the same generations. The filter pass reports the same split on the
public corpus as `usable` versus `with_any_signal`, and the second number is the one that matters
here.

WHAT THE EVALUATION SET IS, AND WHY IT NEVER MOVES
---------------------------------------------------
The 60 local problems, which appear in no public corpus and whose expectations were derived by
executing a reference and cross-checked against a frozen Judge0 oracle. Training on them would burn
the scarcer artefact. DeepCoder contains LiveCodeBench problems up to July 2024, so *no* public
benchmark number may be reported from a model trained on this — the 60 are the only clean readout.

THE HONEST RISK, STATED UP FRONT
---------------------------------
Training on general competitive-programming Python and evaluating on ML/DL implementation problems
may show little transfer. A flat eval curve is a publishable result, not a failure, and this script
is built to show that rather than hide it: eval runs before the first optimizer step, so there is
always a baseline to be flat against.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch

from reward.limits import run_isolated_batch, run_isolated_stdio_batch
from rl.grpo import dead_group_rate, group_advantages, grpo_loss

# The two corpora are NOT the same shape, and conflating them silently produces a flat eval curve
# that looks like an honest negative result.
#
#   training (DeepCoder) : stdin fed, stdout compared      -> run_isolated_stdio_batch
#   eval (the 60 local)  : `entry(*args)` vs a derived     -> run_isolated / reward.grader
#                          expectation, with hidden cases
#
# The first draft of this file graded the 60 with the stdio path. They carry `entry`/`cases`/
# `reference` and no input/output pairs, so every completion would have scored zero and the
# resulting flat curve would have been indistinguishable from "GRPO did not transfer" — the exact
# conclusion this run exists to test. Reuse the prompt/extraction that already measured the 60.
from scripts.base_pass_rate import build_prompt as eval_build_prompt
from scripts.base_pass_rate import extract_code as eval_extract_code


def load_band(band_path: Path, corpus_path: Path, lo: float, hi: float,
              signal: str = "any") -> list[dict]:
    """Join a `filter_corpus.py` summary back onto the source corpus and select trainable problems.

    **The summary carries no prompts or tests.** Its records are `{id, pass_rate,
    mean_case_fraction, n_cases, cases_graded, source}` — metrics only. An earlier version of this
    function looked for `prompt`/`tests` on those records and silently kept nothing, which presents
    as "no in-band problems; nothing to train on" rather than as a join failure. The text lives in
    the corpus that was filtered, and the two are joined by `id`.

    `signal` selects what counts as trainable:

      band  strict 10-90% pass rate  -> 184 of 2000 on the measured run
      any   band PLUS problems that never fully solve but score partial credit -> 1060

    `any` is the default because it is what this project's own measurements argue for. On the 60
    local problems, binary reward left 7 usable and partial credit left 27. The public corpus
    reproduces that ratio at scale: `always_solved` came back **0** and the mean pass rate 0.024,
    so a strict band throws away 876 problems whose completions do vary in case fraction. Group
    advantages need variance *within* a group, not a nonzero pass rate.
    """
    summary = json.loads(band_path.read_text(encoding="utf-8"))
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    problems = corpus["problems"] if isinstance(corpus, dict) else corpus
    by_id = {p["id"]: p for p in problems}

    kept, missing = [], 0
    for r in summary.get("results") or []:
        rate, partial = r.get("pass_rate"), r.get("mean_case_fraction") or 0.0
        if rate is None:
            continue
        in_band = lo <= rate <= hi
        has_signal = in_band or (signal == "any" and rate < lo and partial > 0)
        if not has_signal:
            continue
        src = by_id.get(r["id"])
        if not src or not src.get("prompt") or not src.get("tests"):
            missing += 1
            continue
        kept.append({**src, "pass_rate": rate, "mean_case_fraction": partial})

    if missing:
        print(f"  warning: {missing} band ids had no usable corpus record", flush=True)
    return kept


def build_prompt(problem: str) -> str:
    return (
        "Solve the problem. Read from standard input and write to standard output.\n"
        "Respond with a single Python code block and nothing else.\n\n"
        f"{problem}\n"
    )


def extract_code(text: str) -> str:
    """Pull the code out of a fenced block, tolerating a missing closing fence.

    A truncated generation is common at a tight `--max-new`, and treating it as empty would score a
    near-miss identically to a refusal — which is exactly the signal collapse partial credit exists
    to prevent.
    """
    if "```" not in text:
        return text.strip()
    body = text.split("```", 1)[1]
    if body.startswith("python"):
        body = body[len("python"):]
    return body.split("```", 1)[0].strip()


@torch.no_grad()
def generate_group(model, tok, prompt: str, group: int, max_new: int, temperature: float,
                   greedy: bool = False) -> list[str]:
    """Sample `group` completions, or take the single greedy one when `greedy`.

    Greedy decoding is **deterministic**: the same policy on the same prompt gives the same string
    every time. That makes it the only eval metric here whose movement cannot be sampling noise.
    """
    chat = tok.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
    enc = tok(chat, return_tensors="pt").to(model.device)
    if greedy:
        out = model.generate(**enc, do_sample=False, max_new_tokens=max_new,
                             num_return_sequences=1,
                             pad_token_id=tok.pad_token_id or tok.eos_token_id)
    else:
        out = model.generate(
            **enc, do_sample=True, temperature=temperature, top_p=0.95,
            max_new_tokens=max_new, num_return_sequences=group,
            pad_token_id=tok.pad_token_id or tok.eos_token_id)
    return [tok.decode(o[enc["input_ids"].shape[1]:], skip_special_tokens=True) for o in out]


def reward_for_group(sources: list[str], tests: list, timeout_s: float) -> list[float]:
    """One spawn per problem, not per completion.

    `spawn` costs about a second because it re-execs a fresh interpreter, and `fork` is not an
    option with a live CUDA context — a forked child dies with MemoryError, which the sandbox then
    reports as a timeout and scores zero. At G completions per step across thousands of steps the
    per-completion spawn dominates everything else the loop does; batching measured 9.7x.
    """
    try:
        results = run_isolated_stdio_batch(sources, tests, timeout_s=timeout_s)
    except RuntimeError as exc:
        # A harness bug, not a bad submission. Scoring it zero is precisely how the base pass-rate
        # run once reported 0/4 on problems that were in fact solved.
        print(f"  harness error, group skipped: {exc}", flush=True)
        return []
    return [r.case_fraction for r in results]


def sequence_logp(model, tok, prompt: str, completion: str) -> torch.Tensor:
    """Per-token log-probs of `completion` given `prompt`, as a 1-D tensor.

    **Slices the logits to the completion before doing anything in fp32.** Qwen's vocabulary is
    151,936, so a full-sequence fp32 log_softmax is ~600 MB for a 1,000-token sequence and
    allocates a second copy of the same size. Only the completion positions are ever used, and the
    prompt is usually the longer half. This OOM'd a 46 GB A40.

    `cross_entropy` gives -log p(target) directly, without materialising a full log_softmax
    tensor alongside the logits.
    """
    chat = tok.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
    p_ids = tok(chat, return_tensors="pt").input_ids.to(model.device)
    c_ids = tok(completion, return_tensors="pt", add_special_tokens=False).input_ids.to(model.device)
    ids = torch.cat([p_ids, c_ids], dim=1)

    start = p_ids.shape[1] - 1                   # last prompt position predicts the first new token
    logits = model(ids).logits[:, start:-1]      # completion positions only
    targets = ids[:, start + 1:]
    return -torch.nn.functional.cross_entropy(
        logits.transpose(1, 2).float(), targets, reduction="none")[0]


def evaluate(model, tok, problems: list[dict], group: int, max_new: int,
             temperature: float, timeout_s: float, seed: int = 1234) -> dict:
    """Pass rate and mean case fraction on the held-out 60. Never used for a gradient.

    Uses the catalogue grading path, not the stdio one — see the import block. Grades the whole
    group in **one** child via `run_isolated_batch`: the per-completion version cost 60 x group
    spawns per eval (240 at group 4), and measurement on the A40 showed the GPU idle through all
    of them. `spawn` is not negotiable here — a CUDA context does not survive `fork` — so the only
    lever is spawning less often.

    VARIANCE CONTROL, WHICH THIS FUNCTION ORIGINALLY HAD NONE OF
    -------------------------------------------------------------
    Measured failure: at lr=2e-6 the policy provably did not move (KL flat at ~3e-4 over 100
    steps) and `mean_case_fraction` still fell 0.111 -> 0.0649, a 42% swing. The metric was
    noise-dominated, so three learning rates were compared against numbers that could not resolve
    the difference between them. Three fixes, in order of how much they matter:

    1. **Common random numbers.** The seed is reset to the same value before every eval, so each
       checkpoint sees the *same* sampling draws. Differences between checkpoints then reflect the
       policy rather than two independent doses of noise. This is free and it is the big one.
    2. **A greedy metric.** `greedy_solved` decodes with `do_sample=False`, which is deterministic:
       any change in it is a real change in the policy, full stop. It cannot be sampling noise.
    3. **A standard error.** `case_fraction_se` is reported beside the mean, so a swing can be
       compared against its own uncertainty instead of being eyeballed.
    """
    # Common random numbers: same draws at step 0 and step 200, so the comparison is paired.
    #
    # The RNG state is saved and restored around this. Without that, every eval would rewind the
    # *training* stream to the same point, so the rollouts after step 50 would replay exactly the
    # sequence that followed step 0 — turning an independent sample of 1060 problems into the same
    # short loop, four times over. The variance fix would have quietly created a sampling bug.
    cpu_rng = torch.get_rng_state()
    cuda_rng = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    solved = 0
    greedy_solved = 0
    greedy_fractions = []
    fractions = []
    for p in problems:
        texts = generate_group(model, tok, eval_build_prompt(p), group, max_new, temperature)
        g_text = generate_group(model, tok, eval_build_prompt(p), 1, max_new, temperature,
                                greedy=True)
        sources = [eval_extract_code(t, p["entry"]) for t in texts + g_text]
        try:
            verdicts = run_isolated_batch(p, sources, timeout_s=timeout_s)
        except RuntimeError as exc:
            # A harness bug, surfaced rather than scored. Scoring it zero is how the base
            # pass-rate run once reported 0/4 on problems that were actually solved.
            print(f"  eval harness error on {p['id']}: {exc}", flush=True)
            continue
        rewards = [v.case_fraction for v in verdicts[:-1]]
        greedy = verdicts[-1]
        greedy_fractions.append(greedy.case_fraction)
        if greedy.case_fraction >= 1.0:
            greedy_solved += 1
        if not rewards:
            continue
        fractions.extend(rewards)
        if max(rewards) >= 1.0:
            solved += 1

    torch.set_rng_state(cpu_rng)
    if cuda_rng is not None:
        torch.cuda.set_rng_state_all(cuda_rng)

    n = max(len(fractions), 1)
    mean = sum(fractions) / n
    var = sum((f - mean) ** 2 for f in fractions) / max(n - 1, 1)
    se = (var / n) ** 0.5
    gn = max(len(greedy_fractions), 1)
    return {
        "problems": len(problems),
        "solved_any": solved,
        "solve_rate": round(solved / max(len(problems), 1), 4),
        "mean_case_fraction": round(mean, 4),
        # Compare any movement against this. A change smaller than ~2 SE is not a result.
        "case_fraction_se": round(se, 4),
        # Deterministic: movement here cannot be sampling noise.
        "greedy_solved": greedy_solved,
        "greedy_case_fraction": round(sum(greedy_fractions) / gn, 4),
    }


def save_policy(model, tok, dest: str, step: int) -> None:
    """Write the policy so the run leaves something behind besides a curve.

    Overwrites one directory rather than keeping per-step copies: at 3 GB a checkpoint per eval
    fills a pod disk, and the run this exists because of was on rented hardware. The step is
    recorded inside so a directory is never ambiguous about what it holds.

    Failure here must not kill the run. Losing a checkpoint to a full disk is bad; losing the
    remaining 150 steps of training as well is worse.
    """
    try:
        out = Path(dest)
        out.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(out)
        tok.save_pretrained(out)
        (out / "grpo-step.json").write_text(json.dumps({"step": step}) + "\n", encoding="utf-8")
        print(f"  saved policy at step {step} -> {out}", flush=True)
    except Exception as exc:
        print(f"  WARNING: could not save policy at step {step}: {exc}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="filter_corpus.py summary JSON (metrics only)")
    ap.add_argument("--source", required=True,
                    help="the corpus that was filtered; supplies prompt/tests, joined by id")
    ap.add_argument("--signal", choices=["band", "any"], default="any",
                    help="'band' = strict 10-90%% pass rate; 'any' also keeps partial-credit problems")
    ap.add_argument("--eval-set", required=True, help="the 60 local problems (data/catalogue.json)")
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--band", type=float, nargs=2, default=[0.1, 0.9])
    ap.add_argument("--group", type=int, default=8)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--lr", type=float, default=1e-6)
    ap.add_argument("--beta", type=float, default=0.04)
    ap.add_argument("--max-new", type=int, default=640)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--grade-timeout", type=float, default=8.0)
    # The filter measured pass rates with --max-cases 20. Grading the full set here would change
    # the reward's meaning relative to the band the problems were selected by, and some problems
    # carry 255 cases -- 12x the work, which the per-problem timeout would simply cut short at an
    # arbitrary point. Same cap, same reward.
    ap.add_argument("--max-cases", type=int, default=20)
    ap.add_argument("--eval-every", type=int, default=50)
    ap.add_argument("--eval-group", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="docs/grpo-run.json")
    # Without this the trained policy exists only in the process. The first 200-step run on a
    # rented A40 produced no checkpoint at all, and when the pod was released the model went with
    # it -- so P5 ("serve it back") had nothing to serve and the run could not be re-examined,
    # only repeated. Saved at each eval, not just at the end, so a crash at step 180 still leaves
    # something.
    ap.add_argument("--save-to", default="", help="directory to save the policy into; skipped if empty")
    # Without this a run cannot be audited for reward hacking afterwards, which spec section 4.5
    # requires. The 200-step run wrote a 164 MB log containing 11.6 million lines of *stdout from
    # executed candidates* and not one line of generated source -- so "no hacking found" could not
    # honestly be claimed, only "the evidence was not retained". Samples the graded completions
    # alongside their rewards, at a rate that keeps the file readable.
    ap.add_argument("--log-completions", default="",
                    help="JSONL path to sample graded completions into; skipped if empty")
    ap.add_argument("--log-every", type=int, default=25, help="sample one step in N")
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    train = load_band(Path(args.corpus), Path(args.source),
                      args.band[0], args.band[1], args.signal)
    eval_problems = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    if isinstance(eval_problems, dict):
        eval_problems = eval_problems.get("problems", [])
    if not train:
        print("no in-band problems; nothing to train on", flush=True)
        return 1

    # Leakage guard. The eval set is the entire value of this run, and an id collision would make
    # every number downstream meaningless while still looking perfectly healthy.
    eval_ids = {p.get("id") for p in eval_problems}
    overlap = [p for p in train if p.get("id") in eval_ids]
    if overlap:
        print(f"ABORT: {len(overlap)} training problems share an id with the eval set", flush=True)
        return 1

    print(f"train={len(train)} in-band, eval={len(eval_problems)} held out", flush=True)

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda")
    ref = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda")
    ref.eval()
    for p in ref.parameters():
        p.requires_grad_(False)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)

    # Baseline before any step, so a flat curve is provably flat rather than merely unmeasured.
    history = [{"step": 0, **evaluate(model, tok, eval_problems, args.eval_group,
                                     args.max_new, args.temperature, args.grade_timeout)}]
    print(f"step 0 eval: {history[0]}", flush=True)

    dead = 0
    stats: dict = {}                      # survives a dead step, which skips the update entirely
    for step in range(1, args.steps + 1):
        problem = random.choice(train)
        prompt = build_prompt(problem["prompt"])

        model.eval()
        texts = generate_group(model, tok, prompt, args.group, args.max_new, args.temperature)
        rewards = reward_for_group([extract_code(t) for t in texts],
                                   problem["tests"][: args.max_cases], args.grade_timeout)
        if not rewards:
            continue

        if args.log_completions and step % args.log_every == 0:
            # Highest and lowest scoring completion of the group. The extremes are where hacking
            # shows: a suspiciously perfect score on a problem the group otherwise fails is the
            # shape to look for. Appended so a crash still leaves what was collected.
            order = sorted(range(len(rewards)), key=lambda i: rewards[i])
            sample = {"step": step, "problem_id": problem.get("id"),
                      "rewards": [round(x, 4) for x in rewards],
                      "worst": extract_code(texts[order[0]])[:2000],
                      "best": extract_code(texts[order[-1]])[:2000]}
            with open(args.log_completions, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(sample) + "\n")

        if len(rewards) < 2:
            dead += 1                     # group_advantages rejects G<2: no within-group baseline
            continue

        # (n_groups, group_size). Both helpers require 2-D and raise on a flat tensor rather than
        # broadcasting something meaningless -- one prompt per step is still one *group*, not a
        # batch of scalars.
        r = torch.tensor(rewards, dtype=torch.float32).unsqueeze(0)

        # Counted in BOTH directions. The filter measured always_solved=0 and a 0.024 mean pass
        # rate, so on this corpus the dead groups will be all-fail rather than the all-pass that
        # P3-CORPUS-SCOPE anticipated. Either way the group carries no gradient.
        #
        # `continue` here would skip the eval block at the bottom of the loop as well as the
        # update. At a 33% dead rate that silently dropped a third of the scheduled evals -- the
        # lr=2e-5 run produced a history of steps 0, 50, 150 with **100 missing**, and nothing in
        # the output said so. The eval schedule must not depend on whether one sampled problem
        # happened to yield a gradient.
        is_dead = dead_group_rate(r) > 0
        if is_dead:
            dead += 1

        # The update is skipped for a dead group, but the eval below is NOT. Skipping the update
        # matters on its own terms: with zero advantages the clipped surrogate contributes nothing,
        # but `grpo_loss` still adds `beta * kl`, so stepping anyway would drag the policy toward
        # the reference on the strength of a group that carried no information.
        if not is_dead:
            adv = group_advantages(r)[0]  # back to (group_size,) for per-completion indexing
            model.train()
            opt.zero_grad(set_to_none=True)

            # backward() PER COMPLETION, not once over an accumulated sum. Summing the losses
            # first keeps every completion's autograd graph alive simultaneously -- at --group 16
            # that is 16 graphs, and it OOM'd a 46 GB A40 at 44.24 GiB. Gradients accumulate into
            # .grad either way, so this is identical maths and frees each graph as it is used.
            n = len(texts)
            for i, text in enumerate(texts):
                logp = sequence_logp(model, tok, prompt, text)
                with torch.no_grad():
                    ref_logp = sequence_logp(ref, tok, prompt, text)
                old_logp = logp.detach()  # one update per rollout: the sampling policy IS old
                loss, stats = grpo_loss(logp, old_logp, ref_logp,
                                        adv[i].to(logp.device).expand_as(logp), beta=args.beta)
                (loss / n).backward()

            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            opt.zero_grad(set_to_none=True)

        if step % 10 == 0:
            kl = stats.get("kl", float("nan"))
            print(f"step {step}  reward={r.mean():.3f}  dead_so_far={dead}  kl={kl:.4f}",
                  flush=True)

        if step % args.eval_every == 0:
            model.eval()
            e = {"step": step, **evaluate(model, tok, eval_problems, args.eval_group,
                                          args.max_new, args.temperature, args.grade_timeout)}
            history.append(e)
            print(f"step {step} eval: {e}", flush=True)
            Path(args.out).write_text(
                json.dumps({"model": args.model, "train_problems": len(train),
                            "dead_groups": dead, "history": history}, indent=2) + "\n",
                encoding="utf-8")
            if args.save_to:
                save_policy(model, tok, args.save_to, step)

    if args.save_to:
        save_policy(model, tok, args.save_to, args.steps)

    Path(args.out).write_text(
        json.dumps({"model": args.model, "train_problems": len(train),
                    "dead_groups": dead, "history": history}, indent=2) + "\n",
        encoding="utf-8")
    print(f"\nwrote {args.out}  (dead groups: {dead}/{args.steps})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
