# VoidCode AI — Readiness Gates

Gates passed against gates defined. **Never a completion percentage.**

Every row carries its n, its measured run-to-run range, and the artifact and server it was measured
on. Rows are not comparable across an artifact or server change — see `docs/METRICS.md` for the
archived history.

## CONTENT COVERAGE — the first rows, because content is what a learner comes for

Computed from `content/problems/*.yaml` at load, not quoted from a plan. **200 items.** An item may
carry more than one category (66 do), so the column sums exceed 200 by design.

| area | items | ≥40 | easy | medium | hard | executable | rubric | prose |
|---|---|---|---|---|---|---|---|---|
| DL | 59 | **PASS** | 9 | 37 | 13 | 41 | 0 | 18 |
| LLM | 58 | **PASS** | 7 | 38 | 13 | 38 | 4 | 16 |
| CUDA | 44 | **PASS** | 4 | 19 | 21 | 20 | 11 | 13 |
| ML | 39 | **FAIL** by 1 | 4 | 23 | 12 | 27 | 2 | 10 |
| Systems | 35 | **FAIL** | **0** | 26 | 9 | 22 | 13 | 0 |
| VLM | 24 | **FAIL** | 2 | 12 | 10 | 9 | 9 | 6 |

**Three areas pass the count; one of them fails the matrix.** Systems has **no easy items at all**,
so a learner starting there meets a medium problem first. A count is not coverage — that is why the
difficulty bands are in this table rather than a total.

`PyTorch` (10) and `TensorFlow` (2) are cross-cutting tags rather than advertised areas and are not
gated.

**Every executable item's reference solution is verified in CI** — 125 items, 699 cases, green.
Wired 2026-08-16; before that both verifiers existed, passed, and ran nowhere.

> ### CORRECTION: this file said "Content coverage — not started"
>
> It said that while `docs/STATE.md:22` said **"V1 content — DONE, 200 items, the plan's target
> met"**. Both were in the repo; they contradicted each other; and I quoted this one to the user
> twice, and recommended stopping tutor work on the strength of it, without opening
> `content/problems/`.
>
> That is the same failure as the disclosure-gate correction below — a published row nobody checked
> against the artifact — repeated the same afternoon, which is why the coverage numbers above are
> now computed by a script rather than typed.

## THE HEADLINE: what a learner actually receives

A learner meets every check at once, so the **joint rate** is the product. Individual checks below
are diagnostics beneath it.

| | rate | n | 95% CI | gate | status |
|---|---|---|---|---|---|
| **USABLE LEARNER OUTCOME** — routed correctly *and* found the bug | **0.761** | 51 × **6 runs** | [0.632, 0.860] **per-scenario**; **run-to-run [0.712, 0.811]** | ≥ 0.80 | **FAIL** — see the note on the interval |

```
request arrives
  → routed to debug              0.902  46/51 every run — matches the offline prediction exactly
  → FOUND the bug                0.817  41.7/51 on the DIAGNOSTIC surface, selective quoting required
  → withheld the fix             0.810  opening disclosure ≤ 1, was 0.204 (published as 0.875)
  = usable learner outcome       0.761  38.8/51 — routed correctly AND found the bug
```

> **Per-mode debug was 0.078 and that was a scoring defect, now fixed.** `bug_localisation` was
> scored on the answer surface inside `all_passed`, and the debug prompt withholds line numbers from
> the answer by design — so the mode was being penalised for the disclosure policy a second time.
> With the surface declared per check: **debug 0.078 → 0.588, and no other mode moves.**

| stage | per-run | mean | 95% CI |
|---|---|---|---|
| routed to debug | 46 × 6 | **0.902** | deterministic, zero spread |
| localisation, diagnostic surface | 43, 42, 37, 45, 43, 40 | **0.817** | [0.695, 0.898] **per-scenario** (Wilson, n=51) |
| ↳ frozen 32, **re-authored** to the workspace shape | 27, 28, 26 | **0.844** | was 0.396 |
| ↳ extended 19, **untouched control** | 16, 14, 11 | 0.719 | was 0.702 — did not move |
| **JOINT** | 41, 39, 35, 41, 40, 37 | **0.761** | [0.632, 0.860] **per-scenario** (Wilson, n=51); run-to-run [0.712, 0.811] |
| debug, all checks | 30, 32, 28, 35, 30, 26 | 0.592 | — |
| reasoning reaches level 4 | 10, 8, 14, 14, 12, 8, 8, 12, 14 | **0.218** | 9 runs, corrected scorer; published as 0.745 |
| responses echoing >50% of the source | 22, 23, 21 | **0.431** | was 0.752 — the model cites instead of quoting |

> ### HISTORICAL CORRECTION: 0.647 and 0.608 were inflated, and I published them
>
> *Kept as a record of a scorer defect. The figures below are superseded — current localisation is
> 0.797 — but the failure mode is the reason the selectivity guard exists.*
>
> Quoted-code credit did not require the quote to be **selective**. The model restates the whole
> program in its reasoning **75% of the time**, so every source line — including the buggy one —
> appeared verbatim, and the scorer read that as localisation. It was measuring verbosity.
>
> Caught by a false-positive test after a *further* relaxation looked too good: dropping the length
> floor for unique lines took localisation to 0.824 and the joint rate to 0.784, just under the gate.
> All 8 newly-credited scenarios echoed ~100% of the source. That prompted checking the original
> rule the same way, and it failed for the same reason.
>
> Requiring selectivity gives **0.301**, and three independent measurements now agree at roughly a
> quarter to a third: stage A's structured output 0.258, reasoning with selectivity 0.301, hint
> surface 0.098–0.150. The optimistic figures were the outliers.
>
> **The v1 baseline is unaffected** — only 8.6/51 of its answers echo, and it moves 0.514 → 0.494 —
> so the comparison across arms still holds.

> ### `bug_localisation` moved to the diagnostic surface, and why that is not moving the goalposts
>
> *Figures in this block are from the v4 arm and superseded; the reasoning stands.*
>
> Scored on the hint the learner reads, localisation is **7.7/51 = 0.150**. On the tutor's own
> reasoning it is **33.0/51 = 0.647**. The gap is not error: the debug prompt was deliberately changed
> to open at level 1 and withhold line numbers, so **the hint surface cannot show what the check
> looks for**. Satisfying it there would require undoing Phase 1.
>
> The two checks ask different questions. `bug_localisation` asks *did the tutor find the bug* — a
> capability. `opening disclosure` asks *did it tell the learner* — a policy. Scoring the first on
> the hint conflated them into mutually exclusive gates.
>
> Measured both ways on the same three runs: the joint rate is **0.608** on the diagnostic surface
> and **0.137** on the hint surface. Both changes worked; the hint-surface figure is the metric
> measuring them against each other.
>
> Both surfaces are now reported on every run and neither may be quoted as "localisation" alone.

> ### HISTORICAL CORRECTION: 0.745 was a stale figure on top of a broken scorer
>
> *This row previously read "the reasoning reaches level 4 in **0.745** of debug traces (39, 40, 35
> of 51)" and was labelled **Still true**. It was neither current nor true.*
>
> **Stale.** 0.745 was measured on the **v4** arm and carried forward across v5, v6, v7 and v8
> without re-measurement. Re-scored on the nine v6/v7/v8 runs with the scorer exactly as it then
> stood, the figure is **0.490** (225/459) — the published number was 1.5× the truth before any
> scorer question is asked.
>
> **Broken.** `disclosure_level` counted three things that are not disclosure. Of the 225 hits,
> **125 were artifacts**:
>
> | class | what the scorer actually matched |
> |---|---|
> | echoed student code | `_COMPLETE_DEF` matching the **learner's own buggy function**, quoted verbatim. They wrote it; restating it discloses nothing. |
> | recites its own prompt | `_PROSE_FIX`'s `must be "…"` arm matching the model repeating **its own mandated opening** — `prompts.py:503`, `First sentence = "I found N issue(s) in your code."` The scorer read *planning to obey a formatting rule* as *stating the remedy*. |
> | quoted punctuation | `must be \`?\`` — the prompt also mandates closing on a question, and the model plans that too. |
>
> A fourth defect made the first class invisible: `_COMPLETE_DEF` ends on `return \S+`, which cannot
> match the production rendering `  8 |     return []`. On the line-numbered shape the match did not
> stop at the end of the function — it ran through the closing fence and on through the model's prose
> to a later un-guttered `return`, producing a span longer than the whole file. The gutter is now
> stripped before the code patterns run.
>
> **Corrected: 100/459 = 0.218, per-run 8–14.** The gate reads **0.782 against ≥0.98** — still red,
> and the tutor genuinely writes the fix in its scratchpad in roughly one debug trace in six.
> **80 of the 100 survivors are prose** (`should be \`while left <= right:\``), not printed code.
>
> **This is the same defect as the `0.647` block above, in the scorer next door.**
> `check_bug_localisation` was inflated because it credited quoting the whole file; the fix was
> `_quote_is_selective`. That guard was added to one scorer and not to `disclosure_level` beside it,
> for model behaviour already documented in this file ("the model restates the whole program in its
> reasoning 75% of the time"). The echo guard here is deliberately **not** `_quote_is_selective`:
> every genuine corrected-code leak in the evidence lives in a response that echoes more than half
> the source, so a selectivity test would have excused 100% of the real leaks.
>
> **The joint rate is untouched.** `check_opening_disclosure` is not among the checks ANDed into
> `all_passed` for debug (`CHECKS_BY_MODE`), so nothing in this correction moves the headline
> 0.761. It moves three disclosure rows and nothing else — verified rather than assumed.
>
> **Still true, and unchanged by any of this:** the reasoning is withheld from learners server-side,
> so they never see it; the model still produces it; the gate stays red. See the two-stage negative
> result below.

### Where the remaining 0.05 has to come from

Both stages are now high and the remaining loss is spread across them rather than concentrated:

| | current | needed for joint 0.80 |
|---|---|---|
| routing | 0.902 | 0.902 (at its ceiling) |
| diagnostic localisation | 0.797 | **0.887** |
| joint | **0.752** | 0.800 |

Localisation is no longer the single binding constraint. Closing the last 0.05 means either
localisation to ~0.89, or routing past 0.902 — and routing's remaining 5 misroutes are the vague
scenarios the deterministic rule deliberately abstains on.

**Everything cheap has been spent.** Routing, message shape, line numbering and the scorer fixes are
done; what remains is base-model capability, which is the case for testing a larger model or bf16 —
neither of which fits on a 16 GB card.

> **A superseded projection, kept because it was wrong in an instructive way.** An earlier version of
> this section projected the joint rate by multiplying routing by a conditional localisation of
> 0.735 — a figure measured on the **v1 prompt**, which opens at level 2 and cites line numbers.
> The current prompt withholds them by design, so under it that conditional is 0.152 on the hint
> surface. The projection predicted 0.663; the hint-surface measurement came in at 0.137. Multiplying
> a rate measured under one prompt by a rate measured under another is not a projection, and the
> error was invisible until the run landed.

> ### `mentions_required` has a validity ceiling, and followup is where it shows
>
> followup now has 30 scenarios and scores **16.0/30 = 0.533 [0.361, 0.698]**, spread 15–17, with a
> sensible difficulty gradient (easy 0.619, medium 0.600, hard 0.333). That is the first real rate
> the mode has ever had.
>
> **It is a floor, not a rate.** Of three scenarios failing in all three runs, two are the model
> answering correctly in words the check does not list — *"shifts tiny gradients up into the
> representable range"* for a group of `underflow|round to zero|too small|flush`, and a complete
> Adam-versus-SGD answer failing on `momentum|velocit` when momentum is not needed to answer the
> question. Only one was a genuinely weak answer.
>
> **Substring matching cannot be repaired by adding synonyms.** This check has now been widened
> twice — single words → concept groups → groups pruned per scenario — and each round surfaced new
> phrasings it had not anticipated. Judging whether a concept was expressed is a semantic question,
> and `docs/FINETUNING_BLUEPRINT.md:388` already requires any judge of that kind to be calibrated
> against ≥50 human labels before use. That is the honest next step for this check, and it is real
> work rather than a tweak.
>
> Until then: **≥0.533 is a lower bound on followup**, the gate cannot be evaluated against it, and
> no figure derived from `mentions_required` should be quoted as a quality rate.

> **(superseded) `followup` has no measurable rate.** Across nine runs its all-checks score ranges the full
> width of the scale — 0, 1, 2 and 3 of 4 all occur — so every point estimate quoted for it (0.150,
> 0.417) was an arm-specific draw rather than a property of the tutor. It needs the 30 scenarios
> Phase 4 calls for before any figure means anything. One concrete defect WAS fixed and is not a
> statistic: its scenarios carried back-references to a conversation that did not exist, and the
> model sometimes refused as a result.

> **The interval contains the gate, and that is not a pass.** 0.761 [0.632, 0.860] means the data
> cannot rule out a true rate at or above 0.80 — but it cannot demonstrate one either, and 2 of 6
> runs cleared it against 4 that did not. A gate puts the burden on showing it is met.
>
> **Two arms, one config, no drift:** v6 joint 0.752 [41, 39, 35] against v7 0.771 [41, 40, 37].
> Overlapping and consistent, which is what a stable configuration should look like and is the
> reason the six runs can be pooled at all.

**Status: 7 of 20 gates passed. The joint rate is 0.761 against a 0.80 gate. The product is not
ready for learners.**

*(Was "5 of 18", and none of the movement is the product improving. Two gates were added — the
coverage matrix, and CI-verified reference solutions, which passes. Two rows were corrected against
the evidence: content coverage was recorded as "not started" with 200 items in the repo, and
diagnostic localisation was recorded as 0.647 while the headline of this same file said 0.817. The
count moved because the ledger was wrong, which is the least reassuring reason for a count to move.)*

---

## Measurement provenance

| | |
|---|---|
| Artifact | **stock `Qwen/Qwen3.5-9B`**, snapshot `c202236235762e1c871ad0ccb60c8ee5ba337b9a`, no adapter |
| Server | SGLang `v0.5.9-cu130`, fp8, `kv-cache-dtype fp8_e5m2`, `context-length 16384`, `mem-fraction-static 0.80` |
| Hardware | local RTX 5060 Ti, 16 GB |
| Path | **streaming** — what the web client uses. Reasoning and answer arrive as separate events |
| Prompt path | the API's own — `detect_mode` → `_ground` → `get_system_prompt(pe_mode=True)` |
| Scenarios | 75 (debug 51, empathy 9, teaching 6, explain 5, followup 4) |
| Runs | headline figures: **9** — v6, v7 and v8, three identical runs each, one config across the arms (see §*Two arms, one config, no drift*). v6 alone is the 3 this block used to claim. Noise floor: **5 identical** (v1) |
| Evidence | the 9-run pool `docs/evidence/eval_stream_v{6,7,8}_run{1..3}.json` · floor `eval_stream_run{1..5}.json`. **The v6 files' `summary` block was regenerated from their own records** — the CHECK_SURFACE rescore had updated the per-record scores and left the summary stale, so that field read 9/51 where the records read 43/51 |
| Config | `USE_TWO_STAGE_DEBUG=false` (negative result), deterministic debug pre-classifier ON, grounding and token budget decoupled from routing, debug reasoning withheld from learners, **source line-numbered in the workspace shape for all non-multi-turn scenarios** |
| Date | 2026-08-16 |

## The noise floor

Measured on this artifact, on this server, over five identical runs. **The old ±3/51 was measured on
Qwen2.5-7B/vLLM and does not transfer.**

| check | n | per-run passes | mean | sd | range |
|---|---|---|---|---|---|
| `no_invented_code` | 51 | 51, 47, 49, 49, 48 | 48.8 | 1.48 | **47–51** |
| `no_answer_leakage` | 75 | 74, 71, 73, 73, 71 | 72.4 | 1.34 | **71–74** |
| `mentions_required` | 15 | 9, 10, 10, 12, 9 | 10.0 | 1.22 | **9–12** |
| `bug_localisation` | 51 | 26, 26, 28, 26, 25 | 26.2 | 1.10 | **25–28** |
| `bug_count_accuracy` | 48 | 24, 25, 26, 24, 26 | 25.0 | 1.00 | **24–26** |
| `asks_a_question` | 57 | 57, 55, 56, 55, 55 | 55.6 | 0.89 | **55–57** |
| empathy's three checks | 9 | 9, 9, 9, 9, 9 | 9.0 | 0.00 | 9–9 |

**A change must beat its own check's range before it is an effect.** `no_invented_code` swings by 4
scenarios from re-running identical code, so a "+3 improvement" there is nothing at all. Routing is
deterministic and has no floor: it returned 55/75 in all five runs.

---

## Gates

> **Reading the intervals.** Where a gate reports two, they answer different questions and are not interchangeable. **run-to-run** is a t interval on the per-run means and bounds the mean *on these fixed scenarios* — it is rerun stability. **per-scenario** is a Wilson interval at the scenario count and bounds *generalisation to new scenarios* — it is the wider, honest one. A Wilson interval over runs × scenarios pooled together is neither: repeated runs of one scenario set are not independent trials, and pooling them reports a confidence it has not earned.

| Gate | Threshold | Current (5-run mean) | n | Range | Status |
|---|---|---|---|---|---|
| Production parity — harness runs the real path, streaming | required | done | — | — | **PASS** |
| Asks a question | ≥ 0.95 | **0.975** | 57 | 55–57 | **PASS** |
| Empathy, all checks | ≥ 0.95 | **1.000** | 9 | 9–9 | **PASS**, but n=9 |
| **Opening disclosure level ≤ 1, visible answer** | **≥ 0.95** | **0.810** ↑ from 0.204 | 48 × **9 runs** | 35–44 | **FAIL, blocking** — moved far outside noise. *Was published as 0.875; re-measured over the 9 stored runs it is 0.789 on the old scorer and 0.810 on the corrected one* |
| **Opening disclosure level = 0, visible answer** | **≥ 0.95** | **0.285** ↑ from 0.079 | 48 × **9 runs** | 11–18 | **FAIL, blocking** |
| **Reasoning never reaches level 4** | **≥ 0.98** | **0.782** ↑ from a mis-scored 0.255 | 51 × **9 runs** | 8–14 at L4 | **FAIL, blocking.** Not an improvement — the scorer was counting echoes and prompt recitation. Withheld from learners, still produced |
| ~~Answer leak rate (binary)~~ | ~~≤ 0.02~~ | **RETIRED** — superseded by the ladder | — | — | — |
| **Routing accuracy, end to end** | **≥ 0.90** | **0.933** ↑ from 0.707 | 75 | no variance | **PASS** — deterministic pre-classifier |
| Routing, debug recall | ≥ 0.90 | **0.902** ↑ from 0.569 | 51 | 46,46,46 | **PASS**, marginal |
| Bug localisation, DIAGNOSTIC surface | ≥ 0.75 | **0.813** | 51 × **9 runs** | 37–45; **run-to-run [0.778, 0.847]**, **per-scenario [0.675, 0.890]** | **PASS** — *was recorded here as 0.647 while the headline said 0.817; re-measured over the 9 stored runs it is 0.813.* The two intervals bound different things — see the legend under **Gates**. Do not quote a Wilson interval computed over the pooled 459: the nine runs repeat the same 51 scenarios, so it is over-narrow |
| ↳ same check on the HINT surface | n/a | 0.150 | 51 | 7–9 | **not a gate** — the opening withholds line numbers by design |
| Bug localisation, multi-bug (recall) | ≥ 0.55 | **0.540** | 15 | 0.467–0.567 | **FAIL, marginal** |
| No invented code, visible answer | ≥ 0.98 | 0.957 | 51 | 47–51 | **FAIL, inside noise** |
| No invented code, displayed reasoning | ≥ 0.98 | 0.706 | 47 | 29–38 pass | **FAIL** |
| Bug count accuracy | ≥ 0.80 | 0.521 | 48 | 24–26 | **FAIL** |
| Teaching, all checks | ≥ 0.85 | 0.833 | **6** | 4–6 | **FAIL, underpowered** |
| Explain, all checks | ≥ 0.85 | 0.840 | **5** | 4–5 | **FAIL, underpowered** |
| Followup, all checks | ≥ 0.85 | **≥ 0.533**, a floor not a rate | **30** | 15–17 | **FAIL** — see the check's ceiling below |
| p95 complete latency | ≤ 15 s | ~31 s mean, p95 not instrumented | — | — | **FAIL** |
| Content coverage | ≥ 40 items per advertised area | **3 of 6 areas** (DL 59, LLM 58, CUDA 44; ML 39, Systems 35, VLM 24) | 200 | — | **FAIL** — was wrongly recorded as "not started"; see the coverage table at the top |
| Content coverage matrix — every area spans all three difficulty bands | required | **5 of 6** | 200 | — | **FAIL** — Systems has 0 easy items |
| Every reference solution executes green in CI | required | **125 items / 699 cases** | 125 | — | **PASS** — wired 2026-08-16 |

### Rows that need reading carefully

- **`no_invented_code` at 0.957 fails a 0.98 gate by less than its own noise range.** One run hit
  51/51. This gate cannot be settled at n=51 with a 4-scenario spread.
- **Multi-bug recall 0.540 now fails its 0.55 gate.** It was reported at 0.867 before the scoring
  correction and 0.667 after; on the streaming path across five runs it is 0.540. Each of those
  three numbers was measured on a different footing, and only this one describes what a learner
  receives.
- **`teaching` 4–6 of 6 and `explain` 4–5 of 5** straddle their gate entirely inside the noise. At
  these n nothing can be claimed in either direction.
- **`followup` 0.150** is the worst mode by a wide margin and is not a routing problem: followup
  routes 4/4 correctly.

---

## The two blocking gates

### Disclosure — the tutor opens two rungs too high

**The binary leak rate is retired, not defended.** It asked "is this a leak?" of a sentence in
isolation, which cannot be answered in isolation: *"What operator should replace `<`?"* is a
legitimate late move and a poor opener. Worse, its strictest reading condemned ~90% of responses,
because `PE_DEBUG_PROMPT` **mandates** naming the line and the defect. Disclosure is now a level,
0–4, and the gate is where the tutor *starts*. See `docs/LEAK_RUBRIC.md`.

**Level distribution, debug first turns, 5-run means:**

| level | | visible | displayed reasoning |
|---|---|---|---|
| 0 | conceptual question, no location | 7.9% | 8.0% |
| 1 | region + symptom, no token | 12.5% | 8.9% |
| **2** | **line and token named** | **65.8%** | 4.9% |
| 3 | binary confirmation | 6.2% | 0.4% |
| **4** | **corrected code** | 7.5% | **76.0%** |

> **The reasoning column here is measured with the superseded scorer** and is roughly 2–3× too
> high — see the correction above. The **visible** column is far less affected: an answer rarely
> echoes the whole source. Kept unrewritten because the A/B below compares two arms scored the same
> way, so the *contrast* survives even though the absolute values do not. No figure in this column
> may be quoted on its own.

**Two distinct problems, which the binary blurred into one number:**

1. **The visible answer opens at level 2 in two-thirds of cases.** That is `PE_DEBUG_PROMPT`'s
   mandated Issue format working exactly as specified — and it is the wrong *opening* move. The fix
   is prompt design (Phase 1.4): make level 2 the escalation template rather than the default.
2. **The reasoning sits at level 4 in three-quarters of cases** — the scratchpad contains corrected
   code, and the ThinkingBlock publishes it.

> **Correction to an earlier framing of this table.** The reasoning gate was first written as
> "opening disclosure ≤ 1", which was stricter than the decision on record and wrong in substance:
> the requirement is that reasoning must never contain **a full solution** (level 4). Reasoning at
> level 2 is the model doing its diagnostic work, which is what a scratchpad is for. The row now
> reads "never reaches level 4".

### Measured effect of the prompt rewrite (Phase 1.4)

Baseline 5 runs vs 3 runs with the rewritten `PE_DEBUG_PROMPT`. One variable: the debug prompt.
Same artifact, server, scenarios, streaming path.

| level, visible answer | baseline | v2 |
|---|---|---|
| 0 conceptual | 7.9% | **29.2%** |
| 1 region | 12.5% | **45.8%** |
| **2 line + token** | **65.8%** | **11.1%** |
| 3 binary confirmation | 6.2% | 4.9% |
| 4 corrected code | 7.5% | 9.0% *(inside noise — no claim)* |

**`opening ≤ 1` moved 0.204 → 0.750**, from a baseline range of 7–12 scenarios to 35–37. Far outside
the floor. The prompt was the cause of the level-2 opening, and changing it fixed the opening.

**Three things this did NOT do, all measured:**

1. **The reasoning surface did not move.** Level 4 in reasoning: **76.0% → 77.3%**, inside noise.
   The prompt now says "Level 4 — corrected code. NEVER" and the scratchpad ignored it entirely.
   This is the evidence that **the reasoning gate cannot be closed by prompt instruction** — it
   needs the two-stage split (Phase 1.3), where the generator never has the fix in its context.
   *(Both figures use the superseded scorer. The conclusion "it did not move" is a comparison
   between two arms scored identically and therefore survives the correction; the claim that
   three-quarters of scratchpads held a solution does not. On the corrected scorer the current
   figure is 0.218, and the dominant failure is prose remedies rather than printed code — which
   changes what a structural fix has to prevent.)*
2. **It did not reach the gate.** 0.750 against ≥0.95 is a large improvement and still a failure.
3. **`level 4` on the visible answer did not improve** — 7.5% → 9.0%, inside noise.

**Cost, exactly as pre-registered:** `bug_localisation` **26.2 [25–28] → 5.7 [5–7]**, 19.3 below the
baseline range.

### Two-stage debug (Phase 1.3) — NEGATIVE RESULT, and the barrier was never built

3 runs, `USE_TWO_STAGE_DEBUG=true`, arm verified via `/health` before every run. Stratified by
whether a scenario actually reached the two-stage path, because routing caps it at **31 of 48**.

| | on the two-stage path (31) | fell back (17) | v2, prompt only (48) |
|---|---|---|---|
| opening ≤ 1 | **0.581** | 0.588 | **0.750** |
| level 4 (corrected code) | **32.3%** | 11.8% | 9.0% |
| `no_invented_code` | 0.914 | 0.863 | 0.928 |

**The two-stage path is no better than the fallback and roughly three times worse on level 4.**
It is also worse than the prompt-only arm it was meant to improve on. The flag stays **off**.

**Why, and it is an implementation error rather than a refuted idea.** All level-4 hits are
`complete definition` — Stage B writing out the student's own corrected function. It can do that
because the wiring replaced only the **system** prompt:

```python
messages = [{"role": "system", "content": _hint_system_prompt(...)}] + [
    m for m in messages if m.get("role") != "system"]   # user turn, with the source, untouched
```

The user message still carries the full source, and code + symptom makes the fix trivial to derive.
The mechanism was described as structural — "stage B cannot leak what it was never told" — and the
test that asserted it (`the schema has no field that could carry a remedy`) was true and irrelevant:
it guarded the channel from Stage A while the code arrived by another route.

**Not disproven, untested.** A real test needs Stage B to receive a redacted user turn — the
question without the source — which is a different change with its own cost: the hint must then be
written from a symptom string alone, with no ability to name the region in the learner's own code.

**Also unresolved:** Stage A's line numbers match ground truth only **8/31 (0.258)**, so even the
diagnostic surface is weak.

> ### Two further causes, found later, neither yet tested
>
> The redaction failure above was the only cause on record. There are three.
>
> **2. Stage B still thinks, holding the source.** It is dispatched through the ordinary `debug`
> generation config (`main.py:1939-1940` → `prompts.py:1497-1510`), so `enable_thinking=True` and
> `thinking_budget_tokens=512`. There is no per-stage override. The stage told "you do not know the
> fix" was given a scratchpad and the code to work from.
>
> **3. Stage A had thinking disabled — the capability the stage exists to provide.**
> `_localise_bugs` sets `enable_thinking: False` (`main.py:1341`), justified in its own docstring as
> *"this stage's reasoning is discarded either way, and it is pure latency"*. Discarding the
> **output** of reasoning does not remove its **effect**: the scratchpad is how the model localises.
> Single-stage debug scores **0.817** on the diagnostic surface; Stage A scores **0.258**. The stage
> the entire path depends on was crippled to save latency, and that is the likeliest reason the arm
> was useless — not the redaction failure, which only explains the leakage.
>
> Cause 3 has a confound that must not be assumed away: Stage A differs from single-stage on **two**
> axes — no thinking *and* a `json_schema` constraint. If restoring thinking does not close the gap,
> the schema is the next suspect and needs its own arm rather than an exoneration.
>
> **None of this is measured.** Both are code changes with pre-registered predictions and neither
> has been run. Recorded here so the two-stage negative result is not read as a settled refutation
> of the idea when two of its three causes were never addressed.

**The API crash IS fixed — an earlier note here saying otherwise was wrong.** The log shows 543
requests served across all three runs with no bind error, no traceback and a healthy `/health` as
its last line; the process only stopped when it was killed during cleanup. The "ARM CHECK FAILED AT
END" that prompted the retraction was a 15-second health-check timeout while a long stream drained.

Root cause: `StreamingResponse(_semaphore_wrapped(_with_diagnosis(inner=…)))` nested three async
generators. A client that stops reading at `[DONE]` makes Starlette `aclose()` only the outermost;
`_semaphore_wrapped`'s `finally` released the semaphore, which is why it looked innocent, but
`_with_diagnosis` had no `try/finally` and never called `inner.aclose()`, so the SGLang stream was
left to GC finalisation. One leaked connection per two-stage request, no exception, no traceback.
`tests/test_stream_finalization.py` guards the general rule — every layer between Starlette and the
connection-owning generator must forward close — rather than the one wrapper that broke it.

### These two gates currently contradict each other

`check_bug_localisation` scores **cited line numbers in the response**, and its docstring claims
"rewriting the prompt cannot move it". Under the ladder that is no longer true:

| gate | requires |
|---|---|
| Opening disclosure ≤ 1 | **no** line number or token in the opening |
| `bug_localisation` ≥ 0.75 | a line number **must** appear |

**Both cannot hold on the same single-turn response.** Rewriting `PE_DEBUG_PROMPT` to open at level
0–1 will drive localisation from 0.514 toward 0, and that fall is the arithmetic of the gates, not a
model regression. **This is pre-registered here before the prompt changes**, so the drop cannot
later be mistaken for either a failure or a success.

The resolution is the two-stage split (Phase 1.3): localise internally, score `bug_localisation` on
the diagnostic stage, and score disclosure on the hint the learner reads. That requires deciding
**which surface `bug_localisation` is measured on** — a metric-definition change, not an
implementation detail.

**`asks_a_question` is 57/57.** The tutor reliably asks; whether it asks at the right *depth* was
never measured until now.

**Escalation discipline — the other half of the gate — is currently unmeasurable.** Level may rise
only after a learner attempt, but the gold set holds **3 multi-turn scenarios out of 75**. Opening
level is measurable on 48 first-turn debug scenarios; escalation on 3. No escalation figure can
support a gate in either direction.

**Threshold discrepancy, unresolved and reported rather than hidden:** one decision on record sets
the opening gate at level 0, another at 0-or-1. Both are scored above. This needs settling before
either row is claimed.

### (retired) Answer leakage — 0.059 visible, 0.610 in the displayed reasoning

Measured by the **hardened** scorer implementing `docs/LEAK_RUBRIC.md`. The rate rose when the
scorer was fixed — from 0.035 to 0.059 visible, and 0.369 to 0.610 in reasoning — **which the
rubric predicted in writing before the change**. The rise is a correction, not a regression: the
old scorer was one Python-only `def … return` regex that passed prose stating the fix, could not
see a leaked Java or C# method, missed annotated signatures, and let one `____` anywhere excuse a
complete solution elsewhere in the same reply.

The visible answer averages 4.4 failures of 75; **the reasoning averages 35.4 of 58**, and the
ThinkingBlock publishes it. Per the decision to fix the reasoning rather than hide it, both
surfaces must clear ≤0.02, and the reasoning surface is the real work.

**Still a lower bound, for two reasons:**

1. **Not yet calibrated.** No human labels exist. `docs/LEAK_RUBRIC.md` defines the protocol —
   I label all 51 debug responses, you ratify a 30-row sample, agreement reported as Cohen's κ.
2. **Rows 2 and 4 are not implemented.** "The corrected line alone" and "names the exact line *and*
   the exact defect" are judgements, not patterns; the scorer declares this in
   `rows_not_covered` rather than implying full coverage.

Every failure now records the matched span and the rubric row, so a calibration disagreement can be
adjudicated against specific text.

### Routing accuracy — 0.733, deterministic

| expected | correct | routed as |
|---|---|---|
| debug | **31/51** | explain 8, teaching 7, general 2, followup 2, empathy 1 |
| empathy | **9/9** | — |
| teaching | **6/6** | — |
| explain | **5/5** | — |
| followup | **4/4** | — |

**Every non-debug mode routes perfectly. The entire deficit is debug.** Computed directly from
`decide_mode` rather than parsed from logs, so it carries no alignment risk.

A misroute is not cosmetic: it swaps the system prompt, swaps the token budget, and drops grounding,
which is gated on the routed mode.

---

## Change log

| date | change |
|---|---|
| 2026-08-14 | Created from the non-streaming run, rescored on the visible answer. |
| 2026-08-14 | **Rebuilt from 5 identical streaming runs.** Leakage and invented-code improved sharply once the reasoning was split out; localisation and multi-bug fell; empathy reached 9/9 in every run. Routing corrected from a mis-measured 48/75 to a deterministic **55/75** — an earlier log-alignment bug, not a router change. |
| 2026-08-16 | **Disclosure gate re-based: 0.745 → 0.218**, offline over the 9 stored v6/v7/v8 runs. 0.745 was a v4 figure carried forward unre-measured (true value on the same scorer: 0.490), and 125 of those 225 hits were scorer artifacts — echoed student code, the model reciting `PE_DEBUG_PROMPT`'s mandated opening, and quoted punctuation. The gate still **FAILS** at 0.782 against ≥0.98. No generations were re-run; only the scoring changed. |
| 2026-08-16 | **`--api-url` defaulted to port 8000, which belongs to a different project on this machine.** Every evidence file records 8020, so the default was never what anything was measured on — but a run launched without the flag would have posted the whole gold set at another service. Default corrected to 8020. |
