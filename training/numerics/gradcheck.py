"""Do the parallel strategies compute the same gradients as one GPU?

T1's acceptance criterion, and the one that a throughput table cannot substitute for. A parallelism
strategy that is fast and subtly wrong produces a loss curve that looks fine and a model that is
worse than it should be, and nothing announces it. FSDP2's own table in `docs/METRICS.md` says
`SHARD_GRAD_OP` is 1.45x DDP — that claim is worth nothing if the gradients differ.

THE COMPARISON THAT IS ACTUALLY CORRECT
---------------------------------------
Not "run the same batch on both". Under DDP each rank sees a *different* micro-batch and the
gradients are averaged, so the honest single-GPU reference processes the **concatenation** of what
the ranks saw, with the same reduction. Give both sides the same total batch or the test measures
batch size rather than parallelism.

    reference   1 process, batch [A, B],  mean reduction
    parallel    2 ranks,   rank0 -> A, rank1 -> B, gradients all-reduced

Those must agree. Anything else is comparing two different computations.

RUN IT IN TWO PASSES, NOT ONE
-----------------------------
The reference could be computed on rank 0 alongside the sharded run, but that puts an unsharded copy
of the model on one device and changes its memory profile, which is the thing under test elsewhere.
So: one invocation saves reference gradients to disk, a second loads and compares.

    torchrun --nproc_per_node=1 -m training.numerics.gradcheck --mode reference --out ref.pt
    torchrun --nproc_per_node=2 -m training.numerics.gradcheck --mode compare  --ref ref.pt \
        --strategy fsdp2_shard_grad_op

WHAT TOLERANCE IS HONEST
------------------------
Not bitwise. All-reduce sums in a different order than a single device does, and float addition is
not associative, so exact equality would fail for a correct implementation. The claim is
*near*-bitwise: relative error at the 1e-5 level in fp32. A real bug — a missing gradient scale, an
unsynchronised parameter, a wrong reduction — is orders of magnitude larger than that, so the test
separates the two cases cleanly rather than splitting hairs.

**This runs on gloo and CPU.** Correctness is not a property of the interconnect, so it is proved for
free before any pod is rented, and re-run there on NCCL as confirmation.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
import torch.distributed as dist

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from training.parallel.bench import QWEN_7B, build_model  # noqa: E402


def make_batch(vocab: int, seq: int, n: int, device) -> torch.Tensor:
    """The whole batch, deterministically. Rank r takes row r; the reference takes all of it."""
    generator = torch.Generator().manual_seed(4242)
    return torch.randint(0, vocab, (n, seq), generator=generator).to(device)


def wrap_for(model, strategy: str, device):
    if strategy == "ddp":
        model = model.to(device)
        return torch.nn.parallel.DistributedDataParallel(
            model, device_ids=[device.index] if device.type == "cuda" else None)
    if strategy.startswith("fsdp2"):
        from torch.distributed._composable.fsdp import fully_shard
        from transformers.models.qwen2.modeling_qwen2 import Qwen2DecoderLayer

        reshard = strategy == "fsdp2_full_shard"
        for module in model.modules():
            if isinstance(module, Qwen2DecoderLayer):
                fully_shard(module, reshard_after_forward=reshard)
        fully_shard(model, reshard_after_forward=reshard)
        return model.to(device)
    raise ValueError("unsupported strategy " + repr(strategy))


def full_gradients(model) -> dict:
    """Gradients as dense tensors, gathering shards where FSDP2 left DTensors."""
    out = {}
    for name, param in model.named_parameters():
        grad = param.grad
        if grad is None:
            continue
        # FSDP2 parameters are DTensors; full_tensor() reassembles the unsharded gradient so it can
        # be compared against a single-device reference at all.
        if hasattr(grad, "full_tensor"):
            grad = grad.full_tensor()
        out[name.replace("_checkpoint_wrapped_module.", "").replace("module.", "")] = grad.detach().float().cpu()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=("reference", "compare"))
    ap.add_argument("--strategy", default="ddp")
    ap.add_argument("--layers", type=int, default=2)
    ap.add_argument("--vocab", type=int, default=1024)
    ap.add_argument("--seq", type=int, default=64)
    ap.add_argument("--batch", type=int, default=2, help="TOTAL rows; must equal world size in compare")
    ap.add_argument("--rtol", type=float, default=1e-4)
    ap.add_argument("--atol", type=float, default=1e-5)
    ap.add_argument("--out")
    ap.add_argument("--ref")
    # A gradient check that cannot fail is decoration. All three strategies agreed with the
    # reference to 9.410e-07 — identical to four figures — which is either the same all-reduce
    # reassociation in every case, or a comparison that is not looking at what it claims to.
    # These distinguish the two by injecting bugs a real implementation could plausibly have.
    ap.add_argument("--fault", default="none",
                    choices=("none", "same-row", "half-grad", "no-reduce"),
                    help="deliberately break the parallel run; the check must then FAIL")
    args = ap.parse_args()

    backend = "nccl" if torch.cuda.is_available() else "gloo"
    dist.init_process_group(backend)
    rank, world = dist.get_rank(), dist.get_world_size()
    if torch.cuda.is_available():
        torch.cuda.set_device(rank)
        device = torch.device("cuda", rank)
    else:
        device = torch.device("cpu")

    # fp32 throughout: the question is whether the maths agrees, and bf16 rounding would mask a
    # real discrepancy behind its own noise.
    torch.manual_seed(0)
    model = build_model(args.layers, args.vocab, torch.float32)

    batch = make_batch(args.vocab, args.seq, args.batch, device)

    if args.mode == "reference":
        model = model.to(device)
        _, loss = None, None
        out = model(input_ids=batch, labels=batch)
        out.loss.backward()
        grads = full_gradients(model)
        if rank == 0:
            torch.save({"grads": grads, "loss": float(out.loss)}, args.out)
            print(f"reference: loss {float(out.loss):.10f}, {len(grads)} gradient tensors -> {args.out}")
        dist.destroy_process_group()
        return 0

    if args.batch != world:
        raise SystemExit(f"--batch {args.batch} must equal world size {world} for a 1:1 row split")

    # `same-row` is the realistic data-sharding bug: every rank trains on the same micro-batch, so
    # the job silently does 1/world of the work it reports. It is injected before wrapping because
    # that is where a real dataloader mistake would live.
    row = 0 if args.fault == "same-row" else rank

    model = wrap_for(model, args.strategy, device)
    # Rank r takes row r. Together the ranks cover exactly the reference's batch.
    mine = batch[row : row + 1]
    out = model(input_ids=mine, labels=mine)
    out.loss.backward()

    grads = full_gradients(model)

    if args.fault == "half-grad":
        # A missing 1/world scaling — the classic reduction bug.
        grads = {k: v * 0.5 for k, v in grads.items()}
    elif args.fault == "no-reduce":
        # What the gradients would look like if the collective never happened: this rank's own
        # contribution only, unaveraged.
        grads = {k: v * world for k, v in grads.items()}
    reference = torch.load(args.ref, weights_only=False)
    ref_grads = reference["grads"]

    if rank != 0:
        dist.destroy_process_group()
        return 0

    missing = set(ref_grads) - set(grads)
    extra = set(grads) - set(ref_grads)
    if missing or extra:
        print(f"FAIL: parameter names differ. missing {sorted(missing)[:3]}, extra {sorted(extra)[:3]}")
        dist.destroy_process_group()
        return 1

    worst_name, worst_rel = None, 0.0
    failures = []
    for name, ref in ref_grads.items():
        got = grads[name]
        denom = ref.abs().max().clamp(min=1e-12)
        rel = float((got - ref).abs().max() / denom)
        if rel > worst_rel:
            worst_name, worst_rel = name, rel
        if not torch.allclose(got, ref, rtol=args.rtol, atol=args.atol):
            failures.append((name, rel))

    print(f"strategy       : {args.strategy}, world {world}, backend {backend}")
    print(f"tensors checked: {len(ref_grads)}")
    print(f"worst relative : {worst_rel:.3e}  ({worst_name})")
    print(f"tolerance      : rtol {args.rtol}, atol {args.atol}")
    if failures:
        print(f"\nFAIL: {len(failures)} tensors outside tolerance")
        for name, rel in failures[:5]:
            print(f"  {name:<50} rel {rel:.3e}")
    else:
        print("\nPASS: parallel gradients agree with the single-device reference")

    dist.destroy_process_group()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
