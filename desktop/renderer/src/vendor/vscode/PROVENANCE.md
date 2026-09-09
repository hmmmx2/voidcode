# Vendored from microsoft/vscode

Upstream: <https://github.com/microsoft/vscode>
Commit: `d8b160690c1848cf3d12330939c4cd27287dae93`
Licence: MIT — see `LICENSE.txt` beside this file, copied verbatim from the upstream root.

## The rule

**Files in this directory are Microsoft's, not ours.** They keep the upstream header, the
upstream formatting (tabs, single quotes), and the upstream doc comments. They are not
reformatted to house style, not run through our linter, and not edited to fix things we would
write differently. If one needs to change, the change belongs in a wrapper outside this
directory.

That is the whole reason the directory exists. MIT's only obligation is that the copyright and
permission notice travel with any copy or substantial portion — keeping the files verbatim and
the licence beside them satisfies it, and keeps "which lines are ours?" answerable by looking at
the path rather than by reading a diff.

**Ported code is different and does not live here.** Where we reimplemented an algorithm in our
own style — the grid model and the sizing pass in `lib/layout/` — the file is ours, reads like
ours, and cites the upstream `file:line` in a comment. Vendoring and porting are not
interchangeable, and the directory boundary is what keeps them distinguishable.

## What is here, and why only this

The layout engine itself was deliberately *not* vendored. `grid.ts`'s transitive import closure
is 74 files / 33,626 lines, and `grid.ts:183-197` recovers a view's position by walking exactly
four `parentElement`s per level — with an upstream comment conceding it "will break as soon as
DOM structures of the Splitview or Gridview change". React has to own that markup, so the engine
could never have worked here. What survives the boundary is the part with no DOM in it at all.

| File | Upstream | Notes |
| --- | --- | --- |
| `grid-contract.ts` | `src/vs/base/browser/ui/grid/grid.ts` (744-774), `gridview.ts` (41-136) | The serialised-layout wire format and the view contract. Types only — erases completely at build time. |

Keeping the wire format byte-identical to VS Code's is a deliberate bonus: a serialised layout
can be compared against a known-good format, and anyone who has debugged a VS Code layout can
read ours.

## Checking a file before adding it here

Not everything under `src/` upstream is Microsoft's. Six `cgmanifest.json` files sit inside
`src/vs`, covering `dompurify` (Apache-2.0/MPL-2.0), `marked` (MIT), `semver` (ISC) and others,
and 1,060 JS/TS files carry no MIT banner at all — 654 of them generated protocol bindings. So:
read the file's own header and check for a sibling `cgmanifest.json` before copying it. The
files here were checked individually.

Trademarks are not licensed by MIT. Nothing here uses the Visual Studio Code name or marks.
