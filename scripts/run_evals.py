"""Unified tutor evaluation. V6.

    python scripts/run_evals.py --score results.json        # score cached responses, no GPU
    python scripts/run_evals.py --api-url http://localhost:8020 --run   # generate then score

WHAT WAS WRONG WITH THE EXISTING HARNESS, AND WHY THIS IS A NEW FILE
----------------------------------------------------------------------
`llm/scripts/evaluate_debug_quality.py` works and is kept. Three things it does not do:

1. **It is DEBUG only.** `prompts.py` routes six modes; teaching, explain, followup and empathy have
   no gold set at all, so most of the product is unevaluated.
2. **It scores format compliance, not correctness.** All six of its checks are regex or substring
   matches against the v5.3 `Issue N — Line X` layout. Because production is prompt-engineered,
   editing `PE_DEBUG_PROMPT` moves the scores without the tutor getting better or worse — the metric
   partly measures the prompt it is testing.
3. **It reports bare rates.** 11/33 is a rate over 33 samples with per-check subsets as small as one
   scenario, and a rate without its denominator invites exactly the mistake this project already
   made once: reporting a 33.6% improvement that was smaller than its own noise floor.

THE CHECK THAT IS ACTUALLY ABOUT CORRECTNESS
----------------------------------------------
`eval_debug_gold.jsonl` carries `ground_truth_bugs: [{line, type, description}]` and the existing
harness never compares against those line numbers — `source_code_citation` only asserts that *some*
valid line was cited. A tutor confidently pointing at the wrong line passes it.

`check_bug_localisation` compares the cited line set against the ground-truth lines and reports
recall and precision. It depends on no output format beyond "a line number appears somewhere", so it
survives a prompt rewrite, which is the property the other six lack.

WILSON INTERVALS, NOT BARE RATES
----------------------------------
Every rate is reported with its denominator and a 95% Wilson interval. At n=33 a rate of 0.33 has an
interval roughly [0.19, 0.51] — wide enough that a change of a few points means nothing, and stating
that up front is cheaper than discovering it after acting on it. Wilson rather than normal because
it stays inside [0,1] and behaves at small n, which is the regime every bucket here is in.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Gold sets, by mode. The debug set is the existing 33 scenarios; the rest are added here.
#: THE ORIGINAL 33 ARE FROZEN. `eval_baseline_before_v53.json` records 11/33 against exactly those
#: scenarios, so adding the medium and hard cases to that file would change the denominator and make
#: every later comparison against 11/33 a comparison of two different populations wearing one
#: number. The extended set lives beside it, and `summarise` reports the frozen subset as its own
#: bucket so the baseline stays a like-for-like reference.
#: The single file the published 11/33 was measured on. Named separately because "the frozen set"
#: is a property of THIS file, not of gold sets in general.
FROZEN_DEBUG_GOLD = ROOT / "llm" / "data" / "eval_debug_gold.jsonl"

GOLD_FILES = {
    "debug": [ROOT / "llm" / "data" / "eval_debug_gold.jsonl",
              ROOT / "llm" / "data" / "eval_debug_gold_extended.jsonl"],
    "empathy": ROOT / "llm" / "data" / "eval_empathy_gold.jsonl",
    "teaching": ROOT / "llm" / "data" / "eval_teaching_gold.jsonl",
    "explain": ROOT / "llm" / "data" / "eval_explain_gold.jsonl",
    "followup": ROOT / "llm" / "data" / "eval_followup_gold.jsonl",
}

_LINE_REF = re.compile(r"[Ll]ine\s*:?\s*(\d+)")

# ── Answer-leak patterns, one per rubric row (docs/LEAK_RUBRIC.md) ───────────────────────────────
#
# Row 1 — a complete function with a return and no blanks left to fill.
#: Python, including annotated signatures. The old pattern lacked `(?:->…)?` and so missed every
#: `def f(x) -> list:` outright.
_COMPLETE_DEF = re.compile(
    r"def\s+\w+\s*\([^)]*\)\s*(?:->[^:\n]+)?\s*:(?:[^\n]*\n)+?\s*return\s+\S+", re.M)
#: Brace languages. `PE_DEBUG_PROMPT` is explicitly multi-language and ships Java and C# worked
#: examples, so a Python-only check could not see a leaked method in the languages the prompt
#: most often produces.
_COMPLETE_BRACE_FN = re.compile(
    r"(?:public|private|protected|internal|static|final|async|function|func)\s"
    r"[^\n{;]{0,80}\([^)]*\)\s*\{"
    r"(?:[^{}]|\{[^{}]*\})*?"
    r"\breturn\b[^;\n]{0,80};", re.M)

# Row 3 — the fix stated in prose. The old scorer passed this deliberately
# (`test_prose_about_the_fix_is_not_leakage`); the rubric reverses that call, so the measured rate
# is EXPECTED to rise. Prose is not a hiding place for the answer.
_PROSE_FIX = re.compile(
    r"\b(?:change|replace|swap|switch|convert)\s+(?:the\s+|your\s+|it\s+)?"
    r"[`'\"][^`'\"\n]{1,40}[`'\"]\s*(?:to|with|for)\s*[`'\"][^`'\"\n]{1,40}[`'\"]"
    r"|\buse\s+[`'\"][^`'\"\n]{1,40}[`'\"]\s+(?:instead\s+of|rather\s+than)"
    r"|\b(?:should|needs?\s+to|has\s+to|must)\s+be\s+[`'\"][^`'\"\n]{1,40}[`'\"]",
    re.I)
#: The same row, stated as a bare imperative with no code tokens to key on --
#: "Swap the two indices in your return statement". The VERB carries the whole distinction:
#: swap/replace/change instruct, while look/check/trace/consider guide. Only the instructing verbs
#: are listed, because a guiding imperative is the hint format working as intended (rows 5-6, 8).
_PROSE_FIX_IMPERATIVE = re.compile(
    r"(?:^|[.!?]\s+|\n\s*(?:[-*]|\d+\.)?\s*)"
    r"(?:swap|replace|switch|invert|reverse|negate|initiali[sz]e)\s+"
    r"(?:the|your|it|its|a|an|both|those|these)\s+[^.\n?]{3,70}",
    re.I | re.M)

# Row 7 — a question whose answer IS the fix. `asks_a_question` is at ceiling while leakage fails,
# which is the tutor asking a question and then answering it; scoring this row clean would make the
# two checks agree by construction and measure nothing.
_LEADING_QUESTION = re.compile(
    r"\b(?:should|shouldn'?t)\s+(?:it|this|that|you|we|the\s+\w+|\w+)\s+"
    r"(?:be|use|call|return)\s+[`'\"][^`'\"\n]{1,30}[`'\"][^?\n]{0,40}\?", re.I)

#: Rubric rows this scorer implements. Rows 2, 4 and 5-6 boundaries and 8 are SEMANTIC -- whether a
#: description names "the exact defect" or a question has "one obvious answer" is a judgement, not a
#: pattern. They are labelled by hand during calibration and are NOT covered here. Naming the gap
#: keeps a partial scorer from reading as a complete one.
LEAK_ROWS_COVERED = ("1", "3", "7", "11")
LEAK_ROWS_UNCOVERED = ("2", "4", "9-boundary")

# ── Disclosure ladder (docs/LEAK_RUBRIC.md) ──────────────────────────────────────────────────────
#
# Level 3 — binary confirmation: the answer is supplied and only assent is left. Includes the
# question form, because "Try changing `bucket=[]` to `bucket=None`?" is the fix wearing a question
# mark. This is what the retired row 7 was reaching for, positioned on the ladder instead.
_L3_CONFIRM = re.compile(
    r"\b(?:should|shouldn'?t)\s+(?:it|this|that|you|we|the\s+\w+|\w+)\s+"
    r"(?:be|use|call|return)\s+[`'\"][^`'\"\n]{1,30}[`'\"]"
    r"|\btry\s+(?:changing|replacing|swapping|setting)\s+[^.\n?]{0,60}"
    r"|\b(?:change|replace|swap|switch)\s+(?:the\s+|your\s+|it\s+)?"
    r"[`'\"][^`'\"\n]{1,40}[`'\"]\s*(?:to|with)\s*[`'\"][^`'\"\n]{1,40}[`'\"]",
    re.I)

# Level 2 — names the exact line AND the token. This is PE_DEBUG_PROMPT's own mandated Issue format,
# which is why it is a rung rather than a failure.
_L2_LINE_AND_TOKEN = re.compile(
    r"[Ll]ine\s*:?\s*\d+[^\n]{0,120}?[`'\"][^`'\"\n]{1,30}[`'\"]"
    r"|\*\*Issue\s*\d+\s*[-—]\s*Line\s*\d+\*\*", re.I)

# Level 1 — points at a region, no token named. Structural words for "where", without backticks.
_L1_REGION = re.compile(
    r"\b(?:your|the)\s+(?:loop|condition|return statement|base case|initiali[sz]ation|"
    r"comparison|bound|index|recursion|iteration|assignment)\b", re.I)

DISCLOSURE_LEVELS = {
    0: "conceptual question about behaviour; no location",
    1: "points at a region and the symptom; no token",
    2: "names the exact line and the exact defect, including the token",
    3: "binary confirmation; the answer is supplied",
    4: "corrected code, or the corrected line stated outright",
}


#: The production line-number gutter, byte-for-byte as `build_messages` and `VoidCodeAIPanel.tsx`
#: emit it. Stripped before any echo comparison because `_COMPLETE_DEF` ends on `\s*return\s+\S+`,
#: which cannot match `  3 |     return bucket` -- so when the model echoes the NUMBERED source the
#: span runs past the end of the function into prose, and an ungutted comparison never matches.
_GUTTER = re.compile(r"^[ \t]*\d{1,4}[ \t]*\|[ \t]?", re.M)

#: `PE_DEBUG_PROMPT`'s own mandated opening (`prompts.py:503`: 'First sentence = "I found N
#: issue(s) in your code."'), quoted back by the model while it plans its reply. Measured over nine
#: runs, this was 57-71 of the level-4 prose hits depending on how the `N`->`1` substitution is
#: counted. Reciting an instruction is not stating a remedy; scoring it as one measured the prompt.
_OWN_TEMPLATE = re.compile(r"I found\s+\*{0,2}\s*(?:\d+|N)\s*\*{0,2}\s*issue", re.I)

#: The prompt also mandates closing on a question, and the model plans that too -- "the last
#: character must be `?`". A quoted span that is punctuation is not a remedy. Deliberately NOT
#: "short span": `should be \`n\`` is one alphanumeric character and IS a real fix.
_TRIVIAL_QUOTE = re.compile(r"[`'\"]([^`'\"\n]*)[`'\"]")


def _echoes_the_students_code(span: str, source_code: str) -> bool:
    """Is this span the learner's OWN code, reproduced?

    QUOTING THE STUDENT'S BUGGY FUNCTION IS NOT DISCLOSING A FIX. They wrote it and they have it
    open in the editor. Quoting it WITH AN EDIT is disclosure, and the difference between the two
    is exact equality -- so the comparison is line by line with indentation PRESERVED. Normalising
    whitespace would excuse a corrected version differing only in indentation, and in Python
    indentation is semantics: moving `return total` out of the loop is a real fix.

    DELIBERATELY NOT `_quote_is_selective`. That answers "what share of the file was echoed", which
    is the right question for `check_bug_localisation` and the wrong one here. Measured over nine
    runs: every genuine corrected-code leak lives in a response that echoes MORE than half the
    source -- the model restates the program and then corrects it -- so a selectivity-based
    exemption would excuse 100% of the real leaks.

    Both ENDS of the span are ragged for mechanical reasons, and only the ends are forgiven:

    * the FIRST line loses its leading indentation, because `_COMPLETE_DEF` starts matching at
      `def` rather than at the start of the line -- so an echoed `    def twoSum(...)` inside a
      `class Solution:` arrives as `def twoSum(...)`. Compared with `lstrip()`. This does not open
      a hole: a genuinely corrected function still differs on a BODY line, which is compared exact.
    * the LAST line need only be a PREFIX of the source line, because the pattern ends on a
      non-greedy `return \\S+`, truncating `return total / len(nums)` to `return total`.

    Found by the false-positive check on the survivors: 3 of 37 v7 hits were echoes carrying the
    production line-number gutter that this guard had not exempted.
    """
    if not source_code:
        return False
    span_lines = [ln.rstrip() for ln in _GUTTER.sub("", span).splitlines() if ln.strip()]
    src_lines = [ln.rstrip() for ln in source_code.splitlines() if ln.strip()]
    if not span_lines or len(span_lines) > len(src_lines):
        return False
    for i in range(len(src_lines) - len(span_lines) + 1):
        window = src_lines[i:i + len(span_lines)]
        if [ln.lstrip() for ln in window[:-1]] != [ln.lstrip() for ln in span_lines[:-1]]:
            continue
        if not window[-1].lstrip().startswith(span_lines[-1].lstrip()):
            continue
        # THE CONTENT MATCHES; NOW ASK WHETHER THE STRUCTURE DOES. Comparing text after `lstrip`
        # would excuse a real fix, because in Python indentation IS semantics -- moving
        # `return total` out of the loop changes the answer and is exactly the bug in several
        # scenarios. But a UNIFORM shift is not an edit: the model that de-dents a method out of
        # `class Solution:` has reproduced the code, not corrected it. The two are separable, and
        # this is the separation: every line's indent must differ from the source by the SAME
        # amount. Line 0 is excluded because its indentation is a regex artifact -- the pattern
        # starts matching at `def`, after the leading whitespace.
        deltas = {(len(w) - len(w.lstrip())) - (len(s) - len(s.lstrip()))
                  for w, s in zip(window[1:], span_lines[1:], strict=True)}
        if len(deltas) <= 1:
            return True
    return False


def _recites_its_own_prompt(span: str) -> bool:
    """Is this the model quoting a formatting rule back to itself, rather than stating a fix?

    Two shapes, both measured: the mandated opening sentence, and the mandated closing question
    mark. Both reach `_PROSE_FIX` through its `(should|must) be "..."` arm.
    """
    if _OWN_TEMPLATE.search(span):
        return True
    quoted = [q.strip() for q in _TRIVIAL_QUOTE.findall(span)]
    return bool(quoted) and all(q and not any(c.isalnum() for c in q) for q in quoted)


def disclosure_level(text: str, scenario: dict | None = None) -> dict:
    """How far up the ladder does this response go? Returns {level, evidence}.

    `scenario` IS OPTIONAL, AND ITS ABSENCE IS THE STRICT READING. With no scenario there is no
    source to compare against, so nothing is exempted and the verdict is exactly what it was before
    this parameter existed. That is the compatibility contract with the existing call sites, and it
    fails in the safe direction: a caller who forgets to thread the scenario OVER-reports
    disclosure rather than under-reporting it.

    THE BINARY LEAK CHECK IT REPLACES COULD NOT ANSWER THE QUESTION THAT MATTERS.
    "What operator should replace `<`?" is a legitimate late move and a poor opener, and no rubric
    scoring a sentence in isolation can tell those apart. So the sentence is placed on a ladder and
    the GATE is about where the tutor starts, not whether any one sentence names a token.

    The level is the HIGHEST rung reached, because the learner receives the whole response: a reply
    that opens at 1 and closes at 3 is a 3.

    Level 4 subsumes the old leak check -- corrected code is unambiguously the top rung -- but the
    binary rate built on it is retired rather than defended, per `docs/LEAK_RUBRIC.md`.
    """
    t = text or ""
    if not t.strip():
        return {"level": 0, "evidence": "", "note": "empty"}
    src = (scenario or {}).get("source_code") or ""

    # THE GUTTER IS STRIPPED BEFORE THE CODE PATTERNS RUN, AND THAT IS A CORRECTNESS FIX, NOT
    # TIDYING. `_COMPLETE_DEF` terminates on `\s*return\s+\S+`, which cannot match the production
    # rendering `  8 |     return []`. So when the model echoes the LINE-NUMBERED source -- which
    # is the shape the frontend sends -- the match does not stop at the end of the function. It
    # runs through the closing fence and on through pages of prose until some later un-guttered
    # `return`, producing one span of 30+ lines that is mostly commentary. Measured: that span is
    # then longer than the whole file, so no echo test can recognise it, and the scorer reports
    # "the model wrote a complete corrected function" about a verbatim quote of the student's own.
    t_code = _GUTTER.sub("", t)

    # AN EXEMPT SPAN IS SKIPPED, NOT RETURNED ON. The old loops returned level 4 at the first
    # match, so exempting that match by returning early would let an echo HIDE a correction later
    # in the same response. Measured: the genuine leaks all OPEN with a verbatim echo of the
    # source and CLOSE on the corrected function, so scanning past the exemption is precisely what
    # catches them.
    for pattern, why in ((_COMPLETE_DEF, "complete definition"),
                         (_COMPLETE_BRACE_FN, "complete method")):
        for m in pattern.finditer(t_code):
            if _scaffolded_span(t_code, *m.span()) or _echoes_the_students_code(m.group(0), src):
                continue
            return {"level": 4, "evidence": m.group(0)[:160].strip(), "why": why}
    for pattern, why in ((_PROSE_FIX, "fix stated outright"),
                         (_PROSE_FIX_IMPERATIVE, "fix as imperative")):
        for m in pattern.finditer(t):
            if _recites_its_own_prompt(m.group(0)):
                continue
            return {"level": 4, "evidence": m.group(0)[:160].strip(), "why": why}

    m = _L3_CONFIRM.search(t)
    if m:
        return {"level": 3, "evidence": m.group(0)[:160].strip(), "why": "binary confirmation"}
    m = _L2_LINE_AND_TOKEN.search(t)
    if m:
        return {"level": 2, "evidence": m.group(0)[:160].strip(), "why": "line and token named"}
    m = _L1_REGION.search(t)
    if m:
        return {"level": 1, "evidence": m.group(0)[:160].strip(), "why": "region named"}
    return {"level": 0, "evidence": "", "why": "no location disclosed"}


def check_opening_disclosure(response: str, scenario: dict) -> dict:
    """The gate: how much does the tutor give away in its OPENING move?

    Only meaningful on a first turn, so it opts out for multi-turn scenarios rather than scoring a
    later reply as though it were an opener. Escalation discipline -- level may rise only after a
    learner attempt -- is the other half of the gate and is **not** implemented here: the gold set
    has 3 multi-turn scenarios out of 75, so it cannot support a rate. See `docs/LEAK_RUBRIC.md`.

    Reported against BOTH candidate thresholds because the two decisions on record disagree (opening
    must be 0; opening must be 0 or 1). Picking one silently would bury the disagreement.
    """
    if scenario.get("messages"):
        return {"applicable": False, "reason": "not a first turn"}
    got = disclosure_level(response, scenario)
    return {"applicable": True,
            "level": got["level"],
            "evidence": got.get("evidence", ""),
            "why": got.get("why", ""),
            "passed": got["level"] <= 1,      # the 0-or-1 threshold
            "passed_strict": got["level"] == 0,  # the 0-only threshold
            }


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval. Returns (low, high); (0.0, 1.0) when n == 0.

    Normal-approximation intervals go negative or exceed 1 at the sample sizes here (buckets of 1 to
    6 scenarios), which is how a bucket of one gets reported as a confident result.
    """
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def cited_lines(response: str, max_line: int | None = None) -> set[int]:
    """Every line number the response refers to, optionally bounded by the source length."""
    lines = {int(m) for m in _LINE_REF.findall(response or "")}
    if max_line is not None:
        lines = {n for n in lines if 1 <= n <= max_line}
    return lines


#: Above this share of the source appearing verbatim, a quote no longer identifies anything.
#: Set from measurement: the responses that quoted the buggy line "correctly" without localising it
#: echoed 0.99 of the file on average. Legitimate selective quoting sits far below this.
_ECHO_CEILING = 0.5


def _quote_is_selective(text: str, src: list[str]) -> bool:
    """Did the response quote a FEW lines, or reproduce the file?

    Quoting the whole program matches every line including the buggy one, which reads as perfect
    localisation and is actually just verbosity. Measured on the streaming runs: 8 scenarios were
    credited this way, every one of them echoing ~100% of the source.
    """
    body = [line.strip() for line in src if line.strip()]
    if not body:
        return True
    echoed = sum(1 for line in body if line in text)
    return echoed / len(body) <= _ECHO_CEILING


def check_bug_localisation(response: str, scenario: dict) -> dict:
    """CORRECTNESS: did the tutor point at the lines that are actually wrong?

    The one check here that does not depend on output formatting. It needs a line number to appear
    somewhere and nothing else, so rewriting the prompt cannot move it — unlike the six format
    checks in the existing harness, which a prompt edit shifts on its own.

    `recall` is the headline: of the real bugs, how many were located. `precision` is reported
    beside it because a response listing every line in the file would score perfect recall, and
    naming that failure mode is cheaper than being surprised by it.
    """
    truth = {b["line"] for b in scenario.get("ground_truth_bugs", []) if "line" in b}
    if not truth:
        return {"applicable": False, "reason": "no ground_truth_bugs on this scenario"}
    src = (scenario.get("source_code") or "").splitlines()
    max_line = len(src) or None
    found = cited_lines(response, max_line)
    hit = truth & found

    # QUOTED-CODE MATCH, measured separately from the line number.
    #
    # The first run of this check scored 12.1% and that number was misleading. Inspection showed the
    # tutor quoting the exact buggy source line while citing a different line NUMBER: the gold set
    # counts lines within `source_code`, the model counts them within `user_message`, which prepends
    # a question and a ```python fence — a systematic offset of 2 in 30 of 33 scenarios.
    #
    # Correcting for that offset made the score WORSE (3/30 against 4/33), which rules out a simple
    # coordinate bug and shows the numbering is simply inconsistent. So the line-number check was
    # conflating two different abilities: FINDING the bug and NUMBERING it. They are now separate,
    # because a tutor that points at the right code with a wrong label is a formatting problem,
    # while one that points at the wrong code is a competence problem, and they need different fixes.
    quoted = set()
    text = response or ""
    for line_no in truth:
        if 1 <= line_no <= len(src):
            body = src[line_no - 1].strip()
            # A QUOTE ONLY LOCALISES IF IT IS SELECTIVE.
            #
            # This was briefly relaxed from `len(body) >= 12` to "unique in the source, any length",
            # on the reasoning that `return 0` identifies itself if it appears once. Diagnostic
            # localisation rose 0.647 -> 0.824 and the joint rate to 0.784, just under the gate.
            #
            # It was spurious. All 8 newly-credited scenarios echoed ~100% of the source in their
            # reasoning — the model restates the whole program before analysing it, so every line
            # matched, including the buggy one. The credit measured verbosity, not localisation.
            #
            # So selectivity is now required explicitly: a response that reproduces most of the file
            # gets no quoted-code credit at all, because quoting everything points at nothing. The
            # length floor stays as a second guard for accidental collisions on short lines.
            if len(body) >= 12 and body in text and _quote_is_selective(text, src):
                quoted.add(line_no)

    located = truth & (found | quoted)
    return {
        "applicable": True,
        # Passing on EITHER signal: the bug was identified, however it was labelled.
        "passed": truth.issubset(found | quoted),
        "recall": len(located) / len(truth),
        "precision": (len(hit) / len(found)) if found else 0.0,
        "by_line_number": truth.issubset(found),
        "by_quoted_code": truth.issubset(quoted),
        "expected_lines": sorted(truth),
        "cited_lines": sorted(found),
        "quoted_lines": sorted(quoted),
    }


#: `-1` in the frozen gold set means "do not score the count" — used by the multi-turn scenarios
#: where the bug count is not what is being tested.
COUNT_NOT_CHECKED = -1


def check_bug_count_accuracy(response: str, scenario: dict) -> dict:
    """Did the tutor say how many bugs there are, and was it right?

    SEPARATE FROM LOCALISATION ON PURPOSE, and the separation is what the evidence demanded.
    Measured on 51 debug scenarios: the tutor CLAIMED two issues 7 times while emitting two Issue
    blocks once. It writes "I found **2 issue(s)** in your code. Let's tackle the first one first",
    names one, and stops — at 473 characters against a 2048-token cap, so not truncation.

    That is Socratic one-step-at-a-time guidance, which is what the product is for, and
    `check_bug_localisation` scores it as a miss because it wants every ground-truth line in one
    turn. Counting is therefore a different ability from enumerating, and conflating them hides
    which one is actually weak. Neither replaces the other: a tutor that counts right and names
    nothing has not helped, and one that names a bug while miscounting leaves the learner thinking
    they are done.
    """
    expected = scenario.get("expected_bug_count")
    if expected is None or expected == COUNT_NOT_CHECKED:
        return {"applicable": False, "reason": "no expected_bug_count, or the -1 sentinel"}
    m = re.search(r"I found \*{0,2}(\d+)\s*issue", response or "", re.I)
    if not m:
        m = re.search(r"(?:there are|found)\s+(\w+)\s+(?:issues|bugs|problems)", response or "", re.I)
        words = {"one": 1, "two": 2, "three": 3, "four": 4, "no": 0}
        claimed = words.get(m.group(1).lower()) if m else None
    else:
        claimed = int(m.group(1))
    return {"applicable": True, "passed": claimed == expected,
            "claimed": claimed, "expected": expected,
            "stated_a_count": claimed is not None}


def check_no_invented_code(response: str, scenario: dict) -> dict:
    """The tutor must not quote code the learner did not write.

    Ported from `apps/api/scripts/audit_tutor.py`, where it was written for "a critique of a
    `random.shuffle` implementation that never existed" — and then never wired into this harness.
    Its absence is why a run full of invented code was reported as *poor bug localisation*: the
    tutor was answering about a different program, and `check_bug_localisation` can only say "the
    expected lines were not cited", which reads as a competence gap in finding bugs. It is a
    different failure with a different fix, and naming it correctly is the whole point.

    Non-trivial lines only: short fragments like `return []` occur in almost any program and would
    flag by coincidence. `____` marks a fill-in-the-blank scaffold, which is the teaching format
    rather than a claim about the learner's code.
    """
    src = scenario.get("source_code")
    if not src:
        return {"applicable": False, "reason": "no source_code on this scenario"}
    invented = []
    for block in re.findall(r"```(?:python|py)?\n(.*?)```", response or "", re.S):
        for line in block.split("\n"):
            body = line.strip()
            if len(body) < 12 or body.startswith(("#", "_", "...")) or "____" in body:
                continue
            if body not in src:
                invented.append(body)
    return {"applicable": True, "passed": not invented,
            "n_invented": len(invented), "examples": invented[:3]}


def _scaffolded_span(text: str, start: int, end: int) -> bool:
    """Is THIS span a fill-in-the-blank template, rather than the response containing one somewhere?

    The old check was `"____" in text` over the whole response, so a single scaffold anywhere
    whitelisted a fully-leaked function later in the same reply. Blanks excuse the span they are in.
    """
    return "____" in text[start:end]


def check_no_answer_leakage(response: str, scenario: dict) -> dict:
    """Does the learner still have to work out the fix themselves?

    Implements `docs/LEAK_RUBRIC.md`, which was written down BEFORE this was changed so that
    "did we improve" could not be answered by moving the definition.

    WHAT CHANGED, AND WHY THE RATE IS EXPECTED TO RISE
    --------------------------------------------------
    The previous implementation was one Python-only regex for `def … return`, plus a
    response-global `____` exemption. Four defects, all of which made it read cleaner than the
    tutor was:

      * **Python only.** `PE_DEBUG_PROMPT` is explicitly multi-language and ships Java and C#
        worked examples. A leaked Java method was structurally invisible.
      * **No annotated signatures.** `def f(x) -> list:` did not match at all.
      * **Prose passed by design.** `test_prose_about_the_fix_is_not_leakage` asserted that
        "Swap the two indices in your return statement" is acceptable. Under the rubric it is not —
        row 3. **This alone should raise the measured rate, and that rise is a correction.**
      * **Global scaffold exemption.** One `____` anywhere excused everything.

    Returns the matched spans, because a failure that says only `passed: false` cannot be
    adjudicated against a human label, and calibration is exactly an argument about specific text.

    Rows 2 and 4 — "the corrected line alone" and "names the exact line AND the exact defect" — are
    judgements rather than patterns and are **not** implemented; see `LEAK_ROWS_UNCOVERED`. The rate
    this returns is therefore a LOWER BOUND.
    """
    text = response or ""
    hits: list[dict] = []
    for row, pattern in (("1", _COMPLETE_DEF), ("1", _COMPLETE_BRACE_FN),
                         ("3", _PROSE_FIX), ("3", _PROSE_FIX_IMPERATIVE),
                         ("7", _LEADING_QUESTION)):
        for m in pattern.finditer(text):
            if _scaffolded_span(text, *m.span()):
                continue
            hits.append({"row": row, "span": m.group(0)[:160].strip()})
    return {"applicable": True, "passed": not hits,
            "hits": hits,
            "rows_hit": sorted({h["row"] for h in hits}),
            "rows_covered": list(LEAK_ROWS_COVERED),
            "rows_not_covered": list(LEAK_ROWS_UNCOVERED),
            # kept so older evidence files and the two downstream readers stay comparable
            "complete_definition": any(h["row"] == "1" for h in hits),
            "has_blanks": "____" in text}


def check_asks_a_question(response: str, scenario: dict) -> dict:
    """Teaching and debug modes should hand the next step back to the learner."""
    return {"applicable": True, "passed": "?" in (response or "")}


def check_mentions_required(response: str, scenario: dict) -> dict:
    """Did the answer cover the concepts the gold set says it must?

    `must_mention` entries are either a substring, or a LIST of substrings meaning "any of these".
    Substring matching is crude and honest about being crude: it catches an answer that never raised
    the topic at all, and claims nothing about whether what it said was right.

    A SINGLE SUBSTRING PER CONCEPT WAS TESTING VOCABULARY, NOT UNDERSTANDING.
    Measured over 30 followup scenarios: 21 of 30 failed this check while ZERO failed any other, and
    the failures were correct answers using different words --

        required `anneal`   answer "smoothly reduces the learning rate to near zero"
        required `mass`     answer "keeps adding them up until their total reaches p"
        required `leak`     answer "data contamination, where the model indirectly overfits"
        required `distance` answer "models that rely on dot products between feature vectors"

    The tell was the difficulty gradient running backwards: easy scenarios scored 0.143 against
    0.375 for hard ones, because an easy concept has more valid phrasings and exact matching
    punishes every one it did not anticipate.

    An alternative expressing the same concept is not a miss. Groups let a scenario say "this idea,
    however the tutor words it" while keeping the check deterministic and free -- no judge, no
    calibration, no second model.
    """
    raw = scenario.get("must_mention", [])
    if not raw:
        return {"applicable": False, "reason": "no must_mention on this scenario"}
    #: Each requirement is a group of acceptable surface forms; a bare string is a group of one.
    groups = [[s.lower() for s in g] if isinstance(g, (list, tuple)) else [str(g).lower()]
              for g in raw]
    text = (response or "").lower()
    missing = [g for g in groups if not any(form in text for form in g)]
    return {"applicable": True, "passed": not missing,
            "covered": len(groups) - len(missing), "required": len(groups),
            "missing": ["|".join(g) for g in missing]}


#: Structured debug furniture. EMPATHY_SYSTEM_PROMPT forbids all of it by name, and the reason is
#: not cosmetic: empathy mode is reached when a learner is frustrated, which usually means they are
#: mid-debug and their message still carries [MODE: DEBUG] / [SOURCE CODE] blocks. Regressing to a
#: correct debug report is still a failure, because the thing that was asked for was support.
_DEBUG_MARKERS = ("🔴", "🟢", "🟡", "[EXPLAIN]", "[TEMPLATE]", "[GUIDE]", "[SOURCE CODE]",
                  "[TEST CASE DETAILS]", "[MODE:")
# The dash variants are deliberate, not a typo ruff should normalise: the v5.3 header is written
# "Issue 1 — Line 4" with an em dash, and models reproduce it with an en dash or a hyphen just as
# often. Matching only one variant would let two thirds of the regressions through.
_ISSUE_HEADER = re.compile(r"issue\s*\d+\s*[—\-–:]", re.I)  # noqa: RUF001

#: Agreement with a learner's self-deprecation. EMPATHY_SYSTEM_PROMPT forbids this outright, and it
#: is the one failure here that does real harm rather than merely reading badly.
_AGREES_WITH_SELF_DEPRECATION = (
    "you're not good at", "you are not good at", "you're not cut out", "you are not cut out",
    "maybe this isn't for you", "maybe this is not for you", "you should quit",
    "you should give up", "perhaps programming isn't", "perhaps programming is not",
    "you may not have the aptitude", "it's true that you", "yes, you are struggling because you",
)


def check_no_debug_markers(response: str, scenario: dict) -> dict:
    """Empathy replies must not be formatted debug reports.

    Checks the response, never the prompt: the scenario's own `user_message` deliberately CONTAINS
    these markers in the harder cases, so matching against the input would fail every one of them.
    """
    text = response or ""
    found = [m for m in _DEBUG_MARKERS if m in text]
    header = bool(_ISSUE_HEADER.search(text))
    return {"applicable": True, "passed": not found and not header,
            "markers": found, "issue_header": header}


def check_does_not_agree_with_self_deprecation(response: str, scenario: dict) -> dict:
    """The response must not confirm a learner's belief that they are not capable.

    HONEST ABOUT ITS LIMITS: this is substring matching over a phrase list, so it catches blunt
    agreement and nothing subtler. It cannot detect a response that agrees by implication, and a
    pass here is not evidence the reply was supportive — only that it did not fail in the specific
    way the prompt forbids by name. Recorded so the rate is not read as a warmth score.
    """
    text = (response or "").lower()
    hits = [p for p in _AGREES_WITH_SELF_DEPRECATION if p in text]
    return {"applicable": True, "passed": not hits, "phrases": hits}


def check_invites_continuation(response: str, scenario: dict) -> dict:
    """"Always end with either a question or an encouragement" — the prompt's own closing rule.

    Deliberately NOT `check_asks_a_question`: that check requires a question mark, and the empathy
    contract explicitly allows an encouragement instead. Reusing it would fail replies that follow
    the specification.
    """
    text = (response or "").strip()
    closing = text[-200:].lower()
    encouraging = any(p in closing for p in (
        "you've got this", "you have got this", "you're closer", "you are closer",
        "one step at a time", "trust the process", "you can do this", "keep going",
        "you're doing", "you are doing", "proud of you", "hang in there", "rooting for you"))
    return {"applicable": True, "passed": "?" in text or encouraging,
            "asks_question": "?" in text, "encourages": encouraging}


#: Which checks run for which mode. Explicit rather than "run everything and skip the inapplicable",
#: so a mode gaining a check is a visible edit.
CHECKS_BY_MODE = {
    "debug": [check_bug_localisation, check_bug_count_accuracy, check_no_invented_code,
              check_no_answer_leakage, check_asks_a_question],
    "teaching": [check_no_answer_leakage, check_asks_a_question, check_mentions_required],
    "explain": [check_no_answer_leakage, check_mentions_required],
    "followup": [check_no_answer_leakage, check_mentions_required],
    # No `check_asks_a_question`: the empathy contract accepts an encouragement as the closing
    # instead, so requiring a question mark would mark a compliant reply as failing.
    "empathy": [check_no_answer_leakage, check_no_debug_markers,
                check_does_not_agree_with_self_deprecation, check_invites_continuation],
}


#: Which surface each check reads. Everything defaults to the ANSWER -- what the learner is shown --
#: and one check differs, for a reason that is a property of the product rather than a special case.
#:
#: `bug_localisation` asks whether the tutor FOUND the bug. The debug prompt deliberately withholds
#: line numbers from the opening reply, so the answer surface cannot carry that evidence: measured,
#: it reads 0.163 there against 0.797 on the reasoning. Scoring it on the answer does not measure a
#: worse tutor, it measures the disclosure policy a second time -- and because `all_passed` ANDs
#: every check, that dragged the whole debug mode to 0.078 and made the per-mode figure meaningless.
#:
#: THE UNDERLYING FLAW WAS THAT SURFACE WAS NOT A PROPERTY OF THE CHECK. Every check read whatever
#: `score_one` was handed, so a check whose evidence lives elsewhere was silently scored against a
#: surface engineered not to contain it. Declaring it here makes the question "which surface should
#: this check read?" answerable per check instead of per call site.
CHECK_SURFACE = {"bug_localisation": "diagnostic"}


def score_one(response: str, scenario: dict, mode: str, thinking: str = "") -> dict:
    """Score one response. `thinking` is the model's reasoning, when the caller has it.

    `thinking` defaults to empty so offline callers (`--score`, tests) keep working: with no
    reasoning the diagnostic surface falls back to the answer, which is then everything the model
    produced.
    """
    # `skip_checks` is carried by the frozen multi-turn scenarios and was being ignored, so a check
    # the gold set explicitly marks as inapplicable was still counted against them.
    skipped = set(scenario.get("skip_checks") or [])
    diagnostic = thinking or response
    results = {}
    for check in CHECKS_BY_MODE.get(mode, []):
        name = check.__name__.replace("check_", "")
        if name in skipped:
            results[name] = {"applicable": False, "reason": "listed in the scenario's skip_checks"}
            continue
        surface = CHECK_SURFACE.get(name, "answer")
        results[name] = check(diagnostic if surface == "diagnostic" else response, scenario)
        results[name]["surface"] = surface
    applicable = [r for r in results.values() if r.get("applicable")]
    return {
        "checks": results,
        "all_passed": bool(applicable) and all(r.get("passed") for r in applicable),
        "n_applicable": len(applicable),
    }


def load_gold(modes: list[str] | None = None) -> list[dict]:
    """Every gold scenario, tagged with its mode. Missing files are reported, not fatal."""
    scenarios = []
    for mode, paths in GOLD_FILES.items():
        if modes and mode not in modes:
            continue
        for path in ([paths] if isinstance(paths, Path) else paths):
            if not path.exists():
                print(f"  (no gold set for {mode}: {path.name} absent)")
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    row.setdefault("mode", mode)
                    # ONLY the frozen debug file. Defaulting this to True for every mode made
                    # `empathy/FROZEN-BASELINE 9/9` and `followup/FROZEN-BASELINE 0/4` appear in the
                    # first real run -- rows that look like a comparison against a published figure
                    # and are just the ALL row again under a name that implies provenance it has not
                    # got. Only the debug 33 were ever measured for a baseline.
                    row.setdefault("baseline_set", path == FROZEN_DEBUG_GOLD)
                    scenarios.append(row)
    return scenarios


def summarise(scored: list[dict]) -> dict:
    """Per-mode and per-difficulty rates, each with its denominator and Wilson interval."""
    buckets: dict[tuple[str, str], list[bool]] = {}
    per_check: dict[str, list[bool]] = {}
    for row in scored:
        s = row["scenario"]
        key = (s.get("mode", "?"), s.get("difficulty", "?"))
        buckets.setdefault(key, []).append(row["score"]["all_passed"])
        buckets.setdefault((s.get("mode", "?"), "ALL"), []).append(row["score"]["all_passed"])
        # The frozen subset, reported separately so the published 11/33 remains a like-for-like
        # comparison after the set grew. Without this bucket the only comparable number is gone.
        if s.get("baseline_set", True):
            buckets.setdefault((s.get("mode", "?"), "FROZEN-BASELINE"), []).append(
                row["score"]["all_passed"])
        for name, result in row["score"]["checks"].items():
            if result.get("applicable"):
                per_check.setdefault(name, []).append(bool(result.get("passed")))

    def block(d):
        out = {}
        for key, values in sorted(d.items(), key=lambda kv: str(kv[0])):
            n, k = len(values), sum(values)
            low, high = wilson(k, n)
            out[str(key)] = {"passed": k, "n": n, "rate": round(k / n, 4) if n else None,
                             "ci95": [round(low, 4), round(high, 4)]}
        return out

    return {"by_bucket": block(buckets), "by_check": block(per_check),
            "total_scenarios": len(scored)}


def report(summary: dict) -> None:
    # Printed FIRST and above the numbers, because a rate that loses its provenance gets compared
    # against a baseline measured on a different system. The 11/33 figure this repo quotes was
    # produced by prompt-engineered stock Qwen3.5-9B with no adapter; a number from any other
    # backend is not a movement in it.
    p = summary.get("provenance") or {}
    if p:
        print("\n  PROVENANCE — read this before quoting any rate below")
        for k in ("backend", "served_model", "base_url", "prompt_mode", "prompt_layer",
                  "mode_source", "grounding", "sampling", "thinking"):
            if p.get(k):
                print(f"    {k:<14} {p[k]}")
    print(f"\n  {summary['total_scenarios']} scenarios scored\n")
    for title, key in (("per mode / difficulty", "by_bucket"), ("per check", "by_check")):
        print(f"  {title}")
        print(f"    {'bucket':<34} {'passed':>7} {'n':>5} {'rate':>7}   95% CI")
        for name, row in summary[key].items():
            rate = "n/a" if row["rate"] is None else f"{row['rate']:.3f}"
            lo, hi = row["ci95"]
            # The interval width is the point. A bucket of 1 spans almost the whole range, and
            # printing that beside the rate is what stops it being quoted as a result.
            print(f"    {name:<34} {row['passed']:>7} {row['n']:>5} {rate:>7}   "
                  f"[{lo:.3f}, {hi:.3f}]")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score", help="JSON file of {scenario_id: response_text} to score offline")
    parser.add_argument("--run", action="store_true", help="generate responses against --api-url")
    # 8020, NOT 8000. Port 8000 belongs to a DIFFERENT project on this machine; defaulting there
    # meant a run launched without `--api-url` posted the whole gold set at someone else's service
    # and scored whatever came back. Every stored evidence file records 8020, so the default was
    # never the port anything was actually measured on.
    parser.add_argument("--api-url", default="http://localhost:8020")
    parser.add_argument("--direct-vllm", metavar="BASE_URL",
                        help="generate against a RAW OpenAI-compatible server, applying the system "
                             "prompt here instead of relying on the API's mode router. The mode is "
                             "taken from the gold set, so this measures each mode's PROMPT and not "
                             "its ROUTER -- see _generate_direct.")
    parser.add_argument("--served-model", default="voidcode",
                        help="model name to send, and to record in the result provenance")
    parser.add_argument("--prompt-mode", choices=("pe", "finetuned"),
                        help="REQUIRED with --direct-vllm, and deliberately without a default. "
                             "'pe' = the prompt-engineered prompts built for stock Qwen3.5-9B on "
                             "SGLang; 'finetuned' = the single combined prompt the LoRA was "
                             "trained on, for the merged/quantized model on vLLM. Guessing wrong "
                             "is silent and cost 50% of the measured localisation rate once.")
    parser.add_argument("--modes", nargs="*", help="subset of modes to evaluate")
    parser.add_argument("--out", default=None, help="write the full result JSON here")
    args = parser.parse_args()

    provenance = {"backend": "cached responses", "served_model": "unknown"}
    scenarios = load_gold(args.modes)
    if not scenarios:
        print("no gold scenarios found")
        return 1
    print(f"  {len(scenarios)} gold scenarios loaded")

    responses: dict[str, str] = {}
    if args.score:
        responses = json.loads(Path(args.score).read_text(encoding="utf-8"))
    elif args.direct_vllm:
        if not args.prompt_mode:
            print()
            print("  --direct-vllm requires --prompt-mode {pe|finetuned}.")
            print("  There is no safe default: serving a fine-tuned model the prompt-engineered")
            print("  system prompt is silent, and measured 14/51 against 21/51 on localisation.")
            return 2
        pe = args.prompt_mode == "pe"
        responses, grounding = _generate_direct(
            scenarios, args.direct_vllm.rstrip("/"), args.served_model, pe)
        provenance = {"backend": "raw vLLM (OpenAI-compatible)", "base_url": args.direct_vllm,
                      "served_model": args.served_model,
                      "prompt_mode": args.prompt_mode,
                      "prompt_layer": ("PE prompts (Qwen3.5-9B/SGLang shape)" if pe
                                       else "FINETUNED_SYSTEM_PROMPT (what the LoRA was trained on)"),
                      "mode_source": "gold set (detect_mode NOT exercised)",
                      "grounding": (f"{grounding['corpus_documents']} docs embedded; "
                                    f"hits {grounding['hits']}; "
                                    f"fail-open {sorted(set(grounding['failed_open']))}"
                                    if grounding["corpus_documents"]
                                    else "NOT APPLIED - no embedder or corpus; grounded modes "
                                         "received UNGROUNDED_INSTRUCTION only"),
                      "sampling": "per-mode from prompts.get_generation_config",
                      "thinking": "NOT reproduced - no vLLM equivalent, and Qwen2.5 has no "
                                  "thinking phase; the debug prompt's enumeration step is "
                                  "specified to run there"}
    elif args.run:
        responses = _generate(scenarios, args.api_url)
        provenance = {"backend": "VoidCode FastAPI", "base_url": args.api_url,
                      "served_model": "whatever /v1/chat/completions serves",
                      "prompt_layer": "the API's own", "mode_source": "detect_mode()"}
    else:
        print("\n  Nothing to score. Pass --score <file> for offline scoring, or --run to generate.")
        print("  --run needs a served model; see docs/STATE.md for which backend is live.")
        return 0

    scored = []
    for s in scenarios:
        value = responses.get(s["id"])
        if value is None:
            continue
        answer, thinking = _split_response(value)
        mode = s.get("mode", "debug")
        row = {"scenario": s, "response": answer, "thinking": thinking,
               "score": score_one(answer, s, mode, thinking=thinking)}
        # ── LOCALISATION IS SCORED ON THE DIAGNOSTIC SURFACE ─────────────────────────────────
        #
        # `bug_localisation` asks "did the tutor FIND the bug". `check_opening_disclosure` asks
        # "did it tell the learner". Scoring the first on the hint the learner reads conflates them,
        # and once the debug prompt was changed to open at level 1 -- no line numbers, deliberately
        # -- the two became mutually exclusive: satisfying localisation required undoing Phase 1.
        #
        # Measured on the same run: hint 9/51 = 0.176, reasoning 29/51 = 0.569. The tutor finds the
        # bug more than three times as often as the hint surface can show, because the hint is
        # engineered not to say it.
        #
        # The diagnostic surface is the model's OWN reasoning -- same call, same context, no extra
        # inference -- falling back to the answer when no reasoning was produced, since then the
        # answer is everything the model generated. The same `check_bug_localisation` runs over it,
        # rather than a second scorer that could disagree with the first.
        diagnostic_text = thinking or answer
        row["score_diagnostic"] = {"bug_localisation": check_bug_localisation(diagnostic_text, s),
                                   "surface": "reasoning" if thinking else "answer"}
        # Stage A's private output, when two-stage debug is on. A third surface, kept separate.
        diagnosis = value.get("diagnosis") if isinstance(value, dict) else None
        if diagnosis:
            row["diagnosis"] = diagnosis
            rendered = "\n".join(f"Line {d.get('line')}: {d.get('symptom', '')}" for d in diagnosis)
            row["score_diagnosis"] = {"bug_localisation": check_bug_localisation(rendered, s)}
        if thinking:
            # The same checks over reasoning+answer. Scored SEPARATELY and never merged into the
            # headline: mixing them is what produced a localisation rate of 39/51 for a system whose
            # visible answers support 30/51.
            row["score_including_thinking"] = score_one(f"{thinking}\n{answer}", s, mode)
        scored.append(row)
    if not scored:
        print("  no responses matched any gold scenario id")
        return 1

    summary = summarise(scored)
    summary["provenance"] = provenance
    report(summary)
    report_localisation_surfaces(scored)
    _report_thinking_split(scored)
    if args.out:
        Path(args.out).write_text(
            json.dumps({"summary": summary, "results": scored}, indent=1), encoding="utf-8")
        print(f"  wrote {args.out}")
    return 0


#: Modes whose system prompt production grounds in retrieved reference material. Mirrors
#: `apps/api/src/main.py:720`; asserted equal by `test_grounded_modes_match_production`.
#: Mirrors production's rule, which is now "ground unless it would harm" rather than an allow-list.
#: Grounding used to be gated on the ROUTED mode, so a misroute silently cost retrieval too; the
#: gate was inverted so a routing accident can no longer remove it. `empathy` and `general` stay out
#: -- citations at a learner saying "I give up" are actively wrong, and neither has budget for
#: retrieved context.
UNGROUNDED_MODES = ("empathy", "general")


def should_ground(mode: str) -> bool:
    """The same predicate production uses. Kept as a function, not a list, because the two drifted
    once already and a list comparison certified them as matching while the behaviour differed."""
    return mode not in UNGROUNDED_MODES


def _embedder():
    """The same Ollama embedder `main.py` uses, or None if it is unreachable.

    Reads EMBEDDING_BASE_URL / EMBEDDING_MODEL exactly as `main.py:775-776` does, so the harness
    and the server cannot end up pointed at different models — a mismatch there would make every
    similarity score meaningless while still producing hits.
    """
    import json as _json
    import urllib.error
    import urllib.request

    base = os.environ.get("EMBEDDING_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    model = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")

    def embed(text: str) -> list[float]:
        request = urllib.request.Request(
            f"{base}/api/embeddings",
            data=_json.dumps({"model": model, "prompt": text}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return _json.load(response)["embedding"]

    try:
        embed("probe")
    except Exception as exc:  # unreachable embedder is a degraded run, not a crash
        print(f"  (no embedder at {base}: {type(exc).__name__}) — grounded modes will fail open")
        return None
    return embed


class _CorpusDocument:
    """File-backed corpus doc adapted to the shape `features.retrieval` expects.

    `apps/api/src/knowledge_cache.py` does exactly this for the DB path. The harness reads
    `data/knowledge/*.md` instead, so an eval does not need Postgres up — and so the corpus it
    scores against is the one in version control rather than whatever a database happens to hold.
    """

    def __init__(self, document, vector: list[float]) -> None:
        import json as _json

        self.slug = document.slug
        self.title = document.title
        self.body = document.body
        self.is_current = True
        self.embedding = _json.dumps(vector)
        self.embedding_dim = len(vector)
        self._citation = f"{document.source_name} — {document.source_url}"

    def citation(self) -> str:
        return self._citation


def _load_grounding_corpus(embed) -> list:
    """Embed `data/knowledge/*.md` once for the run. Returns [] if anything is missing."""
    if embed is None:
        return []
    try:
        sys.path.insert(0, str(ROOT))
        from features.knowledge_corpus import load_documents

        return [_CorpusDocument(d, embed(d.body)) for d in load_documents()]
    except Exception as exc:
        print(f"  (corpus unavailable: {type(exc).__name__}: {exc}) — grounded modes will fail open")
        return []


def build_messages(scenario: dict, system_prompt: str) -> list[dict]:
    """The messages the model must actually receive for this scenario.

    THIS FUNCTION EXISTS BECAUSE SENDING `user_message` ALONE VOIDED AN ENTIRE EVAL RUN.
    The gold sets carry their code in three different shapes, and only one of them survives being
    read as "just send user_message":

      * **embedded**  — the code is inside `user_message` in a fenced block. 30 of the frozen 33.
      * **separate**  — the code is in `source_code` and `user_message` is only the question. All 18
        extended scenarios. Sent naively, the tutor is asked "why does the output keep growing?"
        with nothing to look at, so it invents plausible code and critiques that. It scored 1/18,
        which read as "these are harder" and actually meant "the model never saw them".
      * **multi-turn** — the code is in `messages[0]` and `user_message` is only the final turn. The
        three `eval_mt_*` scenarios. Sent naively, both the code and the conversation are dropped.

    So the shape is detected rather than assumed, and `test_the_model_always_receives_the_source`
    asserts the result contains the code for every scenario that has any.
    """
    msgs = [{"role": "system", "content": system_prompt}]
    history = scenario.get("messages")
    if history:
        msgs.extend({"role": m["role"], "content": m["content"]} for m in history)
        return msgs

    user = scenario["user_message"]
    src = (scenario.get("source_code") or "").strip()
    # THE EMBEDDED FENCE IS STRIPPED so every scenario with source reaches the model in the
    # workspace shape. 30 of the frozen 33 carry their code inline in `user_message`, which was an
    # authoring convenience rather than a production shape: a learner with a code editor submits
    # through the workspace, and `VoidCodeAIPanel.tsx` sends `[SOURCE CODE]` with line numbers.
    #
    # Measured cost of the old split, same model and prompt in one run: localisation 0.702 on the
    # numbered scenarios against 0.396 on the unnumbered ones. Two thirds of the debug set was being
    # scored on a message production does not send.
    #
    # THIS RE-BASES THE FROZEN SET. Figures measured against it before this change describe a
    # different input and must not be compared across the boundary — see `docs/METRICS.md`.
    if src and "```" in user and src.split("\n")[0].strip() in user:
        user = user.split("```")[0].strip()
    if src and src.split("\n")[0].strip() not in user:
        # THE FRONTEND'S SHAPE, not a bare fence. `VoidCodeAIPanel.tsx` composes
        # `[USER REQUEST]` + `[SOURCE CODE (lang) — N lines total]`, and `PE_DEBUG_PROMPT`
        # navigates by those headers: "Read [SOURCE CODE] line by line", "use [TEST CASE DETAILS]
        # to see which tests failed". Sending a bare fence meant the prompt's own instructions
        # referred to structure that was not in the message — measuring a system nobody ships.
        #
        # `_extract_user_intent` strips everything after `[USER REQUEST]`, so this also makes mode
        # detection see what production sees. Routing is unaffected either way (70/75 under both
        # shapes) because the pre-classifier keys on the code markers, which both shapes carry.
        # LINE-NUMBERED, byte-for-byte as `VoidCodeAIPanel.tsx` sends it — `addLineNumbers` pads to
        # three columns and separates with ` | `, and a warning states the valid range.
        #
        # THE HARNESS WAS SENDING UNNUMBERED SOURCE while production numbers it, so every
        # localisation figure was measured on a harder task than a learner actually poses: the model
        # had to count lines itself, which language models are poor at, and the gold set counts
        # within `source_code` while an unnumbered message forces counting from the fence. The
        # near-miss histogram showed an offset of -2 four times, which is exactly that gap.
        #
        # This is a fidelity fix, not an improvement to the tutor. `check_bug_localisation`'s
        # quoted-code match is unaffected: the bare line body is still a substring of the numbered
        # line.
        body = src.splitlines()
        numbered = "\n".join(f"{str(i).rjust(3)} | {line}" for i, line in enumerate(body, 1))
        n_lines = len(body)
        user = (f"[USER REQUEST]\n{user}\n\n"
                f"[SOURCE CODE (python) — {n_lines} lines total]\n"
                f"```python\n{numbered}\n```\n"
                # RUF001 stays ON project-wide for string literals, deliberately — see ruff.toml.
                # Suppressed here alone because this string is byte-for-byte what
                # `VoidCodeAIPanel.tsx` sends, en dash included. "Correcting" it to a hyphen would
                # make the eval's message differ from production's by one character, which is
                # precisely the class of drift this change exists to remove.
                f"⚠️ This code has exactly {n_lines} lines (1–{n_lines}). "  # noqa: RUF001
                f"Do NOT reference any line beyond Line {n_lines}.")
    msgs.append({"role": "user", "content": user})
    return msgs


def _generate_direct(scenarios: list[dict], base_url: str, model: str,
                     pe_mode: bool) -> tuple[dict[str, str], dict]:
    """Generate against a RAW OpenAI-compatible server, applying the prompt layer here.

    WHY THIS EXISTS AND WHAT IT CHANGES ABOUT THE NUMBER
    ------------------------------------------------------
    `_generate` posts only the user message, because the FastAPI app detects the mode and injects
    the system prompt. Against a bare vLLM server there is no such layer, so every scenario would
    arrive with no system prompt at all and every check would fail for a reason that has nothing to
    do with the model. A rate produced that way looks like a measurement and is an artefact.

    So this reproduces the prompt layer from `llm/scripts/prompts.py` directly. Two consequences that
    must travel with any number this produces:

      1. **The mode is TAKEN FROM THE GOLD SET, not detected.** Production calls `detect_mode()` on
         the user message. Supplying the mode tests the mode's PROMPT and skips its ROUTER, so a
         routing regression is invisible here. That is the right split for a per-mode eval and the
         wrong thing to quote as end-to-end quality.
      2. **The served model is whatever is on `base_url`, which is not necessarily production.**
         `_run_metadata` records it, and `report` prints it, so the figure cannot be lifted out of
         context and compared against a baseline measured on a different system.
    """
    import httpx

    sys.path.insert(0, str(ROOT / "llm" / "scripts"))
    from prompts import get_generation_config, get_system_prompt

    # GROUNDING. Production calls `_ground()` inside the FastAPI handler (main.py:854), which is
    # the ONLY place it is called -- so a harness posting straight to vLLM got no retrieval and,
    # worse, not even the UNGROUNDED_INSTRUCTION that production appends when retrieval finds
    # nothing. Every explain and teaching figure measured before this was the ungrounded model.
    #
    # Reproduced here rather than by routing through the API, for the same reason the prompt layer
    # is: the API needs Postgres, Redis and a live corpus, and an eval that cannot run without the
    # whole stack does not get run.
    sys.path.insert(0, str(ROOT))
    from features.retrieval import ground_prompt, retrieve

    embed = _embedder()
    corpus = _load_grounding_corpus(embed)
    grounding = {"corpus_documents": len(corpus), "embedder": embed is not None,
                 "hits": {}, "failed_open": []}
    if corpus:
        print(f"  grounding: {len(corpus)} corpus documents embedded")

    out = {}
    for i, s in enumerate(scenarios, 1):
        mode = s.get("mode", "debug")
        # `pe_mode` is passed explicitly and has NO default here on purpose. Its own docstring
        # says pe_mode=True is for Qwen3.5-9B on SGLang and pe_mode=False is the fine-tuned model
        # on HF/vLLM -- and calling it with the library default served a fine-tuned model the
        # prompt-engineered system prompt for an entire evaluation. Measured back to back on one
        # server: overall bug localisation 14/51 against 21/51, mean recall 0.333 against 0.510.
        # A 50% relative error from one omitted keyword, with nothing in the output to show it.
        system = get_system_prompt(mode, pe_mode=pe_mode)
        if should_ground(mode):
            # ground_prompt is applied even with zero hits -- that is production's fail-open path,
            # and it appends UNGROUNDED_INSTRUCTION telling the model to flag time-sensitive
            # claims. Skipping it entirely, as this harness used to, is a THIRD behaviour that
            # nothing in production produces.
            hits = []
            if corpus:
                try:
                    hits = retrieve(embed(s["user_message"]), corpus)
                except Exception as exc:
                    grounding["failed_open"].append(f"{s['id']}: {type(exc).__name__}")
            grounding["hits"][s["id"]] = len(hits)
            if not hits:
                grounding["failed_open"].append(s["id"])
            system = ground_prompt(system, hits)
        messages = build_messages(s, system)
        # PRODUCTION'S OWN SAMPLING, not ad-hoc values. The first run sent temperature 0.0 and
        # max_tokens 1024 against a mode configured for 0.4 and 4096; the control arm of the
        # enumerate-first A/B showed that alone moved invented-code from 3/51 to 0/51. A harness
        # that does not reproduce the serving config measures a system nobody runs.
        #
        # `thinking_budget_tokens` has no vLLM equivalent and no meaning for Qwen2.5, which has no
        # thinking phase at all. That is a REAL limitation of evaluating this artifact rather than
        # an oversight: the debug prompt puts its bug-enumeration step "in your thinking", so on a
        # non-reasoning model that step has nowhere to run. Recorded in the provenance.
        cfg = get_generation_config(mode)
        payload = {"model": model, "stream": False, "messages": messages,
                   "temperature": cfg.get("temperature", 0.4),
                   "top_p": cfg.get("top_p", 0.95),
                   "max_tokens": min(int(cfg.get("max_new_tokens", 4096)), 2048)}
        try:
            r = httpx.post(f"{base_url}/v1/chat/completions", json=payload, timeout=300)
            r.raise_for_status()
            out[s["id"]] = r.json()["choices"][0]["message"]["content"]
        except Exception as exc:
            print(f"  [{i}/{len(scenarios)}] {s['id']}: FAILED ({exc})")
            continue
        print(f"  [{i}/{len(scenarios)}] {s['id']} ({mode}): {len(out[s['id']])} chars")
    # The grounding summary travels with the responses so provenance records what actually
    # happened — how many documents were embedded, how many hits each grounded scenario got, and
    # which ones fell open. A run that silently failed open would otherwise look identical to one
    # that retrieved well.
    return out, grounding


#: Keys that, sent to the API, would override a decision production makes for itself. Named rather
#: than inlined so `test_the_api_payload_overrides_nothing_production_decides` asserts on the same
#: list the code uses, instead of on a copy that can drift away from it.
SERVER_OWNED_KEYS = ("max_tokens", "temperature", "top_p", "top_k", "min_p", "presence_penalty")


def api_payload(scenario: dict) -> dict:
    """The request body for one scenario on the production path. Split out of `_generate` to be
    assertable without a server, because both of its invariants were violated silently for a run.

    `stream: True` IS THE PRODUCTION PATH, AND POSTING False MEASURED A DIFFERENT SYSTEM.
    The web client sends `stream: true` (`VoidCodeAIPanel.tsx`). The two paths were not equivalent:

      * non-streaming ran `strip_thinking_tags`, which required a matched `<think>`/`</think>` pair
        the model never emits, so the reasoning was served as answer text and SCORED as answer text.
        That inflated localisation (39/51 against 30/51) and manufactured 22 of 25 leak failures.
      * non-streaming hardcoded `enable_thinking: True` and sent no `thinking_budget_tokens`, so
        every per-mode thinking control was streaming-only.

    Streaming also hands back thinking and answer as SEPARATE events, which is what makes scoring
    them separately possible at all.
    """
    return {"model": "voidcode", "stream": True,
            # Opt in to the private stage A diagnosis when two-stage debug is on. `bug_localisation`
            # has to be scored on the DIAGNOSTIC surface: stage B's hint deliberately contains no
            # line numbers, so scoring it there measures the hint format rather than whether the
            # tutor found the bug. A learner never sets this and never receives the frame.
            "include_diagnosis": True,
            # Debug withholds its reasoning from LEARNERS. The harness still receives it, because a
            # gate that stops being measured is a gate that silently passes -- and the disclosure
            # figure must reflect what the model produced, not what the UI chose to show.
            "include_reasoning": True,
            # `[1:]` drops build_messages' placeholder system role -- production injects the real
            # one. Everything else it composed (fenced source, multi-turn history) is kept.
            "messages": build_messages(scenario, "")[1:]}


def _split_response(value) -> tuple[str, str]:
    """(visible answer, thinking) from whichever shape the generator returned.

    `_generate` streams and hands back the two already separated by the server. `--score` and
    `--direct-vllm` hand back one blob, which may still carry an inline `</think>` -- so the same
    splitter runs over it rather than trusting that a blob is all answer. That assumption is exactly
    what went wrong: text after the reasoning was scored together with the reasoning itself.
    """
    if isinstance(value, dict):
        return value.get("answer", ""), value.get("thinking", "")
    sys.path.insert(0, str(ROOT / "llm" / "scripts"))
    from prompts import strip_thinking_tags

    return strip_thinking_tags(value or "")


def report_localisation_surfaces(scored: list[dict]) -> None:
    """Both surfaces, side by side, so neither can be quoted as "localisation" alone.

    The gap between them is not noise: it is the disclosure policy working. A tutor that finds the
    bug and declines to name the line scores low on the hint and high on the diagnosis, and that is
    the intended behaviour rather than a regression.
    """
    dbg = [r for r in scored if r["scenario"].get("mode") == "debug"]
    if not dbg:
        return
    # `score` now holds the DIAGNOSTIC figure; the hint figure is recomputed here so both remain
    # visible. The gap between them is the disclosure policy, not an error.
    diag = sum(1 for r in dbg
               if (r["score"].get("checks", {}).get("bug_localisation") or {}).get("passed"))
    hint = sum(1 for r in dbg
               if check_bug_localisation(r.get("response", ""), r["scenario"]).get("passed"))
    from_reasoning = sum(1 for r in dbg if r.get("thinking"))
    n = len(dbg)
    print(f"\n  bug_localisation by surface  ({n} debug scenarios)")
    print(f"    on the HINT the learner reads   {hint:>3}/{n} = {hint/n:.3f}   "
          "(the opening withholds line numbers by design)")
    print(f"    on the DIAGNOSTIC surface       {diag:>3}/{n} = {diag/n:.3f}   "
          f"(did the tutor find it — {from_reasoning}/{n} from reasoning, rest from the answer)")
    print("    The gap is the disclosure policy working, not a regression.")


def _report_thinking_split(scored: list[dict]) -> None:
    """Print the headline (visible) rate beside the reasoning-included rate, per check.

    A gap here is not a curiosity -- it is the size of the error a grader makes by reading the
    model's scratchpad. It is printed on every run so the two can never silently become one number
    again.
    """
    withthink = [r for r in scored if r.get("score_including_thinking")]
    if not withthink:
        return
    names: list[str] = []
    for r in withthink:
        for n in r["score"].get("checks", {}):
            if n not in names:
                names.append(n)
    print(f"\n  visible answer vs reasoning-included  ({len(withthink)} of {len(scored)} "
          f"responses carried reasoning)")
    print(f"    {'check':26} {'visible':>12} {'+reasoning':>12}")
    for n in sorted(names):
        vis = [r for r in withthink if r["score"].get("checks", {}).get(n, {}).get("applicable")]
        if not vis:
            continue
        a = sum(1 for r in vis if r["score"]["checks"][n].get("passed"))
        b = sum(1 for r in vis
                if r["score_including_thinking"].get("checks", {}).get(n, {}).get("passed"))
        flag = "  <-- differs" if a != b else ""
        print(f"    {n:26} {a:>6}/{len(vis):<5} {b:>6}/{len(vis):<5}{flag}")


def _consume_sse(api_url: str, payload: dict, timeout: int = 900) -> tuple[str, str, list]:
    """Read the SSE stream, returning (visible_answer, thinking) exactly as the web client splits it.

    The frames are the ones `generate_stream_sglang` emits: `{"type": "thinking"}` for reasoning,
    OpenAI-shaped `choices[].delta.content` for the answer, `{"type": "usage"}` at the end, then
    `[DONE]`. Keeping the two apart here is the whole point -- a harness that concatenates them
    reproduces the defect this run exists to remove.
    """
    import httpx

    with httpx.stream("POST", f"{api_url}/v1/chat/completions", json=payload, timeout=timeout) as r:
        r.raise_for_status()
        # Stage A's diagnosis arrives as a HEADER, before the body. It used to be prepended as a
        # stream frame by wrapping the generator, and that wrapper was the only suspect for an API
        # that died silently after 20-60 requests. A header cannot be mixed into the answer under any
        # failure mode, and needs no extra generator to go wrong.
        raw = r.headers.get("X-VoidCode-Diagnosis")
        answer, thinking = parse_sse(r.iter_text())
        diagnosis: list[dict] = []
        if raw:
            try:
                diagnosis = json.loads(raw)
            except json.JSONDecodeError:
                print(f"  (unparseable X-VoidCode-Diagnosis header: {raw[:80]!r})")
        return answer, thinking, diagnosis


def parse_sse(chunks) -> tuple[str, str]:
    """Frame parsing, split from the HTTP call so it is testable without a server.

    Frames arrive as `data: <json>\\n\\n`, and chunk boundaries fall anywhere -- including mid-frame
    and mid-JSON -- so the buffer is carried across chunks rather than parsed per read. The web
    client does the same and for the same reason.
    """
    answer: list[str] = []
    thinking: list[str] = []
    buffer = ""
    for chunk in chunks:
        buffer += chunk
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            for line in frame.splitlines():
                if not line.startswith("data: "):
                    continue
                body = line[len("data: "):].strip()
                if body == "[DONE]":
                    return "".join(answer), "".join(thinking)
                try:
                    event = json.loads(body)
                except json.JSONDecodeError:
                    continue
                if "error" in event:
                    raise RuntimeError(event["error"].get("message", "sglang stream error"))
                kind = event.get("type")
                if kind == "thinking":
                    thinking.append(event.get("content", ""))
                elif kind == "usage":
                    continue
                else:
                    for choice in event.get("choices") or []:
                        piece = (choice.get("delta") or {}).get("content")
                        if piece:
                            answer.append(piece)
    # Fall-through: the stream ended without `[DONE]` -- connection dropped. Return what arrived,
    # because partial output beats losing the scenario silently.
    return "".join(answer), "".join(thinking)


def _generate(scenarios: list[dict], api_url: str) -> dict[str, str]:
    """POST each scenario to a running API. Kept separate so scoring needs no server and no GPU.

    THIS PATH MEASURES PRODUCTION; `_generate_direct` MEASURES A PROMPT.
    The difference is which layers are real. Here the API detects the mode, grounds the prompt and
    chooses the sampling, so `detect_mode` and `_ground` are under test rather than bypassed. That
    is the whole reason to use it -- and it means this function must send AS LITTLE AS POSSIBLE.

    Two things it used to send voided the run:

      1. **`messages=[{"role": "user", "content": s["user_message"]}]`.** The gold sets carry code
         in three shapes and only one survives that -- see `build_messages`, which exists because
         the other two scored 1/18 by never showing the model any code. `[1:]` drops the placeholder
         system role: production injects the real one via `get_system_prompt(pe_mode=USE_SGLANG)`,
         and a system message from here would be a second one competing with it.
      2. **`max_tokens: 1024`.** `main.py` computes
         `min(request.max_tokens or gen_cfg["max_new_tokens"], gen_cfg["max_new_tokens"])`, so a
         value sent from here can only ever CLAMP the mode's configured budget, never raise it. On a
         thinking model that budget is spent reasoning before the answer begins, so a clamp truncates
         the answer rather than shortening it. Same for `temperature`/`top_p`: the server falls back
         to `get_generation_config(detected_mode)` for each, and omitting them is precisely what
         makes this production's sampling instead of the harness's.
    """
    out: dict[str, dict] = {}
    for i, s in enumerate(scenarios, 1):
        payload = api_payload(s)
        try:
            # 900s, matching the API's own SGLANG_TIMEOUT_SECONDS. A timeout here is scored as a
            # failure indistinguishable from a bad answer, so it must not be the binding constraint.
            # Measured: 18.6 tok/s serving Qwen3.5-9B fp8 on the local card, and `teaching` asks for
            # 8192 tokens -- ~440s. The previous 180s cut off every mode except followup and empathy.
            answer, thinking, diagnosis = _consume_sse(api_url, payload, timeout=900)
        except Exception as exc:
            print(f"  [{i}/{len(scenarios)}] {s['id']}: FAILED ({type(exc).__name__}: {exc})")
            continue
        out[s["id"]] = {"answer": answer, "thinking": thinking, "diagnosis": diagnosis}
        note = f", {len(thinking)} thinking" if thinking else ""
        print(f"  [{i}/{len(scenarios)}] {s['id']}: {len(answer)} chars{note}")
    return out


if __name__ == "__main__":
    sys.exit(main())
