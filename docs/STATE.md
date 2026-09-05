# Where VoidCode actually stands

Written at the end of a long session, to carry forward the evidence behind each open item rather than
just the item. `docs/METRICS.md` is the numbers; this is what to do next and why.

Verified at time of writing: **533 tests passing** (39 files — 324 in `tests/`, 209 in
`apps/api/tests`), `ruff check .` clean and **now actually covering `apps/` and `scripts/`**, web
image builds and serves, `INTERNAL_AUTH_ENFORCE=true` and enforcing against a live server.

**Read the V6 eval section before quoting any tutor number.** Every debug figure produced before
2026-08-14 came from a harness that was wrong in three separate ways and is superseded.

---

## Revised-plan phases V0-V6: all closed or explicitly descoped

Work against `VoidCode AI — Revised Plan`, which supersedes both original specs.

| phase | state |
|---|---|
| **V0 unblock** | **done** — cap 300, taxonomy 145 concepts, specs committed, hidden test cases live (247 hidden vs 170 visible, filtered at 3 endpoints), artifact question answered in D-012 **and corrected** |
| **V1 content** | **DONE — 200 items, the plan's target met.** 125 executable / 32 rubric. Every per-area minimum met with room: ML+DL 98 · LLM 58 · CUDA 44 · Systems 35 · VLM 24 |
| **V2 retrieval** | connected and expanded 10 → 30 documents, file-backed. **The 0.53 threshold no longer separates** — see below |
| **V3 vision** | **done** — images reach the model or the request 415s. Never accept-and-drop |
| **V4 ranking** | `solve_probability` returns a real float from a **labelled prior**. No Codeforces mapping, by decision |
| **V6 eval** | **5 of 6 routed modes, 75 scenarios**, debug rebalanced to 26/16/9 with the original 33 frozen. Run on an A40; three harness defects found and fixed, and every debug figure before 2026-08-14 is superseded |
| **§7.1 experiments** | **built** — bucketing, always-valid sequential testing, guardrails, interleaving |
| **§8.3 fairness** | **built, and it found a real gap** |

**Every `make` target now either runs or is hardware-blocked.** The NOT IMPLEMENTED stubs are gone.

### The findings worth carrying forward

**The ranker under-serves sparse-history learners, and it is not marginal.** NDCG@10 by pre-cutoff
history depth over 700 learners: 1–5 problems **0.1272** [0.1045, 0.1523] against an overall 0.1888
— **32.6% below, with the interval excluding the mean**. Monotone: 6–20 gives 0.1965, 21–60 gives
0.2636, 61+ gives 0.2664. Sparse learners get **less than half** the quality of established ones.
Behavioural segments show no gap (−5.0% / +0.1%), so this is about history depth, not how someone
practises. Mechanism: every ranker feature is computed from past attempts, so a learner with three
of them has features that are mostly noise — and that is the cold-start case a tutor most needs to
serve. **The audit was a false negative at n=200** (−13.8%, under the 15% flag); a subgroup analysis
needs more traffic than the aggregate it audits, so `make fairness` defaults to 700.

**About half of that 32.6% is the task, not the ranker — and the half that is left resisted the
obvious fix.** Three controls, run before changing anything, each one killing a plausible move:

1. **A popularity fallback would have made sparse learners worse.** In the sparse bucket
   specifically, LambdaMART scores 0.1272 against popularity's 0.0276 — **4.6×**. The standard
   cold-start answer was measured and rejected rather than shipped.
2. **The training sample already contains 30% sparse learners** (59 of 200), so the model has seen
   the regime it fails in. Not a sampling fix either.
3. **Sparse learners get a harder task.** Median gradeable positives by depth: **2 · 4 · 8 · 10**.
   Finding 1 of 2 relevant items in a top-10 of ~11,000 candidates is harder than finding 1 of 10,
   so part of the raw gap is the job. Holding the positive count fixed, **at 1 positive there is no
   gap at all** (0.0945 n=78 vs 0.1006 n=33) — and from 2 upward a real gap survives, *widening*
   with more positives (−27% at 2–3, −28% at 4–8, −36% at 9+). A confound that vanishes at the
   bottom and grows at the top is not the confound doing the work.

**Then three fixes failed, and they are recorded as failures.**

**The difficulty prior was the last untried lever, and it is spent.** Before running it: `beta_for`
maps easy/medium/hard to −1/0/+1 while `FEATURE_NAMES[4]` already carries 0/1/2 for the same enum,
and `theta_from_mastery` is monotone in `mastery` (feature 0). A strictly monotone relabel induces
**identical threshold splits**, so as separate columns both are provably no-ops for a tree ensemble
— worth knowing before spending a run. The one part that could carry information is the interaction
`sigmoid(θ−β)`, since trees approximate a smooth interaction with a staircase of splits and every
split costs data, which predicts it helps most where data is thinnest. Measured: aggregate 0.1887 →
**0.1869** (the pre-registered guard), gain share **0.4%, rank 6 of 12**, and paired over the same
700 learners the sparse bucket moved **−0.0014 [−0.0149, +0.0125] — no effect**. Not merged.

**Pairing is what made that legible, and it overturned my own reading twice.** Reading per-stratum
means side by side said "mixed — better here, worse there". The same learners appear in both runs,
so pairing removes the between-learner variance, and the answer was **no effect anywhere**. Cells of
40–90 learners carry more noise than the movements being interpreted. `ranking.fairness.paired_delta`
is now the tool for this. One caveat it prints rather than hides: testing five groups at 95% means a
single interval excluding zero is ~1-in-4 under a global null, so one flagged small group (here 61+
at n=22) is not a finding.

**And the earlier shrinkage attempt, for the record.** Empirical-Bayes shrinkage
`(n·observed + k·prior)/(n+k)` replacing the "unknown mastery encodes as 0.0" default moved the
aggregate 0.1888 → 0.1906 (noise) and moved the controlled 4–8 stratum the **wrong** way for sparse
learners, 0.1736 → 0.1642. **Reverted.** The likely reason it did nothing: `mastery_known` and
`attempts_on_concept` are already features, so LightGBM could always split on evidence volume —
shrinkage re-encoded information the trees already had. The remaining candidates are a genuinely
new signal (explicit onboarding preferences), a separate model for the thin-history regime, or
accepting the gap and handling it as product cold-start. **`make fairness` now prints the
stratified table, so nobody re-derives the confound or re-tries the shrinkage.**

**Peeking at an experiment is now valid, and the contrast is measured.** Under a true null with 40
peeks per run: always-valid confidence sequence **0.003** false positive rate, the same peeking with
a fixed-horizon z-test **0.313** (α = 0.05). The right to peek costs about **3.6× the data** — a
true +0.06 lift fires at n=4,980/arm where fixed-horizon needed 1,374. The platform has 9 learners
against a 2,748 requirement, so every experiment figure is simulated and labelled on every line.

**The retrieval threshold does not survive an honest probe set.** Tripling the corpus first reported
an *identical* 0.068 gap — because all 8 probes concerned the original 10 documents, so the 20 new
ones were never queried. With 28 on-topic and 10 off-topic probes: worst on-topic **0.478**, best
off-topic **0.506**, **gap −0.028, overlapping**. Acronyms score low (triton 0.478, grpo 0.513,
fsdp/ddp 0.519); polysemy scores high off-topic ("how much *attention* should I give a new puppy"
0.506, "what *transformer* do I need for european appliances" 0.501). **0.53 is kept anyway** — it
admits 0 of 10 off-topic while keeping 25 of 28 on-topic, and the failure directions are asymmetric.
**The fix is the embedder, not the number.**

**One of the 33 baseline scenarios could never be passed, and the failure pointed the wrong way.**
`eval_is_anagram_syntax_logic_001` held an author's note inside `ground_truth_bugs` whose own text
read *"Logic is sound once syntax is fixed"*. Because `check_bug_localisation` requires every
ground-truth line to be cited, passing it meant citing **line 9 — a correct line**. A tutor that
diagnosed the real bug and nothing else was scored as missing one, so **the metric would improve as
the product got worse**. The note moved to `notes`; `expected_bug_count`, the source, and the
33-scenario count are unchanged, so the old harness reads exactly what it read before. The same
validator found `-1` used as an undocumented "don't score the count" sentinel on three multi-turn
scenarios. Both were found by writing the checker, not by reading the file.

**The eval covers five of six modes now, and the baseline survived the expansion.** Empathy was the
uncovered one, with the sharpest failure mode in the product: empathy mode is reached when a learner
is frustrated, which usually means they are mid-debug, so their message still carries
`[MODE: DEBUG]` and `[SOURCE CODE]` blocks — and a *correct* debug report is still a regression,
because what was asked for was support. `check_no_debug_markers` scores the response and never the
prompt, since the hard scenarios deliberately contain those markers in the input. Debug difficulty
went from 26/6/1 to **26/16/9** by adding 18 scenarios rather than editing the 33: the original set
is frozen and reported as its own `FROZEN-BASELINE` bucket, so **11/33 stays a like-for-like
reference** instead of silently becoming 11-of-a-different-51. Ground-truth line numbers are
*computed by anchor search* in `scripts/authoring/build_debug_extended_gold.py`, never typed — a
hand-typed line is precisely the plausible-wrong value this repo keeps producing, and here it would
penalise correct answers.

**A fourth harness defect, and the one that mattered most for answer quality: the eval never
grounded.** `_ground()` is called at exactly one place — inside the FastAPI handler — so
`--direct-vllm` got no retrieval and not even the `UNGROUNDED_INSTRUCTION` production appends on
the fail-open path. Every `explain` and `teaching` figure measured a system missing a layer
production always runs. The harness now embeds the 30 file-backed corpus documents with the same
Ollama model `main.py` uses and applies `ground_prompt` itself; because the embedder lives on the
workstation and the GPU on the pod, the harness runs locally with generation tunnelled over SSH.

**The result overturned my own pre-registered prediction.** I predicted grounding would not help,
because retrieval picks the wrong document for 3 of 5 explain queries — a FlashAttention question
returns the RoPE document at 0.664. Measured same-session against a fail-open arm, explain went
**1/5 → 3/5**. Wrong reference material still beat none.

**The rates are weak evidence; the per-claim check is strong.** At n=5 the interval is [0.23, 0.88],
and `teach_lora_rank_001` retrieved **zero hits in both arms** — byte-identical prompts — and still
flipped, which measures the noise floor directly. But the three fabrications found earlier are
unambiguous: ungrounded the tutor called ZeRO *"Zero Residue Optimization"*, AWQ *"Adaptive Weight
Quantization"* and speculative decoding *"an optimization technique used in beam search"*.
**Grounded, all three are gone.** The explain answers were wrong because the model was answering
from memory with no reference material, which is the thing grounding exists to prevent.

**The eval has been run, and then re-run because the harness — not the content — was wrong in four
separate ways.** Every debug figure produced before 2026-08-14 is superseded. The
authoritative run is 75 scenarios on an A40 against the AWQ 4-bit artifact with
`--prompt-mode finetuned`:

| check | result |
|---|---|
| `bug_localisation` | **22/51 (0.431)**, mean recall **0.529** |
| `bug_count_accuracy` | **27/48 (0.562)** |
| `no_invented_code` | 44/51 (0.863) |
| per mode | empathy **9/9** · teaching 3/6 · explain 1/5 · followup 0/4 |

Reproducible: debug localisation came out **21/51 and 22/51** in two independent runs at this
setting, inside the ±3/51 noise floor that temperature 0.4 produces.

**The three harness defects, all mine, and what each was worth.** The extended set went
**1/18 → 4/18 → 8/18** as they were fixed in turn, which is the cleanest evidence that those
scenarios were never "harder" — the harness was wrong and each time the number looked like a
property of the content.

1. **The model never received the source.** The harness sent `user_message` alone; all 18 extended
   scenarios keep their code in `source_code`, so the tutor was asked *"why does the output keep
   growing?"* with nothing to look at. It invented plausible code and critiqued that — quoting
   `return max(min(value, high), low)` for a program containing no such line. The three `eval_mt_*`
   scenarios lost their conversation history the same way. `build_messages()` now detects all three
   shapes and a test asserts the model always receives its source.
2. **Ad-hoc sampling.** `temperature 0.0`, `max_tokens 1024` against a mode production configures at
   `0.4` / `4096`. Now taken from `prompts.get_generation_config`.
3. **The wrong system prompt — the big one.** `get_system_prompt(mode, pe_mode=True)` defaults to
   the prompt-engineered prompts built for **stock Qwen3.5-9B on SGLang**. The artifact under test
   is the **fine-tuned model on vLLM**, and all 1,860 training examples carry
   `FINETUNED_SYSTEM_PROMPT`. Measured back to back on one server: localisation **14/51 → 21/51**,
   mean recall **0.333 → 0.510**. **A ~50% relative error from one omitted keyword argument, with
   nothing in the output to show it.** `--prompt-mode` is now required with no default; the run
   aborts rather than guessing, and the choice prints in the provenance block.

**Multi-bug stays at 2/16, and that survived every attempt to explain it away.** Three hypotheses
were tested and killed: *"the adapter was trained to report one issue"* — refuted, the v5.3 corpus
is **65% two-issue**; *"4-bit quantization destroyed it"* — refuted, fp16 merged scores 20/51
against AWQ's 21/51 on identical prompts and sampling; and *"the prompt's enumeration step needs a
thinking phase Qwen2.5 lacks"* — asserted in an earlier session **without evidence**, and not what
the data shows. What is partly true is that the metric contradicts the product: the tutor writes
*"I found 2 issue(s) … Let's tackle the first one first"*, names one, and stops at 473 characters
against a 2048-token cap — Socratic one-step-at-a-time guidance scored as a miss. But the
pre-registered test of that **failed**: allowing one follow-up turn recovered the second bug in only
**2 of 16**. So deferral is real and small, and the residue at mean recall 0.529 is a genuine
capability limit of a 7B artifact. `check_bug_count_accuracy` exists because the evidence forced the
distinction — the tutor counts right far more often (27/48) than it enumerates (22/51).

**No figure here is movement in 11/33, for two independent reasons.** The served model is
**Qwen2.5-7B + merged LoRA at AWQ 4-bit**, while the 11/33 baseline is **stock Qwen3.5-9B,
prompt-engineered, no adapter**. And the check sets differ. `run_evals.py` prints a PROVENANCE block
above every table and stores it in the result JSON. `detect_mode()` is **not** exercised — the mode
comes from the gold set, so this measures each mode's prompt, not its router.

Two things got **worse** under the correct prompt and are recorded rather than buried:
`no_invented_code` **48/51 → 44/51** and `asks_a_question` **57/57 → 50/57**. The fine-tuned prompt
produces a different output style; `asks_a_question` leaving the ceiling makes it discriminating
again, but the invented-code regression is a real cost. And `followup 0/4` still overstates its
failure — it is driven by a substring check whose own docstring calls it crude, and one response
("batch norm … uses precomputed values") is substantively right and fails only for lacking the token
`running`. **The gold spec should accept alternatives, and that edit belongs before a run, not
after seeing one.**

**A bug of mine shipped in the previous commit and the first real run exposed it.** `FROZEN-BASELINE`
was printed for *every* mode, so `empathy/FROZEN-BASELINE 9/9` and `followup/FROZEN-BASELINE 0/4`
appeared — rows identical to their own ALL row, wearing a name implying a published baseline that
only the debug 33 have. `load_gold` defaulted the flag to True for all modes instead of keying it to
the frozen file. Fixed, and pinned by a test that asserts no non-debug mode claims one.

**The tutor finds bugs far more often than it numbers them, and that split is why the new harness
exists.** Measured on the frozen 33 with the old harness: `bug_localisation` 13/33 = 0.394
[0.247, 0.563] against near-perfect format checks. **Superseded** by the authoritative run above
(22/51 = 0.431 over the full 51, mean recall 0.529), but the shape held throughout: passing by
quoted code beats passing by line number, so *finding* and *numbering* are different abilities
needing different fixes.

**Two of three CUDA content claims were wrong.** Online softmax exactness confirmed. Launch overhead
is 7.25 µs on an A40, not the 5 µs quoted. The tensor-core framing was wrong: K=4093 costs 2% in
fp32 and 39% in bf16, because dtype is the gate and alignment only bites after it is fixed.
Regenerate with `python scripts/verify_cuda_claims.py` on a GPU box.

**`apps/` and `scripts/` are now inside `ruff.toml`'s `include` list — 353 findings fixed, not
silenced.** `ruff check .` used to pass while `main.py` alone had 57 findings. Two survive as
per-line `noqa` with a stated reason; everything else was repaired. What it turned up:

* **8 `F821` undefined names** in the SQLAlchemy models were string forward references that work at
  runtime but nothing else can follow. `TYPE_CHECKING` blocks give type checkers the link with no
  runtime import, so the cycle these tables genuinely form cannot become an import cycle.
* **`B905` pointed at the exact line where `strict=` was once a bug.** `zip(xs, xs[1:], strict=True)`
  raises unconditionally — the lengths differ by one by construction — and it escaped `load_map` and
  would have 500'd the endpoint. Adding `strict=` back would have restored the bug; `itertools.pairwise`
  states "successive pairs" outright, so the question cannot be asked a third time.
* **`B017` in the password tests asserted bare `Exception`**, which passes for anything. Measured
  rather than guessed: a mismatch raises `VerifyMismatchError` and a malformed encoding raises
  `VerificationError` — different conditions the old assertion could not tell apart.
* **`ruff --fix` deleted documentation.** `RUF100` strips a `noqa` for a rule that is not enabled, and
  it takes the trailing prose with it — four comments explaining deliberate broad-`except` decisions
  vanished, including one a test pins by name. Restored as plain comments. **A formatter's autofix is
  an edit, and it needs the same review as any other.**

Two things stayed as marked suppressions rather than being "fixed". `E402` in `main.py` is correct —
`prompts` only becomes importable after the `sys.path.insert` above it. And one `%`-format in
`audit_tutor.py` builds the **prompt the audited tutor receives**; two separate f-string rewrites
silently turned its escaped newlines into real ones while still parsing, so it is left alone and the
rendered prompt is asserted byte-identical to the original.

### The habit that keeps paying

Independent checks — values derived from arithmetic rather than from the code they test — caught
**four** errors across this work, and in every case the code was right and the expectation was wrong:
a micro-batch count (m=9, not 4), an MFU figure (achieved does not depend on peak), a false-positive
rate of 1.000 from a broken simulation, and a fairness audit that reported no problem at n=200.
A hand-written expectation is a second, unverified implementation.

The Makefile now carries the grep for the other recurring trap: replacing a stub while leaving it in
place gives make a **duplicate target**, and the later definition silently wins. That happened three
times (`sql-test`, `experiment`, `fairness`). `grep -c '^name:' Makefile` should return 1.

### Open, in the order I would do them

1. **The embedder for V2.** `nomic-embed-text` cannot separate ML acronyms from ordinary-English
   polysemy, so no threshold cleanly works. This is a hosting and cost decision, and it is the one
   open item that changes how the product *behaves* rather than how much of it there is.
2. **The V2 corpus is 30 documents.** File-backed and validated now, so growing it is authoring
   rather than engineering. Re-run `scripts/measure_retrieval_threshold.py` after — and extend the
   probe set with it, or the measurement will again report a number about documents nobody queried.
3. **pgvector is not in use.** `embedding` is a `Text` column and cosine runs in Python over a full
   scan. Fine at 30 documents, a real cost at thousands of chunks. Decide explicitly.
4. **The sparse-history gap is now a product decision, because the engineering levers are spent.**
   Three tried and measured: a popularity fallback is **4.6× worse** for exactly these learners,
   feature shrinkage did nothing, and the difficulty prior did nothing (0.4% gain share, paired
   effect indistinguishable from zero). All three reworked signal the model already had. What is
   left needs genuinely **new** signal — explicit onboarding preferences, or a model fitted for the
   thin-history regime alone — or an explicit decision to accept the gap and handle cold start in
   the product rather than the ranker. That call is worth making deliberately rather than by
   default, since it is the case a tutor most needs to serve.
5. **The `followup` gold spec demands exact tokens and should accept alternatives.** It scores 0/4,
   and at least one of those is a substantively correct answer failing for the wrong word ("uses
   precomputed values" vs the required `running`). **Edit it before the next run, not after seeing
   one** — loosening a check because you dislike the number it produced is how a metric stops
   measuring anything.
6. **Evaluating the artifact is not evaluating production.** Everything measured on the GPU is
   **Qwen2.5-7B + merged LoRA at AWQ 4-bit**. Production serves **stock Qwen3.5-9B via SGLang, no
   adapter, with a thinking phase**. The debug prompt's enumeration step is specified to run in that
   phase, which this artifact does not have, so the multi-bug ceiling measured here may not be
   production's. Settling it needs an SGLang session against the real serving stack, and `11/33`
   stays uncomparable until then.
7. **EMPATHY DETECTION IS FIXED; the rest of the router is still weak (22/75).** `detect_frustration`
   went from 3/9 to **9/9** on the empathy gold set and 2/8 to **8/8** on phone-typed apostrophes,
   with hard-negative false positives held at **0/16** and the catalogue at **0/185** — all four
   criteria pre-registered. The fix was structural, not more phrases: four pattern families over
   apostrophe-folded, clause-split text. Three bare literals (`give up`, `hopeless`, `pointless`)
   were routing *technical* sentences into emotional support and are gone. Empathy also **reaches a
   learner's first message now** — `EMPATHY_FIRST_TURN_PROMPT` is derived from the original with
   only Step 3 replaced, and scored **9/9 with 0 back-references** on an A40 against the original's
   8/9 on the same input. Mutation testing earned its keep here: removing the negation guard broke
   nothing, and probing for what would reach it found the case that mattered — *"i'm not so confused
   anymore"*, a student saying they are FINE, routed to a pep talk without it.
   **Still open, and unchanged by this work.** `decide_mode()` was six lines inside a 700-line
   handler, which is why it had zero tests while every mode's prompt had a gold set; it is now a
   pure function (behaviour identical over 318 pairs). Two router defects remain, both untouched by
   the empathy fix. The first — **`_extract_user_intent` erasing the fact that code was
   attached** — is now **SHIPPED**: `detect_mode` takes a `has_code_context` bit (never the code),
   debug routing went **12/51 → 20/51** and the overall rate **22/75 → 30/75** with no other mode
   moving, and `general` stopped being where misroutes land (37/53 → 13/45). The second is also
   **SHIPPED**: the keyword list now carries ML vocabulary drawn from `data/concepts.yaml`, taking
   **explain 1/5 → 5/5** and the overall rate to **34/75**, with bare `attention`/`transformer`
   deliberately excluded so the two recorded polysemy probes still reach `general`. What remains is
   narrower still. **Teaching and followup are fixed too.** `teach me` was not a trigger at all
   (0/6 → 6/6, gated on `is_programming_related` because ungated it sent *"teach me about the french
   revolution"* to a prompt that emits code templates). `followup` was **too narrow and too greedy
   at once** — every gold message names the prior turn outright while the pattern list claimed any
   question of eight words or fewer — so explicit back-references now sit **above `explain`**, and
   the starter list is split into anaphoric openers (`so `, `but `, `that `, self-evidencing) and
   generic question openers (`can `, `when `, gated). **0/4 → 4/4.** Routing is now **44/75 from
   16/75**, with every mode routing something.

   **And then the debug gold labels turned out to be the problem, which is a different claim from
   the router being at fault and has to be kept separate from it.** 13 of the 18 extended scenarios
   described a symptom without naming a bug — *"clamp(5, 0, 10) gives me 10"*, *"always returns 0"*.
   Measured over **2,020 real code-submitting user turns, 86% carry debug vocabulary**; that set
   carried **28%**, over-representing a rare phrasing threefold and making the router look far
   worse than it is. Reworded to the base rate with every bug, source line and ground-truth entry
   byte-identical: **debug 20/51 → 29/51, overall 44/75 → 53/75, with no change to the router.**
   The first correction overshot to 100% and was walked back to 83% — erasing the 14% who really do
   report a bug without naming it is the same error mirrored, and would have flattered the router
   instead of maligning it. The test asserts a two-sided window for that reason.

   **Consequence to carry forward: the extended-set eval figures are stale.** The reworded messages
   are what the model receives, so `bug_localisation 8/18` was measured on different input and needs
   a GPU re-run before being quoted. The frozen 33 are untouched and remain valid.

**Closed since the last revision:** the merge/quantize rebuild (D-012 — rebuilt on an A40, verified
byte-complete, and *served* rather than inferred), and the ruff coverage gap (`apps/` and `scripts/`
are in the include list, 353 findings fixed rather than silenced).

### Machine state

Disk went from 23.7 GB free to ~204 GB (Docker VHDX 207 → 67.55 GB after prune + compact). The
RunPod A40 sessions are finished; the vLLM server was stopped and the GPU freed after each. The
merged (15 GB) and AWQ (5.2 GB) weights live on the pod's **network volume**, which persists across
pods, and separately in WSL at `~/swinburne_ai_tutor_project/llm/outputs/` — nothing was downloaded,
so the reclaimed disk stays reclaimed. Two pod traps cost a run each: RunPod's **nginx already owns
port 8001**, so vLLM dies with `Address already in use` (8123 is free), and `pkill -f "vllm serve"`
**matches the SSH shell's own command line** and kills the session before it launches anything —
use `pkill -f "[v]llm serve"`. **`--set-sparse true` is a trap**: it reclaimed nothing and
*disqualified* the VHDX from compaction (Hyper-V refuses sparse files). The working sequence is
un-sparse, `wsl --shutdown` so `wslservice` releases the handle, then `Optimize-VHD` **elevated** —
right-click "Run with PowerShell" is always unelevated and silently does nothing.

---

## The pattern worth knowing before you touch anything

Almost every real fault found in this work was **code that existed and was never reached**, not code
that was wrong:

| what | how long it was inert |
|---|---|
| `config.py`'s production guardrails | nothing imported the module |
| `.env` itself | **nothing loaded the file** — so the secret was empty, mail went to console, the pepper was default |
| `RATELIMIT_PEPPER`, `TRUSTED_PROXY_HOPS` | defined, read by nothing |
| `pandera` | pinned in the lockfile, imported nowhere |
| `ruff.toml` | existed, CI never ran it (37 findings had accumulated) |
| `features/irt_bootstrap.py` | referenced by three files, did not exist |
| eleven `make` targets | cited by the metrics ledger, absent |
| `assert_temporal_integrity` | correct, and depended on a warehouse nobody built |

**So when something looks configured, check that the configuration is read.** The `.env` case is the
sharpest: the app connected to Postgres and served traffic while every security setting was invisible,
because `os.getenv("DATABASE_URL", <local default>)` happened to have a matching fallback.

The second pattern: **a plausible number is the failure mode, not an error.** A ranking result was 94%
tie-breaking artefact; a popularity baseline was inflated 3.4× by a leak; a sandbox suite reported two
escapes that had not happened; a load test blamed an endpoint for a wedged database. All four looked
like results. Each needed a second measurement to catch.

---

## The earlier open items, and how each closed

Kept because the EVIDENCE behind each one is worth more than the verdict, and because two of them
were closed by discovering the premise was wrong rather than by doing the work. Items 1-3 are done;
item 4 is still yours.

### 1. Do NOT adopt a 2PL — measured, it loses. Recalibrate the 1PL instead.

This slot previously recommended fitting a 2PL, on the reasoning that a per-problem discrimination
would fix both the mid-range calibration error and the 16 non-converged betas. **`features/irt_2pl.py`
was written and measured, and the recommendation was wrong:**

| | 1PL (Rasch) | 2PL |
|---|---|---|
| held-out log loss | **0.226606** | 0.240492 |
| problems with \|β\| > 10 | 482 | **0** |
| discrimination `a` | fixed at 1 | mean 1.020, p5 0.780, p95 1.286 |

**The 2PL predicts 6.1% worse.** With 11,284 extra parameters against a median of 7 observations per
problem, the discrimination is estimated from almost nothing for most items — the variance cost
exceeds the bias benefit. The narrow spread of `a` (p5 0.78, p95 1.29) says the prior is doing most of
the work, and it still costs 6% held out.

**But it does eliminate the extreme betas entirely, 482 → 0.** So the two findings need different
answers rather than one:

- *Mid-range calibration (MCE 0.171)* — recalibrate the 1PL rather than changing the model. **Done
  and closed: isotonic, out-of-fold over all 1.32M rows, takes ECE to 0.0001 and the worst mid-range
  gap from 0.045 to 0.006 while also improving log loss 2.85%.** See below; the 0.171 itself turned
  out to be an in-sample artefact.
- *The 16 non-converged betas* — the evidence filter already exists:
  `quality/contracts.MIN_OBSERVATIONS_FOR_BETA`. Use it rather than adopting a worse model to make a
  small number of parameters look tidier.

`features/irt_2pl.py` stays in the tree as the measurement that settles this, not as a path to adopt.

#### First attempt: one 90/10 split, which could not resolve the mid-range

Kept because the reasoning is what motivated the k-fold rerun, and because the noise-floor mistake it
records is easy to repeat. The numbers in the NEXT subsection supersede these.

`analysis/recalibrate.py` fits θ/β on train, fits the correction on a **calibration** half, and scores
on a **test** half that neither has seen. A calibrator measured on its own fitting rows always looks
excellent, so the three-way split is the whole method.

| on the held-out test half | raw 1PL | isotonic | Platt |
|---|---|---|---|
| ECE | 0.0131 | **0.0027** | 0.0051 |
| MCE | 0.0730 | **0.0345** | 0.0910 |
| worst \|mid-range gap\| | 0.052 | 0.035 | 0.091 |

**Isotonic is the right choice and Platt is actively harmful in the band that motivated the work** —
two parameters can stretch and shift a curve but cannot unbend it, so Platt buys a better
mass-weighted average by making the mid-range worse than raw.

**The aggregate gain is real.** It comes from the buckets holding the mass: 0.8–0.9 gap
+0.016 → +0.000 against a 2·se of 0.006, and 0.9–1.0 +0.009 → +0.001 against 0.002.

**The mid-range claim was not, on that split.** Its mid-range buckets held 221–857 rows — 71% of the
mass sits above 0.8 — so the noise floor was **2·se ≈ 0.044** against an apparent improvement of
**0.017**. Two drafts reported success anyway: the first keyed its verdict on MCE and announced the
bend corrected *while the mid-range gap doubled*; the second cleared a bare 0.7× threshold by 0.001.
Adding the per-bucket standard error is what made it falsifiable.

#### `analysis/recalibrate_kfold.py` settled it. Adopt isotonic — this item is closed.

5 folds, with **both** the θ/β fit and the calibrator fitted out-of-fold, so all 1,320,382 rows carry
an out-of-sample prediction and the mid-range noise floor drops from 0.044 to **0.010**.

| out-of-fold, every row | raw 1PL | isotonic | Platt |
|---|---|---|---|
| ECE | 0.0138 | **0.0001** | 0.0047 |
| MCE | 0.0712 | **0.0061** | 0.0704 |
| worst \|mid-range gap\| | 0.045 | **0.006** | 0.056 |
| log loss | 0.229407 | **0.222866** (−2.85%) | 0.227506 |

**The mid-range is fixed: 0.045 → 0.006, an improvement of 0.039 against a 0.010 floor.** Before
correction all ten buckets had gaps outside their own 2·se; after, **none do**. The earlier
"unresolved" was sample size and nothing else.

**It also predicts better, so this is not just a reporting fix.** Log loss improves 2.85%. Set against
the 2PL's 6.1% *loss*, the cheap monotone correction beats 11,284 extra parameters by roughly 9 points
— which is the real lesson of items 1 and this one together: the 1PL's problem was never its
functional form, it was that its output was read as a probability without ever being mapped to one.

**Platt is worse than doing nothing in the band that motivated the work** (0.056 against raw 0.045).
Two parameters can stretch and shift a curve but cannot unbend one.

Ranking is unaffected — isotonic is monotone, and `tests/test_recalibrate.py` asserts that against the
`np.argsort` order rather than trusting the property.

#### It is wired into the API, and it serves nothing yet — on purpose

`features/export_calibration.py` freezes the map to `apps/api/data/calibration_map.json` (334 knots,
12 KB) and `apps/api/src/calibration.py` applies it with `bisect` — no sklearn or numpy in the request
path. `GET /v1/recommendations/calibration` reports whether it loaded, and `/v1/recommendations`
carries a `solve_probability` per item.

**That field is null on every item today and the response says why.** θ/β are keyed by Codeforces
handles and problem ids; `Problem.difficulty` is the enum `easy | medium | hard`. **No platform problem
has a Codeforces id and no platform user has a handle**, so `calibration.warehouse_ids()` resolves
nothing. Mapping "medium" onto a β from the Codeforces distribution would invent the input — the World
A → World B transfer this document already rules out.

`status()` therefore reports `available` and `probabilities_served` as **two** fields: the map is
loaded and correct while no request receives a number. Collapsing those into one is how a wired-but-
inert feature gets read as a working one.

**When platform problems gain an estimated difficulty, `warehouse_ids()` is the only place to change.**

Two things this cost, worth knowing before regenerating the artifact:

- **Never let the API fall back to the raw sigmoid.** It is miscalibrated in every decile (all ten
  buckets outside their own 2·se). Every failure path — missing file, unknown schema, non-monotone
  knots, corrupt JSON — returns `None`, and the tests assert that rather than the happy path.
- **The exporter ships the fit's own `X_thresholds_`, not a resampled curve.** Two earlier versions
  resampled onto a uniform grid and thinned it, which is lossy where breakpoints are dense:
  interpolating across a jump emits values the fit never produces, and since isotonic assigns each
  group its observed mean, a blended value is no longer that mean. The first drove **MCE from 0.0712 to
  0.1411 while recording an improved ECE**; the second, with error-bounded thinning, still hit 0.1382.
  `assert_reconstructs` now demands exact agreement with `predict`, and the exporter refuses to write a
  map whose out-of-fold ECE or MCE is worse than raw.

#### `analysis/calibration.py`'s headline is an in-sample artefact. Do not quote it.

The sign flip is real, reproduces on identical bucketing, and **is not cold start** — only 1,996 rows
(0.15%) had a problem no training fold saw, and the seen-only curve (MCE 0.0713) is indistinguishable
from the all-rows curve (0.0712).

In the 0.35–0.55 band, in-sample reads predicted 0.404 → observed 0.241 (gap **−0.163**), out-of-fold
reads 0.403 → 0.435 (gap **+0.031**). *Same predicted value, opposite error* — because which rows land
in a bucket depends on which θ/β you score with, and scoring parameters on the rows that produced them
selects rows whose outcomes those parameters have already absorbed. The in-sample curve is
overconfident through the middle and underconfident at the top; the out-of-fold curve is uniformly
underconfident across all ten buckets.

**So `analysis/calibration.py` measures the fit's memory, not its calibration.** ECE 0.0348 / MCE
0.1708 should not be quoted as the platform's calibration. The honest figures are **0.0138 raw and
0.0001 corrected**. That module is worth keeping only if it grows a held-out mode; until then its
output is a diagnostic of overfitting, which is a different and less useful claim than the one its
name makes.

**Read its history before trusting any 2PL number.** The first run reported the 2PL losing by 9.7%,
and that was *also* wrong — the fit had an unanchored scale gauge, so `l2_theta` shrank θ and `a`
inflated to undo it. On synthetic data from a known 2PL it recovered `a` at corr **0.39** with a mean
of 2.99 against a true 1.09, while β and θ both recovered above 0.94 — so nothing about the fit looked
broken. Anchoring `log_a.mean() = 0` alongside `beta.mean() = 0` took recovery to **0.899**. The
numbers above are from the anchored fit.

### 2. `gold_problem_catalog_complete` — DONE, and this item's premise was wrong

It said to repoint `features/spark_jobs/build_features.py` at the complete catalogue, described as a
one-line change to unverifiable Spark code. **There was no consumer to repoint.** Checked:

- `build_features.py` only ever **writes** `gold_problem_catalog` (line 299). It never reads it.
- `features/candidates.py` — the candidate generator the item names — is **World B**. It works over 77
  platform slugs passed in as arguments and never touches the warehouse.
- Nothing else in `features/` or `ranking/` reads either catalogue. Only `quality/contracts.py` does,
  and it already prefers the complete one.

**The real gap was that `gold_problem_catalog_complete` was never registered in the Hive metastore.**
`sql/register_tables.py` listed `gold_problem_catalog` and not the recovered table, so all 12,217 rows
sat on disk unreachable from Spark SQL and HiveQL — the recovered 906 problems were invisible to the
entire layer built to query them. Registered now, and verified: `sql/tests/06_catalogue_coverage.sql`
queries it and passes, which it could not do if the table did not resolve.

That assertion is the point, more than the registration. It checks three things the Python contract
cannot: every attempted problem resolves in the catalogue, the complete table is a strict **superset**
of the original (a backfill that dropped rows while adding others would otherwise pass), and
`catalog_source` is non-null on every row so a reconstructed rating can never be quoted as an observed
one. `quality/contracts.py` asserts the first in Python, but a Python contract reads Parquet directly
and **cannot catch a missing metastore registration** — which is exactly the fault that was live here.

Still true: `name` and `tags` are NULL on backfilled rows. Only the API has them. Any consumer that
displays a problem title must handle that.

### 3. C3 — the six SQL models (§4.1a) — DONE

All six exist under `sql/models/`, all run against Spark SQL over the Hive-registered warehouse, and
`sql/tests/` holds five assertion files that all pass. `make sql-test` is a real target now; the stub
that printed "zero .sql files exist" is gone. **Run these in WSL** — Spark and the metastore live
there, and `make` is not installed on the Windows side.

| model | rows | what it required |
|---|---|---|
| `01_cohort_retention` | 18,080 | CTE chain + `FIRST_VALUE` for cohort size |
| `02_concept_difficulty_ranking` | 76 | `GROUP BY ROLLUP` + `GROUPING_ID`, `RANK` |
| `03_learner_funnel` | 6 | `LAG` for step conversion |
| `04_error_taxonomy_shift` | 610 | partitioned `SUM` + `LAG` |
| `05_concept_cofailure_pairs` | 1,877 | the self-join, plus prereq edges both directions |
| `06_concept_time_to_mastery` | 67 | `percentile_approx` over a probability array |

**The two decisions the spec forced, both resolved in the model headers rather than silently:**

- *Cohort retention by signup week* — there is no signup date, so the cohort is **first-observed
  week**, named `first_seen_week`. The shape is meaningful inside the ingest window; the level is not a
  joining-cohort number and must not be quoted as one.
- *Time-to-mastery percentiles* — **65 of 67 concepts have p50 = 0 seconds**, zero-elapsed share 0.43
  to 0.79 (mean 0.65). Reported as time to *first accepted solution* with the zero share as the leading
  column. "Time to mastery" is not derivable at all: mastery is a continuous score with no crossing
  event, so there is no interval to measure.

**An assertion caught a broken funnel, which is the part worth carrying forward.** `solved_any`
converted at **1.205** — impossible in a nested funnel. A `persisted` stage (attempted ≥2) sat above
`solved_any` on the false premise that solving implies persisting; a learner can attempt exactly one
problem and solve it. It had already passed row counts, null rates, referential integrity *and* grain
uniqueness, because a broken funnel is arithmetically valid under all four. A funnel's nesting is a
claim about set containment, and only `04_value_ranges.sql` tested it. The fix keeps four genuinely
nested stages and reports the non-nested signals with `is_nested_stage = FALSE` and a NULL conversion.

**Measured, worth knowing:** 7.1% of learners bounce without ever solving, and declared prerequisite
pairs average lift 1.290 against 1.203 for the 1,701 undeclared ones — so **co-failure does not
distinguish a real dependency from shared problems.** That 0.09 separation is why model 5 reports
`is_declared_prereq` next to the lift instead of inferring edges, and it is direct evidence for the
warning already on `docs/CONCEPT_RULES_REVIEW.md`.

### 4. The remaining inferred concept tags — yours, not a code task

`docs/TAG_REVIEW.md` — **57 decisions** over 94 items at time of writing; the file regenerates from
the YAML, so trust it over this number. Mastery divides credit across an item's concepts, so a wrong
tag moves weight to the wrong concept and the ranker then recommends against a weakness the learner
does not have — invisibly, because every number stays healthy.

Start with the concepts holding a single pending item (16 of them). That is where the one worked
example came from: `compute-metrics-from-confusion`, a precision-and-recall problem, was tagged
`kernel_fusion` because migration matched the word "compute". Fixing it needed a NEW concept —
`classification_metrics` did not exist — so expect the review to surface **taxonomy gaps, not just
wrong tags**. An item whose subject has no concept got attached to whatever matched textually, and the
signature is a single-item block sitting in an unrelated category.

Also unreviewed: `docs/CONCEPT_RULES_REVIEW.md`, 473 mined co-failure pairs. **These are correlations.**
`line_sweep ↔ convex_hull` at lift 132.9 is almost certainly shared problems, not a prerequisite.

---

## Claims that are true, and the boundary on each

**"Recommended for you" is defensible. "Personalised learning path" is not.** Measured: mean top-10
overlap between any two learners is **4.52 of 10**, and 48 problems serve 40 learners' top-10s. The
lists genuinely differ; nearly half of each is common core. `docs/RANKING_ANALYSIS.md`.

**§5.2 is met on the research corpus only.** NDCG@10 0.2143 against a best baseline of 0.0511, CI
clearing it 3×. That is **World A** — 11,267 Codeforces problems, all classic DSA. The product's 64 ML
concepts are a **disjoint** set, so no model fitted there transfers. `docs/RANKING_DESIGN.md`.

**No product-side ranking number is honestly measurable.** 9 users, 2 submissions. `train_ranker`
returns `None` below two learners and `recommend()` labels the fallback `ranked_by="mastery"`. **Both
guards are correct; weakening either to produce a number is the failure the ledger exists to prevent.**

**The sandbox is contained, with two hardening findings and no breaches.** 10/12 probes fully
contained. Not tested: Java and C++, concurrency, and syscall-level policy — containment is inferred
from behaviour, not from a seccomp profile naming what is denied. `sandbox/FINDINGS.md`.

**The Kubernetes manifests have never been applied to a cluster.** `kubectl kustomize` renders 10
objects and 15 consistency checks pass; that is all that is verified. The *images* are verified
separately and do build and serve.

---

## Things that will bite you

- **`seed_problems --force` will delete real submissions.** `submissions.problem_id` and
  `code_drafts.problem_id` are `ondelete="CASCADE"`, and the seeder deletes each problem before
  re-seeding it — so a routine re-seed after a content change destroys every submission and draft
  attached to ANY seeded problem. Today that is 2 submissions and 2 drafts, the only genuine
  learner data in the database.

  I recommended `--force` for exactly this, then checked before running it. Don't. After a content
  change, either update the affected rows directly — `problem_concepts` has no dependents, so
  replacing a problem's concept rows touches nothing else — or dump `submissions` and `code_drafts`
  first and restore them after. The seeder's own docstring says "delete + re-seed" without saying
  what else goes with it.

- **The `iq-` prefix does not mean what it looks like.** `iq-compute-metrics-from-confusion` is
  `source_kind: interview_problem` and lives in `problems`; the bare `compute-metrics-from-confusion`
  is `source_kind: interview_question` and lives in `interview_questions`. So the prefixed one is the
  *problem* and the bare one is the *question* — the reverse of the obvious reading. It matters
  because `problem_concepts` joins only to `problems`, so mastery attribution reads the `iq-` row and
  not the bare one.

- **`make` is not installed on the Windows side.** Targets resolve under WSL. A sweep from Windows
  reports every target broken, which is `make` being absent, not the rules.
- **`$VC_DATA` is unset**; the warehouse lives at `/home/alwin/voidcode-data` in WSL and is reachable
  from Windows via `//wsl$/Ubuntu/...`. Every analysis module takes `--warehouse` or `VC_WAREHOUSE`.
- **`onboarding@resend.dev` only delivers to the account owner.** Reset mail to any other user silently
  goes nowhere until a domain is verified and `EMAIL_FROM` changes.
- **`APP_BASE_URL` is `localhost:3000`**, so every emailed link points there.
- **SYNTHIEN also defaults to port 8000.** With it running, the VoidCode frontend talks to SYNTHIEN.
  The two projects must stay separate.
- **The config tests disable `.env` loading explicitly.** Without that they pass on a configured
  machine and fail on a bare one. If config tests differ between machines, look there first.
- **Rotate the Resend key** — it was pasted into a chat transcript.
