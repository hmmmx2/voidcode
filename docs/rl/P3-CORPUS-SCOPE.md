# P3 corpus: what to train GRPO on, now that the 60 cannot be it

## Why this document exists

Two measurements killed the original plan for P3a. Qwen2.5-Coder-1.5B solves 7 of the 60 problems
into the usable band; Qwen2.5-7B-Instruct solves 6, with a *worse* dead-group rate. 52 of 60 remain
unsolved by a 7B at temperature 0.8 with eight attempts. **The constraint is the corpus, not the
policy**, and no model this project can afford changes that.

The 60 keep their real job: an ungameable, hidden-case, three-way-validated **evaluation** set.
Training on them would have burned the scarcer artefact.

---

## 1. Corpus choice: DeepCoder's 24K, not KodCode's 447K

| | KodCode | **DeepCoder** |
|---|---|---|
| Size | 447K verified triplets | **24K verified problems** |
| Sources | synthetic | TACO + PrimeIntellect SYNTHETIC-1 + LiveCodeBench (May 2023–Jul 2024) |
| Built for | RL with test-pass rewards | RL with test-pass rewards |

Both are explicitly designed for exactly this — machine-executable tests as the reward signal, cited
for PPO/GRPO/REINFORCE++. The choice is settled by a published comparison rather than by preference:
**a Qwen3-8B-Base trained with GRPO on DeepCoder scored 14.41 against 11.51 for the same recipe on
KodCode, despite KodCode carrying nearly 2× the data.** Curation beat scale by a wide margin.

Taking the smaller, better-curated set also suits a project whose bottleneck is a 16 GiB card and a
$150 ceiling.

**Contamination note.** DeepCoder includes LiveCodeBench problems up to July 2024. That is fine here
because **the evaluation set is the 60 local problems**, which appear in no public corpus. Do not
also report LiveCodeBench numbers from a model trained on this.

## 2. The harness needs **two** new grading paths, not one

**Correction to this document's own scope.** It said KodCode ships pytest-style tests and that one
new mode would cover the corpus. DeepCoder is not that shape: its ~24,973 rows carry `problem` and
`tests`, where `tests` is a list of `{"input", "output"}` pairs against a program reading stdin.
That is **stdin/stdout competitive programming**, sourced from TACO, LiveCodeBench and Codeforces.

Discovering it after building the pytest path cost one function rather than a rewrite, because both
reduce to the same requirement: **count cases individually so partial credit survives**.

| Mode | Shape | For |
|---|---|---|
| `grader.run_cases` | `entry(*args)` vs a derived expectation | the 60 local problems |
| `grade_by_tests` | pytest functions, or bare asserts | KodCode, MBPP |
| **`grade_by_stdio`** | **stdin fed, stdout compared** | **DeepCoder** |

Each has a `limits.run_isolated*` wrapper owning the spawn, timeout and rlimits, and all three
return the same `IsolatedResult`, so callers never branch on which corpus they are grading.

`normalise_output` compares the way a judge does — trailing whitespace per line and trailing blank
lines are not differences. Anything stricter fails correct programs over a newline.

## 2b. The original argument for one path

This is the real work, and it is smaller than it looks.

The current reward compares `repr(round_recursive(normalise(entry(*args)), 8))` — it assumes a
**function called with arguments**, and derives the expected value by executing a reference. Public
corpora are not shaped that way: TACO and LiveCodeBench problems are largely **stdin/stdout
competitive programming**, and KodCode ships **pytest-style unit tests**.

Rather than force them into `(args, expected)`, add a second grading mode:

    grade_by_tests(source, test_code, timeout) -> (passed, total)

Run the candidate solution and its test suite together inside `limits.run_isolated`, count passing
tests. Two things fall out for free:

- **Partial credit is native.** "7 of 10 tests pass" is exactly the `case_fraction` the GRPO reward
  already uses, and the 1.5B measurement showed partial credit is what takes a usable set from 7 to
  27. A pass/fail reward would waste most of any corpus.
- **Isolation is already built.** `limits.run_isolated` exists, has 7 tests, and handles the
  timeout, the rlimits and the CUDA-fork trap. Nothing new is needed for safety.

**What is lost, and it should be stated in the write-up:** the 60 have expectations *derived* by
executing a reference and cross-checked against a frozen Judge0 oracle. A public corpus's tests are
taken on trust. That is acceptable for *training* signal and is precisely why the evaluation set
stays local.

## 3. The filter pass is now the expensive step

Every corpus needs the same 10–90% base-pass filter the 60 got, and at 24K problems that inverts the
cost model: **filtering, not training, becomes the long-running job.**

| | with HF `generate` (measured) | with vLLM (expected) |
|---|---|---|
| 60 problems, G=8 | ~13 s/problem | — |
| 24K problems, G=8 | **~87 hours** | a few hours |

So vLLM stops being a P3b nicety and becomes a P3a dependency. Two ways to keep it cheap:

1. **Sample first.** Filter a random 2,000 before committing to all 24K. That is ~7 hours locally
   with HF generate, or well under an hour with vLLM, and it measures the in-band *fraction* — which
   is the number that decides whether the full pass is worth running at all.
2. **Filter with the policy you will train.** The band is a property of the pair, not the corpus.
   Filtering with a 7B and training a 1.5B would select the wrong problems.

## 4. Sizing

A few thousand in-band problems is ample for a demonstration GRPO run — the 60 gave 27 and that was
already the binding constraint. If the sampled fraction in-band is even 20%, the full 24K yields
~4,800, which is two orders of magnitude more signal than the current position.

## 5. What does not change

- **`reward/grader.py` and the 60 stay exactly as they are.** They are the evaluation set.
- **`reward/limits.py`** does the isolation for both paths.
- **`rl/grpo.py`** is corpus-agnostic — advantages, dead-group rate, k3 KL and the clipped objective
  never see a problem.
- **The dead-group diagnostics matter more, not less.** A public corpus is easier, so the failure
  mode flips from all-fail to all-pass. `dead_group_rate` already counts both, and
  `tests/test_grpo.py` pins that it does.

## 6. Order of work

1. `grade_by_tests` plus its tests — CPU, free, and the only genuinely new code.
2. An adapter that pulls DeepCoder into the same record shape the pass-rate script consumes.
3. vLLM locally, which the 4.32 GiB of headroom from the fused kernel should now permit.
4. Filter a 2,000-problem sample; report the in-band fraction.
5. Only then decide whether P3a runs locally or needs the A40, on a measured number.

## 7. Risks, and which are real

- **Transfer is unproven.** Training on general Python and evaluating on ML/DL implementation
  problems may show little movement. This is the honest headline risk, and the evaluation set is
  built to detect it rather than hide it. A flat eval curve is a publishable result, not a failure.
- **Test quality is taken on trust**, unlike the 60. Mitigated by partial credit being robust to a
  few bad tests, and by never reporting public-benchmark numbers from this model.
- **vLLM in 16 GiB is measured but tight** — 4.32 GiB of headroom, and that figure excludes vLLM's
  own allocator overhead. If it does not fit, the filter pass moves to an A40 for a few hours, which
  is a far better use of $5 than the GRPO run this replaced.

Sources: [DeepCoder](https://www.together.ai/blog/deepcoder),
[KodCode](https://arxiv.org/abs/2503.02951),
[the GRPO comparison](https://arxiv.org/html/2602.17684v1)
