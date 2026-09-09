# Committed licence text

Files here are copied into the packaged app by `scripts/collect-licences.mjs`. They are committed
rather than gathered at build time because **their source packages do not ship them.**

## `MPL-2.0.txt`

Pyodide is MPL-2.0 — its own `package.json` says so — and the npm package contains no licence file at
all: a README, a package.json, the wasm and asm bundles, the stdlib zip and `pyodide-lock.json`, and
nothing else. So there is nothing for the collector to copy, and MPL-2.0 §3.1 requires that recipients
of the covered software be informed of the terms and given the text.

The text here is the unmodified Mozilla Public License 2.0, verified to contain all ten sections plus
Exhibit A and no project-specific additions. It was taken from another MPL-2.0 dependency that does
ship it (`lightningcss`) rather than typed or fetched, so it is byte-identical to a copy already in
the tree.

**If Pyodide starts shipping its own licence file, prefer that** and delete this — a licence copied
from a third package is correct but indirect, and the direct one is better evidence.
