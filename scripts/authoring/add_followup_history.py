"""Give the followup scenarios the conversation they refer to.

THE MODE WAS NEVER EXERCISED.
All four followup scenarios open with a back-reference — "You said…", "Earlier you mentioned…",
"Follow up:", "Following on from that…" — and carried NO `messages` history. The model was asked to
continue a conversation it had never been given.

Three answered the dangling question standalone and happened to be fine. The fourth invented a prior
topic and refused to answer: *"it seems we've shifted topics away from our current discussion on LLM
inference batching and KV cache management"*. That is not a model defect, it is the only sensible
response to a reference with no referent.

Production sends the full conversation, so the scenarios were testing something the product never
does.

WHAT THE PRIOR TURN MUST AND MUST NOT CONTAIN
---------------------------------------------
It must make the back-reference resolvable: the assistant must actually have said the thing the
learner refers to. It must NOT contain the answer, or `must_mention` becomes a test of whether the
model can copy from its own context — the check would pass for the wrong reason and the mode would
look fixed while measuring nothing. So each prior turn raises the topic and stops.

Written as a script rather than by hand-editing the JSONL so the construction is reviewable and the
"does not contain the answer" property is asserted rather than eyeballed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLD = ROOT / "llm" / "data" / "eval_followup_gold.jsonl"

#: The exchange each back-reference points at. The assistant turn names the topic and stops short of
#: the mechanism the learner then asks about.
PRIOR = {
    "followup_batchnorm_eval_001": [
        ("user", "Why does my model give different results in train mode versus eval mode?"),
        ("assistant",
         "A couple of layer types deliberately behave differently in the two modes — normalisation "
         "layers are the usual culprit, and dropout is the other. Which of those is in your model?"),
    ],
    "followup_lr_warmup_001": [
        ("user", "I'm setting up a training schedule for a transformer. Anything I should add?"),
        ("assistant",
         "Most transformer schedules start with a warmup phase before the main decay. Have you "
         "included one, and do you know what it is there to protect against?"),
    ],
    "followup_dropout_inference_001": [
        ("user", "I added dropout to my network and the training loss looks noisier than before."),
        ("assistant",
         "That is expected — dropout randomly removes units during training, so each step sees a "
         "slightly different network. What do you think should happen to that behaviour when you "
         "stop training and start predicting?"),
    ],
    "followup_tokenizer_oov_001": [
        ("user", "How does the model turn my text into numbers?"),
        ("assistant",
         "Through a tokenizer — most modern LLMs use byte pair encoding rather than a fixed word "
         "list. What do you think that means for a word the tokenizer has never encountered?"),
    ],
}


def prune_echo_keywords(row: dict) -> list[str]:
    """Drop `must_mention` keywords the learner already used in their own question.

    Two of the four scenarios required a keyword that appears verbatim in the question:
    `batch` in "You said **batch** norm…", `inference` in "is dropout active when I run
    **inference**?". A model satisfies those by echoing, so they measure nothing.

    Worse, they were flattering the figure. In both scenarios the model covered exactly 1 of 2 —
    and the one it covered was the echo keyword, with the substantive one missed. Reported as
    "covered 1 of 2", the true substantive coverage was zero.

    Pruning them makes the check HARDER in practice, not easier: the free pass that padded `covered`
    is gone and only the substance remains.
    """
    question = row["user_message"].lower()
    return [kw for kw in row.get("must_mention", []) if kw.lower() not in question]


def main() -> int:
    rows = [json.loads(line) for line in GOLD.read_text(encoding="utf-8").splitlines() if line.strip()]
    changed = 0
    for row in rows:
        pruned = prune_echo_keywords(row)
        if pruned != row.get("must_mention"):
            dropped = [k for k in row.get("must_mention", []) if k not in pruned]
            print(f"  {row['id']}: dropped echo keyword(s) {dropped}, kept {pruned}")
            row["must_mention"] = pruned
        prior = PRIOR.get(row["id"])
        if not prior:
            print(f"  !! no prior turn authored for {row['id']} — leaving it alone")
            continue
        if row.get("messages"):
            print(f"  {row['id']}: already has history, skipped")
            continue

        # THE PRIOR TURN MUST NOT GIVE THE ANSWER AWAY. If it contained the required keywords, the
        # model could satisfy `must_mention` by echoing its own context and the check would certify
        # a fix that never happened.
        prior_text = " ".join(text for _role, text in prior).lower()
        leaked = [kw for kw in row.get("must_mention", []) if kw.lower() in prior_text]
        if leaked:
            print(f"  !! {row['id']}: prior turn contains required keyword(s) {leaked} — REFUSING")
            return 1

        row["messages"] = [{"role": r, "content": t} for r, t in prior]
        row["messages"].append({"role": "user", "content": row["user_message"]})
        changed += 1
        print(f"  {row['id']}: added {len(prior)} prior turn(s)")

    GOLD.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                    encoding="utf-8")
    print(f"\n  wrote {GOLD.name}: {changed} scenario(s) given history")
    return 0


if __name__ == "__main__":
    sys.exit(main())
