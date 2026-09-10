"""Interview assessment must be able to reach the backend that is actually configured.

IT COULD NOT, AND NOTHING NOTICED.

`assess_answer` called `generate_response`, which is the HuggingFace path and only that: it reaches
for `tokenizer` and `model` directly. Under `USE_SGLANG=true` the lifespan never loads either --
there is no local model, that is the entire point of delegating inference -- so every assessment
raised `AttributeError: 'NoneType' object has no attribute 'apply_chat_template'`.

TWO THINGS KEPT IT INVISIBLE, AND BOTH ARE WORTH KNOWING.

The first is the endpoint's own `except Exception`, which turns any failure into
"The tutor is unavailable. Your answer is saved." A permanent, total outage of the feature and a
genuinely busy backend produce the identical message, so the only signal was a log line nobody was
reading.

The second is that every test and every evaluation in this repo drives `/v1/chat/completions`, which
has its own SGLang branch and was fine. The broken path is the one that deliberately does NOT go
through that endpoint -- it must not, because `prepare_messages_hybrid` replaces the system prompt
and produced hallucinated feedback, which `interviews.py` documents at length. So the code most in
need of a second path was the code least covered by the tests written for the first.

These read the source rather than importing it, because `conftest.py` records that tests must
never import `main` -- it pulls torch at module scope. `test_gpu_metering_wiring.py` and
`test_config_is_wired.py` make the same trade for the same reason.

THEY SCAN IDENTIFIERS, NOT TEXT, and the first draft of this file is why. Written as substring
checks, two of them failed immediately -- on their own explanatory docstrings, which name the
very things they forbid. A prose mention of `tokenizer` is not a call to it. This project has
the same scar twice already; the rule is to drop docstrings and walk the tree.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
MAIN = (SRC / "main.py").read_text(encoding="utf-8")
INTERVIEWS = (SRC / "routers" / "interviews.py").read_text(encoding="utf-8")


def _imported_generator() -> str:
    """Whatever `interviews.py` imports from `main` to generate with."""
    for node in ast.walk(ast.parse(INTERVIEWS)):
        if not isinstance(node, ast.ImportFrom) or "main" not in (node.module or ""):
            continue
        for alias in node.names:
            if alias.name.startswith("generate_"):
                return alias.name
    raise AssertionError(
        "interviews.py imports nothing named generate_* from main -- if assessment now reaches "
        "the model another way, point this test at it rather than deleting it")


def _function_node(name: str) -> ast.AST:
    for node in ast.walk(ast.parse(MAIN)):
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"main.py no longer defines {name}")


def _identifiers(node: ast.AST) -> list[tuple[str, int]]:
    """Every name and attribute the function actually USES, with its line.

    The docstring is dropped first. A comment or docstring naming a forbidden call is not a
    call to it, and a guard that cannot tell the difference fires on the sentence explaining
    why it exists -- which is exactly what the first version of this file did.
    """
    body = list(getattr(node, "body", []))
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]
    found: list[tuple[str, int]] = []
    for statement in body:
        for inner in ast.walk(statement):
            if isinstance(inner, ast.Name):
                found.append((inner.id, inner.lineno))
            elif isinstance(inner, ast.Attribute):
                found.append((inner.attr, inner.lineno))
    return found


def test_assessment_reaches_a_function_that_handles_the_delegated_backend():
    """THE ONE THAT WOULD HAVE CAUGHT IT.

    Whatever assessment calls has to know about `USE_SGLANG`. `generate_response` never did, and
    under the production configuration that made the feature 503 on every attempt.
    """
    name = _imported_generator()
    used = {ident for ident, _ in _identifiers(_function_node(name))}
    assert "USE_SGLANG" in used, (
        f"{name} has no SGLang branch, so interview assessment cannot reach the backend whenever "
        "inference is delegated -- which is how this is deployed. It will 503 on every attempt "
        "and report it as a busy tutor.")


def test_it_does_not_touch_the_tokenizer_before_choosing_a_backend():
    """The precise shape of the failure: `tokenizer.apply_chat_template` with tokenizer None.

    A branch that exists but sits below an unconditional tokenizer call is no branch at all.
    """
    name = _imported_generator()
    idents = _identifiers(_function_node(name))
    sglang_line = min(line for ident, line in idents if ident == "USE_SGLANG")
    early = [line for ident, line in idents if ident == "tokenizer" and line < sglang_line]
    assert not early, (
        f"{name} touches `tokenizer` before it checks USE_SGLANG; under a delegated backend "
        "tokenizer is None and this raises before the branch is reached")


def test_the_messages_are_passed_through_untouched():
    """Assessment must NOT go through `prepare_messages_hybrid`, and this is why.

    That function keyword-detects a mode and REPLACES the system prompt, so the grading
    instructions never arrived and the model -- handed the DEBUG prompt, which expects source code
    as context -- invented some. A candidate who typed "ewfwfe" was told their `random.shuffle`
    implementation was wrong. Fixing the backend must not quietly undo that fix.
    """
    name = _imported_generator()
    used = {ident for ident, _ in _identifiers(_function_node(name))}
    assert "prepare_messages_hybrid" not in used, (
        f"{name} builds its own prompt; assessment would get the tutoring system prompt instead of "
        "the grading one, which is what produced hallucinated feedback")


def test_a_failure_is_still_logged_rather_than_only_returned_as_503():
    """The reason a total outage looked like transient busyness for as long as it did.

    The message a learner sees is deliberately soft, and should stay soft. The exception behind it
    must reach the log with a traceback, or the next backend-shaped failure is invisible again.
    """
    assert "logger.exception" in INTERVIEWS, (
        "assessment failures are no longer logged with a traceback; the 503 text alone cannot "
        "distinguish a busy backend from a feature that has been dead for a week")
