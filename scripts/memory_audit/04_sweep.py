"""Driver — runs each (model, config, seq, batch) probe in a FRESH subprocess.

A separate process per attempt is deliberate: it guarantees an OOM or a wedged
CUDA context in one attempt cannot contaminate the memory baseline of the next.
"""
import argparse
import json
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "03_probe.py")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True, help="JSON file: list of attempt dicts")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    plan = json.load(open(a.plan))
    open(a.out, "w").close()
    results = []
    for i, item in enumerate(plan, 1):
        desc = (f"{item['model'].split('/')[-1]} | {item['config']} | "
                f"seq={item['seq']} bs={item.get('batch', 1)}")
        print(f"\n[{i}/{len(plan)}] {desc}", flush=True)
        cmd = [sys.executable, PROBE,
               "--model", item["model"], "--config", item["config"],
               "--seq", str(item["seq"]), "--batch", str(item.get("batch", 1)),
               "--steps", str(item.get("steps", 3))]
        env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True",
                   TOKENIZERS_PARALLELISM="false")
        p = subprocess.run(cmd, capture_output=True, text=True, env=env)
        try:
            start = p.stdout.index("{")
            r = json.loads(p.stdout[start:])
        except Exception:
            r = dict(model=item["model"], config=item["config"], seq=item["seq"],
                     batch=item.get("batch", 1), ok=False,
                     failed_stage="process",
                     error=("process died (likely host-level OOM kill or driver "
                            "fault): " + (p.stderr.strip().split("\n")[-1][:300]
                                          if p.stderr.strip() else
                                          f"exit {p.returncode}, no stderr")))
        results.append(r)
        with open(a.out, "a") as f:
            f.write(json.dumps(r) + "\n")
        if r.get("ok"):
            print(f"    OK  peak_alloc={r['peak_alloc_gib']} GiB  "
                  f"reserved={r['peak_reserved_gib']} GiB  "
                  f"static={r.get('static_state_gib')} GiB  "
                  f"tok/s={r.get('tokens_per_sec')}", flush=True)
        else:
            print(f"    FAIL at stage '{r['failed_stage']}': "
                  f"{str(r['error'])[:160]}", flush=True)
    print(f"\nWrote {len(results)} results to {a.out}")


if __name__ == "__main__":
    main()
