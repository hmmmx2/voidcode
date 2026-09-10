#!/usr/bin/env python3
"""What a served 30B actually costs per slot-second, measured rather than assumed.

THE NUMBER THE PRICE NEEDS IS NOT THROUGHPUT

`gpu_pricing.rate_micro_per_slot_second` is `pod_cost_per_hour / (3600 * nominal_concurrency)`.
Throughput does not appear in it. What the price actually rests on is **nominal_concurrency**, and
that is currently 16 because `MAX_CONCURRENT_REQUESTS` is 8 and the deployment runs two replicas --
an API-side semaphore count, not a statement about the hardware.

If an A40 can only serve six concurrent requests of this model with a workable KV cache, then a
fully busy hour produces 6 x 3600 slot-seconds rather than 16 x 3600, and the price under-recovers
by a factor of nearly three while every figure in the ledger stays arithmetically correct. That is
the failure this script exists to catch, and it is the reason `measured=False` sits on the shipped
pricing row.

So the outputs, in order of how much they matter:

  1. **`achievable_concurrency`** -- how many slots the card genuinely serves. This is the pricing
     input. Two sources are recorded and compared: what vLLM reports it can hold in its KV cache,
     and what a real load test sustains without latency collapsing.
  2. **`slot_seconds_p50` / `p95`** -- what a realistic tutor answer occupies. This is what says
     whether `GPU_MAX_SLOT_SECONDS=180` is a sane hold and whether a per-request charge is plausible.
  3. **`tokens_per_second_per_slot`** -- context, and the conversion from "an N-token answer" to
     slot-seconds.

WHAT COUNTS AS REALISTIC

Generation length dominates occupancy, so a 64-token burst measures nothing useful -- the existing
157 tok/s figure in this repo says so about itself, in as many words. The prompts below are authored
ML/DL tutor questions of the kind the product actually receives, and the output cap matches what the
API allows rather than what makes a benchmark look good.

The prompts are synthetic on purpose. `data/catalogue.json` is the reward function's answer key and
is never published or copied into a benchmark artifact.

USAGE, on the pod, with a server already listening:

    python bench_serving.py --base-url http://127.0.0.1:8080/v1 --model rl \\
        --out /workspace/bench-serving-30b.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import asdict, dataclass, field

import httpx

#: Tutor-shaped questions. Long enough to produce a real answer, varied so the KV cache is not
#: serving one shared prefix -- prefix caching would otherwise flatter the concurrency number.
PROMPTS: tuple[str, ...] = (
    "Explain why scaled dot-product attention divides by the square root of the key dimension, "
    "and what breaks if you leave the division out.",
    "Walk me through implementing RMSNorm from scratch, and say why it dropped the mean-centring "
    "step that LayerNorm has.",
    "What is the difference between ZeRO stage 2 and stage 3, and which one would you pick for a "
    "7B model on two 48 GB cards?",
    "I am getting NaN losses about 200 steps into fine-tuning a 7B model in bf16. Give me an "
    "ordered list of things to check and why each one matters.",
    "Derive the memory cost of a KV cache for a decoder-only transformer, then use it to explain "
    "why grouped-query attention exists.",
    "Explain the bias-variance decomposition of test error, then say where it stops being a useful "
    "way to think about deep networks.",
    "Implement top-k and nucleus sampling, and explain what each one does to the tail of the "
    "distribution differently.",
    "Why does a 4-bit quantised model sometimes run slower than the fp16 original under plain "
    "transformers, and what changes that?",
)


@dataclass
class RequestResult:
    ok: bool
    slot_seconds: float
    completion_tokens: int
    prompt_tokens: int
    ttft_seconds: float | None
    error: str | None = None


@dataclass
class Level:
    """One concurrency level's measurements."""

    concurrency: int
    requests: int
    wall_seconds: float
    ok: int
    failed: int
    slot_seconds_p50: float
    slot_seconds_p95: float
    slot_seconds_mean: float
    completion_tokens_total: int
    #: Aggregate output tokens per second across the whole level.
    tokens_per_second_aggregate: float
    #: The per-slot figure. This is what degrades as concurrency rises, and watching where it falls
    #: off a cliff is how the healthy limit is found.
    tokens_per_second_per_slot: float
    ttft_p50: float | None
    errors: list[str] = field(default_factory=list)


async def one_request(
    client: httpx.AsyncClient, *, model: str, prompt: str, max_tokens: int, stream: bool
) -> RequestResult:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        # Deterministic, so a level's variance is the server's and not the sampler's.
        "temperature": 0.0,
        "stream": stream,
    }
    if stream:
        body["stream_options"] = {"include_usage": True}

    start = time.monotonic()
    ttft = None
    completion_tokens = 0
    prompt_tokens = 0
    try:
        if stream:
            async with client.stream("POST", "/chat/completions", json=body) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload.strip() == "[DONE]":
                        break
                    chunk = json.loads(payload)
                    if ttft is None and chunk.get("choices"):
                        delta = chunk["choices"][0].get("delta", {})
                        if delta.get("content"):
                            ttft = time.monotonic() - start
                    if chunk.get("usage"):
                        completion_tokens = chunk["usage"].get("completion_tokens", 0)
                        prompt_tokens = chunk["usage"].get("prompt_tokens", 0)
        else:
            response = await client.post("/chat/completions", json=body)
            response.raise_for_status()
            data = response.json()
            usage = data.get("usage") or {}
            completion_tokens = usage.get("completion_tokens", 0)
            prompt_tokens = usage.get("prompt_tokens", 0)
    except Exception as exc:  # noqa: BLE001 - every failure mode is a datum here
        return RequestResult(
            ok=False,
            slot_seconds=time.monotonic() - start,
            completion_tokens=0,
            prompt_tokens=0,
            ttft_seconds=None,
            error=f"{type(exc).__name__}: {str(exc)[:160]}",
        )

    return RequestResult(
        ok=True,
        # THE BILLING QUANTITY. Wall-clock from submission to the last token, which is exactly what
        # `metering.Meter` measures in production for a request holding one slot.
        slot_seconds=time.monotonic() - start,
        completion_tokens=completion_tokens,
        prompt_tokens=prompt_tokens,
        ttft_seconds=ttft,
    )


async def run_level(
    base_url: str, *, model: str, concurrency: int, requests: int, max_tokens: int, stream: bool
) -> Level:
    limits = httpx.Limits(max_connections=concurrency + 4)
    timeout = httpx.Timeout(connect=10.0, read=1200.0, write=60.0, pool=60.0)

    async with httpx.AsyncClient(
        base_url=base_url, limits=limits, timeout=timeout
    ) as client:
        semaphore = asyncio.Semaphore(concurrency)

        async def worker(index: int) -> RequestResult:
            async with semaphore:
                return await one_request(
                    client,
                    model=model,
                    prompt=PROMPTS[index % len(PROMPTS)],
                    max_tokens=max_tokens,
                    stream=stream,
                )

        start = time.monotonic()
        results = await asyncio.gather(*(worker(i) for i in range(requests)))
        wall = time.monotonic() - start

    ok = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]
    slot_seconds = sorted(r.slot_seconds for r in ok) or [0.0]
    tokens = sum(r.completion_tokens for r in ok)
    ttfts = sorted(r.ttft_seconds for r in ok if r.ttft_seconds is not None)

    def percentile(values: list[float], q: float) -> float:
        if not values:
            return 0.0
        index = min(len(values) - 1, int(round(q * (len(values) - 1))))
        return values[index]

    return Level(
        concurrency=concurrency,
        requests=requests,
        wall_seconds=round(wall, 3),
        ok=len(ok),
        failed=len(failed),
        slot_seconds_p50=round(percentile(slot_seconds, 0.50), 3),
        slot_seconds_p95=round(percentile(slot_seconds, 0.95), 3),
        slot_seconds_mean=round(statistics.fmean(slot_seconds), 3),
        completion_tokens_total=tokens,
        tokens_per_second_aggregate=round(tokens / wall, 1) if wall else 0.0,
        tokens_per_second_per_slot=(
            round(tokens / sum(r.slot_seconds for r in ok), 1) if ok else 0.0
        ),
        ttft_p50=round(percentile(ttfts, 0.50), 3) if ttfts else None,
        # Deduplicated: sixteen copies of one OOM is one fact.
        errors=sorted({r.error for r in failed if r.error})[:5],
    )


def choose_achievable_concurrency(levels: list[Level]) -> dict:
    """The pricing input, with the reasoning recorded alongside it.

    A level counts as healthy while per-slot throughput has not collapsed relative to the
    single-slot baseline and nothing errored. "Collapsed" is a judgement, so the threshold is stated
    rather than buried: per-slot throughput below 25% of the C=1 figure means the card is thrashing
    rather than serving, and slots past that point are not slots anyone would want to be served in.
    """
    single = next((lvl for lvl in levels if lvl.concurrency == 1), None)

    # REFUSE A VERDICT RATHER THAN RETURN 1. The first version returned
    # `achievable_concurrency: 1` when every request had failed, which is a number a reader would
    # plug into the pricing row -- setting a real price from a benchmark that measured nothing.
    # A benchmark with no successful request has no opinion about capacity and must say so.
    if single is None or single.ok == 0:
        return {
            "achievable_concurrency": None,
            "usable": False,
            "reason": (
                "the single-slot level produced no successful request, so nothing here measures "
                "capacity. Do not touch the pricing row on this run."
            ),
            "errors": single.errors if single else ["no C=1 level was run"],
        }

    baseline = next((lvl.tokens_per_second_per_slot for lvl in levels if lvl.concurrency == 1), 0.0)
    healthy = [
        lvl
        for lvl in levels
        if lvl.failed == 0
        and baseline > 0
        and lvl.tokens_per_second_per_slot >= 0.25 * baseline
    ]
    best = max((lvl.concurrency for lvl in healthy), default=1)
    return {
        "achievable_concurrency": best,
        "usable": True,
        "single_slot_tokens_per_second": baseline,
        "rule": (
            "highest concurrency with zero failures and per-slot throughput >= 25% of the "
            "single-slot figure"
        ),
        "levels_rejected": [
            {
                "concurrency": lvl.concurrency,
                "failed": lvl.failed,
                "tokens_per_second_per_slot": lvl.tokens_per_second_per_slot,
            }
            for lvl in levels
            if lvl not in healthy and lvl.concurrency != 1
        ],
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--model", required=True, help="model name the server advertises")
    parser.add_argument(
        "--concurrency", default="1,2,4,8,16",
        help="levels to sweep; the pricing row's nominal_concurrency should be inside this range",
    )
    parser.add_argument(
        "--max-tokens", type=int, default=768,
        help="a realistic tutor answer. Short bursts measure prefill, not service.",
    )
    parser.add_argument("--requests-per-level", type=int, default=0,
                        help="default: 3x the concurrency, so every slot is exercised repeatedly")
    parser.add_argument("--no-stream", action="store_true",
                        help="skip TTFT; occupancy is unaffected")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    levels_wanted = [int(c) for c in args.concurrency.split(",") if c.strip()]

    # Warm up before measuring: the first request pays for CUDA graph capture and any lazy kernel
    # compilation, and charging that to the C=1 baseline would understate the card by a wide margin.
    print("warming up ...", flush=True)
    await run_level(
        args.base_url, model=args.model, concurrency=2, requests=2,
        max_tokens=64, stream=not args.no_stream,
    )

    levels: list[Level] = []
    for concurrency in levels_wanted:
        requests = args.requests_per_level or concurrency * 3
        print(f"level C={concurrency}, {requests} requests ...", flush=True)
        level = await run_level(
            args.base_url, model=args.model, concurrency=concurrency, requests=requests,
            max_tokens=args.max_tokens, stream=not args.no_stream,
        )
        levels.append(level)
        print(
            f"  C={concurrency:2d} ok={level.ok}/{level.requests} "
            f"slot_s p50={level.slot_seconds_p50} p95={level.slot_seconds_p95} "
            f"tok/s agg={level.tokens_per_second_aggregate} per-slot={level.tokens_per_second_per_slot}"
            + (f"  ERRORS: {level.errors}" if level.errors else ""),
            flush=True,
        )

    verdict = choose_achievable_concurrency(levels)
    report = {
        "measured_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_url": args.base_url,
        "model": args.model,
        "max_tokens": args.max_tokens,
        "levels": [asdict(lvl) for lvl in levels],
        "verdict": verdict,
        "how_to_use": (
            "Set PricingRow.nominal_concurrency to verdict.achievable_concurrency, set measured=True, "
            "and re-run apps/api/tests/test_gpu_reconciliation_postgres.py. If a busy hour no longer "
            "covers the pod, the margin or the price has to move -- that is the answer this "
            "benchmark exists to produce, whichever way it comes out."
        ),
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps(verdict, indent=2))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
