"""Labelled cases for `prompts.detect_frustration`, the sole router into EMPATHY mode.

WHY THE NEGATIVES MATTER AS MUCH AS THE POSITIVES
----------------------------------------------------
`decide_mode` assigns empathy LAST, so it overrides debug, teaching, explain, followup and general
alike — and `mode == "empathy"` also disables the LoRA adapter (`main.py:941`, `:1037`). A false
positive therefore costs a learner their bug report and answers them from the base model instead.
Any change that raises recall has to be checked against that, which is why this file carries both
directions and why it exists BEFORE the detector was rewritten rather than after.

WHAT IS READ RATHER THAN COPIED
----------------------------------
The empathy gold messages and the catalogue prompts are read from their source files at call time.
Copying them here would let the guard drift away from the corpus it is supposed to protect — the
same failure as a gold set whose scenarios stop matching the product.

ONE LABEL THAT LOOKS WRONG AND IS NOT
----------------------------------------
`eval_mt_frustration_reverse_list_001` lives in the DEBUG gold set, and its message is textbook
distress ("I give up. I'm terrible at coding..."). It is there to test debug behaviour under
frustration. Detecting it is CORRECT; counting it as a false positive would train the detector to
ignore real distress, so it is listed as a positive here.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: U+2019, what iOS and macOS autocorrect produce in place of a typed apostrophe.
CURLY = "’"  # noqa: RUF001 - U+2019 is the character under test, not a typo


def empathy_gold_messages() -> list[str]:
    """The 9 authored empathy scenarios, read from the gold set they are scored against."""
    path = ROOT / "llm" / "data" / "eval_empathy_gold.jsonl"
    return [json.loads(line)["user_message"]
            for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def catalogue_prompts(limit: int | None = None) -> list[str]:
    """Real ML questions from `content/**/*.yaml` — definitionally not distress.

    The bulk negative set. Formal technical prose is where a substring detector is LEAST likely to
    misfire, so a false positive here means something has gone badly wrong rather than subtly.
    """
    import yaml

    out: list[str] = []
    for f in sorted((ROOT / "content").rglob("*.y*ml")):
        data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        for key in ("prompt", "description", "approach"):
            value = data.get(key)
            if isinstance(value, str) and 20 < len(value) < 600:
                out.append(value)
        if limit and len(out) >= limit:
            break
    return out


def with_curly_apostrophes(messages: list[str]) -> list[str]:
    """The same messages as a phone would send them. Only those that actually contain an
    apostrophe — the rest would be identical and would pad the score."""
    return [m.replace("'", CURLY) for m in messages if "'" in m]


#: Distress that lives in the debug gold set. See the module docstring.
DISTRESS_FILED_UNDER_DEBUG = (
    "I give up. I'm terrible at coding, I don't understand any of this."
)

#: Ordinary ways a person says they are struggling, none of which the original list matched.
#: Every one of these was a MISS at baseline.
UNMATCHED_PHRASINGS = (
    "I've been stuck on this for an hour and I feel so dumb.",
    "I don't think I'm ever going to get this. Everyone else seems to find it obvious.",
    "Genuinely, should I just quit?",
    "I'm just too stupid for this stuff.",
    "honestly I feel like an idiot asking this",
)

#: Statements a learner makes ABOUT CODE that a substring detector mistakes for distress.
#: All nine fired at baseline. These are the cost of raising recall carelessly.
HARD_NEGATIVES = (
    # negation and attribution — the words appear, the sentiment is the opposite
    "don't give up!",
    "you told me not to give up",
    "my tutor said don't give up",
    "I refuse to give up",
    # the distress word is about the PROGRAM, not the person
    "the docs say this is pointless to optimise",
    "this loop runs pointlessly twice",
    "we can't do this in O(1)",
    "the pointer is pointless here",
    "i sucked the value out of the array",
    # THE STUDENT SAYING THEY ARE NOW FINE. These are the only cases that actually reach the
    # negation guard — every other negative above is handled by first-person requirements or by
    # the removal of the bare "give up" / "hopeless" / "pointless" tokens. Without the guard both
    # of these route a recovering student into emotional support, which is the most patronising
    # failure available. Found by mutating the guard away and discovering nothing broke.
    "i'm not so confused anymore",
    "not completely lost, just the last bit",
)

#: Mild confusion. `detect_frustration`'s own docstring says these must NOT fire — they belong to
#: followup mode. A detector that grabs them turns every ordinary question into a pep talk.
MILD_CONFUSION = (
    "idk",
    "not sure",
    "I don't understand. Why does left equal right matter?",
    "wait, why does that work?",
    "hmm, confused about the second line",
)


def positives() -> list[str]:
    """Everything that must route to empathy, including phone-typed apostrophe variants."""
    gold = empathy_gold_messages()
    return [*gold, *with_curly_apostrophes(gold), *UNMATCHED_PHRASINGS,
            DISTRESS_FILED_UNDER_DEBUG,
            *with_curly_apostrophes(list(UNMATCHED_PHRASINGS))]


def negatives() -> list[str]:
    """Everything that must not. Curated — see the module docstring on the one gold label that is
    wrong for routing purposes and is therefore excluded from here."""
    return [*HARD_NEGATIVES, *MILD_CONFUSION]
