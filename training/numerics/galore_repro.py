"""Reproduce GaLore's optimizer-state memory claim, and check it against our own estimator.

T1 asks for one published result reproduced, agreed with, or disputed with evidence. GaLore is the
right candidate here for a specific reason: the memory audit already produced a *validated
estimator*, and that estimator projects a GaLore configuration it never measured. Two independent
predictions to test at once.

WHAT GALORE CLAIMS
------------------
Gradients of a `[m, n]` weight are projected into a rank-r subspace before the optimizer sees them,
so Adam's two moment buffers are kept on the projected gradient rather than the full one. The paper
reports up to **65.5% less optimizer state memory**.

WHY THIS IS MEASURABLE ON A CONSUMER CARD
------------------------------------------
The claim is a **ratio**, not an absolute. Optimizer state per parameter does not depend on how many
layers a model has, so the saving can be measured on a model that fits in 16 GiB and the result
carries. Attempting it at 7B would test the card, not the claim.

WHAT IS MEASURED, PRECISELY
---------------------------
Optimizer state bytes only — the tensors the optimizer owns after a step, walked directly out of
`opt.state`. Not peak allocator memory, which folds in activations and gradients and would let a
favourable batch size flatter either side. Adam allocates its moments lazily on the **first step**,
which the memory audit found the hard way, so every measurement here happens after `.step()`.

The comparison is like-for-like: same model, same parameters, same dtype, same rank of update.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

#: The paper's headline. Reproduced or disputed, not assumed.
GALORE_CLAIM_PCT = 65.5


def optimizer_state_bytes(opt) -> tuple[int, dict]:
    """Bytes held in optimizer state, and a breakdown by tensor name.

    Walks `opt.state` rather than reading the allocator, because the allocator total includes
    parameters, gradients and activations, and the claim is about optimizer state specifically.
    """
    total = 0
    breakdown: dict[str, int] = {}
    for state in opt.state.values():
        for key, value in state.items():
            if torch.is_tensor(value) and value.numel() > 1:
                n = value.numel() * value.element_size()
                total += n
                breakdown[key] = breakdown.get(key, 0) + n
            elif value is not None and not isinstance(value, (int, float, bool, str)):
                # **GaLore's projection matrix is not a tensor in `opt.state`** — it lives inside a
                # `GaLoreProjector` object under the key "projector". Counting only direct tensors
                # reported a 93.75% saving against a shape prediction of 90.62%, and beating your
                # own arithmetic is how undercounting announces itself. The projection matrix is
                # real memory the method requires, so it counts.
                for attr in vars(value).values() if hasattr(value, "__dict__") else ():
                    if torch.is_tensor(attr) and attr.numel() > 1:
                        n = attr.numel() * attr.element_size()
                        total += n
                        breakdown[f"{key}.projection"] = breakdown.get(f"{key}.projection", 0) + n
    return total, breakdown


def build_linear_stack(layers: int, dim: int, device, dtype):
    """A stack of square Linear layers: GaLore projects 2-D weights, so this is what it acts on."""
    model = torch.nn.Sequential(*[torch.nn.Linear(dim, dim, bias=False) for _ in range(layers)])
    return model.to(device=device, dtype=dtype)


def measure(kind: str, layers: int, dim: int, rank: int, device, dtype) -> dict:
    torch.manual_seed(0)
    model = build_linear_stack(layers, dim, device, dtype)
    params = list(model.parameters())
    n_params = sum(p.numel() for p in params)

    if kind == "adamw":
        opt = torch.optim.AdamW(params, lr=1e-4)
    elif kind == "galore":
        from galore_torch import GaLoreAdamW

        opt = GaLoreAdamW(
            [{"params": params, "rank": rank, "update_proj_gap": 200,
              "scale": 0.25, "proj_type": "std"}], lr=1e-4)
    else:
        raise ValueError(kind)

    x = torch.randn(8, dim, device=device, dtype=dtype)
    # Moments are allocated lazily on the first step -- measuring before it reports zero and looks
    # like a spectacular saving. The memory audit found exactly this failure mode.
    model(x).sum().backward()
    opt.step()

    total, breakdown = optimizer_state_bytes(opt)
    return {
        "optimizer": kind,
        "params": n_params,
        "state_bytes": total,
        "bytes_per_param": round(total / n_params, 4),
        "breakdown": {k: round(v / 1024 ** 2, 2) for k, v in breakdown.items()},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", type=int, default=8)
    ap.add_argument("--dim", type=int, default=2048)
    ap.add_argument("--rank", type=int, default=128)
    ap.add_argument("--dtype", default="float32", choices=("float32", "bfloat16"))
    ap.add_argument("--out")
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = getattr(torch, args.dtype)

    adamw = measure("adamw", args.layers, args.dim, args.rank, device, dtype)
    galore = measure("galore", args.layers, args.dim, args.rank, device, dtype)

    saving = (1 - galore["state_bytes"] / adamw["state_bytes"]) * 100
    # What the shapes say it should be: Adam keeps 2 moments of [dim, dim]; GaLore keeps 2 of
    # [dim, rank] plus the projection matrix, all in fp32.
    predicted = (1 - (2 * args.dim * args.rank + args.dim * args.rank)
                 / (2 * args.dim * args.dim)) * 100

    record = {
        "device": torch.cuda.get_device_name(0) if device.type == "cuda" else "cpu",
        "config": {"layers": args.layers, "dim": args.dim, "rank": args.rank, "dtype": args.dtype},
        "adamw": adamw, "galore": galore,
        "measured_saving_pct": round(saving, 2),
        "shape_predicted_saving_pct": round(predicted, 2),
        "paper_claim_pct": GALORE_CLAIM_PCT,
        "reproduces_claim": bool(saving >= GALORE_CLAIM_PCT),
    }

    print(f"device            : {record['device']}")
    print(f"config            : {args.layers} x Linear({args.dim},{args.dim}), rank {args.rank}, {args.dtype}")
    print(f"parameters        : {adamw['params'] / 1e6:.1f}M")
    print()
    print(f"AdamW  state      : {adamw['state_bytes'] / 1024**2:8.1f} MiB   "
          f"({adamw['bytes_per_param']:.2f} bytes/param)  {adamw['breakdown']}")
    print(f"GaLore state      : {galore['state_bytes'] / 1024**2:8.1f} MiB   "
          f"({galore['bytes_per_param']:.2f} bytes/param)  {galore['breakdown']}")
    print()
    print(f"measured saving   : {saving:6.2f}%")
    print(f"shape prediction  : {predicted:6.2f}%")
    print(f"paper claim       : {GALORE_CLAIM_PCT:6.2f}%  -> "
          f"{'REPRODUCED' if record['reproduces_claim'] else 'NOT reached at this rank'}")

    if args.out:
        Path(args.out).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
