"""The build produces exactly the installers the download page offers.

WHY THIS FILE SHRANK

It used to read `apps/web/src/components/marketing/sections/DownloadSection.tsx` and compare its
four asset-matching regexes with `desktop/electron-builder.yml`'s target matrix, in both directions.
The website is `voidcode-web` now and this repository cannot see that file.

WHAT SURVIVES HERE IS THE HALF THIS REPOSITORY OWNS: what the build actually produces. The other
half — that the page offers exactly those files — belongs with the page, and the shape of the asset
names is the contract between them.

WHY NOT A CONTRACT FILE LIKE THE PRICES AND THE LEGAL TEXT. Because the names are already published,
in a place both sides can read: every release carries `SHA256SUMS.txt`, listing every asset by name.
The distribution repositories' `verify-release.yml` checks the installers against it, and the
website reads the release feed itself rather than a committed list. A fourth contract would add a
copy without adding a reader.

So this asserts the matrix is what the release notes, the distribution READMEs and the download page
all assume: x64 and arm64, for both desktop platforms, as `.dmg` and `.exe`. Dropping an
architecture fails here — and `desktop/tests/release-config.test.ts` separately holds the
`distribute` job's expected file counts to the same table, so a build that produces three installers
cannot publish a release claiming four.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "desktop/electron-builder.yml"

#: `artifactName` is `${productName}-${version}-${os}-${arch}.${ext}`, so an asset is named
#: `VoidCode-0.1.0-mac-arm64.dmg`. electron-builder's target name maps to that extension.
EXTENSION_OF = {"dmg": "dmg", "nsis": "exe", "AppImage": "AppImage", "deb": "deb"}

#: What every downstream reader assumes: two architectures per desktop platform.
EXPECTED = {
    ("mac", "x64", "dmg"),
    ("mac", "arm64", "dmg"),
    ("win", "x64", "exe"),
    ("win", "arm64", "exe"),
}


def built_pairs() -> set[tuple[str, str, str]]:
    """`(os, arch, ext)` for every artifact electron-builder is configured to produce."""
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


def test_the_matrix_parses_at_all() -> None:
    """A positive control. An empty set would make the comparison below vacuously true."""
    assert len(built_pairs()) >= 4, f"only {built_pairs()} parsed from electron-builder.yml"


@pytest.mark.parametrize("pair", sorted(EXPECTED))
def test_each_expected_installer_is_built(pair: tuple[str, str, str]) -> None:
    """Named one at a time, so a failure says which platform lost an architecture."""
    assert pair in built_pairs(), (
        f"electron-builder does not build {pair[0]}-{pair[1]}.{pair[2]}. The download page offers "
        "it, the distribution README names it, and `release.yml`'s distribute job counts on it."
    )


def test_no_desktop_installer_is_built_that_nothing_hands_out() -> None:
    """The other direction, scoped to macOS and Windows.

    Linux is built and deliberately not distributed through the two installer repositories: the
    AppImage and `.deb` stay on this repository's own release. So this filters rather than comparing
    whole sets — and that filter is why the website's footer no longer claims Linux builds are on
    "the releases page".
    """
    desktop_only = {pair for pair in built_pairs() if pair[0] in {"mac", "win"}}
    assert desktop_only == EXPECTED, (
        f"the build produces {sorted(desktop_only)} for macOS and Windows, and everything "
        f"downstream assumes {sorted(EXPECTED)}"
    )
