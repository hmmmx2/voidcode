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
import gc
import json
import os
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


def split_holdout(train: list[dict], n: int, seed: int) -> tuple[list[dict], list[dict]]:
    """Reserve `n` problems from the band for in-domain evaluation. Returns `(train, holdout)`.

    Shuffled with the run seed rather than sliced off the end: `load_band` preserves corpus order
    and the corpus is grouped by source (`primeintellect` 1884, `lcbv5` 72, `codeforces` 44), so a
    tail slice would hold out one source instead of a sample of the training distribution — and the
    resulting "in-domain" number would be measuring a distribution shift of its own.
    """
    if n <= 0:
        return train, []
    order = list(range(len(train)))
    random.Random(seed).shuffle(order)
    held = set(order[:n])
    return ([p for i, p in enumerate(train) if i not in held],
            [p for i, p in enumerate(train) if i in held])


def drop_over_context(problems: list[dict], tok, budget: int) -> tuple[list[dict], int]:
    """Remove problems whose templated prompt leaves no room for a completion. Returns (kept, dropped).

    vLLM REJECTS a request longer than `max_model_len` rather than truncating it, and the rejection
    arrives as an exception in the middle of the step loop -- a crash at step 37 of 50 loses the
    whole run. Measured on this corpus with the 30B tokenizer, `--max-new 640`: 18 of 2000 problems
    exceed at `--vllm-max-len 2048`, 1 at 4096, 0 at 5120. At the flags the 30B run launches with
    nothing is dropped and this is pure insurance; at a tighter budget it turns a crash into a
    smaller, and reported, training set.

    Measures the CHAT-TEMPLATED prompt, because that is what reaches the engine — the template adds
    tokens, and a check against the bare prompt would pass problems that then fail in vLLM.
    """
    kept = []
    for p in problems:
        chat = tok.apply_chat_template(
            [{"role": "user", "content": build_prompt(p["prompt"])}],
            tokenize=False, add_generation_prompt=True)
        if len(tok(chat)["input_ids"]) <= budget:
            kept.append(p)
    return kept, len(problems) - len(kept)


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
                   greedy: bool = False, engine=None, seed: int | None = None) -> list[str]:
    """Sample `group` completions, or take the single greedy one when `greedy`.

    Greedy decoding is **deterministic**: the same policy on the same prompt gives the same string
    every time. That makes it the only eval metric here whose movement cannot be sampling noise.
    """
    if engine is not None:
        # vLLM path: same prompt, same sampling parameters, ~86x the throughput.
        return engine.generate(tok, prompt, group, max_new, temperature, greedy=greedy, seed=seed)
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
             temperature: float, timeout_s: float, seed: int = 1234, engine=None) -> dict:
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
    for i, p in enumerate(problems, 1):
        texts = generate_group(model, tok, eval_build_prompt(p), group, max_new, temperature,
                               engine=engine, seed=seed)
        g_text = generate_group(model, tok, eval_build_prompt(p), 1, max_new, temperature,
                                greedy=True, engine=engine, seed=seed)
        sources = [eval_extract_code(t, p["entry"]) for t in texts + g_text]
        if os.environ.get("GRPO_DEBUG_EVAL") and i <= 2:
            # Dump exactly what the policy produced and what the extractor kept. An all-zero eval
            # can come from generation, extraction or grading, and only the raw text separates them.
            print(f"[dbg] {p['id']} raw[0] ({len(texts[0])} ch): {texts[0][:200]!r}", flush=True)
            print(f"[dbg] {p['id']} src[0] ({len(sources[0])} ch): {sources[0][:200]!r}", flush=True)
        try:
            verdicts = run_isolated_batch(p, sources, timeout_s=timeout_s)
        except RuntimeError as exc:
            # A harness bug, surfaced rather than scored. Scoring it zero is how the base
            # pass-rate run once reported 0/4 on problems that were actually solved.
            print(f"  eval harness error on {p['id']}: {exc}", flush=True)
            continue
        rewards = [v.case_fraction for v in verdicts[:-1]]
        greedy = verdicts[-1]
        if os.environ.get("GRPO_DEBUG_EVAL") and i <= 2:
            print(f"[dbg] {p['id']} greedy outcome={greedy.outcome} cf={greedy.case_fraction} "
                  f"err={greedy.error}", flush=True)
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


def evaluate_holdout(model, tok, problems: list[dict], group: int, max_new: int,
                     temperature: float, timeout_s: float, seed: int = 1234, engine=None,
                     max_cases: int = 20) -> dict:
    """The same measurement as `evaluate`, on held-out problems from the TRAINING distribution.

    WHY THIS EXISTS
    ---------------
    The 30B run moved the policy (KL 0 -> 0.0771) and the eval did not move at all (greedy 18/60 at
    step 0 and at step 50). That has two very different explanations and the run as built could not
    tell them apart:

      1. GRPO learned nothing.
      2. GRPO learned something that does not transfer from DeepCoder's stdin/stdout competitive
         problems to the catalogue's 60 authored function-entry problems.

    `evaluate` only ever measured (2)'s failure mode, because `--eval-set` is a different task
    format reached through a different prompt builder, a different extractor and a different
    grading path. A flat curve there is consistent with a policy that improved substantially
    in-distribution. This function closes that gap: same prompt, same extractor and same stdio
    grader the reward uses, on problems the loop is never trained on.

    It is emphatically NOT a replacement for the catalogue eval. Transfer is the thing the project
    ultimately cares about, and an in-domain gain with no transfer is a real and reportable
    negative result. It is a replacement for not knowing which of the two happened.
    """
    cpu_rng = torch.get_rng_state()
    cuda_rng = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    solved = greedy_solved = 0
    fractions: list[float] = []
    greedy_fractions: list[float] = []
    for p in problems:
        prompt = build_prompt(p["prompt"])
        texts = generate_group(model, tok, prompt, group, max_new, temperature,
                               engine=engine, seed=seed)
        g_text = generate_group(model, tok, prompt, 1, max_new, temperature,
                                greedy=True, engine=engine, seed=seed)
        sources = [extract_code(t) for t in texts + g_text]
        try:
            # Same slice the reward uses, so an in-domain number is comparable to the training
            # signal rather than to a different subset of the same problems.
            verdicts = run_isolated_stdio_batch(sources, p["tests"][:max_cases],
                                                timeout_s=timeout_s)
        except RuntimeError as exc:
            print(f"  holdout harness error on {p['id']}: {exc}", flush=True)
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
    gn = max(len(greedy_fractions), 1)
    return {
        "holdout_problems": len(problems),
        "holdout_solved_any": solved,
        "holdout_mean_case_fraction": round(mean, 4),
        "holdout_case_fraction_se": round((var / n) ** 0.5, 4),
        "holdout_greedy_solved": greedy_solved,
        "holdout_greedy_case_fraction": round(sum(greedy_fractions) / gn, 4),
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


class VLLMRollouts:
    """vLLM-backed rollout generation for the GRPO loop.

    Two responsibilities beyond calling generate():

    1. **Keeping generation on-policy.** The policy is base + adapter, so the adapter is written to
       disk after every optimiser step and handed to vLLM under a FRESH LoRA id. vLLM caches
       adapters by id, so reusing an id would silently keep serving the stale adapter and every
       rollout after step 1 would be off-policy -- with no error to notice.

    2. **Sharing one GPU with the trainer.** sleep(level=1) evicts the engine's weights to CPU
       between generations, so the trainer gets the card back for forward/backward. Costs a few
       seconds of PCIe traffic per step and removes the risk of the two models racing for VRAM.
    """

    def __init__(self, model: str, gpu_util: float, max_len: int, max_lora_rank: int,
                 workdir: Path, use_sleep: bool = False):
        from vllm import LLM
        self.use_sleep = use_sleep
        self.workdir = workdir
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.lora_id = 0
        self.truncated = 0
        self.adapter_dir: str | None = None
        self.llm = LLM(
            model=model, dtype="float16", gpu_memory_utilization=gpu_util,
            max_model_len=max_len, trust_remote_code=True,
            enable_lora=True, max_lora_rank=max_lora_rank, max_loras=1,
            enable_sleep_mode=use_sleep,
        )
        self.asleep = False
        print(f"vLLM engine up: {model} (gpu_util={gpu_util}, lora rank {max_lora_rank})",
              flush=True)

    def publish(self, model) -> None:
        """Write the current adapter and bump the id so vLLM reloads it."""
        self.lora_id += 1
        d = self.workdir / f"adapter-{self.lora_id}"
        model.save_pretrained(str(d))
        self.adapter_dir = str(d)

    # SLEEP/WAKE IS OFF BY DEFAULT, AND THAT IS THE POINT.
    #
    # The obvious design -- sleep the engine during backward so the trainer gets the whole card --
    # fails on the way back. sleep() releases the engine's ~20 GiB, PyTorch's caching allocator
    # immediately expands into it, and fragmentation means empty_cache() cannot hand it back:
    #     Call to wake_up method failed: CUDA Error: out of memory (cumem_allocator.cpp:62)
    # expandable_segments would fix the fragmentation but vLLM's memory pool rejects it outright.
    #
    # Leaving the engine RESIDENT sidesteps all of it. Its 20 GiB is simply never available to the
    # trainer, so the trainer's allocator is bounded by construction instead of by discipline, and
    # there is no per-step PCIe shuffle either. Sleep stays available for a future two-model setup
    # that genuinely cannot fit both.
    def wake(self) -> None:
        if self.use_sleep and self.asleep:
            gc.collect()
            torch.cuda.empty_cache()
            self.llm.wake_up()
            self.asleep = False

    def sleep(self) -> None:
        if self.use_sleep and not self.asleep:
            self.llm.sleep(level=1)
            self.asleep = True

    def generate(self, tok, prompt: str, group: int, max_new: int, temperature: float,
                 greedy: bool = False, seed: int | None = None) -> list[str]:
        from vllm import SamplingParams
        from vllm.lora.request import LoRARequest
        chat = tok.apply_chat_template(
            [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
        # SEED THE SAMPLER HERE, not with torch.manual_seed.
        #
        # evaluate() reseeds torch before every eval so two checkpoints see the same sampling draws
        # (common random numbers) and their difference reflects the policy rather than two doses of
        # noise. That reseed became INERT the moment generation moved to vLLM: sampling happens in
        # the engine's own worker process, which torch.manual_seed in this process cannot reach.
        # A per-request seed restores the property the eval was designed around.
        sp = SamplingParams(
            n=1 if greedy else group,
            temperature=0.0 if greedy else temperature,
            top_p=1.0 if greedy else 0.95,
            max_tokens=max_new,
            seed=seed,
        )
        req = (LoRARequest(f"step{self.lora_id}", self.lora_id, self.adapter_dir)
               if self.adapter_dir else None)
        out = self.llm.generate([chat], sp, lora_request=req, use_tqdm=False)
        # Count completions that hit the token wall rather than stopping. A completion truncated
        # mid-prose reaches the grader as unparseable source and scores 0 for every sample in the
        # group -- a dead group caused by max_new, not by the corpus. Without this counter the two
        # are indistinguishable after the fact.
        for c in out[0].outputs:
            if getattr(c, "finish_reason", None) == "length":
                self.truncated += 1
        return [c.text for c in out[0].outputs]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="filter_corpus.py summary JSON (metrics only)")
    ap.add_argument("--source", required=True,
                    help="the corpus that was filtered; supplies prompt/tests, joined by id")
    ap.add_argument("--signal", choices=["band", "any"], default="any",
                    help="'band' = strict 10-90%% pass rate; 'any' also keeps partial-credit problems")
    ap.add_argument("--eval-set", required=True, help="the 60 local problems (data/catalogue.json)")
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    # LoRA. Off by default so existing runs reproduce exactly; --lora-r 16 turns it on.
    #
    # This is what makes a 7B policy fit a 48 GB card. Full-parameter 7.6B needs roughly
    # 15 GB policy + 15 GB frozen reference + 15 GB grads + ~61 GB fp32 AdamW moments ~= 107 GB.
    # With LoRA only the adapter trains (~40M params at r=16), and the reference is the SAME
    # weights with the adapter switched off -- so the second 15 GB copy disappears entirely and the
    # reference is exactly the base policy by construction rather than by a separate load.
    ap.add_argument("--lora-r", type=int, default=0,
                    help="LoRA rank; 0 disables LoRA and trains full-parameter")
    # 4-bit base (QLoRA). This is what puts a 32B policy on a 48 GB card.
    #
    # Measured on this project: 7B + LoRA in bf16 peaks at 15.7 GiB of a 46 GiB A40, so bf16 has
    # room for ~7B and no more. A 32B in bf16 is ~64 GiB of weights alone and does not fit at any
    # batch size. At 4-bit NF4 the same 32B is ~18 GiB, leaving ~26 GiB for the adapter, the
    # rollout batch and activations. Requires --lora-r > 0: training 4-bit weights directly is not
    # possible, only the fp16 adapter on top of them is trained.
    ap.add_argument("--load-4bit", action="store_true",
                    help="load the base in 4-bit NF4 (QLoRA). Requires --lora-r > 0")
    # vLLM-backed rollout generation.
    #
    # MEASURED on this project, Qwen3-Coder-30B-A3B on an A40:
    #   transformers eager   15.1 tok/s   (17% GPU utilisation, no fused MoE kernels)
    #   vLLM 0.11 + AWQ    1295.7 tok/s   85.8x faster
    # A 200-step rollout budget goes from 18.8 h to about 13 minutes. Generation is the dominant
    # cost in GRPO, so this is the single highest-leverage change available to the loop.
    #
    # The policy is base + adapter, so vLLM must generate WITH the current adapter or the rollouts
    # are off-policy. Verified working: vLLM applies an attention-only LoRA on top of a quantized
    # (AWQ) MoE base. Verified by output change, not by absence of an exception -- a silently
    # ignored adapter loads without error and returns base-model text.
    #
    # NOTE the adapter must NOT target expert weights: vLLM does not support fused MoE LoRA. Use
    # --lora-targets attn, which is also what keeps the adapter small.
    ap.add_argument("--vllm-model", default="",
                    help="model id for vLLM rollout generation, e.g. an AWQ build of --model. "
                         "Empty disables vLLM and generation stays in transformers.")
    ap.add_argument("--vllm-gpu-util", type=float, default=0.45,
                    help="fraction of VRAM for the vLLM engine; the trainer needs the rest")
    ap.add_argument("--vllm-max-len", type=int, default=2048)
    ap.add_argument("--lora-alpha", type=int, default=32)
    # peft matches target_modules by NAME SUFFIX, which is a trap on a Mixture-of-Experts model:
    # "gate_proj" matches every expert's gate in every layer, so a 128-expert MoE grows 128x the
    # intended adapters and the parameter count explodes. On MoE pass --lora-targets attn to adapt
    # only the attention projections, which are shared across experts.
    ap.add_argument("--lora-targets", choices=["all", "attn"], default="all",
                    help="'all' = attention + MLP (dense models); 'attn' = attention only (MoE)")
    ap.add_argument("--lora-dropout", type=float, default=0.05)
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
    ap.add_argument("--holdout", type=int, default=0,
                    help="band problems reserved from training and evaluated IN-DOMAIN; "
                         "0 disables. See evaluate_holdout for why this is not optional in "
                         "practice: without it a flat catalogue curve cannot be told apart "
                         "from a real in-distribution gain that simply did not transfer.")
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

    # In-domain holdout, carved out of the band BEFORE any training sees it.
    if args.holdout >= len(train) > 0:
        print(f"ABORT: --holdout {args.holdout} leaves nothing to train on "
              f"({len(train)} in-band)", flush=True)
        return 1
    train, holdout = split_holdout(train, args.holdout, args.seed)

    print(f"train={len(train)} in-band, eval={len(eval_problems)} held out"
          + (f", holdout={len(holdout)} in-domain" if holdout else ""), flush=True)

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(args.model)

    # Silence would be the bug here, so the count is printed. See drop_over_context.
    if args.vllm_model:
        budget = args.vllm_max_len - args.max_new
        train, dropped_t = drop_over_context(train, tok, budget)
        holdout, dropped_h = drop_over_context(holdout, tok, budget)
        dropped = dropped_t + dropped_h
        if dropped:
            print(f"  dropped {dropped} problem(s) whose prompt exceeds "
                  f"--vllm-max-len {args.vllm_max_len} minus --max-new {args.max_new} "
                  f"= {budget} tokens", flush=True)
        if not train:
            print("ABORT: every in-band problem is too long for the context budget", flush=True)
            return 1

    # BUILD THE ENGINE FIRST, WHILE THE CARD IS EMPTY.
    #
    # Order matters more than allocator tuning here. Loading the trainer first left only 4.34 GiB
    # free by vLLM's own measurement -- PyTorch's caching allocator keeps freed blocks reserved, and
    # empty_cache() only returns them properly under expandable_segments, which vLLM's sleep mode
    # rejects outright ("Expandable segments are not compatible with memory pool"). Both levers
    # therefore conflict; constructing the engine on an empty card avoids needing either.
    #
    # vLLM takes gpu_memory_utilization of the card up front, and the 4-bit trainer fits in what
    # remains (~16 GiB allocated against ~24 GiB left at util 0.45).
    engine = None
    if args.vllm_model:
        if args.lora_r <= 0:
            print("--vllm-model currently requires --lora-r > 0: the engine serves a frozen base "
                  "plus a hot-reloaded adapter, which is how the policy reaches it.", flush=True)
            return 2
        engine = VLLMRollouts(args.vllm_model, args.vllm_gpu_util, args.vllm_max_len,
                              args.lora_r, Path(args.save_to or ".").parent / "vllm_adapters")
        print(f"engine resident; {torch.cuda.mem_get_info()[0] / 1024 ** 3:.1f} GiB left for "
              f"the trainer", flush=True)

    if args.load_4bit and args.lora_r <= 0:
        print("--load-4bit requires --lora-r > 0: 4-bit weights cannot be trained directly, "
              "only an fp16 adapter on top of them.", flush=True)
        return 2

    load_kw = {"torch_dtype": torch.bfloat16, "device_map": "cuda"}
    if args.load_4bit:
        from transformers import BitsAndBytesConfig
        load_kw["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    model = AutoModelForCausalLM.from_pretrained(args.model, **load_kw)

    if args.lora_r > 0:
        from peft import LoraConfig, get_peft_model
        model = get_peft_model(model, LoraConfig(
            r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=args.lora_dropout,
            target_modules=(["q_proj", "k_proj", "v_proj", "o_proj"] if args.lora_targets == "attn"
                            else ["q_proj", "k_proj", "v_proj", "o_proj",
                                  "gate_proj", "up_proj", "down_proj"]),
            task_type="CAUSAL_LM"))
        if args.load_4bit:
            # Without this the adapter receives no gradient: the 4-bit base produces no grad_fn,
            # so nothing upstream of the adapter is differentiable.
            model.enable_input_require_grads()

        # GRADIENT CHECKPOINTING, and it is not optional at this size.
        #
        # Sharing one card with a resident vLLM engine leaves the trainer ~24 GiB, and the backward
        # pass over a 48-layer MoE OOM'd inside it:
        #   "Tried to allocate 2.00 MiB ... 24.09 GiB is allocated by PyTorch, and 111.59 MiB is
        #    reserved but unallocated"
        # That 111 MiB of slack says this is real capacity, not fragmentation, so allocator tuning
        # cannot help. Recomputing activations instead of storing them is the only lever that does,
        # and it cannot come out of the engine's share: 0.40 of the card is already close to the
        # floor set by the AWQ weights themselves.
        #
        # use_cache must go off with it -- the KV cache and checkpointing contradict each other, and
        # transformers only warns rather than failing.
        model.gradient_checkpointing_enable()
        model.config.use_cache = False
        print("gradient checkpointing on (use_cache off): trades ~30% compute for activation "
              "memory, which is the binding constraint when sharing the card with vLLM",
              flush=True)
        # No second copy: the reference is these weights with the adapter disabled.
        ref = None
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in model.parameters())
        print(f"LoRA r={args.lora_r}: {trainable/1e6:.1f}M trainable of {total/1e9:.2f}B "
              f"({100*trainable/total:.3f}%); reference = adapter-disabled base", flush=True)
    else:
        ref = AutoModelForCausalLM.from_pretrained(
            args.model, torch_dtype=torch.bfloat16, device_map="cuda")
        ref.eval()
        for p in ref.parameters():
            p.requires_grad_(False)

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr)

    if engine is not None:
        engine.publish(model)   # step-0 adapter, so even the baseline eval is on-policy

    # Baseline before any step, so a flat curve is provably flat rather than merely unmeasured.
    if engine is not None:
        engine.wake()
    oom_skipped = 0
    def eval_all(step_no: int) -> dict:
        """Catalogue eval (transfer) plus, when asked for, the in-domain holdout."""
        row = {"step": step_no, **evaluate(model, tok, eval_problems, args.eval_group,
                                           args.max_new, args.temperature, args.grade_timeout,
                                           engine=engine)}
        if holdout:
            row.update(evaluate_holdout(model, tok, holdout, args.eval_group, args.max_new,
                                        args.temperature, args.grade_timeout, engine=engine,
                                        max_cases=args.max_cases))
        return row

    history = [eval_all(0)]
    print(f"step 0 eval: {history[0]}", flush=True)

    dead = 0
    stats: dict = {}                      # survives a dead step, which skips the update entirely
    for step in range(1, args.steps + 1):
        problem = random.choice(train)
        prompt = build_prompt(problem["prompt"])

        model.eval()
        if engine is not None:
            engine.wake()
        texts = generate_group(model, tok, prompt, args.group, args.max_new, args.temperature,
                               engine=engine)
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
        if engine is not None:
            engine.sleep()      # give the card back to the trainer for forward/backward

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
            step_corrupted = False

            # backward() PER COMPLETION, not once over an accumulated sum. Summing the losses
            # first keeps every completion's autograd graph alive simultaneously -- at --group 16
            # that is 16 graphs, and it OOM'd a 46 GB A40 at 44.24 GiB. Gradients accumulate into
            # .grad either way, so this is identical maths and frees each graph as it is used.
            n = len(texts)
            for i, text in enumerate(texts):
                # OOM GUARD.
                #
                # A single long completion can exhaust the trainer's share of a shared card, and
                # losing the whole run to one bad rollout is unacceptable when the eval before it
                # cost 25 minutes. On OOM: drop this completion's graph, return its blocks to the
                # driver, and carry on with the rest of the group.
                #
                # Skips are COUNTED and reported, never swallowed. A run that quietly dropped half
                # its completions would still produce a smooth-looking curve computed from a
                # different batch size than the one recorded, which is a silent-corruption bug of
                # exactly the kind this project keeps finding.
                try:
                    logp = sequence_logp(model, tok, prompt, text)
                    with torch.no_grad():
                        if ref is not None:
                            ref_logp = sequence_logp(ref, tok, prompt, text)
                        else:
                            # Adapter off == the base policy == the reference, no extra memory.
                            with model.disable_adapter():
                                ref_logp = sequence_logp(model, tok, prompt, text)
                    old_logp = logp.detach()  # one update per rollout: the sampling policy IS old
                    loss, stats = grpo_loss(logp, old_logp, ref_logp,
                                            adv[i].to(logp.device).expand_as(logp), beta=args.beta)
                    (loss / n).backward()
                except torch.OutOfMemoryError:
                    # ABANDON THE STEP, do not salvage it.
                    #
                    # The first version of this handler called opt.zero_grad() and continued, which
                    # is wrong twice over: it throws away the gradient already accumulated from the
                    # group's earlier completions, and then opt.step() fires on whatever came after
                    # the OOM. Group-relative advantages sum to zero ACROSS THE GROUP by
                    # construction, so a partial subset carries a non-zero mean -- the update would
                    # push the policy in a direction no completion voted for, and the run would
                    # still look healthy in the logs.
                    oom_skipped += 1
                    step_corrupted = True
                    print(f"  OOM on completion {i} of step {step} ({len(text)} chars); "
                          f"ABANDONING this step, total OOM steps {oom_skipped}", flush=True)
                    opt.zero_grad(set_to_none=True)
                    gc.collect()
                    torch.cuda.empty_cache()
                    break

            if step_corrupted:
                # A partial group is not a smaller group; it is a biased one.
                opt.zero_grad(set_to_none=True)
            else:
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)

            if engine is not None:
                # The policy just moved, so the engine's adapter is stale. Republishing under a new
                # id is what keeps the next step's rollouts on-policy -- vLLM caches by id, so
                # reusing one would serve the old adapter with no error to notice.
                engine.publish(model)

        if step % 10 == 0:
            kl = stats.get("kl", float("nan"))
            print(f"step {step}  reward={r.mean():.3f}  dead_so_far={dead}  "
                  f"oom_skipped={oom_skipped}  "
                  f"truncated={engine.truncated if engine else 0}  kl={kl:.4f}",
                  flush=True)

        if step % args.eval_every == 0:
            model.eval()
            if engine is not None:
                engine.wake()
            e = eval_all(step)
            history.append(e)
            print(f"step {step} eval: {e}", flush=True)
            Path(args.out).write_text(
                json.dumps({"model": args.model, "train_problems": len(train),
                            "dead_groups": dead, "oom_skipped": oom_skipped, "history": history}, indent=2) + "\n",
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
