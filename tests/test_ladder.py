"""The ladder validator decides what a rung may say, so it has to be watched rejecting things.

THIS IS THE SECOND VALIDATOR WRITTEN FOR THIS JOB. The first was `disclosure_level` from the eval
harness, reused because it already scored disclosure 0-4. Run over the 119 authored ladders it
passed all 119 and scored 118 of them at level 0 — because it looks for line references and phrasing
like "your loop bound", which is what a DEBUG REPLY about a learner's submitted code contains, and
conceptual hints never do. A check that certifies everything is not a strict check, it is an absent
one, and it would have shipped as "validated".

So every assertion here that the validator ACCEPTS something is paired with one that it rejects the
neighbouring case. A test suite that only proves the good input passes cannot tell a working
validator from `return []`.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from features.ladder import (  # noqa: E402
    LADDER_KEYS,
    UNCOVERED,
    check_ladder,
    violations,
)


def rules(vs) -> set[str]:
    return {v.rule for v in vs}


# ── level 0: a conceptual question, no line reference and no code token ──────────────────────────

def test_a_conceptual_question_is_a_valid_rung_zero():
    assert violations("What happens to the softmax output when one logit is far larger?", 0) == []


def test_rung_zero_may_not_name_a_line():
    for text in ("The bug is on line 4.", "Look at L5.", "Check the fifth line."):
        assert "line reference" in rules(violations(text, 0)), text


def test_rung_zero_may_not_name_a_code_token():
    assert "code token" in rules(violations("The `exp` call overflows.", 0))
    assert "code token" in rules(violations("Your max_logit is never subtracted.", 0))


def test_a_region_pointer_is_not_a_code_token():
    """Level 1 is 'a pointer to a region', and regions are ordinary English -- "your loop bound",
    "the base case". If those matched, no valid rung 1 could be written at all."""
    for text in ("Look at your loop bound.", "The base case is where this goes wrong.",
                 "Something in the comparison inside the nested loop."):
        assert violations(text, 0) == [], text


# ── level 1: a region pointer, no operator and no literal ────────────────────────────────────────

def test_rung_one_may_not_state_an_operator():
    v = violations("Rounding up on each axis is (n + tile - 1) // tile.", 1)
    assert "operator" in rules(v)


def test_rung_one_may_not_state_a_literal():
    assert "literal" in rules(violations("Seed the last node's gradient to 1.0.", 1))


def test_rung_one_may_point_at_a_region():
    assert violations("Your loop bound stops one element short of the end.", 1) == []


# ── the vocabulary exemption, and the hole it must not open ──────────────────────────────────────

VOCAB = "Given seq_len tokens and d_model features, compute the attention scores."


def test_a_term_the_question_defines_is_not_a_disclosure():
    """"Doubling seq_len doubles the total" names a variable the problem statement introduces.
    Requiring hints to avoid the question's own nouns makes them unwritable -- and measured over the
    119 authored ladders, the unexempted rule rejects 30 more, every one of this kind."""
    assert violations("Doubling seq_len exactly doubles the total.", 0, VOCAB) == []


def test_the_same_term_is_a_disclosure_when_the_question_never_introduced_it():
    """The exemption is per item, not global. Without the vocabulary it is just a code token."""
    assert "code token" in rules(violations("Doubling seq_len exactly doubles the total.", 0))


def test_an_operator_is_never_exempt_even_if_the_question_uses_it():
    """`//` is mechanism, not vocabulary. A hint that states the formula has finished the exercise
    regardless of where else the token appears -- otherwise any item whose description shows the
    operator could hand over its own answer at rung 1."""
    vocab = "Compute ceil(n / tile) using integer arithmetic: (n + tile - 1) // tile is one way."
    assert "operator" in rules(violations("It is (n + tile - 1) // tile.", 1, vocab))


# ── remedy phrasing: code-adjacent only ──────────────────────────────────────────────────────────

def test_a_comparative_pointing_at_code_is_a_remedy():
    assert "remedy phrasing" in rules(violations("Use `//` instead of `/` here.", 0))


def test_a_comparative_in_ordinary_prose_is_not():
    """Three of the four comparatives in the authored ladders were this kind: advice about approach
    ("record it as you count rather than searching afterwards") and a question about a scenario
    ("if the ranks span four nodes instead of one?"). An unconditional rule is wrong three times in
    four here, and a check that cries wolf gets deleted rather than fixed."""
    for text in ("Record it as you count rather than searching for it afterwards.",
                 "What if the ranks span four nodes instead of one?"):
        assert violations(text, 0) == [], text


# ── the decoy, and the declared gaps ─────────────────────────────────────────────────────────────

def test_a_rung_zero_that_states_the_formula_fails():
    """THE DECOY. Every other test here could pass against a validator with the rules removed, as
    long as it still returned [] for clean input. This one cannot: it is a real rung 0 taken from
    the catalogue, and it gives away the whole exercise."""
    real = "Filter candidates by base + per_item * b <= slo, then take the max."
    assert violations(real, 1) != [], "the validator accepts a rung that states the algorithm"


def test_the_semantic_rows_are_declared_rather_than_implied():
    """Two rows of the four-row table are judgements no pattern decides. Naming them keeps a partial
    validator from reading as a complete one -- the same declaration `docs/LEAK_RUBRIC.md` makes."""
    assert len(UNCOVERED) == 2
    assert any("defect statement" in row for row in UNCOVERED)
    assert any("not the fix" in row for row in UNCOVERED)


def test_levels_two_and_three_are_unconstrained_here():
    """Level 2 names the line and the defect; level 3 IS the fix. What they forbid is semantic, so
    this module must not pretend to check it."""
    assert violations("Line 4 uses `<`, so the last index is never examined.", 2) == []
    assert violations("Subtract the row maximum before exponentiating.", 3) == []


def test_check_ladder_reads_every_rung():
    ladder = dict.fromkeys(LADDER_KEYS, "")
    ladder["level_0"] = "The bug is on line 4."
    ladder["level_1"] = "Seed it to 1.0."
    found = check_ladder(ladder)
    assert {v.level for v in found} == {0, 1}


def test_an_absent_rung_is_not_a_violation():
    """Migration is incremental: the loader fails the whole tree on one bad file, so a half-authored
    ladder must not fail until the rung it is missing is actually required."""
    assert check_ladder({"level_0": "What does this return when the list is empty?"}) == []
