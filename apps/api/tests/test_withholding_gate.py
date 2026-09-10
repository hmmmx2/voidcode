"""The output guard, tested without a model or a database.

`src/withholding.py` is the only thing in this system that can PROMISE the tutor does not hand over
a solution. Every prompt asks; this decides. So it is worth more scrutiny than the prompts, and it
gets it here — none of these need a GPU, so they run in the ordinary suite on every change, unlike
`test_tutor_withholding.py` which needs `TUTOR_EVAL=1` and costs GPU time per assertion.

THE TEST THAT MATTERS MOST IS `test_the_split_points_cannot_change_what_is_delivered`.

A streaming filter is a state machine fed at boundaries it does not choose. SGLang emits a token at
a time, and a fence can arrive as "``" then "`python", or as one chunk, or glued to the end of a
sentence. A state machine that is right for one chunking and wrong for another fails in production
and passes every test written by someone imagining whole lines. So the leaking reply is fed at every
possible boundary and the delivered text must be identical each time.
"""

from __future__ import annotations

import pytest
from src.withholding import (
    REDACTION,
    SolutionGate,
    completed_function,
    hands_over_solution,
    protected_functions,
    submitted_code,
)

SOLUTION = "def softmax(x):\n    e = np.exp(x - np.max(x))\n    return e / e.sum()\n"
SCAFFOLD = "def softmax(x):\n    return ____\n"


def deliver(gate: SolutionGate, text: str, size: int) -> str:
    """Feed `text` through the gate in chunks of `size`, then flush."""
    parts = [gate.feed(text[i : i + size]) for i in range(0, len(text), size)]
    parts.append(gate.flush())
    return "".join(parts)


class TestWhatItProtects:
    """The protected names come from the learner's submission, not from a catalogue."""

    def test_it_reads_the_function_from_the_attached_code(self):
        message = (
            "[USER REQUEST]\nwhy is this nan?\n\n"
            "[CURRENT CODE (Python)]\n```python\ndef softmax(x):\n    return ____\n```"
        )
        assert protected_functions(message) == {"softmax"}

    def test_it_reads_the_review_panel_header_too(self):
        """`buildReviewPrompt` says SOURCE CODE where `buildLightPrompt` says CURRENT CODE."""
        message = (
            "[USER REQUEST]\nfix it\n\n"
            "[SOURCE CODE (python) — 3 lines total]\n```python\ndef layer_norm(x):\n    pass\n```\n\n"
            "[TEST CASE DETAILS]\nall failing"
        )
        assert protected_functions(message) == {"layer_norm"}

    def test_a_question_with_no_code_protects_nothing(self):
        """AND THAT IS DELIBERATE, not a gap.

        With no submission there is no specific exercise to protect and the request is a general
        question. A tutor answering "how does np.max broadcast?" with three lines of illustration is
        doing its job, and a guard that blocked it would make the product worse to avoid a risk that
        is not present.
        """
        assert protected_functions("how does softmax work?") == set()

    def test_it_does_not_read_functions_out_of_the_conversation(self):
        """Only the code the learner attached, not any fenced block anywhere in the message.

        Otherwise the tutor's own previous reply — replayed as history, and containing whatever it
        quoted — would widen the protected set on every turn.
        """
        message = (
            "[USER REQUEST]\nlike this?\n```python\ndef helper(y):\n    return y\n```\n\n"
            "[CURRENT CODE (Python)]\n```python\ndef softmax(x):\n    return ____\n```"
        )
        assert protected_functions(message) == {"softmax"}


class TestWhatCountsAsFinished:
    @pytest.mark.parametrize(
        ("text", "leaks"),
        [
            (SOLUTION, True),
            (SCAFFOLD, False),
            ("def softmax(x):\n    ...\n", False),
            ("def softmax(x):\n    # TODO: subtract the max\n    return None\n", False),
            ("def softmax(x):\n    '''Shifts, then exponentiates.'''\n", False),
            ("def helper(y):\n    return y + 1\n", False),
            ("Subtract the maximum before you exponentiate. What does that buy you?", False),
            # The scaffold restated, then the answer below it. One region, two definitions.
            (SCAFFOLD + "\n" + SOLUTION, True),
            # The reverse order must NOT fire: a worked example, then a blank to fill.
            ("def helper(x):\n    return x\n\n" + SCAFFOLD, False),
        ],
        ids=["solution", "scaffold", "ellipsis", "todo", "docstring-only", "other-function",
             "prose", "scaffold-then-answer", "answer-then-scaffold"],
    )
    def test_it_tells_a_solution_from_a_scaffold(self, text: str, leaks: bool):
        assert (completed_function(text, {"softmax"}) is not None) is leaks

    def test_the_whole_reply_check_sees_unfenced_code(self):
        """A handover is a handover without the backticks."""
        assert hands_over_solution("sure:\n\n" + SOLUTION, "softmax") is not None

    def test_it_says_nothing_about_correctness(self):
        """A plausible finished function costs the learner the exercise whether or not it works.

        Judging correctness would need `reference` from the catalogue — the RL reward function's
        answer key, which must never be loaded on the serving path.
        """
        wrong = "def softmax(x):\n    return x / x.sum()\n"
        assert completed_function(wrong, {"softmax"}) == "softmax"


class TestTheStreamingGate:
    def test_prose_passes_straight_through(self):
        gate = SolutionGate({"softmax"})
        text = "What value should you subtract before exponentiating?"
        assert deliver(gate, text, 3) == text
        assert gate.withheld == []

    def test_a_one_line_quote_of_their_own_code_is_allowed(self):
        """The correct debug escalation shape, and it must survive.

        `**Issue 1 — Line 2**` followed by the single offending line is exactly what the prompt asks
        for, and a guard that ate it would push the model toward describing lines in prose, which is
        measurably worse teaching.
        """
        gate = SolutionGate({"softmax"})
        reply = "I found 1 issue.\n\n```python\ne = np.exp(x)\n```\nLine 2 overflows. What next?"
        assert deliver(gate, reply, 5) == reply
        assert gate.withheld == []

    def test_a_finished_function_is_replaced(self):
        gate = SolutionGate({"softmax"})
        reply = f"Here you go:\n```python\n{SOLUTION}```\nHope that helps."
        out = deliver(gate, reply, 7)
        assert "np.exp" not in out
        assert REDACTION.strip() in out
        assert out.startswith("Here you go:\n")
        assert out.endswith("\nHope that helps.")
        assert gate.withheld == ["softmax"]

    def test_no_stray_fence_is_left_behind(self):
        """The opening ``` must never be delivered ahead of a block that is then withheld."""
        gate = SolutionGate({"softmax"})
        out = deliver(gate, f"Try:\n```python\n{SOLUTION}```\ndone", 1)
        assert "```" not in out

    def test_an_unterminated_block_is_still_judged(self):
        """Truncation must not be the way through.

        A model cut off mid-function — max_tokens, a dropped connection, a cancelled request — has
        still written most of one. Releasing it because the closing fence never arrived would mean
        the guard can be defeated by running out of budget.
        """
        gate = SolutionGate({"softmax"})
        out = deliver(gate, f"Here:\n```python\n{SOLUTION}", 4)
        assert "np.exp" not in out
        assert gate.withheld == ["softmax"]

    def test_a_second_block_after_a_withheld_one_still_works(self):
        """State must be clean after a redaction, or the guard breaks the rest of the reply."""
        gate = SolutionGate({"softmax"})
        reply = f"One:\n```python\n{SOLUTION}```\nTwo:\n```python\ne = np.exp(x)\n```\nend"
        out = deliver(gate, reply, 6)
        assert "np.exp(x - np.max(x))" not in out
        assert "```python\ne = np.exp(x)\n```" in out
        assert gate.withheld == ["softmax"]

    def test_nothing_is_protected_when_nothing_was_submitted(self):
        gate = SolutionGate(set())
        reply = f"```python\n{SOLUTION}```"
        assert deliver(gate, reply, 5) == reply
        assert gate.withheld == []

    @pytest.mark.parametrize("size", list(range(1, 40)))
    def test_the_split_points_cannot_change_what_is_delivered(self, size: int):
        """THE ONE THAT GUARDS THE STATE MACHINE.

        SGLang emits a token at a time and chooses the boundaries. A fence can arrive as "``" then
        "`python", glued to the end of a sentence, or whole. Correct for one chunking and wrong for
        another is a bug that reaches production and passes every test written by someone imagining
        whole lines — so the same reply is fed at every chunk size and must deliver the same text.
        """
        reply = (
            "I found 1 issue in your code.\n\n"
            "```python\ne = np.exp(x)\n```\n"
            "Line 2 overflows for large inputs.\n\n"
            f"Since you're pressed for time:\n```python\n{SOLUTION}```\n"
            "What would you subtract?"
        )
        expected = deliver(SolutionGate({"softmax"}), reply, len(reply))
        assert deliver(SolutionGate({"softmax"}), reply, size) == expected
        assert "np.max" not in expected
        assert "e = np.exp(x)" in expected  # the legitimate one-line quote survived


class TestQuotingTheLearnersOwnCodeBack:
    """Their code is not a solution, even though it has a `def` and a `return`.

    `PE_DEBUG_PROMPT`'s escalation format is BUILT on quoting the learner's own line back at them,
    and the detector deliberately refuses to judge whether an implementation is CORRECT — so a
    learner's own BROKEN function trips every structural test for a handover. A guard that redacted
    that would eat the correct teaching move, confuse a learner about code sitting in front of them
    in the editor, and earn itself a removal.
    """

    SUBMISSION = (
        "[USER REQUEST]\nwhy nan?\n\n"
        "[CURRENT CODE (Python)]\n```python\ndef softmax(x):\n    e = np.exp(x)\n"
        "    return e / e.sum()\n```"
    )

    def _gate(self) -> SolutionGate:
        return SolutionGate(protected_functions(self.SUBMISSION), submitted_code(self.SUBMISSION))

    def test_their_own_function_quoted_back_is_delivered(self):
        gate = self._gate()
        reply = ("Look at this:\n```python\ndef softmax(x):\n    e = np.exp(x)\n"
                 "    return e / e.sum()\n```\nWhere does it overflow?")
        assert deliver(gate, reply, 5) == reply
        assert gate.withheld == []

    def test_a_re_indented_quote_still_counts_as_their_code(self):
        """Models re-indent when they quote. Whitespace must not decide this."""
        gate = self._gate()
        reply = ("```python\n  def softmax(x):\n      e = np.exp(x)\n"
                 "      return e / e.sum()\n```")
        assert deliver(gate, reply, 3) == reply
        assert gate.withheld == []

    def test_their_code_CORRECTED_is_still_withheld(self):
        """The one that matters: "here's your code, fixed" is the leak wearing a quote's clothes.

        One token different from their submission, and the exemption must not apply.
        """
        gate = self._gate()
        reply = ("```python\ndef softmax(x):\n    e = np.exp(x - np.max(x))\n"
                 "    return e / e.sum()\n```")
        out = deliver(gate, reply, 5)
        assert "np.max" not in out
        assert gate.withheld == ["softmax"]

    def test_their_code_followed_by_the_fix_in_one_block_is_withheld(self):
        """THE DIRECTION OF THE CONTAINMENT CHECK, and a mutant survived without this.

        The exemption asks whether the block is inside their submission -- a quote. Asking it
        the other way round, whether their submission is inside the block, is TRUE of a reply
        that echoes their function and appends the corrected one underneath. That is the
        commonest leak shape there is, and it would have been exempted. Both directions pass
        every test where the quote and the submission are identical, which is why this one
        deliberately is not.
        """
        gate = self._gate()
        reply = ("```python\ndef softmax(x):\n    e = np.exp(x)\n"
                 "    return e / e.sum()\n\n"
                 "def softmax(x):\n    e = np.exp(x - np.max(x))\n"
                 "    return e / e.sum()\n```")
        out = deliver(gate, reply, 5)
        assert "np.max" not in out
        assert gate.withheld == ["softmax"]

    def test_a_partial_quote_of_their_code_is_still_a_quote(self):
        """Two of their three lines, which is what pointing at a region looks like."""
        gate = self._gate()
        reply = "```python\ne = np.exp(x)\nreturn e / e.sum()\n```"
        assert deliver(gate, reply, 4) == reply
        assert gate.withheld == []

    def test_the_submission_is_read_back_out_of_the_request(self):
        code = submitted_code(self.SUBMISSION)
        assert "def softmax(x):" in code
        assert "np.exp(x)" in code
        assert "[USER REQUEST]" not in code, "the prose came with it; the exemption would widen"
