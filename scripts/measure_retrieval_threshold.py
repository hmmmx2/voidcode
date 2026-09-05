"""Measure the similarity threshold instead of guessing it.

Run:  python scripts/measure_retrieval_threshold.py

`features/retrieval.py` shipped with `min_similarity = 0.35`, chosen by intuition before any corpus
existed. Once the corpus was real that value admitted **4 of 4 off-topic queries** — the tutor would
have cited a KV-cache paper to someone asking about sourdough, with a citation making it look
authoritative.

The threshold is the only thing standing between "no source for that" and a confident answer built
from unrelated material, and it is embedder- and corpus-specific. A value carried over from a
different embedder is a value that has silently stopped working, so this exists to re-derive it
whenever either changes.

WHY BOTH SETS ARE NEEDED
---------------------------
Measuring only on-topic queries produces a threshold that keeps everything, including junk.
Measuring only off-topic produces one that rejects everything. The number worth having is the gap
between them — and if that gap is small or negative, the honest conclusion is that no threshold
works and the embedder or chunking needs changing, not that the threshold needs tuning.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps" / "api"))

#: Questions the corpus genuinely covers. Phrased as a learner would ask, not as the document is
#: written — matching the document's own wording measures nothing.
ON_TOPIC = [
    "why is the kv cache smaller with grouped query attention?",
    "which zero stage should I use on a slow interconnect?",
    "how does paged attention reduce memory waste?",
    "does lora make the model smaller?",
    "is speculative decoding lossy?",
    "what does gradient checkpointing cost in compute?",
    "why is adamw different from adam with weight decay?",
    "how does rope encode relative position?",
    # ── added with the corpus expansion, one per new document ────────────────
    #
    # THE PROBE SET IS PART OF THE MEASUREMENT. The corpus went from 10 documents to 30 and this
    # script reported an IDENTICAL gap of 0.068 — because all eight queries above concern the
    # original ten, so the twenty new documents were never queried. An unchanged number from an
    # unchanged probe set is not evidence that anything held; it is evidence that nothing was
    # tested. Every document needs a question, or its worst case is invisible.
    "why does fp16 training need loss scaling?",
    "how does tensor parallelism split a transformer layer?",
    "what is the pipeline bubble and how do I shrink it?",
    "how is continuous batching different from static batching?",
    "how does gptq decide which weights to round?",
    "what is the difference between time to first token and inter-token latency?",
    "what happens when mixture of experts routing is unbalanced?",
    "what does top-p sampling actually truncate?",
    "how does a bpe tokenizer handle a word it has never seen?",
    "how is rmsnorm different from layernorm?",
    "why does grpo not need a value network?",
    "why does clip need such a large batch size?",
    "how many tokens does a vision transformer produce for an image?",
    "how does llava connect a vision encoder to a language model?",
    "how is triton different from writing raw cuda?",
    "what does arithmetic intensity tell me about a kernel?",
    "what makes a memory access uncoalesced on a gpu?",
    "how big is the kv cache for a 7b model?",
    "why do transformers need learning rate warmup?",
    "how does fsdp differ from ddp?",
]

#: Plainly unrelated. If any of these clears the threshold, the tutor will cite a paper at someone
#: who asked about something else entirely.
OFF_TOPIC = [
    "what is the best sourdough hydration ratio",
    "how do I change a car tyre",
    "who won the 1998 world cup",
    "best hiking trails in scotland",
    "how long should I boil an egg",
    # More off-topic probes for the same reason: the ceiling is a MAXIMUM over this list, so five
    # samples estimate it poorly. These are deliberately adjacent-sounding in places — "attention"
    # and "transformer" appear in ordinary English — because the easy off-topic cases were already
    # scoring 0.36 and it is the near misses that set the real ceiling.
    "what temperature should I roast a chicken at",
    "how do I fix a leaking tap",
    "why does my car make a grinding noise when braking",
    "how much attention should I give a new puppy",
    "what transformer do I need for european appliances",
]


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
    import os

    import httpx
    from sqlalchemy import select
    from src.database import AsyncSessionLocal
    from src.models import KnowledgeDocument

    from features.retrieval import retrieve

    def embed(text: str) -> list[float]:
        # Env-configured, matching apps/api/src/main.py::_get_embedder. These were hardcoded to
        # 127.0.0.1 while main.py read EMBEDDING_BASE_URL, so a deployed API and the script that
        # seeded its corpus could silently use DIFFERENT embedders. retrieve() raises on a dimension
        # mismatch, but two 768-dim models that disagree on direction produce meaningless neighbours
        # with no error at all -- the worst version of this failure.
        base = os.environ.get("EMBEDDING_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
        model = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")
        r = httpx.post(f"{base}/api/embeddings",
                       json={"model": model, "prompt": text}, timeout=60)
        r.raise_for_status()
        return r.json()["embedding"]

    async def run() -> int:
        async with AsyncSessionLocal() as session:
            docs = (await session.execute(select(KnowledgeDocument))).scalars().all()
        if not docs:
            print("corpus is empty; run scripts/seed_knowledge.py --write first")
            return 1

        def top1(q: str) -> float:
            # min_similarity=-1 so nothing is filtered: we are measuring the distribution the
            # threshold will later be drawn from, and filtering first would beg the question.
            hits = retrieve(embed(q), docs, min_similarity=-1.0, top_k=1)
            return hits[0].similarity if hits else 0.0

        on = [(q, top1(q)) for q in ON_TOPIC]
        off = [(q, top1(q)) for q in OFF_TOPIC]

        print(f"corpus: {len(docs)} documents\n")
        print("  on-topic")
        for q, s in sorted(on, key=lambda x: x[1]):
            print(f"    {s:.3f}  {q}")
        print("  off-topic")
        for q, s in sorted(off, key=lambda x: -x[1]):
            print(f"    {s:.3f}  {q}")

        lo_on, hi_off = min(s for _, s in on), max(s for _, s in off)
        gap = lo_on - hi_off
        print(f"\n  worst on-topic {lo_on:.3f} | best off-topic {hi_off:.3f} | gap {gap:+.3f}")

        if gap <= 0:
            # Not a tuning problem. Say so rather than picking the least-bad number, because a
            # threshold chosen from an overlapping distribution will fail on the next query
            # either way.
            print("\n  NO THRESHOLD SEPARATES THESE. The distributions overlap, so any value")
            print("  either admits junk or rejects real questions. Change the embedder or the")
            print("  chunking; do not pick a number from this.")
            return 1

        # THE MIDPOINT, not the lowest value that admits zero off-topic.
        #
        # That was the original rule and it chose 0.50 when the best off-topic query scored 0.496 —
        # four thousandths of margin. It "passed" every check while sitting on the edge of the
        # off-topic distribution, so any corpus edit could flip it and the symptom would be the tutor
        # citing a bread recipe. The midpoint spends the gap evenly on both sides.
        midpoint = (lo_on + hi_off) / 2
        print(f"\n  RECOMMENDED: {midpoint:.3f} - the midpoint of the gap, giving "
              f"{midpoint - hi_off:+.3f} against off-topic and "
              f"{lo_on - midpoint:+.3f} against on-topic.")
        print("  Set features.retrieval.MIN_SIMILARITY to this, not to the lowest value")
        print("  that happens to admit zero off-topic - that rule leaves all the margin")
        print("  on one side.\n")

        for t in (0.40, 0.45, 0.50, 0.55, 0.60):
            keeps = sum(1 for _, s in on if s >= t)
            admits = sum(1 for _, s in off if s >= t)
            mark = "  <- safe, but check the margin above" if keeps == len(on) and admits == 0 else ""
            print(f"  threshold {t:.2f}: keeps {keeps}/{len(on)} on-topic, "
                  f"admits {admits}/{len(off)} off-topic{mark}")

        print(f"\n  A gap of {gap:.3f} is narrow. Re-run this whenever the embedder or the corpus")
        print("  changes materially, and treat a shrinking gap as a signal about retrieval quality")
        print("  rather than something to tune around.")
        return 0

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
