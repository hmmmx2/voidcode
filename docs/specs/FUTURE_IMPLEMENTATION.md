# VoidCode AI — Future Implementation Roadmap

> Enhancements and tooling recommendations for the LLM subsystem, training pipeline, evaluation framework, and production infrastructure.

---

## 1. Training Pipeline Improvements

### 1.1 Unsloth — Faster Fine-Tuning

**Problem:** Current QLoRA training on RTX 5060 Ti (16 GB VRAM) is slow and memory-constrained. HuggingFace + PEFT + BitsAndBytes stack has significant Python overhead.

**Solution:** [Unsloth](https://github.com/unslothai/unsloth) replaces the training stack with custom Triton kernels that are 2–5× faster and use 60–80% less VRAM. It supports Qwen 2.5 natively.

| Metric | Current (HF + PEFT) | With Unsloth |
|--------|---------------------|-------------|
| Training speed | ~1× baseline | 2–5× faster |
| VRAM usage | ~8 GB | ~3–5 GB |
| Max trainable model | 7B (tight) | 7B (comfortable) or 14B (possible) |

**Migration effort:** Low — Unsloth wraps the same `SFTTrainer` API:

```python
# Before
from transformers import AutoModelForCausalLM
model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-7B-Instruct", ...)

# After
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct",
    max_seq_length=2048,
    load_in_4bit=True,
)
model = FastLanguageModel.get_peft_model(model, r=16, lora_alpha=32, ...)
```

**Additional benefits:**
- Native GGUF/AWQ export (skip separate `merge_lora.py` + `quantize_awq.py` steps)
- Reduced training iteration cycle → enables more hyperparameter experiments
- Supports RoPE scaling for extended context (up to 4× base context)

---

### 1.2 MLflow — Experiment Tracking & Model Registry

**Problem:** No structured way to track training runs. Comparing hyperparameter configs (LoRA rank, learning rate, dataset mix, epochs) requires manual log inspection.

**Solution:** [MLflow](https://mlflow.org/) provides experiment tracking, artifact versioning, and a model registry — all with a local UI (no cloud account needed).

**Integration with current pipeline:**

```python
# llm/scripts/train.py
import mlflow
from mlflow.transformers import log_model

mlflow.set_tracking_uri("file:///mnt/c/.../voidcode_ai/mlruns")
mlflow.set_experiment("qwen25-voidcode-ai-finetune")

with mlflow.start_run(run_name="r16-alpha32-lr1e4-epoch1"):
    mlflow.log_params({
        "lora_r": 16, "lora_alpha": 32, "lr": 1e-4,
        "epochs": 1, "batch_size": 32, "dataset_size": 1000,
        "teaching_pct": 0.45, "debug_pct": 0.30,
    })

    trainer = SFTTrainer(model, ..., callbacks=[MLflowCallback()])
    trainer.train()

    mlflow.log_metrics({
        "final_loss": trainer.state.log_history[-1]["loss"],
        "teaching_accuracy": evaluate_teaching_mode(model),
        "debug_accuracy": evaluate_debug_mode(model),
    })

    mlflow.log_artifact("llm/outputs/final_model/")
    mlflow.log_artifact("llm/outputs/awq_model/")
```

**Key features:**
- **Experiment comparison UI** — `mlflow ui` at `http://localhost:5000`
- **Artifact tracking** — link LoRA adapters and AWQ models to specific runs
- **Model registry** — tag production models vs experiments (e.g., `champion` vs `challenger`)
- **Reproducibility** — every run logs the exact config, code version, and dataset used

---

### 1.3 Synthetic Data Generation with LLM-as-Judge

**Problem:** Current training dataset is ~1,000 manually curated examples. Scaling to 5,000–10,000 requires automation while maintaining quality.

**Solution:** Use a stronger model (GPT-4o / Claude / Qwen 72B API) to:
1. Generate candidate training examples across more problems and edge cases
2. Use LLM-as-Judge to score and filter generated examples before inclusion

**Pipeline:**

```
Seed problems (LeetCode / custom)
     │
     ▼
GPT-4o generates candidate examples          ← diverse prompts + variations
     │
     ▼
LLM-as-Judge (GPT-4o or Claude)              ← scores format compliance,
     │  Score ≥ 4/5?                              pedagogical quality,
     │  ├── YES → add to training set              code correctness
     │  └── NO  → discard or flag for review
     │
     ▼
validate_and_test.py                          ← existing format validator
     │
     ▼
Augmented training dataset (5K+ examples)
```

**Quality dimensions to score:**
- Format compliance (correct `[EXPLAIN]→[TEMPLATE]→[GUIDE]` tags)
- Pedagogical value (guides without giving away answers)
- Code correctness (compilable template, correct algorithm)
- Blank placement (meaningful blanks, not trivial)
- Language consistency (matches requested programming language)

---

## 2. Evaluation & Quality Assurance

### 2.1 A/B Testing for LLM Responses

**Problem:** No way to measure whether model changes actually improve student learning outcomes. Currently relies on manual spot-checking.

**Solution:** Implement A/B testing infrastructure that routes a percentage of requests to a challenger model.

**Architecture:**

```
POST /v1/chat/completions
     │
     ▼
┌─────────────────────────────────┐
│      A/B Router                 │
│                                 │
│  experiment_id = request.user + │
│    request.problem + hash       │
│                                 │
│  if hash(experiment_id) % 100   │
│       < traffic_split:          │
│       → model_b (challenger)    │
│  else:                          │
│       → model_a (champion)      │
│                                 │
│  log: { user, problem, model,   │
│         response, latency,      │
│         timestamp }             │
└─────────────────────────────────┘
     │
     ▼
   PostgreSQL: ab_test_logs table
```

**Metrics to compare:**
| Metric | How to measure |
|--------|---------------|
| Format compliance | Regex check: does response have required tags? |
| Blank quality | Count `____` in template, verify they're in meaningful positions |
| Response latency | Time to first token, total generation time |
| Code correctness | Submit generated template to Judge0 (with blanks filled by answer key) |
| Student engagement | Click-through to hints, time spent on problem after receiving response |
| Student success rate | Did the student eventually submit a correct solution? |

**Tools:** Can use [Evidently AI](https://www.evidentlyai.com/) or [Statsig](https://statsig.com/) for statistical significance testing, or build a lightweight custom solution using PostgreSQL + a dashboard.

---

### 2.2 LLM Guardrails & Output Validation

**Problem:** Fine-tuned model occasionally produces malformed output (e.g., missing `[TEMPLATE]` section, code in wrong language, incomplete blanks).

**Solution:** Add a structured validation layer between the LLM output and the frontend.

**Implementation:**

```python
# apps/api/src/services/response_validator.py

class ResponseValidator:
    def validate_teaching(self, response: str) -> ValidationResult:
        checks = [
            has_section("[EXPLAIN]"),
            has_section("[TEMPLATE]"),
            has_section("[GUIDE]"),
            has_blanks_in_template(min_count=2),
            code_language_matches(requested_language),
            no_complete_solution_leaked(),
        ]
        return ValidationResult(passed=all(checks), issues=[...])

    def validate_debug(self, response: str) -> ValidationResult:
        checks = [
            has_bug_markers("🔴", "🟢"),
            references_specific_lines(),
            does_not_give_direct_fix(),
        ]
        return ValidationResult(passed=all(checks), issues=[...])
```

**On validation failure:**
1. Log the failure with full response for analysis
2. Optionally retry with a slightly higher temperature
3. Return a graceful fallback message to the student

---

### 2.3 Automated Evaluation Suite (Evals)

**Problem:** No automated way to regression-test model quality after retraining. Changes might improve one mode but degrade another.

**Solution:** Build an evaluation suite that runs after every training run.

**Framework options:**
- [LM Evaluation Harness](https://github.com/EleutherAI/lm-evaluation-harness) — standard benchmark framework
- [promptfoo](https://github.com/promptfoo/promptfoo) — prompt-level evaluation with assertion-based tests
- Custom eval suite — most practical for the structured output format

**Recommended eval structure:**

```yaml
# llm/evals/eval_config.yaml
test_suites:
  teaching_mode:
    dataset: llm/evals/teaching_gold.jsonl
    metrics:
      - format_compliance    # [EXPLAIN]→[TEMPLATE]→[GUIDE] present
      - blank_count          # ≥ 3 blanks in template
      - algorithm_correct    # correct algo for the problem
      - no_solution_leak     # template doesn't contain complete code
    pass_threshold: 0.90

  debug_mode:
    dataset: llm/evals/debug_gold.jsonl
    metrics:
      - bug_identified       # correct line numbers flagged
      - marker_format        # 🔴/🟢 present
      - no_direct_fix        # doesn't reveal the answer
    pass_threshold: 0.85
```

**Integration with MLflow:**

```python
eval_results = run_eval_suite(model, "llm/evals/eval_config.yaml")
mlflow.log_metrics({
    "teaching_format_compliance": eval_results["teaching"]["format_compliance"],
    "teaching_blank_count": eval_results["teaching"]["blank_count"],
    "debug_bug_identified": eval_results["debug"]["bug_identified"],
})
```

---

## 3. Inference & Serving Improvements

### 3.1 Speculative Decoding

**Problem:** vLLM generates ~80–120 tok/s, but TEACHING responses (~1,500 tokens) still take 15–25 seconds.

**Solution:** Speculative decoding uses a small draft model (e.g., Qwen 2.5 0.5B) to propose N tokens, then the main 7B model verifies them in a single forward pass. Accepted tokens are "free" — rejected ones fall back to normal generation.

**Expected speedup:** 1.5–2.5× for structured output (high acceptance rate due to predictable format).

**vLLM native support:**

```python
# vllm_engine.py
engine_args = AsyncEngineArgs(
    model="~/voidcode_models/awq_model",
    speculative_model="Qwen/Qwen2.5-0.5B-Instruct",
    num_speculative_tokens=5,
    # ... existing args
)
```

**Consideration:** Requires additional ~1 GB VRAM for the draft model. On a 16 GB GPU running the 7B model at 90% utilization, this may require reducing `gpu_memory_utilization` to 0.85.

---

### 3.2 Structured Output / Guided Generation

**Problem:** Even with fine-tuning, the model occasionally deviates from the expected format. Temperature adjustments are a blunt instrument.

**Solution:** Use constrained decoding to guarantee structural compliance.

**Options:**
- [Outlines](https://github.com/dottxt-ai/outlines) — regex/grammar-based constrained generation
- vLLM's built-in `guided_decoding` with JSON schema or regex

**Example for TEACHING mode:**

```python
from outlines import generate, models

teaching_regex = r"\[EXPLAIN\]\n.+\n\n\[TEMPLATE\]\n```\w+\n.+\n```\n\n\[GUIDE\]\n.+"

generator = generate.regex(model, teaching_regex)
response = generator(prompt)  # guaranteed to match format
```

**vLLM native approach:**

```python
# In the submission payload
sampling_params = SamplingParams(
    guided_decoding=GuidedDecodingParams(
        regex=r"\[EXPLAIN\][\s\S]+\[TEMPLATE\][\s\S]+\[GUIDE\][\s\S]+"
    )
)
```

---

### 3.3 Response Caching with Semantic Similarity

**Problem:** Many students ask the same questions for the same problems (e.g., "How do I solve Two Sum?"). Each generates a full LLM inference pass.

**Solution:** Cache responses keyed by semantic similarity, not exact string match.

**Architecture:**

```
User query: "How to solve two sum problem"
     │
     ▼
Embed query → sentence-transformers (384-dim)
     │
     ▼
Search vector cache (PostgreSQL pgvector / Redis)
     │
     ├── Similarity ≥ 0.95 → return cached response (0 GPU cost)
     ├── Similarity 0.85–0.95 → return cached, log for review
     └── Similarity < 0.85 → generate new response, cache it
```

**Tools:**
- [pgvector](https://github.com/pgvector/pgvector) extension for PostgreSQL (already in the stack)
- [sentence-transformers](https://www.sbert.net/) for embedding (lightweight, ~100 MB model)

**Expected impact:** 30–50% cache hit rate for popular LeetCode problems → significant GPU savings.

---

### 3.4 vLLM Multi-LoRA Serving (Hot-Swappable Models)

**Problem:** Currently, LoRA is pre-merged into the AWQ model. Testing different adapter versions requires rebuilding the entire AWQ model (merge → quantize → deploy).

**Solution:** vLLM supports runtime LoRA loading via `LoRARequest`. This enables serving multiple adapter versions simultaneously for A/B testing.

**Architecture:**

```python
# vllm_engine.py — with multi-LoRA
engine_args = AsyncEngineArgs(
    model="Qwen/Qwen2.5-7B-Instruct",    # base model (not merged)
    quantization="awq",
    enable_lora=True,
    max_loras=3,
    max_lora_rank=16,
)

# Per-request LoRA selection
from vllm.lora.request import LoRARequest

result = engine.generate(
    prompt,
    sampling_params,
    lora_request=LoRARequest("v2-teaching-improved", 1, "path/to/adapter_v2/")
)
```

**Trade-off:** Runtime LoRA adds ~5–10% latency per request due to separate GEMM kernels. Only use for experimentation, not production serving.

---

## 4. Observability & Monitoring

### 4.1 LLM Observability with LangSmith / Langfuse

**Problem:** No visibility into inference quality in production. Don't know which prompts cause failures or what percentage of responses are well-formatted.

**Solution:** [Langfuse](https://langfuse.com/) (open-source, self-hosted) or [LangSmith](https://smith.langchain.com/) (managed) for LLM observability.

**What to track:**

| Signal | Purpose |
|--------|---------|
| Input prompt (full, with system prompt) | Debug specific failures |
| Output response (full) | Quality analysis |
| Mode detected | Distribution of mode usage |
| Token counts (prompt + completion) | Cost tracking per mode |
| Latency (TTFT, total) | Performance monitoring |
| Format compliance score | Quality regression detection |
| User feedback (thumbs up/down) | Ground truth quality signal |

**Langfuse integration:**

```python
from langfuse import Langfuse

langfuse = Langfuse()

trace = langfuse.trace(name="chat-completion", user_id=user_id)
span = trace.span(name="detect-mode", input=user_message)
span.end(output={"mode": detected_mode})

generation = trace.generation(
    name="vllm-generate",
    model="qwen2.5-7b-awq",
    input=formatted_prompt,
    output=response_text,
    usage={"prompt_tokens": prompt_tokens, "completion_tokens": comp_tokens},
)
```

---

### 4.2 Prometheus + Grafana Metrics

**Problem:** No real-time dashboards for system health, inference throughput, or GPU utilization.

**Solution:** vLLM already exposes a Prometheus metrics endpoint. Wire it to Grafana for dashboards.

**Key metrics to surface:**
- `vllm:num_requests_running` — active requests
- `vllm:num_requests_waiting` — queue depth
- `vllm:gpu_cache_usage_perc` — KV cache utilization
- `vllm:avg_generation_throughput_toks_per_s` — throughput
- Custom: mode distribution, format compliance rate, error rate

**Docker Compose additions:**

```yaml
# docker-compose.yml
prometheus:
  image: prom/prometheus:latest
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
  ports:
    - "9090:9090"

grafana:
  image: grafana/grafana:latest
  ports:
    - "3001:3000"
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
```

---

## 5. Advanced Training Techniques

### 5.1 DPO (Direct Preference Optimization)

**Problem:** SFT (supervised fine-tuning) teaches the model one "correct" response per example. It doesn't teach it to prefer good responses over bad ones.

**Solution:** DPO aligns the model using preference pairs (chosen vs rejected). This is particularly valuable for:
- Preferring pedagogical hints over direct solutions
- Preferring concise explanations over verbose ones
- Preferring correct algorithm selection over similar-but-wrong approaches

**Data format:**

```json
{
  "prompt": "How do I solve Two Sum?",
  "chosen": "[EXPLAIN]\nUse a hash map...\n[TEMPLATE]\ndef twoSum(nums, target):\n    seen = ____\n    ...",
  "rejected": "[EXPLAIN]\nHere's the complete solution:\ndef twoSum(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        ..."
}
```

**Framework:** TRL's `DPOTrainer` (already in the dependency tree) or Unsloth's DPO support.

---

### 5.2 RLHF Lite — Student Feedback Loop

**Problem:** No mechanism to learn from actual student interactions. The model is trained once and deployed statically.

**Solution:** Collect implicit and explicit feedback signals, then use them for periodic DPO/RLHF updates.

**Feedback signals:**

| Signal | Type | Collection |
|--------|------|-----------|
| 👍/👎 button | Explicit | Frontend UI component |
| Student solved after hint | Implicit | Judge0 submission result after AI interaction |
| Student asked for clarification | Implicit | Follow-up message detected |
| Student copied template | Implicit | Code editor content matches template structure |
| Time to solve after hint | Implicit | Timestamp between AI response and correct submission |

**Pipeline:**

```
Student interactions → PostgreSQL (feedback_logs table)
     │
     ▼ (weekly batch)
Build preference pairs from feedback
     │
     ▼
DPO training (on recent feedback data)
     │
     ▼
A/B test new model vs current champion
     │
     ▼
Promote if metrics improve → new champion model
```

---

### 5.3 Curriculum-Aware Training

**Problem:** Model doesn't adapt its teaching style based on problem difficulty or student skill level.

**Solution:** Include difficulty metadata in training examples and system prompts so the model adjusts its teaching approach.

**Enhanced system prompt concept:**

```
Student skill level: intermediate
Problem difficulty: hard
Problem topics: dynamic programming, memoization

Adjust your teaching style:
- For intermediate students: use more technical terminology, fewer basic explanations
- For hard problems: break down into sub-problems, show the recurrence relation
- Use analogies sparingly (save for beginners)
```

**Training data enhancement:** Generate difficulty-stratified examples where the same problem gets different teaching approaches based on student level.

---

## 6. Infrastructure Improvements

### 6.1 Model Serving on Cloud (Scalable Deployment)

**Problem:** Currently limited to single GPU on one machine. Can't scale to multiple concurrent users.

**Solution options (ordered by effort):**

| Option | Cost | Scalability | Effort |
|--------|------|-------------|--------|
| [RunPod Serverless](https://www.runpod.io/) | ~$0.0002/s GPU | Auto-scale to demand | Low |
| [Modal](https://modal.com/) | Pay-per-second GPU | Auto-scale, cold start ~30s | Low |
| [Together.ai](https://together.ai/) fine-tune API | ~$0.20/1M tokens | Managed, no infra | Lowest |
| Self-hosted Kubernetes + vLLM | GPU instance cost | Full control | High |

**Recommended path:** Start with Modal or RunPod Serverless for external sharing. Keep local vLLM for development.

---

### 6.2 RAG (Retrieval-Augmented Generation) for Problem Context

**Problem:** The model relies entirely on its training data and parametric knowledge. It can't reference specific course materials, lecture notes, or custom problem sets.

**Solution:** Add a RAG layer that retrieves relevant context before generating responses.

> **Assessment:** Full RAG is **not needed today** — the model's parametric knowledge of algorithms (from 18T-token pre-training) is sufficient for standard LeetCode-style problems. The highest-value RAG use case is a **common mistake pattern database** (see Section 7.3).

**Architecture (when needed):**

```
User question + current problem
     │
     ▼
Embed query → sentence-transformers
     │
     ▼
Search vector store:
  - Common mistake patterns (highest value)
  - Problem editorial database
  - Course lecture notes (chunked)
  - Grading rubrics
     │
     ▼
Top-K relevant chunks → inject into system prompt
     │
     ▼
LLM generates response with grounded context
```

**Tools:**
- [LlamaIndex](https://www.llamaindex.ai/) for RAG orchestration (preferred — lighter than LangChain, better for focused retrieval)
- pgvector (already in PostgreSQL) for vector storage
- `all-MiniLM-L6-v2` for embeddings (~80 MB, runs on CPU)

---

### 6.3 CI/CD for Model Training

**Problem:** Training, evaluation, and deployment are manual processes. No automated pipeline from data → trained model → evaluated → deployed.

**Solution:** Automate the full lifecycle with GitHub Actions or a simple CI pipeline.

**Pipeline:**

```
Git push (new training data or config)
     │
     ▼
CI Job 1: Validate data
  - validate_and_test.py
  - Format checks, duplicate detection
     │
     ▼
CI Job 2: Train model (GPU runner)
  - Unsloth + SFTTrainer
  - MLflow logging
     │
     ▼
CI Job 3: Evaluate
  - Run eval suite against gold set
  - Compare metrics to current champion
  - Auto-reject if regression detected
     │
     ▼
CI Job 4: deploy (if metrics pass)
  - Merge LoRA → Quantize AWQ
  - Push to model registry
  - Stage for A/B testing
```

---

## 7. Architecture Decision Rationale

> Professional assessment of common LLM tools and techniques in the context of
> this project's specific architecture (fine-tuned Qwen 2.5 7B + vLLM + 5-mode
> detection system).

### 7.1 LangChain / LangGraph — Not Recommended

**Verdict: ⛔ Skip — the current architecture is cleaner without it.**

The existing codebase already handles everything LangChain would provide, with
less abstraction overhead:

| Current Code | LangChain Equivalent | Why Ours Is Better |
|---|---|---|
| `detect_mode()` — 5 priority rules | `RouterChain` | Zero overhead, fully debuggable, no framework dependency |
| `get_system_prompt(mode)` | `PromptTemplate` | Simpler, does exactly what's needed |
| `vllm_engine.py` — direct `AsyncLLMEngine` | `ChatVLLM` wrapper | Full control over PagedAttention, CUDA graphs, SSE |
| `prepare_messages_hybrid()` | `RunnableSequence` | Plain function — easy to read, test, modify |

**LangChain adds value when** you're chaining multiple LLM calls in sequence,
integrating 5+ external tools, or prototyping quickly without caring about
performance. This project has **one model, one call per request, structured
output via fine-tuning**.

**LangGraph** is for **agentic workflows** — multi-step reasoning where the
LLM decides which tool to call, loops back on itself, and maintains a state
machine. The VoidCode AI is a **single-turn generator** (user asks → model
generates → done). LangGraph would be massive overkill.

**When to reconsider:**
- If an "intelligent tutor agent" is built that autonomously: runs the student's
  code → analyses the error → checks constraints → generates a tailored hint →
  verifies the hint — *that's* a multi-step agent loop where LangGraph helps.
  But that's Phase 4+ territory.

---

### 7.2 Prompting Strategy — Fine-Tuning Supersedes Few-Shot

**Verdict: Current approach (zero-shot on fine-tuned model) is optimal.**

| Strategy | What It Does | Applies Here? |
|----------|-------------|---------------|
| **Zero-shot** | Just instruction, no examples | ✅ EXPLAIN / GENERAL modes — base model + system prompt is sufficient |
| **One-shot** | 1 example in the prompt | ❌ Not needed — fine-tuning already taught the format |
| **Few-shot** | 2–5 examples in prompt | ❌ Not needed — wastes 500–1000 tokens per request |

**Why few-shot is wrong for this architecture:**

1. **The model already knows the format.** It was trained on ~1,000 examples of
   `[EXPLAIN]→[TEMPLATE]→[GUIDE]`. Putting examples in the prompt is redundant
   — like showing a trained chef a recipe they've already memorised.

2. **Token budget is expensive.** Each few-shot example costs 200–400 tokens.
   On the 8192 max context, that's 5–10% of the budget wasted on examples the
   model doesn't need.

3. **The system prompt already works.** `FINETUNED_SYSTEM_PROMPT` contains the
   format rules. Fine-tuning taught the model to *follow* those rules.

**When few-shot IS useful:**
- Calling an external model (GPT-4o API) that hasn't been fine-tuned
- Prototyping a new mode before committing to fine-tuning data
- In the **eval suite** — use few-shot prompts for the LLM-as-Judge evaluator

---

### 7.3 RAG — Not Now, But Plan the Right Use Case

**Verdict: ⏳ Not needed today. When implemented, start with mistake patterns.**

The model generates responses based on: (1) the problem description passed by
the frontend, (2) the student's code in the message, and (3) parametric
knowledge of algorithms from 18T-token pre-training. That's self-contained —
there's nothing to "retrieve."

**When RAG becomes valuable (ordered by impact):**

| Use Case | Why It Helps | Priority |
|----------|-------------|----------|
| **Common mistake database** | "47 students made this exact error on Two Sum" → targeted hints | 🟡 High — strongest use case |
| Custom problem editorials | Instructor-written solution guides the model should follow | Medium |
| Course lecture materials | Reference specific slides or textbook chapters | Medium — only if integrated with courseware |
| Updated algorithm knowledge | New techniques, language features | Low — Qwen 2.5 already covers this |

**Recommended first RAG target — Mistake Pattern Database:**

```
When a student debugs a problem and you detect the bug type, log it:

{problem: "two_sum", mistake: "forgot_to_return", frequency: 47,
 hint: "Check your function exit path — are you returning in all cases?"}

When a new student hits the same problem:
  1. Retrieve top-3 common mistakes for this problem
  2. Inject into the system prompt as context
  3. Model generates a more targeted, experience-informed hint
```

This is lightweight RAG with high pedagogical impact. Use pgvector (already
in the stack) — no need for a full RAG framework.

**Tool recommendation for RAG (when ready):**
- Use [LlamaIndex](https://www.llamaindex.ai/) over LangChain — lighter,
  purpose-built for retrieval, less abstraction overhead
- pgvector for storage (already in PostgreSQL)
- `all-MiniLM-L6-v2` for embeddings (~80 MB, CPU-friendly)

---

## 8. Priority Matrix

| Enhancement | Impact | Effort | Priority | Rationale |
|-------------|--------|--------|----------|----------|
| **Unsloth** | High | Low | 🔴 P0 | Drop-in replacement, 2–5× faster training |
| **MLflow** | High | Low | 🔴 P0 | Essential for comparing training experiments |
| **Response Validation** | Medium | Low | 🔴 P0 | Simple regex checker, catches malformed output |
| **Automated Evals** | High | Medium | 🟡 P1 | Prevents regressions across retraining cycles |
| **Langfuse Observability** | Medium | Low | 🟡 P1 | Know which prompts cause bad outputs in prod |
| **A/B Testing** | High | Medium | 🟡 P1 | Data-driven model iteration decisions |
| **Synthetic Data Generation** | High | Medium | 🟡 P1 | Scale from 1K to 5K+ training examples |
| **DPO Alignment** | High | Medium | 🟢 P2 | Preference learning (hints > solutions) |
| **Speculative Decoding** | Medium | Low | 🟢 P2 | 1.5–2× inference speedup |
| **Guided Generation** | Medium | Low | 🟢 P2 | Constrained decoding for format guarantees |
| **Semantic Caching** | Medium | Medium | 🟢 P2 | 30–50% GPU cost reduction |
| **RAG (Mistake Patterns)** | Medium | Medium | 🟢 P2 | Highest-value RAG use case |
| **Student Feedback Loop** | High | High | 🔵 P3 | Requires sufficient interaction data first |
| **Cloud Deployment** | High | Medium | 🔵 P3 | Only when scaling beyond single GPU |
| **CI/CD Pipeline** | Medium | High | 🔵 P3 | Automation — not critical at current scale |
| **Curriculum-Aware Training** | Medium | High | 🔵 P3 | Personalisation — needs difficulty metadata |
| ~~LangChain / LangGraph~~ | — | — | ⛔ Skip | Current architecture is cleaner without it |
| ~~Few-shot Prompting~~ | — | — | ⛔ Skip | Fine-tuning already handles format learning |
| ~~Full RAG (lectures)~~ | Low | High | ⛔ Skip | Parametric knowledge is sufficient for now |

---

## 9. Recommended Implementation Order

```
Phase 1 — Immediate (1–2 weeks)
├── Unsloth integration (replace training stack)
├── MLflow experiment tracking
├── Response validation layer (regex-based, lightweight)
└── Basic automated eval suite (50–100 gold examples per mode)

Phase 2 — Short-term (2–4 weeks)
├── Langfuse / observability setup
├── Synthetic data generation pipeline (LLM-as-Judge)
├── A/B testing infrastructure
└── Prometheus + Grafana dashboards

Phase 3 — Medium-term (1–2 months)
├── DPO alignment training
├── Speculative decoding (Qwen 2.5 0.5B draft model)
├── Guided generation (Outlines / vLLM constrained decoding)
├── Semantic response caching (pgvector)
└── RAG: mistake pattern database (first RAG use case)

Phase 4 — Long-term (2–4 months)
├── Student feedback loop (RLHF lite via DPO)
├── Cloud deployment (Modal / RunPod Serverless)
├── CI/CD for model training
├── Curriculum-aware personalisation
└── RAG: course materials (only if integrated with courseware)

Not Planned
├── LangChain / LangGraph (current architecture is simpler and faster)
├── Few-shot prompting (fine-tuning handles format learning)
└── Multi-LoRA serving (merge-before-quantize is better for production)
```
