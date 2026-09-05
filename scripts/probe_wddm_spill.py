"""Does this driver still silently spill GPU memory to host RAM instead of raising OOM?

`training/memory_guard.py` is built on one observation: under WDDM the driver accepts allocations
past physical VRAM and pages them over PCIe, so a run that does not fit executes at a fraction of
expected speed while every log line looks healthy. The docstring cites a backward pass reaching
**28.77 GiB on a 16 GiB card** without failing.

That was observed once, on an older driver. The whole guard rests on it. This finds out whether it
still reproduces here, and at what threshold -- which is the difference between the guard being
load-bearing and being superstition.

    Reserved climbs past capacity, no OOM   -> spill confirmed; the guard is load-bearing
    OOM at roughly capacity                 -> this driver fails honestly; the guard is cheap
                                               insurance rather than a live necessity

READ THIS BEFORE RUNNING IT
---------------------------
**This GPU probably also drives your display.** Deliberately exhausting its memory can make the
desktop unresponsive, and on some driver versions can force a TDR reset that takes running
applications with it. That is why it is a script you invoke on purpose and not a test, why it
requires `--yes-i-understand`, and why it stops at a modest multiple of capacity rather than
climbing until something breaks.

Close anything you would mind losing first. Run it when you can afford a hung desktop for a minute.

    python scripts/probe_wddm_spill.py --yes-i-understand --max-fraction 1.5
"""

from __future__ import annotations

import argparse
import json
import sys

GIB = 1024**3


def probe(step_gib: float, max_fraction: float, hold: bool) -> dict:
    import torch

    if not torch.cuda.is_available():
        return {"skipped": "no CUDA device"}

    props = torch.cuda.get_device_properties(0)
    capacity = props.total_memory
    ceiling = int(capacity * max_fraction)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    blocks: list = []
    record: dict = {
        "device": props.name,
        "capacity_gib": round(capacity / GIB, 3),
        "ceiling_gib": round(ceiling / GIB, 3),
        "step_gib": step_gib,
        "outcome": None,
        "spilled": None,
        "oom_at_gib": None,
        "max_reserved_gib": None,
        "steps": [],
    }

    elements = int(step_gib * GIB // 2)  # float16
    try:
        while True:
            reserved = torch.cuda.memory_reserved()
            if reserved >= ceiling:
                record["outcome"] = "reached ceiling without OOM"
                record["spilled"] = reserved > capacity
                break
            try:
                blocks.append(torch.empty(elements, dtype=torch.float16, device="cuda"))
            except torch.cuda.OutOfMemoryError:
                record["outcome"] = "OutOfMemoryError"
                record["oom_at_gib"] = round(torch.cuda.memory_reserved() / GIB, 3)
                # The honest-failure case: the driver refused rather than paging.
                record["spilled"] = torch.cuda.max_memory_reserved() > capacity
                break
            if not hold:
                # Keep only enough references to grow; freeing lets the allocator reuse and the
                # test then measures the allocator rather than the driver.
                pass
            record["steps"].append(round(torch.cuda.memory_reserved() / GIB, 3))
    finally:
        record["max_reserved_gib"] = round(torch.cuda.max_memory_reserved() / GIB, 3)
        blocks.clear()
        torch.cuda.empty_cache()

    record["exceeded_capacity_by_gib"] = round(
        max(0.0, record["max_reserved_gib"] - capacity / GIB), 3
    )
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--yes-i-understand", action="store_true",
                        help="acknowledge this can hang the desktop while it runs")
    parser.add_argument("--step-gib", type=float, default=0.5)
    parser.add_argument("--max-fraction", type=float, default=1.5,
                        help="stop once reserved reaches this multiple of capacity")
    parser.add_argument("--out", help="write the JSON record here")
    args = parser.parse_args(argv)

    if not args.yes_i_understand:
        parser.error(
            "refusing to run without --yes-i-understand. This deliberately exhausts the VRAM of a "
            "GPU that is probably also driving your display; read the module docstring first."
        )

    record = probe(args.step_gib, args.max_fraction, hold=True)
    print(json.dumps(record, indent=2))

    if record.get("spilled"):
        print("\nSPILL CONFIRMED: reserved exceeded physical capacity without an OOM.\n"
              "MemoryGuard's premise holds on this driver, and any throughput measured in that\n"
              "state would have been invalid.")
    elif record.get("outcome") == "OutOfMemoryError":
        print("\nNo spill: this driver raised OutOfMemoryError instead of paging.\n"
              "MemoryGuard is insurance here rather than a live necessity -- worth recording in\n"
              "docs/DECISIONS.md, since it weakens the justification written into memory_guard.py.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
