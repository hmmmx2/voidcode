# Knowledge architecture — what changes when content changes

> ## ⚠ DATED 2026-07-28. Four load-bearing claims below have since decayed.
>
> Kept as written, because a dated audit rewritten in place stops being evidence of what was true
> when a decision was made. But it has been cited as current — including by me, to recommend a
> course of action — so the decayed claims are named here rather than left for the next reader to
> trip over. See also `docs/AUDIT_CORRECTIONS.md`, which corrects three of them and predates this
> banner.
>
> | claim below | line | as of 2026-08-16 |
> |---|---|---|
> | "`MAX_CONCEPTS = 80` … the taxonomy is sitting exactly on its ceiling" | 162, 360, 505 | `MIN_CONCEPTS, MAX_CONCEPTS = 40, 300` (`features/taxonomy.py:37`), **145** concepts — 155 of headroom |
> | "Every test case is `is_hidden: False` — 15 of 15" | 85, 279, 400, 506 | **421 hidden / 258 visible.** Filtered from the read path (`routers/problems.py`) and redacted on the grade path (`execution.py`) |
> | "the shipped catalogue is classical DSA and contains no ML material" | §2.2 | **200 items, all ML/GPU.** 125 executable, 32 rubric, 40 interview questions, 3 papers |
> | "four duplicated copies of catalogue content in the frontend" | 90-104 | Two of the four are gone; two remain; two more exist that this list never named. One of them published a hidden test's expected output — fixed 2026-08-16 |
>
> The verification claim in §1 — that content changes need no retraining — is **unaffected and still
> true**; it rests on the serving path, not on any of the above.

**Question:** does adding a new interview question require retraining the tutor model?

Everything below is grounded in this repository as of 2026-07-28. Claims from general
principle rather than from the repo are labelled **[principle]**. Recommendations for
things that do not exist yet are labelled **[design recommendation]**.

---

## 1. Direct answer

**No.** Adding an interview question is a database write. It requires no GPU, no
retraining, and no model artifact of any kind. Three independent facts in this
repository establish it rather than merely suggest it. First, the question catalog is
already a separate plane from the model — `apps/api/scripts/seed_problems.py` writes
`problems` / `test_cases` / `code_templates` rows to Postgres, and the tutor receives
problem content as *text assembled at request time* by the browser
(`apps/web/src/components/VoidCodeAI/VoidCodeAIPanel.tsx:902` `buildContextPrompt`),
never from its weights. Second, the production serving path contains **no fine-tuned
weights at all**: under `USE_SGLANG` the model is stock Qwen3.5-9B from the HF cache,
`/health` reports `arch_label = "prompt-engineered"` and `adapter_path: None`
(`apps/api/src/main.py:1309-1316`), and the vLLM path cannot even start because
`llm/outputs/awq_model/` and `merged_model/` contain **zero `*.safetensors` shards**
(verified: only the 154 MB LoRA adapter at `llm/outputs/final_model/` holds real
weights). A question cannot require retraining a model the deployed system does not
use. Third, the repo has already ruled on this on measured evidence —
`ENGINEERING_RECOMMENDATION.md:83` is titled *"Recommendation: Fix via Prompts, Not
Retraining"* and `:507` states *"Any new problem (dijkstra, segment tree, Fenwick tree)
is handled by the base model's general reasoning — no new training data needed."*

**But your stated reason for believing it is not what was actually built, and that
matters.** The premise "fine-tuning teaches pedagogical behaviour rather than storing
answers" is the correct *design*, and it is the correct thing to hold to. It is not a
description of `llm/data/voidcode_training_data_v53.jsonl`. That corpus is 1,860
examples covering **13 distinct problems** (`llm/data/validation_report.txt:33`,
"Unique problems: 13") at roughly 154 near-clones each, with **3,015 near-duplicate
pairs** above 85% similarity (`:13`). The examples do not teach hinting in the
abstract; they hardcode the DP recurrence for Climbing Stairs, its exact seven-line
skeleton, and which expressions to blank. The behaviour generalises because the
*format* was learned; the content did not need to generalise because it is supplied at
request time. So the answer holds — but it holds despite the training corpus, not
because of it. §6 gives the threshold at which that stops being true.

---

## 2. Current state

Reported as found. `NOT PRESENT` means searched for and absent, not "not yet reviewed".

### 2.1 Tutor prompts, model configuration, fine-tuning code

| Thing | Where | Notes |
|---|---|---|
| All system prompts | `llm/scripts/prompts.py` (1,026 lines) | Single file, imported by the API via `sys.path` injection (`main.py:71-85`). No prompts module exists inside `apps/api/src`. |
| `FINETUNED_SYSTEM_PROMPT` | `prompts.py:21-252` | 10,509 chars. Also the system message of **all 1,860** training examples, byte-identical. |
| Prompt-engineered variants | `prompts.py:266-383` (teaching), `:398-534` (debug), `:543-562` (followup) | Used when `USE_SGLANG=true` — i.e. in the intended production config. |
| Mode-independent prompts | `:569-587` explain, `:594-625` general, `:635-672` empathy | Bypass `pe_mode` entirely; always base-model behaviour. |
| Prompt/adapter coupling | `llm/scripts/validate_prompt_match.py:9-18` | Exists because a one-character drift in the system prompt produced *"43-token garbage on the v5.2 → v5.3 transition"*. **This is the single tightest coupling in the system.** |
| Training config | `llm/configs/training_config.yaml` | QLoRA, Qwen2.5-7B-Instruct, 4-bit NF4, r=16, α=32, 7 projection modules, lr 1e-4 cosine, 1 epoch, effective batch 32. |
| Trainer | `llm/scripts/train.py` (718 lines) | `trl.SFTTrainer`. The only trainer. |
| RL / DPO / reward model | — | **NOT PRESENT.** Zero hits for `DPOTrainer\|PPO\|GRPO\|RLHF\|reward_model\|ORPO\|KTO` across the repo. `trl>=0.8.0` is pinned but only `SFTTrainer` is imported. |
| Eval harness | `train.py:438-573`, `llm/scripts/evaluate_debug_quality.py` | Both are **format-compliance checkers**. Checks are string matching — `'[EXPLAIN]' in response`, presence of 🔴/🟢. There is no correctness, no held-out accuracy, and no learning-outcome eval anywhere. |

**Model artifacts.** `llm/outputs/final_model/adapter_model.safetensors` — 154 MB, real.
`llm/outputs/merged_model/` and `llm/outputs/awq_model/` — tokenizer and config files
only, **0 safetensors shards**, verified by listing. Both are empty shells;
`docker-compose.gpu.yml:64` mounts the latter and `vllm_engine.py:108-114` only checks
`is_dir()`, so the guard passes and vLLM fails later on missing shards.

**Which model actually serves.** Three mutually exclusive backends (`main.py:103-111`).
`USE_SGLANG` → stock **Qwen3.5-9B** fp8, no adapter, prompt-engineered. `USE_VLLM` →
cannot start (above). Default → HF + LoRA, `MAX_CONCURRENT_REQUESTS=2`.

### 2.2 How questions are stored

**Canonically: Postgres, seeded by a Python script.** No JSON, YAML, or Markdown
problem file exists anywhere.

- `apps/api/scripts/seed_problems.py:22` — `PROBLEMS = [...]`, **5 problems, all
  `difficulty: "easy"`, all classical DSA**: two-sum, reverse-string, valid-parentheses,
  merge-two-sorted-lists, best-time-to-buy-and-sell-stock.
- Per problem: `description`, `examples` (3), `constraints`, `hints` (3), `test_cases`
  (3), `code_templates` (4 languages: Python 71, JS 63, C++ 54, Java 62).
- **Every test case is `is_hidden: False`** — 15 of 15. Submit and Run see identical
  cases, so there is no held-out grading signal at all.
- Schema: `apps/api/src/models/problem.py:23` (`problems`), `:83` (`test_cases`),
  `:108` (`code_templates`). 14 tables total, 7 Alembic revisions.

**The same content is duplicated in four more places**, which is the operational
finding that matters most in §5:

1. `apps/web/src/lib/mock-data.ts:53-86` — a full hardcoded Two Sum whose `hints`
   **have already drifted** from the seed script's.
2. `apps/web/src/app/(workspace)/problems/[id]/page.tsx:5-11` — `SLUG_MAP` plus
   `totalProblems={5}`.
3. `apps/web/src/components/ProblemPanel/ProblemTabs.tsx:63-68` — hardcoded title list.
4. `apps/web/src/components/VoidCodeAI/VoidCodeAIPanel.tsx:584-885` —
   `PROBLEM_TEACHING_TEMPLATES`, **five problems' worth of hand-written pedagogy
   (`explain` / `template` / `guide`) compiled into the client bundle.**

### 2.3 Retrieval, embedding, vector store

**NOT PRESENT. Definitively, with no partial implementation.**

A repo-wide scan for `faiss|chromadb|pinecone|qdrant|weaviate|milvus|pgvector|
sentence-transformers|langchain|llama-index|BM25|elasticsearch|HNSW|semantic search`
returns **19 hits, all prose inside `FUTURE_IMPLEMENTATION.md`**. No dependency
manifest lists any of them. No Alembic migration creates a vector column. No
`docker-compose*.yml` service is a vector DB or search engine.

The word *vector* in this codebase always means a hand-engineered feature vector —
`features/spark_jobs/build_features.py:194`, *"The mastery vector. One row per (learner,
concept)"* — never an embedding. The only `embed` hits are `embed_tokens` parameter
accounting in `scripts/memory_audit/`. The only `retriev` hits are docstrings meaning
"fetch a row from Postgres".

**How the tutor gets context today:** the browser concatenates a literal text block —
`[PROBLEM DESCRIPTION]`, `[SOURCE CODE]`, `[TEST CASE DETAILS]`, `[CODE EXECUTION
OUTPUT]` — from the Postgres row and the editor buffer
(`VoidCodeAIPanel.tsx:902-1116`, invoked at `:1482`). Everything else it "knows" comes
from base-model pre-training.

### 2.4 Reference material

**NOT PRESENT as subject-matter corpus.** `docs/` (9 files, 2,781 lines) and the 12
root `*.md` (6,883 lines) are engineering notes about building the project — zero
learner-facing prose. `data/` holds exactly one file, `concepts.yaml`, which is a
taxonomy (ids, categories, prerequisites, tag mappings) with no explanatory text and no
citations. No `corpus/`, no PDFs. The Codeforces ingest lands outside the repo and
carries **no problem statements** — only ids, names, ratings and tags.

### 2.5 The content gap — the crux

**Zero of the five advertised content areas has a single answerable question.**

Searching all file types for `cuda|kernel|attention|transformer|quantiz|tokeniz|RAG|
embedding|system design|recommender|distributed training|VLM|multimodal|backprop`
produces hits in exactly two categories: **the project's own inference infrastructure**
(`vllm_engine.py`, `train.py`, `docker-compose.gpu.yml`, the memory-audit scripts) and
**marketing copy** (`TwoTracks.tsx:17-33` lists "Attention, multi-head and causal", "KV
cache", "Quantization: what you lose"; `Hero.tsx:75` "ML & Systems interview prep").
Neither is curriculum. VLM and CUDA do not appear in the marketing copy at all.

The repository already says so in three places:

- `demo-content.ts:18-20` — *"this is authored demo content. It is not drawn from the
  problem bank … the shipped catalogue is classical DSA and contains no ML material at
  all."*
- `ConceptGraph.tsx:18-22` — *"listing its contents on a page positioned for ML
  interviews would be a claim the repository does not support."*
- `docs/specs/OPEN_QUESTIONS.md:246-263`, **Q-010, BLOCKER FOR LAUNCH** — *"The repository
  contains no ML learner content of any kind."*

The fine-tuning corpus is likewise 100% DSA: 26 distinct LeetCode problems across
1,860 examples, zero ML/CUDA/VLM/systems-design examples.

**Correction to a repo fact you may be carrying:** `data/concepts.yaml` holds
**exactly 80 concepts, not 88** (verified by parsing: techniques 16, graphs 14,
data_structures 12, recursion_dp 11, math 11, foundations 7, strings 6, geometry 3).
`docs/specs/OPEN_QUESTIONS.md` and `MEMORY.md` both say 88 and are stale. This is not pedantry —
`features/taxonomy.py:24` sets `MAX_CONCEPTS = 80`, so **the taxonomy is sitting exactly
on its ceiling and adding an 81st concept raises `TaxonomyError`.** Any ML concept
added to that file fails validation until the cap is raised.

### 2.6 Verifiability infrastructure

Real, and narrower than it looks. Judge0 CE 1.13.1 self-hosted
(`docker-compose.yml:49-95`, `privileged: true`), async submit-and-poll
(`services/judge0_client.py`), 5 s CPU / 256 MB per run. Grading is
`status_id == 3 and actual_output.rstrip("\n") == expected_output.rstrip("\n")`
(`routers/execution.py:190-195`) — **exact stdout string comparison**, no numeric
tolerance, no custom checkers. Four languages. **No GPU passthrough**: no
`deploy.resources.reservations.devices`, no `runtime: nvidia`, no `nvcc`, no CUDA
language id. **No free-text submission model, no rubric, no LLM-as-judge endpoint.**

### 2.7 User state and personalisation

Attempt history exists: `submissions` and `test_case_results`
(`models/submission.py:23`, `:91`). **Mastery does not** — no proficiency, theta, or
per-concept column in any of the 14 tables. The only progress computation is
`SELECT DISTINCT problem_id WHERE status='accepted'` (`routers/dashboard.py:56-63`), a
binary solved set. No spaced repetition anywhere.

A full mastery model *does* exist — Rasch 1PL IRT (`features/irt.py`), 25-column mastery
vectors, prerequisite signals — but it is an **offline Spark pipeline over scraped
Codeforces data with no join to platform users**. `features/*` is imported nowhere under
`apps/`. The ranker itself is specified only: zero hits for
`lightgbm|LGBMRanker|lambdarank|ndcg` in any `.py`; `lightgbm==4.7.0` is pinned and
imported nowhere; `Makefile:100-102` prints *"NOT IMPLEMENTED: belongs to a phase that
has not started"*; `docs/METRICS.md:36-38` reports Recall@100 and NDCG@10 as
`NOT MEASURED`.

---

## 3. Tier classification

Your three tiers are the right decomposition, with one addition. **The repo demonstrates
a fourth tier you did not list, and it is currently the most load-bearing one: Tier 0,
the system prompt.** Under `USE_SGLANG` — the intended production config — *all* tutor
behaviour lives in `prompts.py`, not in weights, because no adapter is loaded. Folding
prompts into "model weights" would misclassify the cheapest and most-used update path in
the system as a GPU job. It is a deploy, not a training run.

| # | Content type | Tier | Why | Update cost |
|---|---|---|---|---|
| 1 | A new Python coding question | **3** | Description, tests and templates are already DB rows; the tutor gets them as request-time text. | DB write + **4 frontend files** (§2.2). ~30 min, no GPU. |
| 2 | A new CUDA kernel exercise | **3**, blocked on infra | Same data shape, but nothing can execute it: Judge0 has no GPU, no `nvcc`, no CUDA language id. | DB write is minutes. **The GPU sandbox is the real cost** — see §4.2. |
| 3 | A new systems design prompt | **3 + 2** | The prompt is a row. The *rubric* it is graded against is reference material that must be retrievable and versioned, and does not exist. | DB write + rubric authoring. No GPU. Grading is unsolved (§4.2). |
| 4 | A new paper the tutor should know | **2** | Textbook retrieval: a fact, dated, citable, replaceable. Putting it in weights makes it unremovable. | Corpus write + re-index. Minutes. No GPU. **Requires building Tier 2, which does not exist.** |
| 5 | New CUDA toolkit, changed occupancy rules | **2** | A fact that *invalidates a prior fact*. Weights cannot forget; a corpus row can be replaced. | Corpus update. Minutes. The danger is the stale copy still in weights (§4.1). |
| 6 | A new model family after the cutoff | **2** | Pure fact, highest staleness rate of anything on this list. | Corpus write. Minutes. |
| 7 | **A new task mode (mock interview roleplay)** | **1** | The one genuine Tier 1 item here. A new output *schema* and a sustained multi-turn behaviour is exactly what SFT is for — `ENGINEERING_RECOMMENDATION.md:479`: *"the textbook SFT use case: teaching a new output schema, not teaching knowledge."* Try Tier 0 first; escalate only on measured failure. | Tier 0 attempt: hours. If it fails: corpus + QLoRA run + eval + merge + quantize + redeploy. **Days, GPU required.** |
| 8 | **Change to how strongly hints are withheld** | **0 today, 1 if the adapter is ever loaded** | Today it is an edit to `PE_TEACHING_PROMPT`. But `validate_prompt_match.py:9-18` exists because the adapter was trained on `FINETUNED_SYSTEM_PROMPT` **verbatim** — with the adapter live, editing that prompt is out-of-distribution and produced observed garbage output. So the same edit is a 10-minute deploy or a full retrain depending on a serving flag. | Prompt-engineered: **minutes**. Adapter-loaded: **full retrain**, because prompt and weights are one artifact. |

**The hidden coupling in row 8 is the most important line in this table.** Loading the
adapter does not merely add behaviour — it *converts the cheapest update path in the
system into the most expensive one*, silently, with no signal at the call site. See §7.

---

## 4. Domain complications

### 4.1 Staleness — how much fact should ever live in the weights?

**Recommendation: zero. Not "a little", not "stable fundamentals only" — zero
deliberately-placed factual content.** Fine-tune exclusively on behaviour and output
schema. Committing to this is cheap now and expensive later.

The reasoning is asymmetric cost, not fastidiousness. **[principle]** A wrong fact in a
corpus is one row to replace; a wrong fact in weights is unremovable without retraining
and, worse, *unlocatable* — you cannot enumerate what a LoRA adapter believes about
FlashAttention. And a tutor is the worst possible place for a confidently stale fact,
because the user cannot detect it: someone preparing for an interview does not know
enough to catch the tutor describing a superseded quantization scheme. The failure is
silent and it lands in the user's interview.

The repo already contains the argument, and also its refutation.
`FUTURE_IMPLEMENTATION.md:569` says full RAG is *"not needed today — the model's
parametric knowledge of algorithms (from 18T-token pre-training) is sufficient for
standard LeetCode-style problems"*, and `:710` *"That's self-contained — there's nothing
to 'retrieve.'"* **That is correct for classical DSA and void for this product.** Two
Sum has not changed since 1990. Attention variants, KV-cache paging, quantization
schemes and occupancy rules churn continuously. Q-010 retired the premise that document
was reasoning from; it should not be cited as precedent for the new scope.

Contrast the internal reasoning about *format*: `LLM_ARCHITECTURE.md:703` argues
fine-tuning is justified for TEACHING/DEBUG because they need rigid structure, and
harmful for EXPLAIN/GENERAL where the base model already excels. That is the correct
axis — **structure vs. knowledge**, not important-fact vs. unimportant-fact.

**A falsifiable acceptance test for any future corpus [design recommendation].** Could
you substitute every problem name and every technical detail in a training example for a
different subject and have the example still teach the same lesson? If yes, it is
behaviour. If no, it is content and belongs in Tier 2 or 3. Today's corpus fails this
test outright — the Climbing Stairs examples teach the Climbing Stairs recurrence. Two
enforceable gates: **no single problem exceeds 2% of examples** (today: ~8%, and 13
problems carry the whole corpus), and **near-duplicate pairs below 5%** (today: 3,015).

### 4.2 Verifiability and the RL plan

Your framing is right that the three areas differ, and the ordering you propose is
mostly right. Two corrections.

**Correction 1 — measured speedup is a *noisy* reward, and that is a real difference in
kind, not degree.** You say CUDA verification is "arguably a stronger reward signal than
unit tests". Numerical correctness against a reference is indeed strong — arguably
stronger, since it admits tolerance rather than exact-match. But *speedup* is not. A
unit test is deterministic: same input, same verdict, forever. Wall-clock speedup varies
with clock throttling, co-tenancy, cache state, and launch configuration.
**[principle]** A reward with variance the policy cannot influence is one a policy
optimises by exploiting measurement conditions rather than by writing better kernels —
the classic reward-hacking shape. If you use speedup, it needs locked clocks, repeated
trials with a robust statistic, and a correctness gate that hard-zeroes the reward
before speed is ever considered. Correctness first as a boolean, speed second as a
tiebreak.

**Correction 2 — nothing here can currently produce any reward signal.** There is no RL
code of any kind. More fundamentally, `is_hidden: False` on all 15 test cases means the
client is handed the expected outputs and posts them back in the submit payload
(`execution.py:52-56`) — there is no held-out set to reward against. And CUDA needs a
GPU sandbox that does not exist; `docs/AI_ENGINEER_PLATFORM_ARCHITECTURE.md:20` names the
actual problem precisely: *"It is not scale. It is untrusted code with CUDA access."*

**What a reward loop could and could not cover:**

| Area | Verifiable? | Verdict |
|---|---|---|
| Python for ML/DL | Yes — unit tests, deterministic | **Covered.** Judge0 works today. Needs hidden tests first. |
| CUDA kernels | Correctness yes; speed noisy | **Coverable, at real infrastructure cost.** Correctness as the gate, speed as a bounded tiebreak. |
| LLM / VLM architecture | Partly — implementation questions only | **Split the area.** "Implement causal masking" is verifiable; "when would you choose GQA" is not. |
| ML systems design | **No** | **Not coverable.** No automatic verification exists or can exist. |

**Recommendation: do not build an RL loop yet, and when you do, scope it to
execution-verified implementation tasks only.** `docs/FINETUNING_BLUEPRINT.md:379` states
the boundary well — *"Execution settles correctness. It cannot settle whether an
explanation is any good."* For systems design, use a rubric with a calibrated LLM judge
and treat it as **evaluation, not reward**; the blueprint's own calibration bar (≥50
human labels, report Cohen's κ, judge ≠ model under test, `:377-402`) has never been
met — no human labels exist. An uncalibrated judge as a reward signal optimises the
judge's biases. Two prerequisites gate all of this: **hidden test cases**, and **a
GPU-isolated sandbox**.

### 4.3 VLM image inputs

**Both — but the split is lopsided and favourable, and there is an asset already paid
for and idle.**

The served model in the SGLang config is **Qwen3.5-9B, a multimodal VL architecture**.
`docker-compose.sglang.yml:27-31` states it outright: *"multimodal VL arch — used
text-only, vision encoder idles … the vision encoder loads into VRAM but never
executes"*, and `:33-36` budgets **1–2 GB of VRAM to it**. You are already paying for
vision and getting nothing.

**It is blocked in the application layer, in one line.** `apps/api/src/main.py:527-529`:

```python
class ChatMessage(BaseModel):
    role: str
    content: str          # ← a list is rejected by Pydantic with 422
```

An OpenAI multimodal payload is `content: [{"type": "image_url", ...}]` — a list. It
fails validation before any handler runs. Downstream, `prepare_messages_hybrid`
(`main.py:714`) rebuilds string-only messages, and `schemas/chat.py:19-20` types
persisted content as `str`. The only `<input type="file">` in the web app is the profile
avatar (`ProfileClient.tsx:579-580`), which never reaches the chat endpoint.

**So: mostly a capability problem, already solved by the model choice, and gated by an
app-layer schema.** Cost is a Pydantic union type, a prompt-builder change, a frontend
composer, and image storage — days, not weeks, and **no GPU work**.

**Two caveats worth deciding on before building it [principle].** First, the four input
types you name are not one feature. Architecture diagrams and loss curves are genuine
vision. **Profiler output and error screenshots are text the user photographed** — OCR,
not understanding, and the right answer there is usually "paste the text instead", which
is cheaper and more accurate. Second, images are the largest realistic prompt-injection
surface this product would have: an "architecture diagram" can carry instruction text
addressed to the tutor. Whatever context-assembly the image feeds must be treated as
untrusted data.

**Recommendation:** enable image input for diagrams and curves; do not build screenshot
OCR; treat image-derived content as untrusted. It is a **model capability** already
bought — spend the days to stop wasting it, and no retraining is involved.

### 4.4 Personalisation is a ranking problem

**Confirmed. The model does not change when the catalog grows** — a ranker scores
candidates from a catalog, so growth changes its input, not its parameters. Retraining
a *ranker* on more interaction data is a normal periodic job and has nothing to do with
the tutor LLM. `docs/DESIGN.md:54-59` already specifies exactly this: two-stage
candidate-generation plus LambdaMART.

**But "no model change" is not the binding constraint, and I would push back on the
framing being the useful question.** Four things must change, and three are unbuilt:

1. **Concept tags on every new item.** Ranking is over concepts, not raw items. Adding a
   question without tagging it makes it unrankable. **And there is no concept to tag ML
   content with** — the taxonomy is 100% DSA and, as verified in §2.5, sits *exactly* on
   `MAX_CONCEPTS = 80`, so adding one raises `TaxonomyError`. This is the first thing
   that breaks.
2. **A join that does not exist.** The mastery pipeline runs on hashed Codeforces
   handles; `features/*` is imported nowhere under `apps/`. There is no code path from
   `gold_learner_concept_mastery` to `users.id`. Personalisation is currently computed
   for people who are not users, about problems that are not in the catalog.
3. **The ranker itself.** Specified, not built (§2.7).
4. **Cold start.** `docs/DATA_SOURCES.md:46-49` — *"VoidCode has **zero** real learner
   submissions today."* With 5 problems and no users there is nothing to rank and nothing
   to rank on.

**Recommendation:** yes, keep personalisation entirely out of the model. But the honest
statement of its status is *"blocked on a taxonomy that cannot accept ML concepts, a
missing warehouse-to-Postgres join, and having any users at all"* — not *"needs a
ranker."*

---

## 5. Update paths

### Tier 3 — application data

**Today, adding one question is a 4-file change and it is the worst path in the system.**

```
1. Edit apps/api/scripts/seed_problems.py         → PROBLEMS list
2. Edit apps/web/.../problems/[id]/page.tsx       → SLUG_MAP, totalProblems
3. Edit apps/web/.../ProblemPanel/ProblemTabs.tsx → hardcoded title list
4. Edit apps/web/.../VoidCodeAIPanel.tsx          → PROBLEM_TEACHING_TEMPLATES (optional)
5. Run the seeder; redeploy the web bundle
```

- **Recomputed downstream:** nothing today. In a built system: concept tags, then the
  candidate index.
- **Time:** ~30 min. **GPU:** none.
- **What breaks:** (a) steps 2–4 are silently skippable — the API is fine and the UI is
  wrong, which is how `mock-data.ts` hints already drifted from the seed script;
  (b) `PROBLEM_TEACHING_TEMPLATES` is *pedagogy in the client bundle*, so a teaching fix
  ships as a frontend deploy; (c) with no match there, the tutor improvises from the
  generic format instruction alone — quality is silently worse for every problem outside
  the hardcoded five; (d) `is_hidden: False` means new tests are handed to the client.

**Recommendation [design recommendation]:** make the catalog a versioned content bundle
(YAML per problem, reviewed in PRs) with a single loader, and delete all four frontend
copies. Until then, `docs/AI_ENGINEER_PLATFORM_ARCHITECTURE.md:212`'s
"curriculum-as-code" is the right target and nothing in the repo implements it.

### Tier 2 — retrieval

**NOT PRESENT. This path does not exist and must be built.** [design recommendation]
Target shape: a versioned document corpus with dated entries → chunk → embed → index;
tutor retrieves at request time and **cites**. Update = write the doc, re-index the
delta. Minutes, no GPU (embedding a few thousand chunks is CPU-feasible; a GPU makes it
faster, not necessary). What breaks: stale index versus corpus, retrieval returning
plausible-but-wrong context, and citation drift. Postgres + pgvector is the obvious
choice — the DB is already there and the corpus will be small.

### Tier 1 — model weights

Path as it exists: edit `llm/data/*.jsonl` → `train.py` (QLoRA) → `run_evaluation()` →
`merge_lora.py` → `quantize_awq.py` → redeploy.

- **Time:** hours to days. **GPU: required**, and per `docs/DECISIONS.md` D-001/D-005 the
  local 1× RTX 5060 Ti (15.93 GiB) is insufficient, so this is a cloud spend blocked on
  Q-008 (budget unanswered).
- **What breaks, in order of likelihood:** (1) the **system-prompt lock** — any edit to
  `FINETUNED_SYSTEM_PROMPT` invalidates the adapter, observed as 43-token garbage;
  (2) **truncation** — `llm/logs/training_20260310_213004.log` records *"Examples
  exceeding max_seq_length (1536): 1860"*, i.e. **100% of examples were truncated**,
  because the 10,509-char shared system prompt alone consumes ~2,600 tokens of a 1,536
  window; (3) the eval gate tests format compliance only, so a regression in *teaching
  quality* passes it; (4) both merge/quantize outputs are currently absent, so the
  pipeline's tail is unproven end-to-end.

### Tier 0 — prompts

Edit `llm/scripts/prompts.py`, restart the API. **Minutes, no GPU.** The cheapest and
most-used path. Breaks only if the adapter is loaded (§3 row 8) — otherwise the risk is
ordinary prompt regression, which the existing eval does partially catch.

---

## 6. Retraining triggers

**Retrain only when the required change is to *behaviour or output schema*, and only
after a Tier 0 attempt has measurably failed.** Everything else is a corpus or DB write.
Thresholds below are proposals **[design recommendation]** — the repo has no measured
baseline for most of them, which is itself the first thing to fix.

| # | Trigger | Threshold | Why measurable |
|---|---|---|---|
| T1 | **Format compliance regression** | Any mode below **95%** on `evaluate_debug_quality.py` over ≥100 live samples, sustained a week and not fixable in Tier 0 | Format is what the fine-tune buys. Note `explain` already scores **0/4** in `evaluation_results.json` — it is a Tier 0 bug, not a retrain trigger. |
| T2 | **A new task mode** | Any new sustained output schema (mock-interview roleplay) that fails a **2-week Tier 0 attempt** | The one legitimate Tier 1 reason. |
| T3 | **Pedagogical policy shift** | A change to hint-withholding strength that Tier 0 cannot hold — measured as **>10% leak rate** (full solutions given) after prompt revision | Leak rate is countable from logs and is the product's core promise. |
| T4 | **Behavioural drift on unseen content** | Format compliance on problems **outside the training 13** more than **10 points** below in-corpus | Directly measures the overfitting `ENGINEERING_RECOMMENDATION.md:91-98` warns of. **Cannot be measured today** — no such eval split exists. |
| T5 | **Base-model change** | Any swap of base model or serving stack | An adapter is bound to its base. A no-op decision, listed so it is not forgotten. |
| T6 | **Corpus health** | Not a trigger — a **gate**. Refuse to retrain while any problem exceeds **2%** of examples or near-duplicates exceed **5%** | Today: ~8% and 3,015 pairs. Retraining on this corpus would deepen the overfit it already has. |

**Explicit non-triggers.** New questions in any of the five areas. New papers. New CUDA
versions. New model families. Catalog growth of any size. Personalisation quality. Image
support. **None of these justify a training run.**

**Cadence: none.** Do not schedule retraining. **[principle]** A calendar cadence
manufactures reasons to retrain and, with a corpus this duplicated, each round narrows
the model onto its training problems — the documented failure mode at
`ENGINEERING_RECOMMENDATION.md:91-98`. Retrain on trigger only.

**Monitoring that would detect the need** (none of it exists today; this is the concrete
gap): per-mode format compliance sampled continuously from production; **leak rate**;
in-corpus versus out-of-corpus compliance split (T4); user-visible outcome signal —
solved-after-hint, which `FUTURE_IMPLEMENTATION.md:493-499` designs and the schema has no
`feedback_logs` table for. **Build T1 and T4 monitoring before the next training run**,
or you cannot tell whether it helped.

---

## 7. What this changes about the existing plan

**7.1 `FUTURE_IMPLEMENTATION.md` §6.2/§7.3 should be marked superseded.** It rules out
RAG — *"Parametric knowledge is sufficient for now"* (`:769`), *"there's nothing to
'retrieve'"* (`:710`) — on a premise Q-010 retired. That reasoning is sound for
LeetCode DSA and does not survive repositioning to ML/LLM/VLM/CUDA. It is the only
document that squarely contradicts a retrieval-first architecture, and it should be
annotated rather than deleted, since its reasoning is correct within its original scope.

**7.2 The `PROBLEM_TEACHING_TEMPLATES` pattern should be abandoned before it grows.**
Five problems of hand-written pedagogy in a React component
(`VoidCodeAIPanel.tsx:584-885`) is Tier 3 content in the worst possible tier — a client
bundle. It does not scale past a few dozen and it silently produces two quality classes
of problem. Move to the catalog.

**7.3 Loading the adapter is a bigger decision than it looks, and should be deliberate.**
Today `USE_SGLANG` serves a stock model, so all behaviour is Tier 0 — minutes to change.
Loading an adapter converts every prompt edit into a retraining job via the
`validate_prompt_match.py` lock. **My recommendation: stay prompt-engineered until a
trigger in §6 fires.** That is the continuation of `ENGINEERING_RECOMMENDATION.md`'s
existing ruling, not a reversal of it — and given the merged/AWQ artifacts are empty
shells, it is also the only path that currently runs.

**7.4 `docs/FINETUNING_BLUEPRINT.md` is the one spec shaped weights-first.** Its posture
is "new capability → new corpus → new fine-tune → promotion gate", which is right for
*capability* and wrong if applied to *content*. Add an explicit scope line: the blueprint
governs behaviour and schema, never subject-matter facts.

**7.5 Two things must be fixed before any ML content can be added at all.** The taxonomy
cap (`features/taxonomy.py:24`, `MAX_CONCEPTS = 80`, currently at exactly 80 — an ML
concept raises `TaxonomyError`), and hidden test cases (all 15 are `is_hidden: False`,
so there is no held-out grading signal for any reward or eval work).

**7.6 Correct the stale concept count** in `docs/specs/OPEN_QUESTIONS.md` and `MEMORY.md`: 80,
not 88. Q-010's argument is unaffected — it is stronger, since 80 is the hard ceiling.

**7.7 `docs/METRICS.md` is stale relative to `docs/DECISIONS.md`** — it still reports
103 problems / 94,850 learners / Spearman 0.9170, all superseded by D-009/D-010
(11,284 / 117,453 / 0.4864). Not a knowledge-architecture issue, but it will mislead
anyone sizing the ranking work in §4.4.

---

## 8. Open questions

Things I could not resolve from the repository.

1. **Is `PROBLEM_TEACHING_TEMPLATES` a stopgap or the intended pattern?** Whether every
   new question is expected to ship with hand-written scaffolding determines whether
   authoring cost is ~30 minutes or ~4 hours per item, and therefore whether the five
   content areas are reachable at all. Nothing states the intent.

2. **Does the adapter get loaded in production, ever?** The three backends imply three
   different knowledge architectures and the repo does not say which is the target.
   §7.3's recommendation depends on this.

3. **Why do `merged_model/` and `awq_model/` contain config but no weights?** Cleaned,
   gitignored, or a pipeline that never completed? It determines whether the Tier 1 tail
   is proven or merely written.

4. **Which of Q-010's three exits was chosen** — author ML content, reposition the copy,
   or waitlist? Every cost estimate in §5 assumes the first.

5. **Is `docs/AI_ENGINEER_PLATFORM_ARCHITECTURE.md` this product or a second one?** It
   self-flags as *"a different product"* (`:12-14`) yet is the only doc scoping the five
   areas and the only one specifying the GPU sandbox §4.2 needs.

6. **What is the intended source of ML questions?** The Codeforces warehouse cannot
   supply them — it has no problem statements, only ids, ratings and tags. Nothing
   describes an authoring pipeline.

7. ~~**The missing spec.**~~ **CORRECTED — this entry was wrong.** It claimed
   `VOIDCODE_PLATFORM_SPEC.md` and `VOIDCODE_TRAINING_SPEC.md` were NOT PRESENT and that
   every `spec §N` citation was unresolvable. Both files exist at the repository root
   (37 KB and 22 KB) and the citations resolve fine. They are **untracked in git**, which
   is what the original search actually established and what the entry should have said —
   so they are absent from a fresh clone but present for anyone with the working tree.
   Committing them is a one-line `git add`, deliberately left to the operator because the
   working tree currently carries substantial unrelated changes and commit scoping is
   theirs to decide.

8. **Budget (Q-008, open).** Tier 1 needs rented GPUs; no ceiling is recorded. Tier 2 and
   Tier 3 need none, which is a further argument for sequencing them first.
