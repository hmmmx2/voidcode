"""The download page offers exactly the installers the build produces, from the right repositories.

WHY THIS FILE EXISTS

`DownloadSection.tsx` finds its files by matching asset names against four regexes. Nothing checked
those against `desktop/electron-builder.yml`, which decides what is actually built and under what
name. Dropping `arm64` from `win.target` would leave a panel offering an ARM installer that no
release carries, and the section would say "No download yet" for a platform that has one — or worse,
offer the x64 file as the ARM one if a pattern were loosened to compensate.

It also caught a live gap. The section's environment variable was renamed from
`NEXT_PUBLIC_RELEASES_REPO` to a pair, one per platform, and NOTHING FAILED: no test named either
variable, so the component, the Dockerfile and the workflow could have disagreed silently. A
misconfigured build does not crash — it renders a section that permanently says no release has been
published, which reads like "not released yet" rather than "misconfigured".

WHAT HAPPENS TO THIS AT THE SPLIT. The website is being extracted into its own repository and will
not be able to read `electron-builder.yml`. The asset-name half then becomes a committed list in the
website's own repository, checked against its own patterns, with this repository asserting that its
build still produces those names. Written here while both trees are present, for the same reason as
`test_legal_digest.py`: right now the two ends can be compared directly, and after the split they
cannot.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
SECTION = ROOT / "apps/web/src/components/marketing/sections/DownloadSection.tsx"
BUILDER = ROOT / "desktop/electron-builder.yml"
DOCKERFILE = ROOT / "apps/web/Dockerfile"
CONTAINERS = ROOT / ".github/workflows/containers.yml"

#: The two variables the section reads, one per platform.
EXPECTED_VARS = {"NEXT_PUBLIC_RELEASES_REPO_MAC", "NEXT_PUBLIC_RELEASES_REPO_WIN"}

#: `artifactName` is `${productName}-${version}-${os}-${arch}.${ext}`, so an asset is named
#: `VoidCode-0.1.0-mac-arm64.dmg`. electron-builder's target name maps to that extension.
EXTENSION_OF = {"dmg": "dmg", "nsis": "exe", "AppImage": "AppImage", "deb": "deb"}


def section_source() -> str:
    return SECTION.read_text(encoding="utf-8")


def built_pairs() -> set[tuple[str, str, str]]:
    """`(os, arch, ext)` for every desktop artifact electron-builder is configured to produce."""
    config = yaml.safe_load(BUILDER.read_text(encoding="utf-8"))
    pairs: set[tuple[str, str, str]] = set()
    for os_key in ("mac", "win", "linux"):
        for target in config.get(os_key, {}).get("target", []):
            name = target["target"] if isinstance(target, dict) else target
            arches = target.get("arch", ["x64"]) if isinstance(target, dict) else ["x64"]
            ext = EXTENSION_OF.get(name)
            assert ext is not None, f"unknown electron-builder target {name!r}"
            for arch in arches:
                pairs.add((os_key, arch, ext))
    return pairs


def offered_pairs() -> set[tuple[str, str, str]]:
    """`(os, arch, ext)` for every pattern the download section matches on.

    Read out of the `KINDS` array's regexes rather than its `os`/`arch` fields, because the REGEX is
    what decides which asset a panel links to. A row whose fields say arm64 while its pattern
    matches x64 would hand someone the wrong installer, and only the pattern would show it.
    """
    found = re.findall(r"pattern:\s*/-(\w+)-(\w+)\\\.(\w+)\$/", section_source())
    return {(os_, arch, ext) for os_, arch, ext in found}


def test_the_patterns_parse_at_all() -> None:
    """A positive control. An empty set would make the comparison below vacuously true."""
    assert len(offered_pairs()) == 4, f"expected four KINDS patterns, read {offered_pairs()}"
    assert len(built_pairs()) >= 4


def test_every_offered_download_is_one_the_build_produces() -> None:
    """The direction that matters most: a dead link on the page that hands over the product."""
    missing = sorted(offered_pairs() - built_pairs())
    assert not missing, (
        "the download section offers installers electron-builder does not build: "
        f"{missing}. Either add the target in desktop/electron-builder.yml or drop the KINDS entry."
    )


def test_every_desktop_installer_the_build_produces_is_offered() -> None:
    """The other direction, scoped to macOS and Windows.

    Linux is built and deliberately NOT offered here: AppImage and .deb go to the main repository's
    own release, and the distribution repositories the section reads carry installers for these two
    platforms only. That is why this test filters rather than comparing the whole set — and why the
    section's footer no longer claims Linux builds are on "the releases page".
    """
    desktop_only = {p for p in built_pairs() if p[0] in {"mac", "win"}}
    unoffered = sorted(desktop_only - offered_pairs())
    assert not unoffered, (
        f"electron-builder builds installers the download section never offers: {unoffered}"
    )


def test_the_section_reads_one_repository_per_platform() -> None:
    source = section_source()
    for name in EXPECTED_VARS:
        assert f"process.env.{name}" in source, f"{name} is not read by the download section"

    # The single-repository variable is GONE, not kept as a fallback: a deployment that set only the
    # old name would look configured and serve Windows visitors macOS disk images.
    assert "process.env.NEXT_PUBLIC_RELEASES_REPO ?" not in source
    assert not re.search(r"process\.env\.NEXT_PUBLIC_RELEASES_REPO\b(?!_)", source)


@pytest.mark.parametrize("name", sorted(EXPECTED_VARS))
def test_the_build_pipeline_supplies_both_variables(name: str) -> None:
    """A NEXT_PUBLIC_* value is inlined at build time, so it has to arrive as a Docker ARG.

    Three places have to agree: the component reads it, the Dockerfile declares it as an ARG and
    promotes it to ENV, and the workflow passes it. Any one of them missing produces a page that
    says "no release has been published" forever, with nothing failing anywhere.
    """
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert f"ARG {name}=" in dockerfile, f"{name} is not an ARG in apps/web/Dockerfile"
    assert f"ENV {name}=${name}" in dockerfile, f"{name} is declared but never promoted to ENV"

    workflow = CONTAINERS.read_text(encoding="utf-8")
    assert f"{name}=$" in workflow, f"{name} is not passed as a build-arg in containers.yml"


def test_the_old_single_variable_is_gone_from_the_pipeline_too() -> None:
    """Leaving it behind anywhere is a knob nothing reads, which looks like a control."""
    for path in (DOCKERFILE, CONTAINERS):
        source = path.read_text(encoding="utf-8")
        # Comments legitimately mention the old name to explain the change, so this looks for the
        # operative shapes only: an ARG/ENV declaration, or a build-arg assignment.
        assert not re.search(r"^\s*(ARG|ENV)\s+NEXT_PUBLIC_RELEASES_REPO=", source, re.M), path
        assert not re.search(r"^\s+NEXT_PUBLIC_RELEASES_REPO=\$", source, re.M), path
