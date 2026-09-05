"""Kill a training process mid-run, resume it, and require the loss curve to be unchanged.

This is P2b's fault-tolerance acceptance criterion, and it does not need a GPU. The property is
identical at 7.6B on two A40s and at 30k parameters on a laptop: a run that is interrupted and
resumed must compute exactly what an uninterrupted run computes. Proving it here means the pod
spends its hours measuring throughput rather than debugging resume.

HOW THE KILL IS DONE, AND WHY IT MATTERS
----------------------------------------
The worker is terminated **externally**, by this process, after it has been observed to reach a
chosen step. It is not asked to stop and it does not choose to: `os._exit` and `sys.exit` both run
inside a process that co-operated, and a node that dies does not co-operate. The distinction is not
pedantic -- a co-operative exit can flush buffers and finish a half-written file, which is exactly
the state a crash-safety test must not be allowed to skip.

WHAT COUNTS AS PASSING
----------------------
Not "it restarted". Not "the loss went down again". The resumed curve must match the uninterrupted
curve **step for step**. A resume that loses optimizer state recovers within a few dozen steps and
produces a curve that looks entirely normal, which is why "it recovered" is not evidence and this
asserts equality instead.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path


def read_log(path: Path) -> dict[int, float]:
    """Losses by step, last write wins.

    Duplicates are expected and are not a bug: a process killed after checkpointing step k but
    before logging it resumes at k and logs it again. Keeping the last occurrence is what makes the
    comparison meaningful rather than tripping over an artefact of when the kill landed.
    """
    if not path.exists():
        return {}
    out: dict[int, float] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            out[row["step"]] = row["loss"]
    return out


def _spawn(workdir: Path, log: Path, steps: int, seed: int, slow: float) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "training.faulttol.worker",
         "--dir", str(workdir), "--log", str(log),
         "--steps", str(steps), "--seed", str(seed), "--slow", str(slow)],
        cwd=str(Path(__file__).resolve().parents[2]),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def run(tmp: Path, steps: int = 8, kill_after: int = 3, seed: int = 5, slow: float = 0.05) -> dict:
    """Uninterrupted run, then a killed-and-resumed run. Returns both curves and the verdict."""
    tmp = Path(tmp)

    # ── the reference: one process, never disturbed ───────────────────────────────────────────
    ref_log = tmp / "reference.jsonl"
    proc = _spawn(tmp / "reference", ref_log, steps, seed, 0.0)
    out, err = proc.communicate(timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"reference run failed ({proc.returncode}):\n{err or out}")
    reference = read_log(ref_log)

    # ── the interrupted one ───────────────────────────────────────────────────────────────────
    kill_log = tmp / "killed.jsonl"
    workdir = tmp / "killed"
    victim = _spawn(workdir, kill_log, steps, seed, slow)

    deadline = time.monotonic() + 120
    killed_at = None
    while time.monotonic() < deadline:
        progress = read_log(kill_log)
        if progress and max(progress) >= kill_after - 1:
            victim.kill()                       # external, uncooperative, no flush
            killed_at = max(progress)
            break
        if victim.poll() is not None:
            raise RuntimeError(f"victim exited before reaching step {kill_after}:\n{victim.stderr.read()}")
        time.sleep(0.01)
    victim.wait(timeout=30)
    if killed_at is None:
        raise RuntimeError(f"never observed step {kill_after} within the deadline")

    # ── resume: a brand-new process, same checkpoint directory ────────────────────────────────
    resumed = _spawn(workdir, kill_log, steps, seed, 0.0)
    out, err = resumed.communicate(timeout=300)
    if resumed.returncode != 0:
        raise RuntimeError(f"resumed run failed ({resumed.returncode}):\n{err or out}")

    after = read_log(kill_log)
    mismatches = {
        step: (reference[step], after.get(step))
        for step in sorted(reference)
        if step not in after or abs(reference[step] - after[step]) > 1e-12
    }
    return {
        "steps": steps,
        "killed_after_step": killed_at,
        "reference": reference,
        "resumed": after,
        "mismatches": mismatches,
        "identical": not mismatches and set(after) == set(reference),
    }


def main() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        result = run(Path(tmp))
    print(f"killed after step {result['killed_after_step']}, {result['steps']} steps total")
    for step in sorted(result["reference"]):
        ref = result["reference"][step]
        got = result["resumed"].get(step)
        flag = "" if got is not None and abs(ref - got) <= 1e-12 else "   <-- MISMATCH"
        print(f"  step {step}: reference {ref:.12f}  resumed {got if got is None else f'{got:.12f}'}{flag}")
    print("\nIDENTICAL" if result["identical"] else "\nDIVERGED")
    return 0 if result["identical"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
