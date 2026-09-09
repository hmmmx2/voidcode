# VoidCode — Open Questions

What is genuinely undecided about **this** repository: an ML/DL/LLM/VLM interview-prep curriculum
and a coding agent sharing one Electron window, the FastAPI platform behind it, and the RL training
work that produces the model.

Three documents answer "what is undecided", and they are not interchangeable:

| File | Scope |
|---|---|
| **this file** | shipping the product — signing, notarisation, updates, provenance |
| [`docs/rl/OPEN_QUESTIONS.md`](rl/OPEN_QUESTIONS.md) | the RL half: what was built ahead of its prerequisites, and what the training spec still lacks |
| [`docs/specs/OPEN_QUESTIONS.md`](specs/OPEN_QUESTIONS.md) | review findings against the two specs, raised under their own §0 rule 5 |

## What this file used to be

Seven questions (Q-001 … Q-007) about a distributed GPU training run: whether a second card was
present for ZeRO-2, DeepSpeed's `no_sync` behaviour, 31.6 GB of host RAM against a 128 GB
requirement, a PCIe link negotiated at 8x, and how a proposed flat ML layout reconciled with an
`apps/web` + `apps/api` + `llm/` monorepo.

**Those questions are real and they are still in this repository** — they moved to
[`docs/specs/OPEN_QUESTIONS.md`](specs/OPEN_QUESTIONS.md), beside the specs they review. What was
wrong was never their content; it was that they occupied the path the README points at as "what is
undecided", so the most visible statement of this project's uncertainty was a set of mostly-answered
findings about hardware the desktop application does not use.

That happened twice, for two different reasons, which is why it is written down rather than simply
fixed. The first time, the desktop half inherited the file from the branch it forked from. The
second time, the consolidation of the two codebases hit a name collision at this path and the
platform half's copy won silently — the same defect, reintroduced by a merge rather than by
inheritance. `desktop/tests/doc-links.test.ts` is what caught it, and it fails on the day a heading
here mentions ZeRO, DeepSpeed, NCCL, PCIe or a monorepo again.

The questions below are the real ones. Each says what would settle it, because an open question
nobody can close is a complaint.

---

## Q-001 — Code signing on Windows

**Unsigned.** SmartScreen shows "Windows protected your PC" on first run and hides **Run anyway**
behind **More info**. Verified against the built artifact: `Get-AuthenticodeSignature` reports
`NotSigned` for all three Windows installers.

A certificate is an annual fee. **SignPath** is free for open-source projects and is the intended
route.

*Settled by:* applying to SignPath and wiring the signing step into `.github/workflows/release.yml`.
Until then the README's "Installing a build" section documents the prompt rather than hiding it, and
`desktop/tests/packaging.test.ts` fails if that section stops matching the config.

## Q-002 — Notarisation on macOS, and whether anyone can test it

**Not notarised**, and this is the one item nobody here can verify by running it: there is no Mac.
`hardenedRuntime` is on in `desktop/electron-builder.yml` while notarisation is not — the truthful
configuration rather than a claim to something we do not have.

Notarisation needs a paid Apple Developer account. The macOS steps in the README are Apple's
documented behaviour, and the README says so rather than implying they were observed.

*Settled by:* an Apple Developer account **and** someone with a Mac confirming the first-launch
flow. The second half is the real blocker.

## Q-003 — Auto-update

**None, deliberately.** `electron-updater` is absent, and `desktop/electron-builder.yml` declares no
`publish` provider — a two-sided pin in `desktop/tests/packaging.test.ts` fails on the day someone
adds the updater, which is the right day to design a release channel rather than inherit one.

There is a concrete reason beyond effort: silent updates to an application that runs an autonomous
coding agent against the user's files change what they consented to. An update the user chooses is a
different product decision from one they receive.

*Settled by:* deciding whether updates are opt-in, and if so what the feed is. Not by adding the
dependency first.

## Q-004 — Packaging channels beyond the three installers

`nsis`, `dmg`, `AppImage` and `deb` are built. Flatpak is named in the spec and deliberately not
built: it needs `flatpak-builder` on the runner and its own manifest, which is a task rather than a
flag. winget and Homebrew both want a stable release URL, so they follow Q-001 and Q-002 rather than
leading them.

*Settled by:* one real release existing first.

## Q-005 — Source-map line numbers resolve to React Compiler output

Measured during the release rehearsal, and the most concrete of these. A real failure at
`MenuBar.tsx:48` resolves to `MenuBar.tsx:223`, and the map is not wrong: the build runs the React
Compiler, and Next's production map composes *minified → compiler output*, not *minified → your
file*. The map's embedded source for that file opens with
`import { c as _c } from "react/compiler-runtime"` and has hoisted an inline handler into a
`function _temp` 175 lines lower. Of 183 sources in one build's maps, 96 differ in length from the
file on disk and 87 are identical — the split is exactly which files the compiler rewrote.

So a resolved frame's **file and function are exact and its line number is approximate**.
`desktop/scripts/resolve-log.mjs` says this at length now, and the released source-map archive
carries a `BUILD-COMMIT.txt` so nobody has to distinguish this from a stale artifact by hand.

*Settled by:* composing the React Compiler's own map into the chain, or turning the compiler off for
production builds and measuring what that costs. Neither has been attempted.

## Q-006 — Whether the Expo root goes — **SETTLED by the consolidation**

The desktop half's repository root was a leftover Expo/React Native project. Nothing in `desktop/`
built from it, and its `tsconfig.json` extending `expo/tsconfig.base` was why every `vitest` run
printed a "Cannot find base config file" warning.

It is gone. The consolidation built a fresh tree from the two halves and did not carry it across, so
the question was answered by the move rather than by a decision — which is the outcome it asked for.
The warning it caused should be gone with it; if it ever returns, something has reintroduced a root
`tsconfig.json` extending a config that is not there.

## Q-007 — Build provenance

`.github/workflows/release.yml` calls `actions/attest-build-provenance@v4` over `SHA256SUMS.txt`, so
one attestation covers every asset. It has never run — there is no git remote — and it requires a
public repository or GitHub Advanced Security.

*Settled by:* the first real release either producing an attestation or not. If it does not, the
honest response is to delete the step and record its absence here rather than leave a workflow
asserting provenance nobody can check.

## Q-008 — The app executable keeps Electron's icon

Found by the Phase 10 rehearsal, and only by looking at the artefact rather than the config. The
installer has the app's own icon; the installed `VoidCode.exe` does not — `ExtractAssociatedIcon`
hashes it identically to `node_modules/electron/dist/electron.exe`. So Explorer, the Start Menu
shortcut and the taskbar show the Electron logo. `resources/icon.png` *is* packaged, and
`desktop/src/main/windows.ts` passes it to `BrowserWindow`, so this is the executable's own resource
rather than the window's.

The cause is `signAndEditExecutable: false` in `desktop/electron-builder.yml`, which switches off the
executable rewrite that embeds an icon. Removing it makes electron-builder fetch the `winCodeSign`
toolchain, whose `.7z` contains symlinks (`darwin/10.12/lib/libcrypto.dylib` and one other) that a
Windows machine cannot create without Developer Mode or an elevated shell. Verified here: Developer
Mode is off, the shell is not elevated, and `New-Item -ItemType SymbolicLink` fails.

So the flag is what makes `npm run package` work at all on a developer's machine, and losing that
would cost the only place any of this gets verified. Kept deliberately, with the defect recorded
rather than hidden.

*Settled by:* deleting the line once releases are built on a runner — `windows-latest` permits symlink
creation, so CI would embed the icon. Then confirm against the artefact with the same hash comparison,
because a config that looks right is what produced this.

---

## The standing constraint behind most of the above

**No git remote is configured and nothing has been pushed.** Every workflow in `.github/workflows/`
is therefore unexecuted. What could be rehearsed locally was: the checksum pipeline was run over real
installers and verified with `sha256sum --check`, and the source-map archive was created, extracted
elsewhere, and used to resolve a genuine stack from a running build. The orchestration around those
steps is unproven, and `desktop/tests/packaging.test.ts` checks the YAML precisely because nothing
else can.
