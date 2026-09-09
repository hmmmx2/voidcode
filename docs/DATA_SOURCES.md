# VoidCode AI — Data Sources

Every corpus used by this build, what it is licensed under, and what we do with it.
Spec §3.1 requires licence terms per source; §4.1 requires the bootstrapped volume to be
stated plainly rather than implied to be organic traffic.

---

## 1. Codeforces public API — Phase 2 submission telemetry

**Endpoints.** `problemset.problems` (catalog), `contest.list`, `contest.status`
(submissions). Base `https://codeforces.com/api`. No authentication is required for these
public endpoints.

**What it gives us.** This is the corpus the mastery model is built on. Each
`contest.status` row carries the field most published dumps drop — a **per-user handle** —
alongside everything spec §4.3 needs:

| Field | Feeds |
|---|---|
| `author.members[].handle` | learner identity |
| `problem.contestId` + `index` | problem identity |
| `problem.rating` | difficulty (a real Elo-scale number, 800–3500) |
| `problem.tags` | concept projection via `data/concepts.yaml` |
| `verdict` | pass rate, error taxonomy |
| `creationTimeSeconds` | attempt ordering, time-to-accept, recency decay |
| `passedTestCount`, `timeConsumedMillis`, `memoryConsumedBytes` | partial-credit and TLE signals |

**Licence position — read this before redistributing anything.** Codeforces publishes an
open API but does **not** attach an open-data licence (no CC-BY, no ODbL) to the data it
returns. Use here is therefore scoped conservatively:

- Read-only, rate-limited to below the documented ~1 request / 2 seconds.
- Used for research and education, which is the stated purpose of this build.
- **The raw corpus is not redistributed.** It is fetched to a local landing zone and
  is `.gitignore`d. Only derived, aggregated features are committed.
- If this project is ever published with data attached, the licence question must be
  re-opened first. It is unresolved, not resolved in our favour.

**Privacy handling.** Codeforces handles are public pseudonyms, not real names. Even so,
the bronze layer is the only place a handle appears. The Spark job derives
`learner_id = sha256(handle + salt)[:16]` and every downstream artifact — mastery vectors,
ranking features, experiment buckets — carries only the hashed id. The salt lives in the
environment, not the repository.

**Volume, stated plainly (spec §0 rule 3).** This is a bootstrapped public corpus, not
VoidCode's own traffic. VoidCode has **zero** real learner submissions today. Row counts
and learner counts go in `docs/METRICS.md` as measured, with no rounding up and no
implication that these are our users.

---

## 2. Project CodeNet — nominated by the spec, not used

Spec §4.1 nominates Project CodeNet (~14M submissions) as "the obvious choice". It was
attempted first and rejected on availability:

```
https://dax-cdn.cdn.appdomain.cloud/dax-project-codenet/1.0.0/Project_CodeNet_metadata.tar.gz
-> URLError: [Errno 11002] getaddrinfo failed
```

The IBM Data Asset eXchange CDN host does not resolve from this network. HuggingFace,
PyPI and Codeforces all resolve from the same machine, so this is specific to that host
rather than a general egress block.

The HuggingFace mirrors carrying the CodeNet name were also checked and are unsuitable —
`iidai/codenet` is 1,000 rows, `petersa2/CodeNet` is 3,377 rows, and neither carries a
user identifier.

**If CodeNet becomes reachable it remains the better corpus**, because it spans multiple
judges and 55 languages. It is licensed CDLA-Permissive-2.0, which is genuinely
redistributable — unlike the Codeforces data above. Re-opening this is tracked as a
follow-up, not a blocker.

---

## 3. `MatrixStudio/Codeforces-Python-Submissions` — evaluated, rejected

690,396 rows (621,356 train / 69,040 test), 4.7 GB, on HuggingFace. Carries verdict,
rating, tags, timestamp and full source code.

**Rejected for Phase 2 because it has no user identifier.** Its 28 columns include
`contestId`, `verdict`, `creationTimeSeconds` and `code`, but nothing identifying who
submitted. Per-learner mastery vectors cannot be built from it, and assigning synthetic
learner ids at random would manufacture a mastery structure that does not exist.

It is still a **candidate for Phase 1**, where the `code` column and problem statements
are useful for the bug-diagnosis and worked-solution task modes and no learner identity is
needed. Row count is below the 1M Phase 2 floor but ample for instruction tuning.

---

## 4. Existing VoidCode tutoring data — Phase 1, synthetic

`llm/data/voidcode_training_data_v53.jsonl` — 1,860 examples, and
`voidcode_training_data_v52.jsonl` — 1,700 examples.

**Generated, not collected.** Produced by `llm/scripts/generate_debug_examples_v53.py` and
`generate_gap_examples.py`. Modes: debug 760, teaching 900, followup 200. These trained the
existing QLoRA checkpoint and are the source of the 411.9 tok/s baseline in the metrics
ledger.

Note that these were rewritten during the VoidCode AI rebrand — the system prompt now
reads "VoidCode AI" where the trained checkpoint in `llm/outputs/checkpoint-108/` still
expects the old wording. Retraining is required before that checkpoint and this data agree.

---

## 5. Phase 1 corpora — not yet acquired

Spec §3.1 nominates Project CodeNet, Codeforces dumps and the MBPP / HumanEval families.
Status: **NOT ACQUIRED.** Phase 1 is blocked on the hardware question in
`docs/specs/OPEN_QUESTIONS.md` Q-001, so acquisition is deferred rather than skipped. Licences
to record when it happens:

| Corpus | Licence | Note |
|---|---|---|
| MBPP | CC-BY-4.0 | 974 short Python problems |
| HumanEval | MIT | 164 problems; a benchmark, keep out of training |
| Project CodeNet | CDLA-Permissive-2.0 | redistributable, unlike the CF API data |

HumanEval must stay in evaluation only. Training on it would invalidate the pass@1 figure
spec §3.3 asks for.
