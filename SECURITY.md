# Security

## Reporting

Report privately via GitHub's **Report a vulnerability** button on the Security tab, once this
repository is published — **it is not yet, and there is no remote configured**, so today the only
route is `privacy@swin.edu.au`, the same address the Privacy Policy and the Code of Conduct give.
Either way, do not open a public issue. Expect an acknowledgement within a week.

## What counts

This app runs untrusted input by design: research papers fetched from the internet,
model output, generated exercises, and user code. The boundaries that matter:

| Boundary | Promise |
|---|---|
| Study window privileges | No filesystem, no shell. `fs:*`, `pty:*`, `lsp:*` are unreachable — absent from the preload and denied by the broker. |
| Context firewall | The tutor cannot read reference implementations or expected outputs; its database view excludes those tables. |
| Workspace confinement | Build Mode file access resolves inside the project root only. Symlink escapes are the case that matters, and are tested. |
| Execution tiers | Pyodide has no network and no host filesystem. Native execution is opt-in, announced, per-session, and never used by the agent autonomously. |
| Secrets | An API key is encrypted with `safeStorage` and the ciphertext kept in the app's SQLite file; what decrypts it is in the OS keychain, so the database alone does not yield the key. No channel returns a secret to the renderer — only ones that report whether it exists and remove it. Where the OS offers no keychain worth the name, the key is never written to disk at all. |
| Renderer | `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP without `unsafe-eval`, navigation pinned to `app://`. |
| Visualisers | Rendered in a sandboxed frame with no host bridge, including ones the generator wrote. |

A bypass of any row above is a vulnerability. So is a prompt-injection path that
gets the agent to act outside its tier — a paper that talks the tutor into reading
`~/.ssh` is a real finding, not a curiosity.

## Not vulnerabilities

- Reading a solution by opening your own exercise file in Build Mode. That is your
  call to make; the firewall exists to stop the *tutor* leaking, not to stop you.
- Unsigned Windows and macOS builds. Deliberate — see `docs/desktop-app-spec.md`
  §4.3, and the README's **Installing a build** section for what the prompts say and
  what to click. Checksums are the substitute for a signature and **nothing publishes
  them yet**: `release.yml` generates `SHA256SUMS.txt` and has never run, because there
  is no remote. Until a release exists, building from source is the only thing that
  establishes provenance. Tracked as Q-001 and Q-002 in `docs/OPEN_QUESTIONS.md`.
- Anything requiring an attacker to already have code execution as your user.
