"""Frontend failure states, asserted from source because `apps/web` has no JS test runner.

159 TypeScript files, zero automated tests, guarded only by `tsc --noEmit` and ESLint — neither of
which runs in CI. These checks are weaker than executing the components, and they are chosen for one
property: each guards a failure that **renders successfully**. A blank screen, a permanent skeleton
and an empty IDE all typecheck, lint clean, and look like working software.

They belong in the Python suite because that is what CI actually runs today. When a JS runner lands,
these should become real component tests and this file should go.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[2] / "web" / "src"


def code_of(path: Path) -> str:
    """Source with comments stripped, so a comment describing a hazard is not read as the hazard."""
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))


# ── the workspace no longer renders an IDE with no problem in it ─────────────

def test_the_workspace_has_a_failure_state() -> None:
    """It caught the error, logged it, and fell through to the full IDE with `problem === null`:
    "No problem loaded" in the tabs, empty editor, no test cases, no tutor panel. A working-looking
    workspace with nothing in it and no explanation."""
    code = code_of(WEB / "components" / "Layout" / "WorkspaceClient.tsx")
    assert "loadError" in code, "WorkspaceClient does not track why the load failed"
    assert "if (loadError || !problem)" in code, (
        "the failure branch is gone — a failed load would render the empty IDE again")


def test_the_workspace_separates_a_dead_link_from_a_dead_api() -> None:
    """They need different actions: a 404 should offer the catalogue, an unreachable API a retry.
    Collapsed together, one of the two buttons is always wrong."""
    code = code_of(WEB / "components" / "Layout" / "WorkspaceClient.tsx")
    assert 'setLoadError(missing ? "missing" : "failed")' in code


# ── the four pages that hung on their skeleton forever ───────────────────────

PAGES = [
    "components/Homepage/HomepageClient.tsx",
    "components/Problems/ProblemCatalogueClient.tsx",
    "components/Interviews/InterviewCatalogueClient.tsx",
    "components/Research/PaperLibraryClient.tsx",
]


@pytest.mark.parametrize("relative", PAGES)
def test_pages_guard_on_session_readiness_not_on_a_user_id(relative: str) -> None:
    """`useUserId()` returns undefined BOTH while the session resolves and when there is no id.

    `if (!userId) return` inside an effect whose `isLoading` starts true therefore hangs on the
    skeleton forever for a signed-out reader — no error, no empty state, a permanent shimmer. The
    API serves the public catalogue to an anonymous caller, so these pages must fetch either way.
    """
    code = code_of(WEB / relative)
    assert "if (!userId) return" not in code, (
        f"{relative} still gates its fetch on a user id that may never arrive")
    assert "useSessionUser" in code and "if (!ready) return" in code


@pytest.mark.parametrize("relative", PAGES)
def test_readiness_is_in_the_effect_dependencies(relative: str) -> None:
    """Guarding on `ready` without depending on it means the effect never re-runs once the session
    settles — the same permanent skeleton, reached a different way."""
    code = code_of(WEB / relative)
    assert "[userId, ready]" in code or "ready]" in code, (
        f"{relative} guards on `ready` but does not depend on it")


def test_the_hook_documents_the_ambiguity_it_causes() -> None:
    """`useUserId` is kept for other callers, so the trap has to be written down where it is."""
    code = code_of(WEB / "lib" / "hooks" / "useUserId.ts")
    assert "useSessionUser" in code
    assert 'status !== "loading"' in code


# ── error boundaries, which did not exist at all ─────────────────────────────

def test_the_app_has_a_not_found_page() -> None:
    """Without one, a bad URL fell to Next's light-themed default in an all-dark app — which reads
    as a broken site rather than a mistyped link."""
    assert (WEB / "app" / "not-found.tsx").exists()


def test_the_app_has_an_error_boundary() -> None:
    path = WEB / "app" / "error.tsx"
    assert path.exists()
    code = code_of(path)
    assert '"use client"' in code, "error.tsx must be a client component — Next requires it"
    assert "reset" in code, "must accept `reset`, or a transient failure needs a full reload"


def test_the_error_page_does_not_publish_the_error_message() -> None:
    """A thrown error can carry a database string, an internal URL or a stack fragment. `digest` is
    Next's own hash of the server-side error and is the safe thing to show."""
    code = code_of(WEB / "app" / "error.tsx")
    assert "error.digest" in code
    assert "{error.message}" not in code, "error.tsx renders the raw message to the user"


def test_there_is_a_global_error_for_root_layout_failures() -> None:
    """`error.tsx` renders INSIDE the layout, so it cannot catch a layout that failed."""
    path = WEB / "app" / "global-error.tsx"
    assert path.exists()
    code = code_of(path)
    assert "<html" in code and "<body" in code, (
        "global-error replaces the whole document and must supply html and body")


def test_global_error_does_not_depend_on_the_layout_it_replaces() -> None:
    """It runs when the root layout failed, so it cannot use the fonts, CSS variables or providers
    that layout was responsible for. A fallback needing the thing it falls back from is not one."""
    code = code_of(WEB / "app" / "global-error.tsx")
    for token in ("bg-void", "text-ink", "@/components", "className="):
        assert token not in code, f"global-error.tsx depends on {token!r} from the failed layout"


# ── every profile field was announced unlabelled ─────────────────────────────

def test_no_profile_label_is_left_unassociated() -> None:
    """Labels were siblings of their inputs with no htmlFor and no id, so a screen reader announced
    name, bio, birth date, country, occupation and timezone as unlabelled edit boxes."""
    code = code_of(WEB / "components" / "Profile" / "ProfileClient.tsx")
    orphans = re.findall(r"<label(?![^>]*htmlFor)[^>]*>", code)
    assert not orphans, f"{len(orphans)} label(s) with no htmlFor: {orphans[:2]}"


def test_the_shared_field_row_generates_its_own_id() -> None:
    """A slug of the label text would collide when two fields share a label, and duplicate ids
    silently associate the second label with the first input."""
    code = code_of(WEB / "components" / "Profile" / "ProfileClient.tsx")
    assert "useId()" in code
