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
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]

#: Every requirements file an API image is built from.
REQUIREMENTS = ("requirements.txt", "requirements.gpu.txt", "requirements.sglang.txt")

#: Distribution → the module the API imports it as.
ACCOUNT_DEPENDENCIES = {
    "argon2-cffi": "argon2",
    "email-validator": "email_validator",
    "pyjwt": "jwt",
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


def test_the_parser_reads_every_line_shape_the_files_use():
    """The test above is only as good as `declared`. Pinned (`httpx==`), extras (`uvicorn[standard]`,
    `PyJWT[crypto]`), mixed case and `_`/`-` spellings all occur in these files; each must normalise
    to the name the table uses, or a present dependency reads as missing and a missing one might not."""
    names = declared("requirements.gpu.txt")
    assert {"httpx", "fastapi", "pyjwt", "uvicorn", "argon2-cffi", "email-validator"} <= names
    assert not any("[" in n or "=" in n or n != n.lower() for n in names)
