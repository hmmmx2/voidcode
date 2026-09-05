"""Bronze-layer ingest: real Codeforces submission telemetry.

Why this corpus. Spec §4.1 nominates Project CodeNet, whose CDN does not resolve from
this network (see docs/DATA_SOURCES.md). The Codeforces public API is reachable and is
a strictly better fit for Phase 2, because `contest.status` returns the one field the
mastery model cannot be built without and that most published dumps omit: a per-user
handle. Each row carries user, problem, verdict, timestamp, difficulty rating and
concept tags — every input spec §4.3 asks for.

Landing zone is immutable newline-delimited JSON, one file per (contest, page).
Re-running skips files that already exist, so the job is resumable after an
interruption and idempotent on a clean rerun. Curation into Parquet happens in the
Spark layer, not here.

    python -m features.ingest.codeforces_fetch --target-rows 1200000
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

API = "https://codeforces.com/api"
PAGE = 100_000          # server-side maximum observed for contest.status
# Codeforces permits ~1 request / 2 s. The depth pass issues thousands of sequential
# requests rather than the fifteen the breadth pass needs, which is a different risk
# profile, so this sits further under the limit and adds jitter to avoid presenting
# as a metronome.
RATE_LIMIT_S = 2.5
RATE_JITTER_S = 0.3
UA = "Mozilla/5.0 (VoidCode-AI research ingest)"

_last_call = 0.0


def _throttle() -> None:
    global _last_call
    interval = RATE_LIMIT_S + random.uniform(-RATE_JITTER_S, RATE_JITTER_S)
    wait = interval - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()


def api_get(method: str, **params):
    """One API call with throttling and bounded backoff.

    Rate limiting and transient failure are treated differently. A 5xx or a dropped
    connection clears in seconds; "Call limit exceeded" means the server has decided
    we are asking too often, and retrying on the same short schedule makes that worse.
    """
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API}/{method}" + (f"?{qs}" if qs else "")
    last_err = None
    rate_limited_backoff = [60, 300, 600]
    rate_limit_hits = 0
    for attempt in range(5):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = json.load(resp)
            if payload.get("status") != "OK":
                raise RuntimeError(f"API status {payload.get('status')}: "
                                   f"{payload.get('comment')}")
            return payload["result"]
        # ValueError covers json.JSONDecodeError, which is what a truncated or
        # half-delivered response body raises. It is a transport failure like any
        # other and must be retried — leaving it uncaught killed a 42-minute depth
        # run at handle 193 of 1000.
        except (urllib.error.URLError, RuntimeError, TimeoutError, ValueError,
                ConnectionError, OSError) as e:
            last_err = e
            msg = str(e)
            if "limit exceeded" in msg.lower():
                backoff = rate_limited_backoff[min(rate_limit_hits,
                                                   len(rate_limited_backoff) - 1)]
                rate_limit_hits += 1
                label = "RATE LIMITED"
            else:
                backoff = 5 * (2 ** attempt)
                label = "transient"
            print(f"    retry {attempt+1}/5 in {backoff}s [{label}] "
                  f"({type(e).__name__}: {msg[:80]})", flush=True)
            time.sleep(backoff)
    raise RuntimeError(f"{method} failed after 5 attempts: {last_err}")


def flatten(sub: dict) -> dict | None:
    """contest.status record -> flat row. Returns None for rows we cannot use."""
    members = (sub.get("author") or {}).get("members") or []
    if not members:
        return None                      # ghost / team entries without a handle
    handle = members[0].get("handle")
    if not handle:
        return None
    p = sub.get("problem") or {}
    idx = p.get("index")
    cid = p.get("contestId")
    if idx is None or cid is None:
        return None
    return {
        "submission_id": sub.get("id"),
        "user_handle": handle,
        "problem_id": f"{cid}-{idx}",
        "contest_id": cid,
        "problem_index": idx,
        "problem_name": p.get("name"),
        "problem_rating": p.get("rating"),
        "problem_tags": p.get("tags") or [],
        "verdict": sub.get("verdict"),
        "programming_language": sub.get("programmingLanguage"),
        "created_at": sub.get("creationTimeSeconds"),
        "relative_time_seconds": sub.get("relativeTimeSeconds"),
        "participant_type": (sub.get("author") or {}).get("participantType"),
        "testset": sub.get("testset"),
        "passed_test_count": sub.get("passedTestCount"),
        "time_consumed_ms": sub.get("timeConsumedMillis"),
        "memory_consumed_bytes": sub.get("memoryConsumedBytes"),
    }


def write_catalog(out_dir: str) -> int:
    """The problem catalogue, from `problemset.problems`.

    THIS ENDPOINT IS NOT A SUPERSET OF WHAT LEARNERS SUBMIT TO, AND THAT IS A MEASURED FAULT.

    `quality/contracts.py` found 906 problem_ids in the fact tables absent from the catalogue,
    covering 28,285 learner-problem rows (2.1%) and 12,496 learners. The gap skews hard to later
    contest indices — C: 13,643 rows, D: 8,069, E: 1,783 — while A and B are nearly complete.

    The cause is a SOURCE MISMATCH, not a truncated loop. `problemset.problems` returns the official
    RATED problemset; the fact tables come from `contest.status`, which records every submission to
    every problem. Unrated problems, gym problems and some later Div. 2 problems appear in submissions
    and never in the problemset — which is exactly the index skew observed.

    So RE-RUNNING THIS FUNCTION WILL NOT FIX IT. It will fetch the same set and reproduce the same
    906-problem gap. Two real options, neither of which is a re-fetch of this endpoint:

      1. Also fetch `contest.standings` per contest, whose `problems` array lists that contest's
         problems including unrated ones. Costs one request per contest against a rate-limited API.
      2. Backfill from observed submissions. `problem_id`, `contest_id` and `problem_index` are all
         derivable from a submission, and `problem_rating` is already carried on
         `gold_learner_problem`. `name` and `tags` are not recoverable and would have to be null —
         which is honest, and enough to stop every join silently dropping 2.1% of rows.

    Option 2 needs no network and no API budget, so it is the one to do first. Neither is done here:
    both change the warehouse, and `quality/contracts.py` fails on this deliberately so the gap
    cannot be forgotten while it is outstanding.
    """
    path = os.path.join(out_dir, "problemset.jsonl")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            n = sum(1 for _ in f)
        print(f"catalog already present ({n} problems)")
        return n
    problems = api_get("problemset.problems")["problems"]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for p in problems:
            f.write(json.dumps({
                "problem_id": f"{p.get('contestId')}-{p.get('index')}",
                "contest_id": p.get("contestId"),
                "problem_index": p.get("index"),
                "name": p.get("name"),
                "rating": p.get("rating"),
                "tags": p.get("tags") or [],
            }) + "\n")
    os.replace(tmp, path)
    print(f"catalog: {len(problems)} problems -> {path}")
    return len(problems)


def pick_contests(limit: int) -> list[dict]:
    """Recent finished, non-gym contests. Div 2/3 and Educational draw the most
    participants, so they yield both the most rows and the most distinct learners."""
    contests = api_get("contest.list", gym="false")
    finished = [c for c in contests if c.get("phase") == "FINISHED"]
    finished.sort(key=lambda c: c.get("startTimeSeconds") or 0, reverse=True)
    preferred, other = [], []
    for c in finished:
        name = c.get("name", "")
        (preferred if any(k in name for k in ("Div. 2", "Div. 3", "Div. 4",
                                              "Educational")) else other).append(c)
    return (preferred + other)[:limit]


def _write_json_atomic(obj: dict, path: str) -> None:
    """Write via a temp file and rename.

    The manifest is rewritten after every handle, so a plain truncate-and-write
    leaves a corrupt file if the process dies mid-write — which would lose the
    resume state for every handle already fetched, not just the current one.

    The temp name carries the pid. A shared ".tmp" is not actually atomic between
    two processes: both write it, the first renames it away, and the second's
    os.replace dies with FileNotFoundError. That happened, and `acquire_lock` now
    stops it happening at all — this is belt and braces.
    """
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def acquire_lock(out_dir: str):
    """Refuse to run two fetchers against one landing zone.

    Two concurrent fetchers double the API request rate against a rate-limited
    public endpoint, race on the manifest, and silently orphan fetched files. Killing
    a wrapper process does not necessarily kill the Python process underneath it, so
    an orphan can outlive the command that started it — the lock records the pid so
    the second run can say which process to kill.
    """
    lock_path = os.path.join(out_dir, ".fetch.lock")
    if os.path.exists(lock_path):
        with open(lock_path, encoding="utf-8") as f:
            owner = f.read().strip()
        pid = owner.split()[0] if owner else "?"
        alive = pid.isdigit() and os.path.exists(f"/proc/{pid}")
        if alive:
            raise SystemExit(
                f"another fetch is already running (pid {pid}). "
                f"Wait for it, or: kill {pid} && rm {lock_path}")
        print(f"clearing stale lock from dead pid {pid}")
    with open(lock_path, "w", encoding="utf-8") as f:
        f.write(f"{os.getpid()} {time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
    return lock_path


def reconcile_users(out_dir: str, manifest: dict) -> int:
    """Rebuild manifest entries for user files present on disk but unrecorded.

    Those rows were paid for with rate-limited API calls; losing track of them means
    refetching. The filename is a hash of the handle and not reversible, but every
    row carries `user_handle`, so the mapping is recoverable from the file itself.
    """
    known = {v.get("file") for v in manifest["users"].values()}
    recovered = 0
    for fname in sorted(os.listdir(out_dir)):
        if not (fname.startswith("user_") and fname.endswith(".jsonl")):
            continue
        if fname in known:
            continue
        path = os.path.join(out_dir, fname)
        handle, n = None, 0
        with open(path, encoding="utf-8") as f:
            for line in f:
                n += 1
                if handle is None:
                    try:
                        handle = json.loads(line)["user_handle"]
                    except (ValueError, KeyError):
                        pass
        if handle:
            manifest["users"][handle] = {"file": fname, "rows": n,
                                         "recovered": True}
            recovered += 1
    if recovered:
        print(f"reconciled {recovered} user file(s) present on disk but absent "
              f"from the manifest")
    return recovered


def load_manifest(manifest_path: str, catalog_size: int) -> dict:
    """Manifest v2. Backwards compatible: v1 files carried only `files`."""
    manifest = {"files": {}, "users": {}, "catalog_size": catalog_size}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        manifest.setdefault("files", {})
        manifest.setdefault("users", {})
        manifest["catalog_size"] = catalog_size
    return manifest


def save_manifest(manifest: dict, manifest_path: str) -> dict:
    contest_rows = sum(manifest["files"].values())
    user_rows = sum(u.get("rows", 0) for u in manifest["users"].values())
    manifest["contest_rows"] = contest_rows
    manifest["user_rows"] = user_rows
    manifest["total_rows"] = contest_rows + user_rows
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    return manifest


def sample_handles(out_dir: str, n: int, min_subs: int, seed: int,
                   already: set[str]) -> list[str]:
    """Pick a cohort of handles to deepen, stratified across contests.

    Taking the top-N most active handles would produce a cohort of strong, unusually
    prolific competitors, and every mastery statistic downstream would inherit that
    bias. Instead handles are bucketed by the contest they first appear in and drawn
    round-robin across buckets, so the cohort spans the corpus rather than one
    contest's participants. Deterministic under `seed`.

    Streams the bronze files with a Counter rather than starting Spark: 1.3M lines is
    ~30-45 s of pure Python and the caller usually just wants the list.
    """
    counts: collections.Counter[str] = collections.Counter()
    first_seen: dict[str, str] = {}
    for fname in sorted(os.listdir(out_dir)):
        if not (fname.startswith("contest_") and fname.endswith(".jsonl")):
            continue
        with open(os.path.join(out_dir, fname), encoding="utf-8") as f:
            for line in f:
                try:
                    h = json.loads(line)["user_handle"]
                except (ValueError, KeyError):
                    continue
                counts[h] += 1
                first_seen.setdefault(h, fname)

    eligible = [h for h, c in counts.items() if c >= min_subs and h not in already]
    buckets: dict[str, list[str]] = collections.defaultdict(list)
    for h in eligible:
        buckets[first_seen[h]].append(h)

    rng = random.Random(seed)
    for b in buckets.values():
        b.sort()            # stable before shuffling, so the seed fully determines it
        rng.shuffle(b)

    picked: list[str] = []
    order = sorted(buckets)
    while len(picked) < n and any(buckets[k] for k in order):
        for k in order:
            if buckets[k]:
                picked.append(buckets[k].pop())
                if len(picked) >= n:
                    break
    print(f"sampled {len(picked):,} handles from {len(eligible):,} eligible "
          f"(>= {min_subs} subs) across {len(buckets)} contest buckets")
    return picked


def fetch_users(out_dir: str, handles: list[str], count: int, manifest: dict,
                manifest_path: str) -> int:
    """Depth pass: full cross-contest history per handle via user.status.

    One file per handle, and the manifest is rewritten after every handle, so a run
    lasting hours is resumable at ~2.5-second granularity rather than losing the lot.
    """
    added = 0
    for i, handle in enumerate(handles, 1):
        if handle in manifest["users"]:
            continue
        fname = f"user_{hashlib.sha256(handle.encode()).hexdigest()[:16]}.jsonl"
        fpath = os.path.join(out_dir, fname)
        try:
            rows = api_get("user.status", handle=handle, **{"from": 1}, count=count)
        except Exception as e:
            # Defence in depth. api_get already retries transport failures; anything
            # reaching here is specific to this handle (deleted account, rename,
            # a response that stays malformed across five attempts). Recording it
            # and moving on is always better than losing the hours already spent.
            print(f"  [{i}/{len(handles)}] {handle}: SKIPPED "
                  f"({type(e).__name__}: {str(e)[:60]})", flush=True)
            manifest["users"][handle] = {"file": None, "rows": 0,
                                         "error": f"{type(e).__name__}: {str(e)[:100]}"}
            _write_json_atomic(manifest, manifest_path)
            continue
        flat = [r for r in (flatten(s) for s in rows) if r]
        tmp = fpath + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for r in flat:
                f.write(json.dumps(r) + "\n")
        os.replace(tmp, fpath)
        manifest["users"][handle] = {"file": fname, "rows": len(flat)}
        added += len(flat)
        _write_json_atomic(manifest, manifest_path)
        if i % 25 == 0 or i == len(handles):
            print(f"  [{i}/{len(handles)}] {handle[:20]:20s} {len(flat):>6,} rows "
                  f"| added {added:>9,}", flush=True)
    return added


def fetch(out_dir: str, target_rows: int, max_contests: int,
          max_pages: int, rows_per_contest: int = PAGE) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    catalog_size = write_catalog(out_dir)

    manifest_path = os.path.join(out_dir, "manifest.json")
    manifest = load_manifest(manifest_path, catalog_size)
    total = sum(manifest["files"].values())
    print(f"starting from {total:,} rows already on disk")

    for c in pick_contests(max_contests):
        if total >= target_rows:
            break
        cid = c["id"]
        for page in range(max_pages):
            if total >= target_rows:
                break
            fname = f"contest_{cid}_p{page}.jsonl"
            fpath = os.path.join(out_dir, fname)
            if fname in manifest["files"] and os.path.exists(fpath):
                continue                                  # already fetched
            try:
                rows = api_get("contest.status", contestId=cid,
                               **{"from": page * rows_per_contest + 1},
                               count=rows_per_contest)
            except RuntimeError as e:
                print(f"  contest {cid} page {page}: giving up ({str(e)[:90]})")
                break
            if not rows:
                break
            flat = [r for r in (flatten(s) for s in rows) if r]
            tmp = fpath + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                for r in flat:
                    f.write(json.dumps(r) + "\n")
            os.replace(tmp, fpath)
            manifest["files"][fname] = len(flat)
            total += len(flat)
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=1)
            print(f"  {c['name'][:44]:44s} p{page}: {len(flat):>7,} rows "
                  f"| total {total:>9,}", flush=True)
            if len(rows) < rows_per_contest:
                break                                     # contest exhausted

    return save_manifest(manifest, manifest_path)


def distinct_problems(out_dir: str) -> int:
    """Distinct problems across the whole landing zone. This is the number Q-010 is
    about, so it is reported after every fetch rather than inferred later."""
    seen = set()
    for fname in os.listdir(out_dir):
        if not fname.endswith(".jsonl") or fname == "problemset.jsonl":
            continue
        with open(os.path.join(out_dir, fname), encoding="utf-8") as f:
            for line in f:
                try:
                    seen.add(json.loads(line)["problem_id"])
                except (ValueError, KeyError):
                    continue
    return len(seen)


def main() -> None:
    ap = argparse.ArgumentParser()
    default_out = os.path.join(
        os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data")),
        "raw", "codeforces")
    ap.add_argument("--out", default=default_out)
    ap.add_argument("--mode", choices=["contest", "user"], default="contest",
                    help="contest = breadth (many contests, few rows each); "
                         "user = depth (full cross-contest history per handle)")
    # breadth
    ap.add_argument("--target-rows", type=int, default=1_200_000)
    ap.add_argument("--max-contests", type=int, default=40)
    ap.add_argument("--max-pages", type=int, default=6)
    ap.add_argument("--rows-per-contest", type=int, default=PAGE)
    # depth
    ap.add_argument("--handles", type=int, default=1000)
    ap.add_argument("--min-handle-subs", type=int, default=3)
    ap.add_argument("--user-rows", type=int, default=10_000,
                    help="max submissions to pull per handle")
    ap.add_argument("--seed", type=int, default=17)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    lock_path = acquire_lock(a.out)
    try:
        _run(a)
    finally:
        if os.path.exists(lock_path):
            os.remove(lock_path)


def _run(a) -> None:
    if a.mode == "contest":
        m = fetch(a.out, a.target_rows, a.max_contests, a.max_pages,
                  a.rows_per_contest)
    else:
        catalog_size = write_catalog(a.out)
        manifest_path = os.path.join(a.out, "manifest.json")
        manifest = load_manifest(manifest_path, catalog_size)
        if reconcile_users(a.out, manifest):
            _write_json_atomic(manifest, manifest_path)
        # --handles is a TARGET TOTAL, not an increment. `make ingest-depth
        # HANDLES=5000` means "the cohort should end up at 5000 learners",
        # which is what its help text says and what makes resuming after an
        # interruption land where you asked rather than overshooting.
        done = len(manifest["users"])
        remaining = max(0, a.handles - done)
        print(f"cohort target {a.handles:,} | already fetched {done:,} | "
              f"sampling {remaining:,} more")
        handles = (sample_handles(a.out, remaining, a.min_handle_subs, a.seed,
                                  already=set(manifest["users"]))
                   if remaining else [])
        t0 = time.time()
        added = fetch_users(a.out, handles, a.user_rows, manifest, manifest_path)
        m = save_manifest(manifest, manifest_path)
        done = [u for u in manifest["users"].values() if u.get("file")]
        elapsed = time.time() - t0
        print(f"\ndepth pass: +{added:,} rows from {len(handles):,} handles "
              f"in {elapsed/60:.1f} min")
        if done:
            print(f"  rows per handle: mean {added/max(len(handles),1):.1f} "
                  f"| handles with data {len(done):,}")

    n_problems = distinct_problems(a.out)
    print(f"\nDONE  contest_files={len(m['files'])}  users={len(m['users'])}  "
          f"rows={m['total_rows']:,}  distinct_problems={n_problems:,}  -> {a.out}")
    if m["total_rows"] < 1_000_000:
        print("WARNING: below the 1,000,000-row floor in spec §4.1", file=sys.stderr)


if __name__ == "__main__":
    main()
