"""Migrate the five `*_content.py` scripts into one YAML file per item.

Run:  python scripts/migrate_content_to_yaml.py [--write]

Dry run by default. Nothing is deleted — the source scripts stay until the API reads from the
loader, because a migration that removes its own source before the consumer has switched is a
migration you cannot check.

THE CONCEPT TAGS ARE THE RISK, NOT THE MECHANICS
--------------------------------------------------
Moving dicts into YAML is mechanical. Assigning taxonomy concepts is not, and no item has ever had
a concept tag, so there is nothing to copy — every tag here is *inferred*.

A wrong tag is worse than no tag. Mastery attribution divides credit across an item's concepts, so
a mis-tagged item quietly corrupts every learner vector that touches it, and ranking then
recommends against a weakness the learner does not have. That failure is invisible: the numbers
look fine, they are simply about the wrong thing.

So every inferred tag carries `review_needed: true` and `inferred_concepts: true`. The loader
accepts them — they are structurally valid — but the flag is the honest record that a human has
not confirmed them, and `scripts/audit_catalog_coverage.py` should keep treating them as weak
evidence until it is cleared.

Matching is on the slug and title only, deliberately, not the description. Descriptions mention
neighbouring concepts constantly — an item about softmax will discuss numerical stability without
teaching it — and matching on prose produced five or six tags per item in testing, every one
plausible and most of them wrong.
"""
from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))

OUT = ROOT / "content" / "problems"

#: Keyword -> concept id. Ordered most specific first: "flash" must win over "attention", or
#: FlashAttention items get tagged as generic attention and the IO-aware concept stays bare.
RULES: list[tuple[str, str]] = [
    ("flashattention", "flash_attention"), ("flash", "flash_attention"),
    ("kv-cache", "kv_cache"), ("kv_cache", "kv_cache"), ("paged", "paged_attention"),
    ("speculative", "speculative_decoding"), ("continuous-batch", "continuous_batching"),
    ("multi-head", "multi_head_attention"), ("mha", "multi_head_attention"),
    ("scaled-dot", "attention_scaled_dot"), ("attention", "attention_scaled_dot"),
    ("rope", "positional_encoding"), ("positional", "positional_encoding"),
    ("bpe", "tokenization"), ("subword", "tokenization"), ("token", "tokenization"),
    ("embedding", "embeddings"), ("perplexity", "sampling_decoding"),
    ("top-k", "sampling_decoding"), ("top-p", "sampling_decoding"), ("decode", "sampling_decoding"),
    ("moe", "moe_routing"), ("expert", "moe_routing"),
    ("swiglu", "feedforward_blocks"), ("glu", "feedforward_blocks"), ("ffn", "feedforward_blocks"),
    ("layernorm", "normalization_layers"), ("batchnorm", "normalization_layers"),
    ("rmsnorm", "normalization_layers"), ("norm", "normalization_layers"),
    ("softmax", "numerical_stability"), ("logsumexp", "numerical_stability"),
    ("stable", "numerical_stability"), ("fp16", "mixed_precision"), ("bf16", "mixed_precision"),
    ("precision", "mixed_precision"), ("quantiz", "quantization_basics"),
    ("awq", "quantization_schemes"), ("gptq", "quantization_schemes"),
    ("lora", "peft_lora"), ("grpo", "rlhf_grpo"), ("ppo", "rlhf_grpo"), ("rlhf", "rlhf_grpo"),
    ("zero", "zero_sharding"), ("shard", "zero_sharding"), ("checkpoint", "gradient_checkpointing"),
    ("pipeline", "pipeline_parallel"), ("tensor-parallel", "tensor_parallel"),
    ("all-reduce", "collective_ops"), ("nccl", "collective_ops"),
    ("activation-memory", "memory_accounting"), ("memory-budget", "memory_accounting"),
    ("coalesc", "memory_coalescing"), ("occupancy", "occupancy"), ("warp", "warp_divergence"),
    ("thread", "gpu_execution_model"), ("roofline", "roofline_analysis"),
    ("arithmetic-intensity", "roofline_analysis"), ("triton", "triton_basics"),
    ("reduction", "reduction_kernels"), ("tiled", "tiled_matmul"), ("fusion", "kernel_fusion"),
    ("vit", "vision_transformer"), ("patch", "vision_transformer"), ("clip", "contrastive_pretraining"),
    ("modality", "projection_layers"), ("iou", "image_preprocessing"),
    ("interpolate", "image_preprocessing"), ("conv", "convolutions"),
    ("backprop", "backpropagation"), ("gradient", "backpropagation"), ("autograd", "autograd"),
    ("sgd", "optimizers_sgd"), ("adam", "optimizers_adaptive"), ("warmup", "lr_scheduling"),
    ("schedule", "lr_scheduling"), ("dropout", "regularization"), ("init", "initialization"),
    ("einsum", "einsum_notation"), ("broadcast", "tensors_and_shapes"),
    ("matrix", "linear_layers"), ("matmul", "linear_layers"), ("linear", "linear_layers"),
    ("cross-entropy", "loss_functions"), ("loss", "loss_functions"), ("kl", "loss_functions"),
    ("auc", "loss_functions"), ("bayes", "loss_functions"),
]

#: Used only when no rule matches. Deliberately coarse: a wrong-but-plausible specific tag is worse
#: than an honestly vague one, because it looks reviewed.
FALLBACK = {
    "CUDA": "gpu_execution_model", "LLM": "transformer_block", "VLM": "vlm_architecture",
    "DL": "linear_layers", "ML": "tensors_and_shapes", "PyTorch": "tensors_and_shapes",
    "TensorFlow": "tensors_and_shapes", "Systems": "memory_accounting",
}


def infer_concepts(slug: str, title: str, categories: list[str], valid: set[str]) -> list[str]:
    hay = f"{slug} {title}".lower()
    found: list[str] = []
    for keyword, concept in RULES:
        if keyword in hay and concept not in found and concept in valid:
            found.append(concept)
        if len(found) == 3:               # leave headroom under the cap of 4 for a human addition
            break
    if not found:
        for cat in categories:
            cid = FALLBACK.get(cat)
            if cid in valid:
                found.append(cid)
                break
    return found or ["tensors_and_shapes"]


def collect() -> list[dict[str, Any]]:
    """Pull items out of the five scripts. `problem_content.PROBLEMS` already absorbs
    `GPU_PROBLEMS` via `PROBLEMS += GPU_PROBLEMS`, so that module is not read separately —
    reading both would duplicate four items and the slug-uniqueness check would reject the load."""
    out: list[dict[str, Any]] = []
    # `source_kind` records which script an item came from. The three seeders each want their own subset,
    # and without this the only way to split 94 mixed items is a slug-prefix guess — which would
    # silently mis-route the first item whose slug convention drifts, and mis-routing means an item
    # seeded into the wrong table or not at all.
    for module, attr, kind in (
            ("scripts.interview_problems", "INTERVIEW_PROBLEMS", "interview_problem"),
            ("scripts.interview_content", "INTERVIEW_QUESTIONS", "interview_question"),
            ("scripts.problem_content", "PROBLEMS", "problem"),
            ("scripts.paper_content", "PAPERS", "paper")):
        try:
            mod = importlib.import_module(module)
        except Exception as exc:
            print(f"  SKIP {module}: {type(exc).__name__}: {exc}")
            continue
        data = getattr(mod, attr, None)
        if data is None:
            print(f"  SKIP {module}.{attr}: not found")
            continue
        # Reference solutions live in a SEPARATE module-level dict, keyed by slug, not on the
        # problem rows. The first migration read only the rows and left all 50 behind — and they
        # are the highest-value content here, since a wrong reference solution on an interview-prep
        # platform is worse than a missing question. Merged in by slug rather than migrated
        # separately, so an item and its answer cannot drift apart into two files.
        refs: dict[str, Any] = {}
        for ref_attr in ("REFERENCE_SOLUTIONS", "INTERVIEW_REFERENCE_SOLUTIONS"):
            found = getattr(mod, ref_attr, None)
            if isinstance(found, dict):
                refs.update(found)

        # **The reference dicts are keyed by the container's key, not by the item's slug**, and for
        # interview problems those differ: INTERVIEW_PROBLEMS is keyed `implement-auc` while the
        # item's slug is `iq-implement-auc`. Looking up by slug found 12 of 50 and silently left
        # the other 38 behind — a miss that looks exactly like "those items have no reference
        # solution". So carry the key alongside the row and try both.
        if isinstance(data, dict):
            pairs = [(k, v) for k, v in data.items() if isinstance(v, dict) and v.get("slug")]
        else:
            pairs = [(r.get("slug"), r) for r in data if isinstance(r, dict) and r.get("slug")]

        rows = []
        for key, r in pairs:
            row = dict(r, source_kind=kind)
            sol = refs.get(key, refs.get(row["slug"]))
            if sol is not None:
                row["reference_solution"] = sol
            rows.append(row)
        print(f"  {module}.{attr}: {len(rows)} items ({kind})")
        out.extend(rows)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="actually write files (default: dry run)")
    args = ap.parse_args()

    from features.taxonomy import load_taxonomy
    valid = set(load_taxonomy().concepts)

    rows = collect()
    seen: dict[str, dict] = {}
    for r in rows:
        seen.setdefault(r["slug"], r)          # first definition wins; duplicates reported below
    dupes = len(rows) - len(seen)
    print(f"\n  {len(rows)} rows, {len(seen)} distinct slugs ({dupes} duplicates collapsed)")

    written = 0
    for slug, r in sorted(seen.items()):
        cats = [c for c in r.get("categories", []) if c] or ["ML"]
        item = {
            "slug": slug,
            "title": r.get("title") or slug.replace("-", " ").title(),
            "difficulty": (r.get("difficulty") or "medium").lower(),
            "categories": cats,
            "concepts": infer_concepts(slug, r.get("title", ""), cats, valid),
            "description": r.get("description") or r.get("prompt") or r.get("body") or "TODO",
            # Not decoration. No item has ever carried a concept tag, so every one of these is
            # inferred from a keyword and none has been confirmed by a human.
            "inferred_concepts": True,
            "review_needed": True,
        }
        # **Everything else passes through verbatim.** The first version of this script wrote only
        # the six fields above and silently dropped test_cases, code_templates, examples, hints,
        # constraints and order_index. Losing test_cases is not a cosmetic loss: execution.py:75
        # records that an empty test list was once graded as a *pass*, because
        # `passed == len(test_cases)` is vacuously true for an empty list. Switching the API to a
        # loader built on those files would have made every problem pass silently — the exact bug
        # this codebase already fixed once, reintroduced through the back door.
        for key, value in r.items():
            if key not in item:
                item[key] = value
        if args.write:
            OUT.mkdir(parents=True, exist_ok=True)
            (OUT / f"{slug}.yaml").write_text(
                yaml.safe_dump(item, sort_keys=False, allow_unicode=True, width=100),
                encoding="utf-8")
        written += 1

    print(f"  {'wrote' if args.write else 'would write'} {written} files to {OUT}")
    if not args.write:
        print("  (dry run — pass --write)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
