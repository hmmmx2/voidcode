# RL findings

Required by `VOIDCODE_TRAINING_SPEC.md` §4.5: *"Record any hacking you find in
`docs/RL_FINDINGS.md`. Finding and documenting reward hacking is a stronger result than a clean
curve."*

---

## The audit could not be performed on the completed run, and that is the finding

**The generated completions were never persisted.** `train_grpo.py` as run logged only what the
graded candidates *printed* while executing. The artefact is
`docs/grpo-runs/grpo-train-lr5e-6.log`: **164 MB, 11,669,334 lines, and zero lines containing
`def ` or `import `.** It is 11.6 million lines of program output like `Range: [4, 4]` and not one
line of generated source.

Searched anyway, and every count is zero — which is evidence about the *log*, not about the policy:

| pattern | hits |
|---|---|
| bare `except:` | 0 |
| `except ... pass` (swallowing failures) | 0 |
| `sys.exit(0)` early-out | 0 |
| `assert True` / `assert 1` | 0 |
| grader monkeypatching (`run_cases`, `__import__`) | 0 |
| file or network access | 0 |
| `harness error`, `timeout` | 0 |

The last row is the tell. Timeouts and harness errors certainly occurred during a 200-step run, and
they read zero here too. **A search that returns zero for things known to have happened is not a
clean result, it is a broken search** — and reporting the other rows as "no hacking found" on the
strength of it would have been exactly the kind of plausible wrong number this project keeps
catching.

**So the honest claim is: the evidence was not retained, and no audit was performed.** That is
weaker than §4.5 asks for, and it is not the same as "we looked and found none". Only the second is
worth writing, and only the first is true.

## Root cause, and it has a sibling

The run did not persist what was needed to examine it afterwards. This is the same failure as the
missing checkpoint recorded in D-016: `train_grpo.py` had no `--save-to`, so the 200-step policy
died with its pod. Two different artefacts, one cause — **the loop produced numbers and discarded
everything that would let anyone interrogate them.**

Fixed for future runs by `--log-completions`, which samples one step in `--log-every` and writes
JSONL carrying the problem id, every reward in the group, and the **best and worst** completions.
The extremes are where hacking shows: a suspiciously perfect score on a problem the rest of the
group fails is the shape to look for.

## What can be said about hacking risk on this run, without evidence

Not an audit, but worth stating so the gap is bounded rather than open:

- **The policy never improved.** `greedy_solved` ran 4 → 3 → 3 → 4 → 3 across 200 steps and
  `mean_case_fraction` moved 0.0062 against a 0.0214 detection threshold. A policy that did not
  learn to solve more problems is unlikely to have learned to cheat at them, since both require the
  same gradient signal the run did not produce.
- **KL stayed at 0.001–0.008.** §4.5 names "a sharp KL rise with a rising reward" as the classic
  signature. Neither half of that occurred: KL was flat and low, and reward did not rise.
- **The reward path is comparatively hard to game.** Grading is hidden-case, out-of-process, and the
  expectations are derived by executing a reference — not string-matched against visible tests. The
  Revised Plan's warning about visible test cases applies to the *platform's* five DSA problems, not
  to the 60 local problems used here, which do hold hidden cases.

**None of this is a substitute for looking.** It is an argument that the prior probability is low,
which is a different and much weaker claim than the one §4.5 asks for.

## To close this properly

Re-run with `--log-completions docs/grpo-runs/completions.jsonl`, then audit the sampled extremes by
hand. Cheap to fold into the PPO-vs-GRPO comparison, which has to generate completions anyway.
