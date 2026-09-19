# VoidCode — IDE parity, revised against the VS Code source

Supersedes the seven-phase plan. Phases 1–4 of that plan have shipped; Phase 5 is in the tree
uncommitted. This revision covers what comes after, and is grounded in a read of
`microsoft/vscode` at `d8b1606` cloned to `../vscode-reference` (330 MB, depth 1).

Every reuse claim below was checked twice: once by a subsystem study and once by an adversarial
verifier that opened the same files trying to refute it. Two claims were downgraded, one hard.
Both downgrades are recorded, because the optimistic version of each would have cost days.

---

## 0. What was already true, and what the audit changed

| Phase | State |
| --- | --- |
| 1 Chrome polish | shipped `919965a` |
| 2 Model Manager `/models` | shipped, then extended to 126 entries / 52 families |
| 3 AI Assistant header | shipped `7de03fb` |
| 4 Bottom dock + terminals | shipped `c1b512f` |
| 5 Problems + Output | in tree, uncommitted |
| 6 Context input | not started |
| 7 Slash commands | not started |

The original plan's "Phase 1 — set up the repository, integrate Monaco, build a file explorer"
describes work that exists: Monaco at `renderer/src/components/Editor/MonacoWrapper.tsx` with a
local loader and a deliberate monochrome theme, the explorer at
`renderer/src/components/Build/FileTree.tsx`, 81 IPC channels, and a suite in the low thousands.
Rebuilding it would be destruction, not progress.

(This said "82 IPC channels, ~1810 tests". The channel count was one too many; the test count is the
kind of number that is wrong again by the next commit, so it is no longer stated precisely here — the
contract table and `tests/content-census.test.ts` are where counts belong.) Phase 1 below is the real next increment.

---

## 1. System architecture — main ↔ renderer

**Unchanged, and deliberately.** Electron 43, not Tauri. Moving to Tauri rewrites the main
process from Node to Rust and costs `node-pty` (the terminals), the `MessagePort` transfer that
carries `chat:open` / `agent:open` / `pty:spawn`, the `contextBridge` preload
that *is* the privilege boundary, and every main-process test. The trade is a smaller binary.
Not worth it.

The existing shape stays:

```
renderer (sandboxed, contextIsolation)
   │  host.<ns>.<method>()          generated from the channel list in preload
   ▼
preload  ─ contextBridge ─────────  cannot pass a MessagePort, so PORT_CHANNELS are proxied
   │
   ▼
broker.ts ── CHANNELS table (zod input schema + `modes: study | build`) ── handlers
```

Three rules that already hold and must keep holding:

1. **Every channel is in one table with a `modes` entry.** Adding one without it is a type
   error. Reviewing "what can a Study window reach?" is reading one file.
2. **`IpcError` is the only error whose message survives to the renderer.** Everything else is
   flattened, so a handler cannot leak a path or a stack by accident.
3. **`src/shared/*` is import-free.** `contract.ts` imports from it; a back-edge is a cycle.

**What the audit adds.** VS Code's `LayoutStateModel` (`layout.ts:2915-3221`) persists 22
independently-typed keys, each with its own default, storage scope and write policy, instead of
one versioned document. `BuildWorkspace.tsx` currently holds a single blob behind a
`version !== 1 && version !== 2` gate and re-saves on every change of
`[host, layout, paneSizes, centreSizes, dockTab, restored]` — which is an IPC round-trip on
every frame of a pane drag. Phase 2 below adopts the key-table shape and a batched
`onWillSaveState`-style flush. That is ~90 lines and it deletes a migration gate.

---

## 2. Core UI layout — a docking system, not a fixed grid

Today: `usePanels` gives per-destination booleans, `pane-sizes.ts` distributes fractions across
a fixed `left | centre | right`, and the dock is bottom-only with three tabs. Panels can be
hidden. They cannot be moved, split, or stacked.

The target is a **serialisable split tree**, which is what makes a dock "customizable" and
persistable at the same time. Deliberately *not* a copy of VS Code's chrome:

- **Panes are content, not roles.** VS Code has eight fixed `Parts` with string ids. Ours takes
  any registered view into any leaf, so "Terminal beside the editor" needs no new part type.
- **The dock is the same primitive as the sidebar.** One engine, four edges.
- **Monochrome did not stay, and this line said it would.** It read "`lib/monaco-theme.ts` is
  untouched; the ten greyscale rules are an identity, not an oversight". That was true of a
  read-only pane and a marketing demo, and stopped being true when the pane became an editor
  people read their own repository in. The rules are a desaturated hue set now, keeping the
  luminance ramp the greyscale carried; `apps/web` stays monochrome, which is where the
  identity argument still holds. Sashes still read as a 1px line, not a chrome ridge.
- **Layout is serialisable to a document a human can read**, so a broken layout is debuggable
  and a "reset layout" command is one delete.

### The seam that makes this possible

**Nothing in VS Code's layout engine measures the DOM.** `getBoundingClientRect`, `offsetWidth`
and `clientWidth` return zero hits across `grid.ts`, `gridview.ts`, `splitview.ts` and
`sash.ts`. Layout is arithmetic driven by an explicit `layout(width, height, top, left)`, then
written outward to `style.top/left/width/height`.

So the algebra can live in a pure module while **React owns every DOM node**. That is the whole
integration strategy, and it is why we do not take the engine itself: `grid.ts:183-197`
recovers a view's location by hopping exactly four `parentElement`s per level, with a comment
conceding it "will break as soon as DOM structures of the Splitview or Gridview change". React
can never own markup that code walks.

### What we take, verified twice

| Unit | Verdict | Why |
| --- | --- | --- |
| `IView` / `ISerializableView` contract | **vendor** | ~7 lines of content after type erasure. Three external types, not one: `Event<T>`, `LayoutPriority` (3-member enum), `IBoundarySashes`. |
| Layout algebra — `Direction`, orientation helpers, `getRelativeLocation` (141-157), `Sizing` (199-210), `ISerialized*` (744-774), `sanitizeGridNodeDescriptor`/`createSerializedGrid` (864-951) | **port** | Downgraded from lift-as-is: ~171 of 250 lines are genuinely pure, the rest are not. |
| 1-D flex resize — `resize`, `distributeEmptySpace`, `distributeViewSizes`, `saveProportions` | **port** | Holds at port-small. Deps are `clamp` (2 lines) and `range`/`pushToStart`/`pushToEnd` (~25). But `layout()` itself writes DOM — port the sizing, not the method. |
| `RangeMap` + `Range` (`base/browser/ui/list/rangeMap.ts`, `base/common/range.ts`) | **vendor**, at Phase 3 | 2 files, 278 lines (218 + 60). `range.ts` has zero imports; `rangeMap.ts` has exactly one, to `range.js`. The only claim that survived verification unaltered — though the path was recorded wrong first time and corrected against the tree. |
| `gridview.css` + `splitview.css` | **skip** | 85 lines, but encodes their DOM shape — `.monaco-scrollable-element` appears in nine rules. We render our own. |
| `SplitView`, `GridView`, `Grid`, `SerializableGrid` | **reference** | 74 files / 33,626 lines transitive. Plus the DOM-walking above. |
| `Part`, DI container, `Registry` | **reference** | 167 files / 58,216 lines; 73 / 22,224; contributions 316 / 113,746. All solve problems React solves — see §5. |
| VS Code's grid/splitview test suites | **reference** | **Downgraded hard.** 3 of ~35 tests are engine-independent (~63 lines, 3%). The serialize/deserialize block instantiates the real engine. Not a free conformance suite. |

### `saveProportions`, the trick worth naming

`deserialize` ends in `saveProportions()` (`splitview.ts:622-634`): stored pixel sizes become
ratios, and the first real `layout()` rescales them to the current window. That is what lets a
layout serialised on a 34" ultrawide restore sanely on a laptop. Our `pane-sizes.ts` reinvented
half of this already — a hidden pane keeps its share and reclaims it — so the concept is
familiar; the missing half is that *every* stored size should be a ratio, not a pixel count.

---

## 3. Licensing — the constraint that gates all of it

Verified by reading files, then re-verified adversarially.

- **The repository source is MIT.** `LICENSE.txt` is 21 lines of stock MIT,
  "Copyright (c) 2015 - present Microsoft Corporation". The sole obligation is lines 12-13:
  include the copyright and permission notice in all copies or substantial portions.
- **The product is not the repository.** `README.md:16`, verbatim: *"Visual Studio Code is a
  distribution of the `Code - OSS` repository with Microsoft-specific customizations released
  under a traditional Microsoft product license."* That sentence is the whole VSCodium story.
- **`product.json` has no `extensionsGallery` key.** The Marketplace is configured only in the
  branded build, and its Terms of Use restrict it to Visual Studio Code. If extensions ever
  happen here, the registry is **Open VSX**, never that endpoint.
- **MIT is already on our OSI allowlist**, so this does not strain the policy that removed
  DeepSeek-Coder.
- **MIT grants no trademark rights.** Not the name, not the logo. We are not "VS Code"-anything.
- **Not everything under `src/` is Microsoft's.** Six `cgmanifest.json` files sit under `src/`:
  `dompurify` (Apache-2.0/MPL-2.0), `marked` (MIT), `semver` (ISC), and others. 1,060 JS/TS
  files carry no MIT banner, 654 of them generated Codex protocol bindings. **Check the header
  and the directory before copying anything.** The units named in §2 were checked individually.
- Distribution-level encumbrances exist and are not ours: ffmpeg LGPL-2.1+, an H.264/AVC patent
  clause (`cgmanifest.json:487-512`, `"license": "OTHER"`), a zsh GPL warning in
  `terminal-suggest`. We ship none of that.

### Vendor discipline

Anything copied lands in `desktop/vendor/vscode/` — never edited in place, never reformatted —
with the original header intact, a `PROVENANCE.md` naming the upstream path and commit, and
`LICENSE.txt` alongside. Anything *ported* stays in our tree in our style, with a comment citing
`file:line` upstream. The distinction is deliberate: vendored code is Microsoft's and reads like
it; ported code is ours and must read like ours.

---

## 4. Extension host — architected for, not built

Deferred by decision. The architecture, for when it happens:

VS Code spawns a separate process and speaks `RPCProtocol`
(`services/extensions/common/rpcProtocol.ts`) over it, with `MainThreadX` / `ExtHostX` proxy
pairs in `src/vs/workbench/api/`. The shape maps cleanly onto our `PORT_CHANNELS` — we already
transfer a `MessagePort` per stream and proxy it in preload because a port cannot cross
`contextBridge`. An extension host is that pattern with a third process.

What makes it a project rather than a phase: it is arbitrary third-party code with filesystem
and process access. Our own plan already calls MCP's config-driven subprocess launching *"a
larger capability than `run_command`, which this codebase treats as the most dangerous thing it
does"*. An extension host is strictly larger. It needs a consent model that does not exist, a
sandboxing story, and it breaks the closed-world invariants `agent-tools.test.ts` asserts.
The smoke asserts `lspAbsent === true` as a deliberate claim, and that claim survives this plan.
(This listed a fourth `MessagePort` channel, `lsp:connect`, above. There are three
— `src/preload/index.ts` is the list — and no `lsp:` channel is declared anywhere, which is
what the assertion is asserting. A comment in `lib/monaco-local.ts` sent readers to that same
unbuilt subsystem for Build Mode's diagnostics; it now names `lint:run`, which is what actually
reports them.)

---

## 5. What we are not taking from VS Code, and why

- **The DI container.** `createDecorator` + `InstantiationService`, 769 lines, exists so 664
  services can be wired without `workbench.ts` importing them. Its `@IFoo` parameter decorators
  need class constructors; our ~185 renderer files are function components. React context is not
  a worse version of this — it is the same thing with compile-time checking instead of
  `accessor.get()` throwing at runtime.
- **`Registry` + `registerWorkbenchContribution2`** (716 and 367 call sites). Self-registration
  exists because extensions cannot import the workbench. We have no extensions, and
  `commands.tsx` already derives enablement from what is mounted, which is stronger than
  when-clauses.
- **The `Part` class.** 326 lines that look liftable and drag 167 files / 58,216 lines —
  `Part extends Component extends Themable` pulls the theme service and colour registry. Steal
  one idea instead: each panel owns its own persisted state rather than `BuildWorkspace.tsx`
  holding all of it.
- **A Ports tab.** Unchanged from the original plan and still correct: nothing in the app owns a
  port, `net/allowlist.ts` blocks loopback as SSRF defence, and the only binder is a command the
  user typed into an opaque pty.

---

## 6. Phases

### Phase 1 — the docking engine (this phase)

Pure model first, React second, because the model is where the bugs are and it is testable
without a DOM.

1. `vendor/vscode/` scaffolding: `LICENSE.txt`, `PROVENANCE.md`, `README.md` stating the rule.
2. `vendor/vscode/grid-contract.ts` — the vendored `IView` / serialised-node types, header
   intact.
3. `renderer/src/lib/layout/grid-model.ts` — ported algebra: `Direction`, orientation helpers,
   `getRelativeLocation`, node tree, `addView`/`removeView`/`moveView`, serialise/deserialise.
   Pure. No React, no DOM.
4. `renderer/src/lib/layout/sizing.ts` — ported 1-D distribution: clamp to `[min,max]`, carry
   the remainder, `saveProportions` as ratios.
5. `tests/grid-model.test.ts`, `tests/sizing.test.ts` — ours, written against the behaviour, not
   copied. Mutation-checked.
6. `components/Layout/DockGrid.tsx` + `Sash.tsx` — React renders the tree the model describes.
7. Migrate `BuildWorkspace` behind the existing layout document, defaulting to today's
   `left | centre | right` so a restored window is unchanged.

Verification: `tsc` both projects → `vitest run` → build → drive the real app over CDP,
screenshot at 1920/2560/3440, split and drag a pane, reload, confirm the layout restored.

### Phase 2 — layout state model

The `LayoutStateModel` key table, workspace-vs-profile scope, batched saving. Deletes the
version gate and the per-drag-frame IPC.

### Phase 3 — virtualised file tree

Vendor `RangeMap` + `Range` from `base/browser/ui/list/rangeMap.ts` and `base/common/range.ts` (278 lines, verified clean against the tree). Port the flat visible-rows model with
per-node `renderNodeCount` as ~150 lines over `BuildProjectTree` — the idea, not
`indexTreeModel.ts`'s 796 lines, which drag 80 files / 32,517 including `LcsDiff`. Keep
focus-vs-selection as separate concepts; VS Code is right about that and we currently conflate.

### Phase 4 — editor model + view state

Shared `ITextModel` across split editors, per-tab `ICodeEditorViewState` save/restore on tab
switch. This is the concrete gap in our Monaco integration.

### Phases 5–7 — unchanged from the original plan

Problems + Output (in tree), context input, slash commands.

---

## Verification, every phase

```bash
cd desktop && npx tsc --noEmit -p tsconfig.json && (cd renderer && npx tsc --noEmit -p tsconfig.json)
```

```bash
cd desktop && npx vitest run
```

```bash
cd desktop && npm run build && npm run build:renderer
```

Then drive the real app over CDP and look at it. Every guard gets a mutation test: change the
guard, watch the named test fail, restore. Source-reading assertions strip comments first and
are scoped to the declaration under test.
