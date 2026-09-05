"""
The grading primitives — pure, no database, no Judge0.

Every defect `/v1/submit` has shipped lived in one of these functions, and each
was invisible inside the request handler. They are tested here directly.
"""

import pytest
from src.routers.execution import (
    ExecutionResultModel,
    build_submission_result,
    case_passed,
    outputs_match,
    redact_for_response,
)

# Aliased on import: pytest tries to collect any module-level name matching
# `Test*` as a test class, and warns when it cannot. Renaming production code
# to satisfy a collector would be the wrong fix.
from src.routers.execution import TestCaseResultModel as CaseResult

# ── normalize_output / outputs_match ────────────────────────────


@pytest.mark.parametrize(
    "actual, expected",
    [
        ("[0, 1]\n", "[0, 1]"),          # trailing newline
        ("[0, 1]", "[0, 1]\n\n"),        # several trailing newlines
        ("[0, 1]   ", "[0, 1]"),         # trailing spaces
        ("a\r\nb", "a\nb"),              # CRLF from a Windows-authored seed
        ("a  \nb\t", "a\nb"),            # trailing whitespace per line
        ("", ""),
    ],
)
def test_insignificant_whitespace_is_ignored(actual, expected):
    assert outputs_match(actual, expected)


@pytest.mark.parametrize(
    "actual, expected",
    [
        ("[0,1]", "[0, 1]"),             # THE one that must never pass
        ("[0, 1]", "[1, 0]"),            # order
        ("a\nb", "ab"),                  # a newline is not nothing
        ("  a", "a"),                    # LEADING whitespace is significant
        ("0", ""),                       # output vs no output
        ("true", "True"),                # case
    ],
)
def test_internal_whitespace_is_significant(actual, expected):
    """
    The counterweight to the test above, and the more important of the two.

    A flaky comparison is always tempting to fix by stripping harder. The end
    state of that is `[0,1]` comparing equal to `[0, 1]`, at which point the
    platform accepts wrong answers and reports them as correct. Loosening
    `normalize_output` must break a test, not merely be a judgement call.
    """
    assert not outputs_match(actual, expected)


def test_none_is_treated_as_empty_output():
    """Judge0 returns null stdout for a program that printed nothing."""
    assert outputs_match(None, "")
    assert not outputs_match(None, "42")


# ── case_passed ─────────────────────────────────────────────────


def test_matching_output_on_accepted_status_passes():
    assert case_passed(3, "[0, 1]\n", "[0, 1]")


@pytest.mark.parametrize("status_id", [4, 5, 6, 11, 12, 13])
def test_nonzero_status_never_passes_even_when_output_matches(status_id):
    """
    A program killed by the time limit can still have flushed correct output
    before it was killed, and one that prints the answer then segfaults is not
    a correct solution. Output equality alone is not sufficient.
    """
    assert not case_passed(status_id, "[0, 1]", "[0, 1]")


# ── build_submission_result — the empty-set defect ──────────────


def _result(passed: bool, *, hidden: bool = False, label: str = "Case 1"):
    return CaseResult(
        test_case_id="00000000-0000-0000-0000-000000000001",
        label=label,
        is_hidden=hidden,
        passed=passed,
        execution_result=ExecutionResultModel(
            stdout="out", stderr=None, compile_output=None,
            status_id=3, status_description="Accepted",
        ),
        expected_output="out",
        actual_output="out",
    )


def test_build_submission_result_returns_false_when_total_is_zero():
    """
    The original expression was `passed_count == len(request.test_cases)`.
    For an empty list that is `0 == 0` — so a submission that ran no tests at
    all was recorded as accepted, and `POST /v1/submit` with `test_cases: []`
    was a free pass on any problem.

    The router now rejects an empty set with 409 before reaching here, but that
    is policy and policy gets refactored. This is the invariant.
    """
    result = build_submission_result([])
    assert result.total_tests == 0
    assert result.passed_tests == 0
    assert result.all_passed is False


def test_all_passing_is_a_pass():
    result = build_submission_result([_result(True), _result(True)])
    assert (result.total_tests, result.passed_tests, result.all_passed) == (2, 2, True)


def test_one_failure_fails_the_submission():
    result = build_submission_result([_result(True), _result(False), _result(True)])
    assert (result.total_tests, result.passed_tests, result.all_passed) == (3, 2, False)


def test_hidden_failure_fails_the_submission():
    """Hidden cases count toward the verdict — that is the point of them."""
    result = build_submission_result([_result(True), _result(False, hidden=True)])
    assert result.all_passed is False
    assert result.total_tests == 2


# ── redact_for_response ─────────────────────────────────────────


def _hidden_result():
    return CaseResult(
        test_case_id="00000000-0000-0000-0000-0000000000ff",
        label="Hidden 1",
        is_hidden=True,
        passed=False,
        execution_result=ExecutionResultModel(
            stdout="SECRET_STDIN_ECHOED_BACK",
            stderr="ValueError: invalid literal for int(): SECRET_STDIN_ECHOED_BACK",
            compile_output="warning: unused variable 'x'",
            status_id=3,
            status_description="Accepted",
            time="0.010",
            memory=3200,
        ),
        expected_output="SECRET_EXPECTED",
        actual_output="SECRET_STDIN_ECHOED_BACK",
    )


def test_hidden_expected_output_is_redacted():
    assert redact_for_response(_hidden_result()).expected_output is None


def test_hidden_stdout_is_redacted():
    """
    The redaction people skip.

    Submitting `print(sys.stdin.read())` echoes the hidden case's INPUT back in
    stdout. Hiding the expected answer while returning the input defeats the
    whole exercise — the learner just hardcodes against what came back.
    """
    redacted = redact_for_response(_hidden_result())
    assert redacted.execution_result.stdout is None
    assert redacted.actual_output is None


def test_hidden_stderr_is_redacted():
    """Tracebacks quote the values that caused them, so stderr leaks input too."""
    assert redact_for_response(_hidden_result()).execution_result.stderr is None


def test_hidden_compile_output_is_preserved():
    """
    Guards the opposite direction. `compile_output` is produced before the
    program runs and cannot contain stdin, so keeping it lets the tutor explain
    a compile error on a hidden case at no cost. Over-redacting would silently
    degrade the product with no security benefit.
    """
    redacted = redact_for_response(_hidden_result())
    assert redacted.execution_result.compile_output == "warning: unused variable 'x'"


def test_hidden_pass_flag_and_label_survive():
    """A one-bit oracle per case is unavoidable, and is what every judge ships."""
    redacted = redact_for_response(_hidden_result())
    assert redacted.passed is False
    assert redacted.label == "Hidden 1"
    assert redacted.execution_result.status_id == 3


def test_no_secret_survives_serialisation_of_a_hidden_case():
    """
    Assert on the serialised STRING, not on parsed fields.

    A field-by-field check only covers the fields someone thought to check. If a
    future change adds another channel carrying output — a diff, a preview, a
    truncated echo — this catches it and the field checks above do not.
    """
    blob = redact_for_response(_hidden_result()).model_dump_json()
    assert "SECRET_EXPECTED" not in blob
    assert "SECRET_STDIN_ECHOED_BACK" not in blob


def test_visible_case_is_returned_untouched():
    visible = _result(True, label="Case 1")
    assert redact_for_response(visible) == visible
