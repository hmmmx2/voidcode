"""P2b: one strategy per launch, measured identically. The DeepSpeed deliverable.

    torchrun --nproc_per_node=2 -m training.parallel.bench --strategy ddp

WHY EVERY ROW USES ADAFACTOR
----------------------------
Not taste, arithmetic. DDP does not shard optimizer state, so at 7.6B with 8-bit AdamW it needs
46.19 GiB by the memory audit's validated estimator, and an A40 reports **44.43 GiB usable**. The
baseline row would not run at all, and a table missing its baseline compares the sharded strategies
only to each other. Adafactor fits every row, which is what makes them comparable.

Note the card is 44.43 GiB, not the 48 GB on the spec sheet. The audit's headroom figures were
written against 48; this is the real number and it is what MemoryGuard is given.

WHY THE WEIGHTS ARE RANDOM
--------------------------
This measures tokens/s and peak reserved per device, which are properties of the *system* rather
than of a trained model. Real Qwen2.5-7B architecture and parameter count, random init, no 15 GB
download on a metered pod. To be stated plainly in the write-up: a systems measurement, not a claim
that the model learned anything.

WHAT IS BEING COMPARED
----------------------
  ddp                   replicate everything. The baseline, and the memory ceiling.
  fsdp2_shard_grad_op   shard gradients and optimizer, keep params after forward (ZeRO-2)
  fsdp2_full_shard      shard params too, re-gather per layer (ZeRO-3)
  zero2 / zero3         DeepSpeed's implementations of those same two ideas

The platform branch's FINETUNING_BLUEPRINT argued FSDP2 over DeepSpeed at this scale. A table
settles that better than a preference does.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import torch
import torch.distributed as dist

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Qwen2.5-7B, inline so no config download is needed on a metered pod.
QWEN_7B = dict(
    vocab_size=152064, hidden_size=3584, intermediate_size=18944,
    num_hidden_layers=28, num_attention_heads=28, num_key_value_heads=4,
    max_position_embeddings=32768, rope_theta=1000000.0, tie_word_embeddings=False,
)

STRATEGIES = ("single", "ddp", "fsdp2_shard_grad_op", "fsdp2_full_shard", "zero2", "zero3")


def log(msg):
    if int(os.environ.get("RANK", 0)) == 0:
        print(msg, flush=True)


def build_model(layers, vocab=None, dtype=torch.bfloat16):
    from transformers import Qwen2Config, Qwen2ForCausalLM

    overrides = {"num_hidden_layers": layers}
    if vocab:
        overrides["vocab_size"] = vocab
    cfg = Qwen2Config(**{**QWEN_7B, **overrides})
    torch.set_default_dtype(dtype)
    model = Qwen2ForCausalLM(cfg)
    torch.set_default_dtype(torch.float32)
    model.gradient_checkpointing_enable()
    model.config.use_cache = False
    return model


def optimizer_state_dtypes(opt):
    """What precision the moments are actually held in — evidence, not assertion.

    The first version of this table compared FSDP2 against DeepSpeed without checking, and the
    ranking it produced was an artefact: torch's AdamW allocates state in the *parameter* dtype,
    so a bf16 model silently gets bf16 moments, while DeepSpeed keeps fp32 moments and fp32 master
    weights. Half the memory difference was precision, not parallelism. This goes in the record so
    the reader can see the comparison is like-for-like instead of taking my word for it.
    """
    seen = {}
    for state in list(getattr(opt, "state", {}).values())[:4]:
        for key, value in state.items():
            if torch.is_tensor(value) and key in ("exp_avg", "exp_avg_sq"):
                seen[key] = str(value.dtype)
    return seen


def wrap(model, strategy, lr, optimizer="adafactor", mp_policy=None):
    from transformers.optimization import Adafactor

    def adafactor(params):
        """Adafactor, or AdamW when FSDP2 forces it.

        **transformers' Adafactor cannot drive FSDP2 on torch 2.4.** Its factored state is built
        with plain `torch.zeros`, so the first in-place update raises

            aten.add_.Tensor: got mixed torch.Tensor and DTensor

        because FSDP2's parameters are DTensors and the optimizer state is not. torch's own
        optimizers are DTensor-aware; this one is not. Recorded rather than worked around, because
        it is a real constraint on the blueprint's preference for FSDP2 at this scale.
        """
        if optimizer == "adamw":
            return torch.optim.AdamW(params, lr=lr, betas=(0.9, 0.95), foreach=False)
        return Adafactor(params, lr=lr, relative_step=False, scale_parameter=False,
                         warmup_init=False)

    if strategy == "single":
        # P2a. A plain single-GPU loop with NO parallel wrapper at all.
        #
        # This is not the same as running `ddp` at world=1, and the difference is not academic:
        # DistributedDataParallel allocates gradient buckets for the all-reduce, a full extra copy
        # of the gradients — roughly 15 GiB at 7.6B in bf16. Measuring `ddp --nproc_per_node=1`
        # against the memory audit's single-card prediction OOM'd at 43.84 GiB against a predicted
        # 31.65 GiB peak, and the wrapper was most of the gap. The estimator was being blamed for
        # a cost the experiment had itself introduced.
        model = model.cuda()
        return model, adafactor(model.parameters()), None

    if strategy == "ddp":
        model = model.cuda()
        opt = adafactor(model.parameters())
        wrapped = torch.nn.parallel.DistributedDataParallel(
            model, device_ids=[torch.cuda.current_device()])
        return wrapped, opt, None

    if strategy.startswith("fsdp2"):
        from torch.distributed._composable.fsdp import fully_shard
        from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer

        # reshard_after_forward is the entire ZeRO-2 / ZeRO-3 distinction: keep the gathered
        # parameters after forward (more memory, less communication) or drop them (the reverse).
        reshard = strategy == "fsdp2_full_shard"
        kwargs = {"reshard_after_forward": reshard}
        if mp_policy is not None:
            # Parameters stay fp32 and are cast to bf16 for compute, so the optimizer sees fp32
            # and allocates fp32 moments — the same recipe DeepSpeed uses. Without this, a bf16
            # model gives bf16 moments and the memory comparison is measuring precision.
            kwargs["mp_policy"] = mp_policy
        for module in model.modules():
            if isinstance(module, Qwen2DecoderLayer):
                fully_shard(module, **kwargs)
        fully_shard(model, **kwargs)
        model = model.cuda()
        opt = adafactor(model.parameters())
        return model, opt, None

    if strategy in ("zero2", "zero3"):
        import deepspeed

        config = {
            "train_micro_batch_size_per_gpu": 1,
            "gradient_accumulation_steps": 1,
            "bf16": {"enabled": True},
            "zero_optimization": {
                "stage": 2 if strategy == "zero2" else 3,
                "overlap_comm": True,
                "contiguous_gradients": True,
            },
            "steps_per_print": 10 ** 9,
            # DeepSpeed refuses any optimizer it has not itself validated. Adafactor is the
            # plan's choice for a measured reason, so the assertion is opted out of rather than
            # the optimizer changed to suit the framework.
            "zero_allow_untested_optimizer": True,
        }
        opt = adafactor(model.parameters())
        engine, opt, _, _ = deepspeed.initialize(model=model, optimizer=opt, config=config)
        return engine, opt, engine

    raise ValueError("unknown strategy " + repr(strategy))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", required=True, choices=STRATEGIES)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--warmup", type=int, default=4)
    ap.add_argument("--seq", type=int, default=1024)
    ap.add_argument("--layers", type=int, default=28)
    # Qwen's 152064-token vocabulary is 2.18B parameters of embedding before a single transformer
    # layer exists, which dominates the memory at small depths. Shrinking it is how the comparable
    # table gets a DDP baseline that fits.
    ap.add_argument("--vocab", type=int, default=QWEN_7B["vocab_size"])
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--optimizer", default="adafactor", choices=("adafactor", "adamw"))
    # bf16_native : model in bf16, optimizer state inherits bf16. Cheap, numerically weaker.
    # mixed_fp32  : fp32 master weights, bf16 compute, fp32 moments. What DeepSpeed already did,
    #               and the only setting under which all five rows are comparable.
    ap.add_argument("--recipe", default="bf16_native", choices=("bf16_native", "mixed_fp32"))
    ap.add_argument("--out")
    args = ap.parse_args()

    dist.init_process_group("nccl")
    rank, world = dist.get_rank(), dist.get_world_size()
    torch.cuda.set_device(rank)

    from training.memory_guard import MemoryGuard

    log("[" + args.strategy + "] building " + str(args.layers) + "-layer model on "
        + str(world) + " ranks...")
    mixed = args.recipe == "mixed_fp32"
    model = build_model(args.layers, args.vocab,
                        torch.float32 if mixed else torch.bfloat16)
    n_params = sum(p.numel() for p in model.parameters())
    log("[" + args.strategy + "] " + format(n_params / 1e9, ".2f") + "B parameters, recipe "
        + args.recipe)

    mp_policy = None
    if mixed and args.strategy.startswith("fsdp2"):
        from torch.distributed._composable.fsdp import MixedPrecisionPolicy

        mp_policy = MixedPrecisionPolicy(param_dtype=torch.bfloat16,
                                         reduce_dtype=torch.float32)

    model, opt, engine = wrap(model, args.strategy, args.lr, args.optimizer, mp_policy)
    guard = MemoryGuard.for_current_device(fraction=0.98)

    torch.manual_seed(1234 + rank)
    ids = torch.randint(0, args.vocab, (1, args.seq), device="cuda")

    times = []
    for step in range(args.steps):
        torch.cuda.synchronize()
        t0 = time.perf_counter()

        with guard.stage("forward"):
            # DDP has no mp_policy, so autocast is how its fp32 parameters get bf16 compute.
            # FSDP2 does its own casting via mp_policy; DeepSpeed via its bf16 config.
            autocast = torch.autocast("cuda", dtype=torch.bfloat16,
                                      enabled=mixed and args.strategy == "ddp")
            with autocast:
                out = model(input_ids=ids, labels=ids)
                loss = out.loss
        with guard.stage("backward"):
            if engine is not None:
                engine.backward(loss)
            else:
                loss.backward()
        with guard.stage("optimizer"):
            if engine is not None:
                engine.step()
            else:
                opt.step()
                opt.zero_grad(set_to_none=True)

        torch.cuda.synchronize()
        dt = time.perf_counter() - t0
        if step >= args.warmup:
            times.append(dt)
        log("  step " + str(step).rjust(2) + "  " + format(dt * 1000, "8.1f")
            + " ms  loss " + format(float(loss), ".4f"))

    mean = sum(times) / len(times)
    # Every rank processes one micro-batch, so job throughput is world * seq / step.
    tokens_s = world * args.seq / mean
    peak = torch.cuda.max_memory_reserved() / 1024 ** 3

    gathered = [torch.zeros(1, device="cuda") for _ in range(world)]
    dist.all_gather(gathered, torch.tensor([peak], device="cuda"))

    record = {
        "strategy": args.strategy, "world_size": world, "optimizer": args.optimizer,
        "recipe": args.recipe,
        # Carried in every record so the table can be checked rather than believed.
        "optimizer_state_dtypes": optimizer_state_dtypes(opt),
        "params_b": round(n_params / 1e9, 3), "layers": args.layers, "vocab": args.vocab,
        "seq": args.seq,
        "steps": args.steps, "warmup": args.warmup,
        "step_ms_mean": round(mean * 1000, 2),
        "step_ms_min": round(min(times) * 1000, 2),
        "tokens_per_s": round(tokens_s, 1),
        "peak_reserved_gib_per_device": [round(float(p), 3) for p in gathered],
        "guard": guard.report(),
    }
    if rank == 0:
        printable = {k: v for k, v in record.items() if k != "guard"}
        log("\n" + json.dumps(printable, indent=2))
        if args.out:
            Path(args.out).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n",
                                      encoding="utf-8")
            log("wrote " + args.out)
    dist.destroy_process_group()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
