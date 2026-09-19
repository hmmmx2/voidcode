"""The in-process inference path names what it needs before it touches it.

WHY THIS IS A SOURCE TEST AND NOT A CALL. `conftest.py` states the rule it follows: nothing in this
suite imports `main`, because that module imports torch and transformers at module scope and
injects `llm/scripts` onto `sys.path`. Importing it here to call one function would make every test
in the suite depend on the whole inference stack. So the property is checked against the AST.

WHAT WENT WRONG, AND WHY THE AST RATHER THAN A REGEX. The torch import in `main.py` is optional by
design — the comment above it says so, because the SGLang container is CPU-only and carries no
torch. `load_model` then dereferenced `torch.cuda` without checking, so in any image built without
it the process exited during startup with:

    AttributeError: 'NoneType' object has no attribute 'cuda'

which names neither the missing dependency nor the flag that avoids needing it. That is reachable
and was reached: standing this API up in the test image exited exactly there.

A regex over the source would be the obvious check and the wrong one — this file discusses
`torch.cuda` in prose, in this very docstring, and a text scan cannot tell a comment from a
statement. The walk below reads the function's statements in order.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "src" / "main.py"


def _function(name: str) -> ast.FunctionDef:
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} is gone from src/main.py; this test guards nothing")


def _mentions(node: ast.AST, name: str) -> bool:
    return any(isinstance(child, ast.Name) and child.id == name for child in ast.walk(node))


def test_load_model_checks_torch_is_present_before_using_it() -> None:
    """The availability flag has to be read before the module it describes is dereferenced."""
    body = _function("load_model").body

    first_use = next(
        (i for i, statement in enumerate(body) if _mentions(statement, "torch")),
        None,
    )
    assert first_use is not None, (
        "load_model no longer mentions torch at all. If the in-process path is gone, delete this "
        "test rather than loosening it."
    )

    first_guard = next(
        (i for i, statement in enumerate(body) if _mentions(statement, "_TORCH_AVAILABLE")),
        None,
    )
    assert first_guard is not None, (
        "load_model dereferences torch without consulting _TORCH_AVAILABLE. In an image without "
        "torch the module is None, and the first attribute access raises AttributeError during "
        "startup instead of saying which dependency is missing."
    )
    assert first_guard < first_use, (
        f"load_model reads torch at statement {first_use} and checks _TORCH_AVAILABLE at "
        f"{first_guard}. The check has to come first, or it cannot prevent anything."
    )


def test_it_also_checks_transformers_before_building_a_quantisation_config() -> None:
    """`BitsAndBytesConfig` is imported under the same optional guard as torch.

    One dependency later, and the same shape of failure: a `NameError` on a symbol that simply was
    not imported, raised at startup, naming nothing useful. Checked together with torch so an image
    missing both is told once rather than twice.
    """
    body = _function("load_model").body

    first_use = next(
        (i for i, statement in enumerate(body) if _mentions(statement, "BitsAndBytesConfig")),
        None,
    )
    if first_use is None:
        return  # the 4-bit path is gone; nothing to guard

    first_guard = next(
        (i for i, statement in enumerate(body) if _mentions(statement, "_TRANSFORMERS_AVAILABLE")),
        None,
    )
    assert first_guard is not None and first_guard < first_use, (
        "load_model builds a BitsAndBytesConfig without checking _TRANSFORMERS_AVAILABLE first"
    )


def test_the_refusal_names_the_way_out() -> None:
    """A message that says what is missing and not what to do about it is half a diagnosis.

    The in-process path is the DEFAULT — it runs when neither `USE_SGLANG` nor `USE_VLLM` is set —
    so the operator who reaches this error never chose it. Both of the errors it can raise therefore
    name the flag, which is the part that turns the message into an action.
    """
    source = ast.unparse(_function("load_model"))

    raises = [
        node
        for node in ast.walk(_function("load_model"))
        if isinstance(node, ast.Raise)
    ]
    assert len(raises) >= 3, f"load_model raises {len(raises)} times, expected the three prerequisites"

    assert "USE_SGLANG" in source, (
        "neither refusal mentions USE_SGLANG, so nothing tells the reader that delegating "
        "inference is the alternative to installing a GPU stack"
    )
    # The dependency refusal points at the requirements file that would satisfy it; the CUDA
    # refusal points at scheduling. Both are actions rather than observations.
    assert "requirements.gpu.txt" in source
