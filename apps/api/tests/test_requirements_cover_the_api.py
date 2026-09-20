"""Every image that runs the API can import the parts of the API that sign people in.

There are three requirements files because there are three ways to build the API: the plain one, the
GPU image that runs the model in-process, and the CPU image that sits in front of an SGLang server.
Only the plain one declared the auth and metrics dependencies. The other two images could not import
`routers/auth.py` at all — `password_service` needs argon2, the request models need
`email-validator`, `/metrics` needs `prometheus-client` — and nothing noticed, because CI installs a
hand-picked list rather than any of the three files.

With sign-in moving into the desktop app, the API is the only place an account can be created, so an
image that cannot load the auth router is an image that cannot serve the product.

Read as text and never imported: this has to pass in an environment that has none of these installed,
because that is exactly the environment it is protecting.
"""

import re
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]

#: Every requirements file an API image is built from.
REQUIREMENTS = ("requirements.txt", "requirements.gpu.txt", "requirements.sglang.txt")

#: Distribution → the module the API imports it as.
#:
#: `"pyjwt": "jwt"` WAS HERE, and it came out with Google and Microsoft sign-in. It was declared in
#: all three files for `services/oidc.py`, which verified ID tokens against the provider's JWKS;
#: nothing imports `jwt` now. Both tests below would have caught it from either direction — one
#: fails if a file stops declaring what the table names, the other if the table names something the
#: source never imports — which is why the entry could not simply be left behind.
ACCOUNT_DEPENDENCIES = {
    "argon2-cffi": "argon2",
    "email-validator": "email_validator",
    "prometheus-client": "prometheus_client",
}

_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def declared(filename: str) -> set[str]:
    """Normalised distribution names in a requirements file: case-folded, `_`/`.` → `-`, no extras."""
    names = set()
    for line in (API / filename).read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        match = _NAME.match(line)
        if match:
            names.add(re.sub(r"[._]+", "-", match.group(1)).lower())
    return names


@pytest.mark.parametrize("filename", REQUIREMENTS)
def test_every_api_image_declares_the_account_dependencies(filename):
    missing = sorted(set(ACCOUNT_DEPENDENCIES) - declared(filename))
    assert not missing, (
        f"{filename} does not declare {missing}. An image built from it cannot import the auth "
        "router, so it cannot sign anybody in."
    )


def _imported_top_level_modules() -> set[str]:
    import ast

    modules: set[str] = set()
    for path in (API / "src").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules.add(node.module.split(".")[0])
    return modules


#: Dependencies the API needs without importing them by name. `EmailStr` makes pydantic import
#: `email_validator` at validation time, so an import scan never sees it; the source marker proves
#: the need instead.
_INDIRECT = {"email_validator": "EmailStr"}


def test_every_declared_account_dependency_is_really_used():
    """The other direction. Without this the table above could keep a dependency nothing needs —
    or keep being cited as the reason one is installed long after the code that needed it is gone."""
    imported = _imported_top_level_modules()
    source = "\n".join(p.read_text(encoding="utf-8") for p in (API / "src").rglob("*.py"))
    unused = []
    for dist, module in ACCOUNT_DEPENDENCIES.items():
        marker = _INDIRECT.get(module)
        used = module in imported or (marker is not None and marker in source)
        if not used:
            unused.append(f"{dist} ({module})")
    assert not unused, f"declared as account dependencies but not used by apps/api/src: {unused}"


def test_the_parser_reads_every_line_shape_the_files_use(tmp_path, monkeypatch):
    """The test above is only as good as `declared`.

    THE REAL FILES NO LONGER COVER EVERY SHAPE. `PyJWT[crypto]` was the one mixed-case entry in all
    three, and removing it left only lower-case names — so an assertion over the real files would
    still pass with the case-folding deleted, which is a guard that has quietly stopped guarding.

    So the shapes are fed in directly. The real files are still asserted below, for the shapes they
    do use: a pin, an extra, and a plain name."""
    written = tmp_path / "requirements.sample.txt"
    written.write_text(
        "\n".join(
            (
                "# a comment line",
                "--extra-index-url https://example.invalid/simple",
                "",
                "Mixed-Case==1.0",
                "under_score>=2",
                "dotted.name==3",
                "extras[one,two]==4",
                "plain",
                "trailing==5  # with a comment",
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sys.modules[__name__], "API", tmp_path)
    assert declared("requirements.sample.txt") == {
        "mixed-case",
        "under-score",
        "dotted-name",
        "extras",
        "plain",
        "trailing",
    }

    monkeypatch.undo()
    names = declared("requirements.gpu.txt")
    assert {"httpx", "fastapi", "uvicorn", "argon2-cffi", "email-validator"} <= names
    assert not any("[" in n or "=" in n or n != n.lower() for n in names)


# ── The hand-picked lists, which are what CI actually installs ───────────────

#: Every workflow with a job that either runs this suite or starts the app.
_WORKFLOWS = (".github/workflows/ci.yml", ".github/workflows/desktop.yml")

#: What a step's `run:` contains when its job needs the auth router to import. Both shapes matter:
#: one runs these tests, the other spawns `src.main:app` through the account harness.
_RUNS_THE_API = ("pytest apps/api/tests", "smoke:account")

REPO = API.parents[1]


def _pip_arguments(run: str) -> str:
    """The packages a `run:` block actually asks pip for — comments removed, continuations joined.

    COMMENTS ARE STRIPPED FIRST, AND THAT IS THE WHOLE POINT OF THIS FUNCTION. The first version of
    the test below searched the raw `run:` text, and `ci.yml`'s install step carries a paragraph
    explaining which package had been missing — so the guard was satisfied by the comment that
    describes the bug rather than by the fix. A guard whose subject is prose about itself is the
    trap `docs/` records under "the comment explaining a banned pattern IS the banned pattern".
    """
    uncommented = "\n".join(line.split("#", 1)[0] for line in run.splitlines())
    # `pip install a \` + newline + `  b` is one command; join before matching.
    joined = re.sub(r"\\s*\n\s*", " ", uncommented)
    return "\n".join(line for line in joined.splitlines() if "pip install" in line)


def _api_jobs() -> list[tuple[str, str, str]]:
    """(workflow, job name, the pip arguments of every step) for jobs that exercise the API.

    yaml rather than a text search over the file, because "does this job install X" is a question
    about a job, and two jobs in one file have two different lists.
    """
    import yaml

    found = []
    for relative in _WORKFLOWS:
        document = yaml.safe_load((REPO / relative).read_text(encoding="utf-8"))
        for name, job in (document.get("jobs") or {}).items():
            runs = [
                step["run"]
                for step in (job.get("steps") or [])
                if isinstance(step, dict) and isinstance(step.get("run"), str)
            ]
            if any(marker in run for run in runs for marker in _RUNS_THE_API):
                found.append((relative, name, "\n".join(_pip_arguments(run) for run in runs)))
    return found


def test_a_job_that_runs_the_api_was_found_in_each_workflow():
    """The floor. Everything below is vacuous if the markers stop matching anything, and a renamed
    script or a moved job is exactly how that happens quietly."""
    jobs = _api_jobs()
    assert jobs, f"no job in {_WORKFLOWS} runs any of {_RUNS_THE_API}; the guard below checks nothing"
    covered = {relative for relative, _, _ in jobs}
    assert covered == set(_WORKFLOWS), (
        f"only {sorted(covered)} has a job matching {_RUNS_THE_API}; expected all of {_WORKFLOWS}"
    )


def test_the_workflows_install_what_the_api_needs():
    """THE GAP THIS FILE'S OWN DOCSTRING NAMES, closed.

    The three requirements files are checked above, and CI installs none of them — it installs a
    hand-picked list, which is stated at the top of this file as the reason the omission went
    unnoticed the first time. It then went unnoticed a second time: `prometheus-client` was added to
    all three files and to `desktop.yml`'s account job and not to `ci.yml`'s, so
    `test_backend_registry.py` and `test_monitoring_dashboard.py` refused to run rather than pass
    vacuously — correct of them — and the job failed with an annotation that named no package.

    Reading the workflow rather than importing is the same choice the rest of this file makes: this
    has to pass in an environment that has none of these installed.
    """
    for relative, job, installs in _api_jobs():
        # A job that installs a whole requirements file is asking for the declared set, which the
        # tests above already hold. That is the better shape and is not failed for.
        if re.search(r"pip install[^\n]*-r[^\n]*apps/api/requirements\.txt", installs):
            continue
        missing = [
            dist
            for dist in sorted(ACCOUNT_DEPENDENCIES)
            if not re.search(rf"(?<![A-Za-z0-9._-]){re.escape(dist)}(?![A-Za-z0-9._-])", installs)
        ]
        assert not missing, (
            f"{relative} job {job!r} runs the API but never installs {missing}. The auth router "
            f"cannot import without them, and the failure reads as a broken test rather than a "
            f"missing package. What it does install:\n{installs}"
        )


def test_the_pip_argument_reader_ignores_comments_and_follows_continuations():
    """`_pip_arguments` is the only reason the test above is not satisfied by its own documentation.

    Positive control and negative control in one place, because the negative is the one that failed:
    a package named ONLY in a comment must not count, and a package on a continuation line must.
    """
    assert "argon2-cffi" not in _pip_arguments("pip install fastapi\n# argon2-cffi goes here")
    assert "argon2-cffi" in _pip_arguments("pip install fastapi \\n  argon2-cffi email-validator")
    # A comment on the same line as a real install does not hide the packages before it.
    assert "fastapi" in _pip_arguments("pip install fastapi  # the web framework")
    # And a line that is not a pip install contributes nothing, however much it names.
    assert _pip_arguments("pytest apps/api/tests -v  # needs prometheus-client") == ""
