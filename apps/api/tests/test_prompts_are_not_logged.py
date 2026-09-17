"""A learner's words never reach a log line.

The Privacy Policy tells an account holder that conversations sent to the VoidCode model are not
stored. Two log lines in `main.py` kept the first 60 characters of every question — not in a table,
so a check of the schema would never have seen it, but a log is stored, shipped and read more widely
than any row.

Checked on the AST, not the text: the comments that explain this rule name the very variables it
bans, and a regex over source would trip on its own explanation. `main.py` is parsed, never imported
— importing it pulls in torch.
"""
from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"

LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}

#: Names that hold what a learner typed, in the handlers that receive it.
LEARNER_TEXT = {"latest_user_message", "user_intent", "user_messages"}

#: Attributes that are a conversation's text wherever they appear on a request.
LEARNER_TEXT_ATTRS = {"messages", "content"}


def _is_logger_call(node: ast.Call) -> bool:
    func = node.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr in LOG_METHODS
        and isinstance(func.value, ast.Name)
        and func.value.id in {"logger", "log", "logging"}
    )


def _leaks(node: ast.AST) -> list[str]:
    """Learner-text references under `node`, ignoring those only measured with `len()`."""
    found: list[str] = []

    def visit(n: ast.AST) -> None:
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "len":
            return  # a count says nothing about what was written
        if isinstance(n, ast.Name) and n.id in LEARNER_TEXT:
            found.append(n.id)
        if isinstance(n, ast.Attribute) and n.attr in LEARNER_TEXT_ATTRS:
            found.append(f".{n.attr}")
        for child in ast.iter_child_nodes(n):
            visit(child)

    visit(node)
    return found


def _violations() -> list[str]:
    out: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _is_logger_call(node):
                args = [*node.args, *(k.value for k in node.keywords)]
                for arg in args:
                    for name in _leaks(arg):
                        out.append(f"{path.relative_to(SRC)}:{node.lineno} logs {name}")
    return out


def test_no_log_line_carries_a_learners_words() -> None:
    assert _violations() == []


def test_the_check_sees_a_leak() -> None:
    """Without this, a scan that matched nothing (wrong directory, wrong logger name) would pass."""
    tree = ast.parse('logger.info(f"q={latest_user_message[:60]}")\nlogger.info(f"n={len(user_messages)}")')
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _is_logger_call(n)]
    assert [name for c in calls for a in c.args for name in _leaks(a)] == ["latest_user_message"]
    assert any(SRC.rglob("main.py")), "the scan is not looking at the API source"
