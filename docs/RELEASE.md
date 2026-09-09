# Releasing VoidCode

What the release path does, what it deliberately does not do, and how to rehearse it without a
remote. Everything here was run locally; nothing has been pushed.

## The path

```bash
cd desktop
npm ci && npm --prefix renderer ci
npm run vendor:pyodide
npm run package          # -> desktop/release/
```

`package` chains `vendor:pyodide → collect:licences → build:renderer → electron-vite build →
electron-builder --publish never`. Vendoring inside the script rather than only in CI is the point: a
human packaging a clean clone gets the Python wheels too, and without them the grader reaches for a
CDN — which is exactly the offline promise the app makes.

Tagging `v*` triggers `.github/workflows/release.yml`, which calls the whole `desktop.yml` gate as a
reusable workflow, then produces one `SHA256SUMS.txt` over every asset, a provenance attestation over
that file, and a **draft** GitHub Release. A human writes the notes and can delete a bad build before
anyone downloads it.

## Rehearsing it with no remote

Use `git archive`, not `git clone`. An archive emits exactly the tracked file set with **no `.git`** —
stricter than `actions/checkout`, impossible to push from, and constitutionally unable to pick up
`desktop/vendor/`, `node_modules/` or `renderer/out`. Those three absences are the bug class this
harness exists to reproduce; `CONTRIBUTING.md` has the procedure.

```bash
git -C "$SRC" archive HEAD | tar -x -C "$DEST"
```

## Accepted trade-offs

Each of these is a decision, not an omission. That distinction is the reason this file exists: an
undocumented gap reads as an oversight, and the follow-up is what makes it a trade-off.

| | State | Why | Follow-up |
|---|---|---|---|
| **Code signing (Windows)** | Unsigned. `Get-AuthenticodeSignature` reports `NotSigned` for all three installers. | A certificate is an annual fee. | **SignPath**, free for open-source projects. `docs/OPEN_QUESTIONS.md` Q-001. |
| **The app executable's icon** | The installer carries the app's own icon; **`VoidCode.exe` still carries Electron's default**. Measured: `ExtractAssociatedIcon` hashes identically to `node_modules/electron/dist/electron.exe`. | `signAndEditExecutable: false` disables the executable rewrite that embeds an icon. Removing it makes electron-builder fetch the `winCodeSign` toolchain, whose archive contains symlinks a Windows machine cannot create without Developer Mode or elevation — so local packaging stops working, and local packaging is where everything here is verified. | Q-008. One line to delete once releases are built on a runner; `windows-latest` permits symlink creation. |
| **Notarisation (macOS)** | Not notarised. `hardenedRuntime` is on, which is the truthful configuration rather than a claim to something we do not have. | Needs a paid Apple Developer account — and **nobody here has a Mac to verify the first-launch flow on**, which is the real blocker. | Q-002. The account is the cheaper half. |
| **Auto-update** | None. `electron-updater` is absent and no `publish` provider is declared; a two-sided pin in `tests/packaging.test.ts` fails on the day someone adds the updater. | Not only effort. Silent updates to an app that runs an autonomous coding agent against the user's files change what they consented to. | Q-003 — decide opt-in vs. automatic *before* adding the dependency. |
| **Flatpak, winget, Homebrew** | Not built. `nsis`, `dmg`, `AppImage` and `deb` are. | Flatpak needs `flatpak-builder` on the runner and its own manifest — a task, not a flag. winget and Homebrew both want a stable release URL. | Q-004, after a first release exists. |
| **Build provenance** | `actions/attest-build-provenance@v4` over `SHA256SUMS.txt` is wired and **has never run**. Requires a public repository or GitHub Advanced Security. | No remote. | Q-007. If it fails on the first real release, delete the step and record its absence rather than leave a workflow asserting provenance nobody can check. |
| **Source-map line numbers** | A resolved frame's file and function are exact; the **line number is approximate**. | The build runs the React Compiler, and Next's map composes minified → *compiler output*, not minified → source. Measured: of 183 sources in one build's maps, 96 differ in length from the file on disk. | Q-005. Compose the compiler's own map, or measure what turning it off costs. `scripts/resolve-log.mjs` documents the current behaviour. |
| **CI itself** | Every workflow is unexecuted. | There is no git remote and nothing has been pushed. | Configure a remote. `tests/packaging.test.ts` checks the YAML precisely because nothing else can. |

## What was rehearsed by hand instead

The orchestration is unproven; the substance is not. All of the following was run in a fresh
`git archive` tree — no `.git`, no `node_modules`, no vendored wheels — and, where it says *packaged*,
against `release/win-unpacked/VoidCode.exe` rather than `electron out/main/index.js`.

- **All three CI sequences.** Licence gate on both dependency trees, both SBOMs, both typecheckers,
  1956 tests across 116 files, `npm run build`, `npm run build:renderer`, `npm run smoke`, and a real
  `npm run package`.
- **The installer's contents.** 120 licence files under `resources/licenses` including the MPL-2.0 text
  no npm package ships, `resources/icon.png`, the vendored NumPy wheel, and — the one that matters —
  **0 `.map` files against 143 `.js`** under `resources/renderer`.
- **The checksum pipeline**, the workflow's exact `find | sort | xargs sha256sum`, over ten real
  assets, verified with `sha256sum --check --ignore-missing`.
- **Offline.** The packaged app with `--host-resolver-rules=MAP * ~NOTFOUND`, so DNS fails inside the
  process rather than the machine's adapter being touched: an outbound `fetch` fails as intended, and
  two exercises grade — `layer-norm` 5/5 and `online-softmax` 6/6.
- **The legal pages in the packaged app.** `/terms` renders 4712 characters over 8 headings and
  `/privacy` 12699 over 13, with **zero occurrences of "Platform"** in either.
- **A real renderer crash in the packaged build**, logged as
  `renderer process gone: crashed` with the reason, exit code and route, plus one minidump in
  `Crashpad`.
- **The whole source-map chain**, end to end: a genuine stack from the installed binary resolved
  against the release archive extracted to an unrelated directory, reaching `MenuBar.tsx` and
  `Overlay.tsx` — with two controls, an empty directory and a **maps-only** directory, both of which
  resolve nothing.

The one thing not verified by looking at the artefact is macOS, because there is no Mac. That is
Q-002, and the README says so where a user would read it rather than only here.

## The one thing that is not automated

`--publish never` stays on `electron-builder`, so packaging never uploads. Publishing is `gh`'s job in
one job that holds `contents: write`, and it creates a **draft**. Both halves are deliberate: a local
`npm run package` cannot reach the internet by accident, and a release cannot become public without
someone choosing to make it so.
