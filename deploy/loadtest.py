"""Load test for the read paths. Spec §6.2 asks for one; there was none.

Run:  python deploy/loadtest.py --url http://127.0.0.1:8000 --users 20 --seconds 30

WHY NOT k6 OR LOCUST
-----------------------
Both are better tools and both are another dependency plus another runtime to install in CI. This
needs httpx, which the API already depends on, and it produces the two numbers that actually matter
here. If load testing becomes routine, replace this — it is deliberately small enough to throw away.

WHAT IT MEASURES, AND WHY p99 RATHER THAN A MEAN
--------------------------------------------------
A mean hides the tail, and the tail is the experience. 200 requests at 40 ms and 5 at 4 s average out
to 130 ms, which looks fine and describes nobody: five people waited four seconds. p50 says what a
typical request costs, p99 says what the worst realistic one costs, and the gap between them is the
thing worth watching.

WHAT IT DELIBERATELY DOES NOT DO
-----------------------------------
**No writes, no submissions, no chat completions.** A load test that POSTs submissions fills the
database with junk that then has to be cleaned out of a real environment, and one that hits
`/v1/chat/completions` measures a GPU rather than the API. The expensive paths need their own
targeted test with a disposable database; this one is safe to point at anything.

**It cannot tell you the HPA works.** That needs a cluster, and the manifests in `deploy/base` have
never been applied to one. This measures a single instance's capacity, which is the input to a
scaling decision, not evidence of one.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import dataclass, field

#: Read-only endpoints. `/health` is included as a control: if its p99 rises with the others, the
#: bottleneck is the process or the event loop rather than any one query.
PATHS = [
    "/health",
    "/v1/dashboard",
    "/v1/recommendations?limit=10",
    "/v1/problems",
    "/v1/interviews",
]


@dataclass
class Sample:
    path: str
    ms: float
    status: int


@dataclass
class Report:
    samples: list[Sample] = field(default_factory=list)
    errors: int = 0

    def percentiles(self, path: str | None = None) -> dict[str, float]:
        values = sorted(s.ms for s in self.samples if path is None or s.path == path)
        if not values:
            return {}
        def pct(p: float) -> float:
            # Nearest-rank rather than interpolation: with a few hundred samples the
            # interpolated p99 is a number no request actually experienced.
            index = min(len(values) - 1, int(round(p / 100 * len(values)) - 1))
            return values[max(index, 0)]
        return {"n": len(values), "p50": pct(50), "p95": pct(95), "p99": pct(99),
                "max": values[-1]}


async def worker(client, url: str, deadline: float, report: Report) -> None:
    i = 0
    while time.monotonic() < deadline:
        path = PATHS[i % len(PATHS)]
        i += 1
        start = time.monotonic()
        try:
            response = await client.get(f"{url}{path}", timeout=30)
            elapsed = (time.monotonic() - start) * 1000
            report.samples.append(Sample(path, elapsed, response.status_code))
            if response.status_code >= 500:
                report.errors += 1
        except Exception:
            # A timeout is a result, not a crash. Dropping it would flatter the tail:
            # the slowest requests are exactly the ones that fail.
            report.samples.append(Sample(path, (time.monotonic() - start) * 1000, 0))
            report.errors += 1


async def run(url: str, users: int, seconds: int) -> int:
    import httpx

    report = Report()
    async with httpx.AsyncClient() as client:
        try:
            probe = await client.get(f"{url}/health", timeout=10)
        except Exception as exc:
            print(f"{url} is not reachable ({type(exc).__name__}). Refusing to report numbers "
                  "against a service that is not running.")
            return 2
        print(f"target {url} responded {probe.status_code}; {users} concurrent for {seconds}s\n")

        deadline = time.monotonic() + seconds
        await asyncio.gather(*(worker(client, url, deadline, report) for _ in range(users)))

    overall = report.percentiles()
    if not overall:
        print("no samples collected")
        return 2

    rps = overall["n"] / seconds
    print(f"  {overall['n']} requests, {rps:.1f} req/s, {report.errors} errors")
    print(f"  overall   p50 {overall['p50']:6.0f}ms   p95 {overall['p95']:6.0f}ms   "
          f"p99 {overall['p99']:6.0f}ms   max {overall['max']:6.0f}ms\n")

    for path in PATHS:
        stats = report.percentiles(path)
        if stats:
            print(f"  {path:34} n={stats['n']:4}  p50 {stats['p50']:6.0f}ms  "
                  f"p95 {stats['p95']:6.0f}ms  p99 {stats['p99']:6.0f}ms")

    statuses: dict[int, int] = {}
    for sample in report.samples:
        statuses[sample.status] = statuses.get(sample.status, 0) + 1
    print(f"\n  statuses: {dict(sorted(statuses.items()))}   (0 = timeout or transport failure)")

    # Errors fail the run; slow does not. A latency threshold here would be a number
    # picked from nothing — there is no SLO for this product yet, and inventing one in
    # a test file is how an unmeasured target becomes a quoted one.
    if report.errors:
        print(f"\n  {report.errors} request(s) failed. That is the finding, not the latency.")
        return 1
    print("\n  no failures. Latency above is a measurement, not a pass or fail:")
    print("  there is no agreed SLO for this product, and inventing one here would turn")
    print("  a number nobody chose into a target somebody quotes.")
    return 0


def _utf8_stdout() -> None:
    """Make printing non-ASCII safe when stdout is not a terminal.

    On Windows, Python picks cp1252 for a redirected stdout, so any print containing an em dash, a
    section sign or a box-drawing character raises UnicodeEncodeError. The failure is invisible
    interactively and fatal in CI or under a pipe — this module crashed halfway through its report the
    first time its output was redirected to a file, after printing 45 correct lines.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            # Already wrapped, or not a real stream. Nothing to do and nothing worth failing over.
            pass

def main() -> int:
    _utf8_stdout()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--users", type=int, default=10)
    parser.add_argument("--seconds", type=int, default=20)
    args = parser.parse_args()
    return asyncio.run(run(args.url.rstrip("/"), args.users, args.seconds))


if __name__ == "__main__":
    raise SystemExit(main())
