"""The hint ladder: what each rung may say, enforced rather than requested.

WHY THIS IS A VALIDATOR AND NOT A STYLE GUIDE

The tutor's disclosure gate — "the reasoning must never contain a full solution" — sits at 0.782
against a 0.98 threshold and has never moved. Every remedy tried so far has attempted to stop a 9B
model from generating a fix once it has found the bug, and finding a bug and knowing its fix are the
same act. Authored ladders make it a data problem instead: if every item carries human-written rungs
and rungs 0 and 1 are *validated at authoring time* to contain no fix, the tutor selects a rung
rather than composing one, and the gate is closed by construction rather than by instruction.

That only works if "contains no fix" is checked by something. A rule in a style guide is a rule
nobody runs.

THE RULES, FROM THE PROGRAMME'S OWN TABLE

    level 0  a conceptual question about behaviour   no line reference, no code token
    level 1  a pointer to a region                   no operator, no literal
    level 2  the line and the defect                 not the fix
    level 3  the fix                                 --

WHAT IS DELIBERATELY NOT IMPLEMENTED

Level 1 also forbids "a defect statement", and level 2 forbids "the fix". Both are semantic: whether
a sentence *states* a defect rather than pointing at one is a judgement, and no pattern decides it.
They are named in `UNCOVERED` rather than silently skipped, because a validator that implies full
coverage of a four-row table while implementing two rows is worse than one that says which two.
`docs/LEAK_RUBRIC.md` makes the same declaration for the same reason.

THE VOCABULARY EXEMPTION, AND WHY IT IS NOT A LOOPHOLE

A term the question itself defines cannot be a disclosure. "Doubling seq_len doubles the total"
names a variable the problem statement introduces; requiring the hint to avoid the problem's own
nouns makes it unwritable. Measured over the 119 authored ladders, the literal rule rejects 69 and
the vocabulary-pruned rule rejects 39, and the 30 it stops rejecting are all of this kind.

This is the `must_mention` echo prune, arrived at from the opposite direction: there, a keyword
present in the question was too EASY to satisfy and had to be dropped; here, it is unfair to forbid.
Same principle, that the question's own words carry no information about the answer.

OPERATORS AND REMEDY PHRASING ARE NEVER EXEMPT. `//` is not vocabulary even if the problem statement
uses it -- "(n + tile - 1) // tile" is the formula, and a hint that states the formula has finished
the exercise regardless of where the token also appears.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

#: Rows of the ladder table this module does NOT decide. Both are judgements, not patterns.
UNCOVERED = (
    "level 1 — 'no defect statement': whether a sentence states a defect or points at one",
    "level 2 — 'not the fix': whether a described change IS the correction",
)

LADDER_KEYS = ("level_0", "level_1", "level_2", "level_3")

#: A named thing from the program: a backticked span, a call, snake_case, or camelCase. Bare English
#: words are not code tokens -- "loop", "the base case" and "your comparison" are exactly what a
#: level-1 region pointer is made of, and matching them would leave no way to write one.
#:
#: The call form is `\w+\([^)]*\)`, NOT `\w+\(\)`. With empty parens only, "Subtract max(logits)
#: instead of the raw value" contained no recognised code at rung 0 and loaded clean -- a rung
#: stating the fix, passing the validator written to stop exactly that. A call with arguments is
#: the ordinary way to write code in prose. Requiring no space before the paren keeps English
#: parentheticals ("the ranks (see above)") out of it.
_CODE_TOKEN = re.compile(r"`[^`]+`|\b\w+\([^)]*\)|\b[a-z]+_\w+\b|\b[a-z]+[A-Z]\w*\b")

#: "line 5", "the fifth line", "L5".
_LINE_REF = re.compile(r"\bline\s*:?\s*\d+\b|\bL\d+\b|\bthe\s+(?:first|second|third|fourth|fifth|"
                       r"sixth|seventh|eighth|ninth|tenth|last)\s+line\b", re.I)

#: Mechanism, not vocabulary. Never exempt.
_OPERATOR = re.compile(r"(?:^|[\s(])(?:[<>]=?|==|!=|\+=|-=|\*=|//|\*\*)(?:[\s)]|$)")

#: A bare number. Not a version, not part of an identifier, not a decimal fragment.
#:
#: The trailing guard is `(?![\w]|\.\d)` rather than `(?![\w.])`. The simpler form rejected any
#: following dot, so `1.0` at the END OF A SENTENCE -- "seed the gradient to 1.0." -- was silently
#: not a literal, which is exactly where a hint puts one. Caught by a test asserting the rejection
#: rather than by reading the pattern.
_LITERAL = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w]|\.\d)")

#: Stating a change. This is level 3's content wherever it appears, so it is barred from 0 and 1
#: and never exempt: "should be", "instead of", "replace X with Y".
_REMEDY = re.compile(
    r"\b(?:instead\s+of|rather\s+than|should\s+be|must\s+be|needs?\s+to\s+be|"
    r"replace|swap|invert|negate)\b", re.I)

#: How far either side of a comparative to look for code before calling it a remedy.
_REMEDY_WINDOW = 45


def _remedy_is_about_code(text: str, start: int, end: int) -> bool:
    """Does this comparative point at a code token, or is it ordinary prose?

    "Use `//` instead of `/`" is the fix. "Record it as you count rather than searching for it
    afterwards" is advice about approach, and "if the ranks span four nodes instead of one?" is a
    question about a scenario. Measured over the authored ladders, three of the four comparatives
    flagged were the second kind -- so an unconditional rule is wrong three times in four here.

    What this deliberately does NOT catch is the comparative that states required behaviour in plain
    English, e.g. "return None rather than rounding". That is a defect statement, which is the
    semantic row named in UNCOVERED -- not something to half-catch with a wider regex.
    """
    near = text[max(0, start - _REMEDY_WINDOW): min(len(text), end + _REMEDY_WINDOW)]
    return bool(_CODE_TOKEN.search(near) or _LITERAL.search(near))

#: level -> the rules that apply. Level 2 may name the line and the token; level 3 is the fix and is
#: unconstrained. Both still forbid nothing here, because what they forbid is semantic (see UNCOVERED).
_RULES: dict[int, tuple[tuple[str, re.Pattern[str], bool], ...]] = {
    # (name, pattern, exemptible_by_vocabulary)
    0: (("line reference", _LINE_REF, False),
        ("code token", _CODE_TOKEN, True),
        ("remedy phrasing", _REMEDY, False)),
    1: (("operator", _OPERATOR, False),
        ("literal", _LITERAL, True),
        ("remedy phrasing", _REMEDY, False)),
    2: (),
    3: (),
}


@dataclass(frozen=True)
class Violation:
    level: int
    rule: str
    span: str
    text: str

    def __str__(self) -> str:
        return f"level_{self.level}: {self.rule} {self.span!r} in {self.text!r}"


def violations(text: str, level: int, vocabulary: str = "") -> list[Violation]:
    """Every rule this rung breaks. Empty means the rung is valid.

    `vocabulary` is the item's own words -- its description and prompt. A code token or literal
    appearing there is the question's own, and is exempt. Operators and remedy phrasing are not.
    """
    own = (vocabulary or "").lower()
    body = text or ""
    found: list[Violation] = []
    for rule, pattern, exemptible in _RULES.get(level, ()):
        for m in pattern.finditer(body):
            span = m.group(0).strip()
            if exemptible and span.strip("`").lower() in own:
                continue
            if rule == "remedy phrasing" and not _remedy_is_about_code(body, *m.span()):
                continue
            found.append(Violation(level, rule, span, body[:100]))
    return found


def check_ladder(ladder: dict, vocabulary: str = "") -> list[Violation]:
    """Validate a whole `hint_ladder` mapping. Levels absent from it are not checked."""
    out: list[Violation] = []
    for i, key in enumerate(LADDER_KEYS):
        if ladder.get(key):
            out += violations(str(ladder[key]), i, vocabulary)
    return out
