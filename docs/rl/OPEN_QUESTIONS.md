# Open questions

Required by `VOIDCODE_TRAINING_SPEC.md` rule 7: flag anything ambiguous or technically wrong here
rather than working around it silently. This file did not exist until now, which is itself a gap —
several of the entries below were worked around during the build instead of being raised.

---

## Q-001 — V6 was executed ahead of its own prerequisites, and the result may be a consequence

**Status:** open, and it affects how the GRPO result should be reported.

The Revised Plan defers V6 and lists four prerequisites. Measured against them at the time the
200-step GRPO run was made:

| Prerequisite | State when V6 ran |
|---|---|
| 1. ML content exists on the platform | **No.** Catalog is five DSA problems |
| 2. Hidden test cases exist | **Partly.** Not on the platform, but the 60 local problems in `data/catalogue.json` do have hidden cases, and those were the eval set |
| 3. Corpus rebuilt | **Sidestepped.** The 1,860-example truncated corpus was not rebuilt; a different corpus (DeepCoder, 1060 in-band problems) was built instead |
| 4. Evaluation measures teaching quality | **No.** It measures code correctness by hidden-case pass rate |

Prerequisite 1 is the one that bites. The plan warns: *"otherwise you are fine-tuning a tutor for a
subject the platform does not teach."* The run trained on general competitive-programming Python and
evaluated on ML/DL implementation problems, and **measured no transfer** — which is the failure the
prerequisite exists to prevent.

**This does not invalidate the result.** The eval was verified deterministic first and the policy
demonstrably moved (KL 0.001–0.008), so "no transfer for this recipe at this scale" is a real
finding. But it should be reported as *a negative result obtained outside the plan's stated
preconditions*, not as evidence that GRPO cannot work on this platform — the plan predicted this
outcome and the run did not test the configuration the plan actually recommends.

**To resolve:** either rebuild the training corpus from ML content once V1 exists, or state
explicitly in the write-up that the domains were mismatched by design.

## Q-002 — The merge / quantize / vLLM-serve pipeline never completed

**Status:** answered, recorded as D-016. Kept here because the plan asked the question.

V0 asks whether that pipeline ever completed. **It did not.** No `.safetensors` exist anywhere in
this repository, and no `awq_model` directory exists at any documented path. Any figure quoted from
that pipeline is unbacked and must not be repeated.

## Q-003 — Training-spec deliverables not built, and not previously flagged

`VOIDCODE_TRAINING_SPEC.md` names these; none exist. Listing them so the gap is visible rather than
discovered by a reader.

| Spec section | Deliverable | State |
|---|---|---|
| §4.6 | **PPO comparison arm** — "the job description names both" | Not built. GRPO only |
| §4.7 | **Weight sync cost** between trainer and rollout engine | Not measured. The trainer and vLLM were never run as a synchronising pair; P3b timed generation only |
| §4.7 | pass@1 improves over base on held-out | **Failed.** 5–7/60 throughout, no improvement |
| §4.5 | `docs/RL_FINDINGS.md` — reward hacking found or its absence argued | Not written. No manual completion inspection was done |
| §1.2, §8 | **Multi-node** — named as "required", cannot be faked locally | Not done. Every run was single-node |
| §8 | `docs/TRAINING_METRICS.md` | Numbers went into `docs/METRICS.md` instead. Either rename or state the substitution |
| §2.1, T5 | Public repo + `docs/CONTRIBUTIONS.md` | Mirror exists at `C:\Temp\vct-pub`, 33 commits, **no remote configured**, so nothing is published |

**The load-bearing one is multi-node.** §1.2 calls it out as one of two capabilities that "cannot be
faked locally", names it as required by the target role, and budgets for it. Two GPUs in one box is
single-node, and the spec is explicit that conflating them "is the fastest way to lose credibility".
Every measurement in this repo is single-node and must be described that way.

## Q-004 — Is the target the job or the product?

The Revised Plan §3 says these have come apart and asks for a deliberate choice. The work so far is
consistent with **the job** (measured infrastructure results, negative results reported honestly),
not with the product (V1 content authoring, ~200 items, is untouched and is the only thing that
makes VoidCode real).

Raised because it decides whether V1 or the remaining training-spec gaps come next, and the two
point in opposite directions.
