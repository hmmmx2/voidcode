# Contributing

## Licensing and sign-off

Code is **Apache-2.0**. Exercise content is licensed separately — see
`content/LICENSE` — so a contribution of problems is not entangled with a
contribution of code.

We use a **DCO**, not a CLA. You keep copyright in your work; you are asserting you
have the right to submit it. Sign off every commit:

```bash
git commit -s -m "your message"
```

That appends `Signed-off-by: Your Name <you@example.com>`, which is the whole of
the agreement — the text is at <https://developercertificate.org>.

## The licence gate will reject some dependencies

CI fails on any production dependency whose licence is not in
[`.github/allowed-licenses.txt`](.github/allowed-licenses.txt). This is not
bureaucracy; two specific traps have already been hit while planning:

- **PyMuPDF (`fitz`) is AGPL-3.0.** It is the obvious choice for PDF parsing and it
  would relicense the entire application. Use **pypdfium2** or **pdf.js**.
- **Nougat and Marker** have permissive *code* and **CC-BY-NC model weights**.
  Non-commercial weights are not open source and cannot ship in a redistributable
  build. They may be offered as an opt-in the user installs themselves.

**Model weights are a separate licence surface from code.** Only OSI-licensed
weights may be defaults — Qwen2.5-Coder (Apache-2.0), DeepSeek-Coder (MIT),
Mistral 7B (Apache-2.0). Llama 3.x and Gemma have custom, non-OSI terms; they may
be user-installable with the licence shown before download, never bundled.

If you genuinely need something the allowlist blocks, open an issue first. Widening
the allowlist is a project decision, not a PR detail.

## Things that must not land

From `docs/desktop-app-spec.md` §4.5:

- **No telemetry by default.** Opt-in only, disclosed on first run, payload
  documented in this repo. The local-first claim rests on this.
- **No content paywall in the binary.** A lock users can remove with a one-line
  patch only teaches patching.
- **No hardcoded API keys, no required cloud account.**
- **No non-redistributable assets**: paper PDFs, NC-licensed weights, proprietary
  fonts or icons.

## Working on the desktop app

**Two installs, not one.** `desktop/` and `desktop/renderer/` keep separate `node_modules`, and
nothing installs the second for you — no npm workspaces, no `postinstall`. Skipping it is the single
most common way to get a confusing failure here, because the error arrives as dozens of
`Cannot find module 'next/link'` from `tsc` rather than as "you forgot an install".

```bash
cd desktop
npm ci
npm --prefix renderer ci
npm run vendor:pyodide
npm run dev
```

`vendor:pyodide` downloads the WebAssembly Python runtime the grader executes in. It has to run
before the tests too — they execute real NumPy, and without it Pyodide reaches for a CDN.

Before opening a PR:

```bash
npm run typecheck
npm --prefix renderer run typecheck
npm test
npm run smoke
```

`npm test` transpiles without typechecking, so a green suite does not mean `tsc` passes. That is why
both typechecks are separate steps, and why the renderer's is separate from main's: `npm run
typecheck` covers main and the tests, and the renderer is its own TypeScript project.

## Verifying a workflow change without pushing

CI is the one thing you cannot test by running it, and this repository has no remote — so a broken
workflow can sit green-looking and unexecuted indefinitely. It did: `verify` and `package` both
called `npm --prefix renderer run typecheck`, `build:renderer` and `npm run package` while installing
only `desktop/`, and three steps failed for a whole release cycle with nobody in a position to notice.

Reproduce a runner faithfully with `git archive`, **not** `git clone`:

```bash
git -C /path/to/repo archive HEAD | tar -x -C /tmp/clean
```

An archive emits exactly the tracked file set with **no `.git` at all**. That matters three ways: it
is stricter than `actions/checkout`, it is impossible to push from by accident, and it cannot pick up
`desktop/vendor/`, `node_modules/` or `renderer/out` — all gitignored. Those three absences *are*
what a fresh runner has, and reproducing them is the whole point.

Then run the job's steps in order, from the same working directory the job declares. If a step is
supposed to fail before your fix, **watch it fail first** and keep the output; a fix you never saw
break is a fix you cannot show is load-bearing.

`tests/packaging.test.ts` asserts the property behind this — that every job installs what its steps
read — derived over all jobs, so a job added later is covered without anyone remembering this page.

## The privilege boundary is not negotiable

The app runs two modes with different privileges (`docs/desktop-app-spec.md` §2.2):
**Study** has no filesystem and no shell; **Build** has both. Mode is fixed when a
window opens and there is deliberately no setter — a mutable mode would be a
privilege-escalation primitive.

Consequences for a contributor:

- Adding an IPC channel means adding it to `desktop/src/main/ipc/contract.ts` with
  an explicit `modes` list. There is no way to expose something and forget to say
  who may call it; omitting `modes` is a type error.
- The tutor cannot reach reference solutions or expected outputs because its
  database view does not include those tables. If you find yourself widening that
  view, stop — a prompt asking the model not to reveal an answer is not a
  mechanism, and that is the point of the schema-level split.
- `tests/mode-gate.test.ts` and `npm run smoke` both assert a Study window cannot
  reach `fs:*`. If a change makes those fail, the change is wrong.

Anything the *agent* runs autonomously executes in the Pyodide tier only. Native
execution is opt-in, announced, and per-session.

## Reporting a vulnerability

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
