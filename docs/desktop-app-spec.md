# Paper-to-IDE Desktop App — Technical Specification

An open-source, local-first Electron IDE with two modes: **Study** (papers → exercises → tutor)
and **Build** (an unrestricted, Cursor-class AI code assistant). One shared local inference stack.

## Context

Five pillars from the brief: a research-paper → exercise pipeline; a local-first AI backend under
the user's hardware control; an in-IDE tutor; a **standalone unrestricted code assistant**; and
full open-source readiness on any desktop or laptop.

Ten saved pages from **TensorTonic** (a competitor, supplied as reference) were analysed to ground
the UI/UX critique: `Gated MLA`, `Frequent-Word Subsampling`, `Implement Sigmoid in NumPy`,
`Compute ROC Curve`, `Compute AUC`, `Streaming Min-Max Normalization`, `Mean, Median, Mode`,
`Stratified Train/Test Split`, `Binomial PMF`, `One-Hot Encoding`. Every claim in Part 1 is
traceable to those files.

**On the reference material — learn from it, do not copy it.** The competitor is useful as evidence
of what this product category has converged on and where it fails. Three separate things must not
be carried over:

- **Their content.** Statements, hints, test cases and the bespoke visualisers are TensorTonic's
  work. The Part 2 pipeline exists precisely so content generation is never the bottleneck that
  tempts shortcuts.
- **Their taxonomy.** The tag list (3D Geometry, Activation Functions, Classic ML, …) and collection
  framing ("Kimi K3") are editorial choices of theirs. Ours derives from papers (§1.0).
- **Their look.** This is the one that happens by accident. They are stock shadcn/ui on default zinc
  with lucide icons; reach for the same defaults and the app is visually indistinguishable from
  them without a single line being copied. §1.0 sets the counter-direction.

What *is* fair to converge on: `Run`/`Submit`, a test-case panel, Examples/Constraints sections,
prev/next navigation. Category conventions, not signature design; diverging costs usability for no
gain.

---

## Part 0 — What the competitor actually is

Reconstructed from the DOM, not marketing copy.

| Layer | Evidence |
|---|---|
| Next.js App Router | `_next/static` chunk graph in all 10 files |
| Tailwind + shadcn/ui | `text-muted-foreground`, `border-border`, `hover:bg-accent`, `focus-visible:ring-ring` |
| lucide-react | 81 `lucide` class hits on Gated MLA alone |
| KaTeX | 220 `katex` hits on Gated MLA; emits `katex-mathml` *and* `katex-html` |
| Theming | `dark:` variants plus a "Toggle theme" control |

**Information architecture.** Top nav → `Problems`, `Explore` (ML Research · ML Math · LLM
Internals · ML System Design · Leaderboard), `Study Plans`, `Projects`, `Interview`, `Pricing`,
`Feedback`.

**Problem view.** Left rail is either a tag-filtered list or a numbered collection rail — Gated MLA
sits at `02/11` in a "Kimi K3" collection (KDA Recurrence, Gated MLA, Full AttnRes, Block AttnRes,
SiTU-GLU, Quantile Balancing, Stable LatentMoE, MXFP4 Experts, Per-Head Muon, Multi-Teacher OPD,
KDA Context Parallel). Six mutually exclusive tabs: `Problem · Theory · Solution (Free) ·
Submissions · Notes · Code`. Body carries statement, a bespoke interactive visualiser, `Examples`,
numbered `Hints`, `Requirements`, `Constraints`. Editor has `Save · Run · Submit`, gated by the
string **"You must run your code first."** Footer: `Prev / n / N / Next`, `Try Similar Problems`.

**The content spans two runtimes.** The single most consequential fact in the corpus:

- *Implement Sigmoid* — "Allowed library: NumPy only", "Time limit: 200 ms; Memory: 64 MB"
- *Gated MLA* — needs `torch.triu(..., diagonal=1)`, `masked_fill`, `.reshape(...).transpose(1, 2)`

One execution backend cannot serve both well. §2.6 splits them, and that split is also what makes
the app viable on a low-end laptop.

---

## Part 1 — UI/UX findings and what to do differently

§1.0 sets an independent design direction. §1.1 onward are defects in the reference, ordered by
severity, each grounded in the artifacts. Both halves are needed: fixing their bugs without §1.0
lands you on a tidier version of their product.

### 1.0 Design direction — deliberately not TensorTonic

Six decisions that make this a different product rather than a restyle. Each is structural, so the
difference survives contact with implementation.

**1. Paper-first, not problem-first.** Their root object is a problem; papers are a filter over a
hardcoded list (§1.2). Invert it. The user opens a *paper*, reads it, and exercises hang off
equations within it. Navigation, search and progress all key on the paper. This reshapes the IA and
cannot be arrived at by restyling a problem list.

**2. A reader is a first-class surface.** They have no reader at all. Ours: paper on the left,
derived exercises on the right, every exercise anchored to the equation it came from and every
equation showing what it generated. This is the core loop and has no competitor equivalent.

**3. Provenance is a visual primitive.** Every problem carries a clickable chip —
`Eq. 4 · §3.2 · arXiv:1706.03762` — that scrolls the reader to the source. Where they have
untraceable prose attribution, we have a link that resolves. It should be the most recognisable
element in a screenshot.

**4. Desktop idiom, not a web page in a window.** They are tabs and rails because they are a
website. Ours is an activity bar, dockable and tear-off panels, multi-window, native menus, and a
command palette (`Ctrl/Cmd-K`) as primary navigation. Someone who has used VS Code should be
immediately fluent; someone who has used LeetCode should notice it is not that.

**5. Compute is ambient and honest.** A persistent status bar: which model is loaded, local or
cloud, VRAM headroom, current run tier. They have no concept of this because their compute is
invisible and remote. For a local-first app it is a defining surface, and it is where the "text
just left your machine" indicator lives (§2.7).

**6. Our own visual language, not shadcn defaults.** Reuse and extend the existing VoidCode tokens
(`--void-0`, `--ink`, `--ink-2`, `--line`, per-domain accent rgb triples) rather than adopting stock
zinc/`text-muted-foreground`. Distinct type scale, density and accent behaviour. Concretely: pick a
different icon set or a customised one, do not ship default KaTeX styling, and set a type scale that
is not the shadcn default. If a screenshot of our problem view could be mistaken for theirs, this
has failed regardless of how the code was written.

*Design-distinctness check, run at Phase 5 exit: put a screenshot of each app's problem view side by
side. If the difference is only colour, redo it.*

### 1.1 KaTeX double-renders, so no equation is copyable — **critical**

KaTeX emits MathML *and* HTML and both serialise. Extracting visible text yields:

```
σ(x)=11+e−x\sigma(x) = \frac{1}{1 + e^{-x}}σ(x)=1+e−x1​
Q=XWqT∈RB×S×D.Q=XW_q^{\mathsf T}\in\mathbb{R}^{B\times S\times D}.Q=XWqT​∈RB×S×D.
```

Every symbol three times: MathML, LaTeX annotation, HTML spans. Selecting a statement and pasting it
into a chat gives tripled garbage — on a platform premised on "read the maths, then implement it",
the most common action is broken. Screen readers may double-read. Full-text search matches
`mtight`/`vlist` noise.

**Do instead.** LaTeX source on the element (`data-tex`) + a `copy` handler that rewrites the
selection to source. `aria-hidden="true"` on `katex-html`, MathML left to assistive tech (standard
KaTeX guidance, unapplied here). Explicit **Copy as LaTeX / Copy as Markdown** context items. Given
§2.11, also **"Send equation to Build Mode"** — paper to scratch implementation in one action.

### 1.2 The research pillar never links a paper — **critical, and the opening**

`Explore → ML Research → "Implement research papers"`. Across all ten pages: **zero** arXiv links,
**zero** DOIs, **zero** PDF references. The index is 22 hardcoded slugs — `?paper=transformer`,
`llama`, `resnet`, `gpt2`, `gemma3`, `bert`, `vit`, `deepseekv3`, `arcee-trinity`, `ddpm`, `vae`,
`gan`, `unet`, `alexnet`, `vgg`, `rnn`, `lstm`, `gru`, `gptoss`, `glm45`, `word2vec`, `densenet`.
Attribution is prose: "Mikolov et al. (2013), the Word2Vec phrases paper."

Users cannot check a derivation against its source, cannot see *which equation* a problem came from,
and cannot bring their own paper. A fixed list an editor typed in.

**Do instead.** §1.0's paper-first inversion, plus §2.8: resolvable identifiers, equation anchors,
"paste an arXiv ID" as a supported entry point.

### 1.3 Six exclusive tabs hide what you need while you work

`Theory` and `Code` cannot both be visible. Implementing Gated MLA means holding six equations in
your head while typing — exactly the task the app exists for.

**Do instead.** Dockable panes; statement and editor side by side by default; any panel tear-off-able
into a split or second window. Multi-window is nearly free in Electron and is the clearest win over
a browser: paper on one monitor, editor on the other.

### 1.4 "You must run your code first." is an error where a disabled control belongs

Fires after the user acts. Disable `Submit`, attach the reason (`title` / `aria-describedby`) so the
constraint is legible before the click.

### 1.5 Constraints are prose, not contract

"NumPy only", "200 ms", "64 MB" are body text; nothing in the runner surfaces or enforces them.
Users learn a limit exists by violating it.

**Do instead.** Structure them (`allowed_imports`, `time_limit_ms`, `memory_limit_mb`); render in
the runner chrome — allowlist badge on the editor, wall-clock and peak RSS beside each result;
enforce in the sandbox (§2.6) so prose and behaviour cannot drift.

### 1.6 Hints are a static ladder

`Hint 1/2/3`, identical for everyone. Sigmoid's Hint 2 is `Use np.asarray(x, dtype=float)` — the
answer, for someone 80% there.

**Carry forward our tutor audit.** The 8-scenario / 18-check audit found the failure mode is
*presupposition compliance*: asked "what's wrong with my loop?" against an untouched template, the
model invents a loop to criticise. Adaptive hints must be allowed to say "nothing is wrong yet", and
must be grounded in a diff of the buffer against the template rather than in the user's framing
(§2.12).

### 1.7 Two competing left rails

Tag-filtered list and numbered collection rail share one slot with different semantics. Collapse to
one activity bar (§1.0 point 4): Papers / Exercises / Library / Runs in Study; Explorer / Search /
Source Control / Chat in Build.

### 1.8 Smaller items

- `Solution` carries a `Free` badge — commercial gating in the learning surface. An open-source
  offline app gates nothing in the binary (§4.5).
- `Try Similar Problems` lists five with no indication of *why*. Ours can say "also derives from
  Eq. 4" — provenance again doing work theirs cannot.
- Their bespoke visualisers ("click a token to make it the query"; causal-access and channel-gate
  toggles) are their strongest feature. Build our own as a first-class plugin type (§2.10), or they
  will never be contributed by outsiders.

---

## Part 2 — System architecture

### 2.1 Process model

```
┌─ main (Node) ─────────────────────────────────────────────────────┐
│ windows+lifecycle · IPC broker · secrets (safeStorage) · MODE GATE │
└──┬────────────┬────────────┬────────────┬────────────┬───────────┘
   │contextBridge│MessagePort │child_process│child_process│child_process
┌──▼─────────┐ ┌▼──────────┐ ┌▼──────────┐ ┌▼──────────┐ ┌▼─────────┐
│ renderer   │ │ utility   │ │ ai-daemon │ │exec-sandbox│ │ pty +LSP │
│ React      │ │ hw-scan,  │ │ Ollama /  │ │ Pyodide or │ │ BUILD    │
│sandbox:true│ │parse,index│ │ llama.cpp │ │ CPython    │ │ MODE ONLY│
└────────────┘ └───────────┘ └───────────┘ └───────────┘ └──────────┘
```

Non-negotiable:

- **Renderer is untrusted.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`. No `@electron/remote`.
- **No blocking work in main.** Main brokers IPC and enforces the mode gate; a synchronous
  `nvidia-smi` there freezes every window. Scanning, parsing, indexing → `utilityProcess`.
- **Inference never in-process.** Ollama runs its own daemon; llama.cpp ships `llama-server`. Talk
  over loopback, so a model crash cannot take the app down and users can reuse a server they run.
- **CSP without `unsafe-eval`**, `setWindowOpenHandler` → `deny`, `will-navigate` pinned to `app://`.

### 2.2 The mode gate — Study and Build have different privileges

Requirement 4 puts an unrestricted assistant beside a deliberately restricted tutor. They cannot
share one privilege envelope. **Mode is a property of the window, fixed when it opens, never toggled
at runtime.**

| | **Study Mode** | **Build Mode** |
|---|---|---|
| Filesystem | none — buffers live in SQLite | user-chosen project root, read/write |
| Execution | Tier A (Pyodide) | real pty shell + Tier B |
| Assistant | tutor: withholding, disclosure-gated | code assistant: no limits, full files |
| In context | statement, buffer diff, paper section | workspace files, `@`-mentions, codebase index |
| **Never in context** | reference impl, expected outputs, model answer | — |

**The context firewall, enforced by construction rather than by prompt.** Reference implementations,
expected outputs and model answers live in dedicated tables. The Study-mode context assembler
connects through a **read-only SQLite view that does not include them**, so there is no query path
from tutor context to the answer. A prompt instruction saying "don't reveal the solution" is not a
mechanism; a missing table is.

If a user opens their own exercise scratch file in Build Mode and asks for the answer, they get it.
That is their call and it is fine. What must not happen is the *tutor* leaking it, or Build Mode
silently pulling graded answers into an exercise the user is mid-way through.

`main` stamps every IPC call with the originating window's mode and rejects out-of-envelope
requests — `exec:runNative` and `fs:*` from a Study window fail at the broker.

### 2.3 IPC contract

One namespaced preload surface; every payload zod-validated in main.

```ts
contextBridge.exposeInMainWorld("host", {
  mode: () => invoke("mode:get"),                       // "study" | "build"
  hardware: { scan:  () => invoke("hw:scan"),
              watch: (cb) => subscribe("hw:telemetry", cb) },
  models:   { list: () => invoke("models:list"),
              recommend: (q) => invoke("models:recommend", q),
              pull: (id) => invoke("models:pull", id),
              load: (id, o) => invoke("models:load", { id, o }) },
  // MessagePort, not repeated IPC: token-by-token through the broker stalls main.
  chat:     { open: (r) => invoke("chat:open", r) as Promise<MessagePort> },
  complete: { fim: (r) => invoke("complete:fim", r),    // debounced, cancellable
              cancel: (id) => invoke("complete:cancel", id) },
  exec:     { run: (r) => invoke("exec:run", r),
              cancel: (id) => invoke("exec:cancel", id) },
  papers:   { search: (q) => invoke("papers:search", q),
              ingest: (id) => invoke("papers:ingest", id),
              open: () => invoke("papers:openDialog") },
  vault:    { set: (k, v) => invoke("vault:set", { k, v }),
              has: (k) => invoke("vault:has", k) },
  // Build Mode only — the broker rejects these from a Study window.
  fs:       { openProject: () => invoke("fs:openProject"),
              read: (p) => invoke("fs:read", p),
              writeWithDiff: (p, next) => invoke("fs:writeWithDiff", { p, next }),
              watch: (cb) => subscribe("fs:changed", cb) },
  pty:      { spawn: (o) => invoke("pty:spawn", o) },
  lsp:      { connect: (lang) => invoke("lsp:connect", lang) as Promise<MessagePort> },
});
```

- **Streaming over `MessagePort`**, not repeated `ipcRenderer.send`; the port dies with the window.
- **`vault` never returns a secret** — only `has`. Keys sit in `safeStorage.encryptString` (DPAPI /
  Keychain / libsecret) and are attached inside main, so a compromised renderer cannot exfiltrate an
  OpenRouter key.
- **`fs.writeWithDiff` returns a diff; it does not write.** A second explicit call commits. Agent
  edits are reviewable by construction.

### 2.4 Hardware scanner

`utilityProcess`, TTL-cached, re-run on `powerMonitor` resume and GPU device-change.

| Signal | Windows | Linux | macOS |
|---|---|---|---|
| NVIDIA | `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,compute_cap --format=csv,noheader,nounits` | same | n/a |
| AMD | `Get-CimInstance Win32_VideoController` | `rocm-smi --showmeminfo vram --json` | n/a |
| Apple | n/a | n/a | `system_profiler SPDisplaysDataType -json`; `sysctl hw.memsize` |
| CPU/RAM | `os.cpus()`, `os.totalmem()`, `systeminformation` for AVX2/AVX512 | same | same |
| Disk | free space on the model volume — a 40 GB pull dying at 90% is the worst failure | | |

```ts
interface HardwareProfile {
  gpus: Array<{ vendor: "nvidia"|"amd"|"apple"|"intel"; name: string;
                vramTotalMB: number; vramFreeMB: number;
                computeCapability?: string; driver?: string }>;
  unifiedMemory: boolean;   // Apple Silicon: VRAM is RAM — changes every calculation
  cpu: { model: string; physicalCores: number; flags: string[] };  // AVX2 gates llama.cpp perf
  ramTotalMB: number; diskFreeMB: number;
  backends: { ollama?: string; llamaCpp?: string; vllm?: string };  // detected, not assumed
}
```

Probe `http://127.0.0.1:11434/api/version` for Ollama rather than shelling out, so remote and
containerised installs are found too.

### 2.5 Model recommendation, including no-GPU

```
weights_GB  ≈ params_B × bits_per_weight / 8
              # Q4_K_M ≈ 4.8 bits/w → 8B ≈ 4.9 GB, matching real GGUFs
kv_cache_GB = 2 × n_layers × n_kv_heads × head_dim × ctx × bytes / 2^30
              # Llama-3.1-8B @4k fp16: 2×32×8×128×4096×2 = 0.5 GiB
              # GQA is why this is small — MHA costs n_heads, not n_kv_heads
overhead_GB ≈ 0.6 (CUDA/Metal context) + activations
usable_GB   = vramTotal × 0.92 − desktopReserve
              # ≈1.2 GB reserve on Windows with a display attached; ~0 headless.
              # Apple Silicon: use recommended-max-working-set, not total RAM.
fits = weights + kv_cache + overhead ≤ usable
```

Four tiers, not a yes/no:

| Tier | Condition | Default (OSI-licensed only, §4.2) |
|---|---|---|
| Comfortable | ≤70% usable | Qwen2.5-Coder-7B Q4_K_M @8k |
| Tight | ≤100%, context shrinks | same @4k, warning stated |
| Offload | partial GPU layers | project tok/s: "≈6 tok/s, 18 layers on CPU" |
| **CPU-only** | no usable GPU | Qwen2.5-Coder-1.5B Q4 (~1 GB), AVX2 path |

**Build Mode wants two models resident** (FIM for completion, chat for conversation) or one that
does both. Budget for both when computing fit; prefer one dual-purpose model under 12 GB. Below
that, load FIM only and route chat to whatever is loaded.

### 2.6 Execution sandbox — two tiers

**Tier A — Pyodide (Study default; why the app runs anywhere).** WASM CPython in a hidden worker.
numpy/scipy/pandas/scikit-learn as wasm wheels, covering most of the observed catalogue. No network
by construction, virtual FS only, deterministic, zero install, ~1–2 s cold then warm.
`allowed_imports` enforced by an import hook, making §1.5's prose constraint real. Cancel by
terminating the worker. Identical on a Chromebook-class laptop and a workstation.

**Tier B — managed CPython (opt-in; Build Mode default).** A venv provisioned on first use of a
torch problem: no inherited environment, scratch `cwd`, network denied, hard wall-clock kill, memory
capped via `setrlimit` (Linux/macOS) or a Job Object with `JOB_OBJECT_LIMIT_PROCESS_MEMORY |
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (Windows).

Tier B is genuine local code execution: opt-in, self-announcing, explicit download. Anything the
*Study* agent runs autonomously is Tier A only.

**Grading rule.** Expected outputs come from executing a reference implementation, never from a
model. An LLM asked to predict `sigmoid([0,2,-2])` emits plausible wrong digits with full
confidence. The generator (§2.8) may not author expectations.

### 2.7 Inference layer

One `InferenceProvider` interface, four implementations, capability-flagged (`fim`, `tools`,
`grammar`, `contextWindow`):

| Backend | Transport | Reality |
|---|---|---|
| **Ollama** | `POST /api/chat` NDJSON on `:11434` | Default. All platforms, own daemon, handles pulls/unloads. MIT. |
| **llama.cpp** | `llama-server`, OpenAI-compatible | Raw GGUF, custom quants, GBNF grammars, best CPU path, native `/infill`. MIT. |
| **vLLM** | OpenAI-compatible HTTP | **Linux/CUDA only — no official Windows wheels, needs WSL2.** Also a throughput server that preallocates most of VRAM, wrong for a desktop sharing a GPU with the compositor. Support as *connect to an existing endpoint*; never install or manage. |
| **OpenRouter** | OpenAI-compatible HTTPS | Optional cloud. Key in `safeStorage`, signed in main, **visibly labelled while active** (§1.0 point 5) — a local-first app owes an unambiguous indicator that text just left the machine. |

The vLLM row corrects the brief's implicit assumption; treating it as a peer of Ollama on Windows
would ship a feature that cannot run on the primary platform.

Structured output (§2.8 depends on it) uses native mechanisms — Ollama `format`, llama.cpp GBNF,
OpenRouter JSON schema — not prompt-and-hope parsing.

### 2.8 Paper → exercise pipeline

Closes §1.2 and implements §1.0's paper-first inversion.

```
search ──> fetch ──> parse ──> extract ──> author ──> VERIFY ──> publish
arXiv API   e-print   LaTeX AST  LLM        LLM       execute    local DB
                      or PDF    (structured)          reference
```

**Search/fetch.** arXiv API (`export.arxiv.org/api/query`); honour the ~3 s rate limit, real
User-Agent. Also accept a user-supplied local PDF.

**Parse — prefer LaTeX source over PDF.** `arxiv.org/e-print/{id}` serves the submission tarball,
usually real LaTeX. Equations then arrive as `\frac{1}{1+e^{-x}}` instead of being reconstructed from
glyph positions — and §1.0 point 3's equation anchors need labels (`\label{eq:attention}`) that only
source provides. Largest accuracy win available and the highest-leverage decision in the pipeline.
PDF fallback only when no source exists — and see §4.2, because the obvious PDF libraries are
licence traps.

**Extract.** Local model, one section at a time, schema-constrained, for self-contained
computational units: a defined equation, an algorithm block, a stated complexity result. Each
candidate carries provenance — `arxiv_id`, section, equation label — which is what §1.0 point 3
renders as a chip.

**Author.** Statement, signature, reference implementation, test *inputs*.

**Verify — the gate that makes this trustworthy.** Nothing enters the library until:

1. the reference executes in the sandbox on every input;
2. **expected outputs are recorded from that execution** (§2.6), never generated;
3. a deliberately mutated reference fails ≥1 case — otherwise the tests are vacuous;
4. the statement is checked for answer leakage against the reference;
5. `allowed_imports` are satisfiable in the target tier.

Failures land in a visible **Needs review** queue, never silently in the catalogue. Generation is
cheap; one wrong expected output destroys trust permanently.

**Licensing — why desktop wins.** arXiv's default licence grants distribution rights to arXiv, not
onward redistribution by third parties; only a subset is CC-BY. A hosted service redistributing
parsed paper text has a real problem; a desktop app whose user's own machine fetches, caches locally
and never re-serves does not. Ship metadata and generated exercises, never paper text. Store
`arxiv_id`, licence and fetch timestamp per paper; surface the licence in the reader.

### 2.9 Visualisers as a plugin type

Their token-attention widget is the competitor's strongest feature (§1.8). One contract, so
contributors can author ours without touching app code:

```ts
interface Visualiser {
  id: string;
  // Sandboxed <webview>/iframe, no host bridge. Untrusted content — including
  // ones the generator or a contributor wrote.
  entry: string;
  state: Record<string, unknown>;   // serialisable, persisted per problem
  onEvent?(e: { type: string; payload: unknown }): void;
}
```

Once §2.8 can generate exercises it can generate visualisers, and in an OSS project third-party
plugins are the point. Generated and contributed code never runs with host privileges.

### 2.10 Build Mode — the standalone code assistant

A Cursor-class assistant, sharing the inference stack but nothing else.

**Editor — this revises an earlier call.** A lightweight editor was preferable for a Study-only
design. Requirement 4 needs real IntelliSense, go-to-definition and multi-file refactors, so
**Monaco** is now the recommendation, with LSP servers (`pyright`, `typescript-language-server`,
`rust-analyzer`) as child processes speaking LSP over stdio, bridged to the renderer by
`MessagePort`. Monaco is MIT and licence-clean. The cost is bundle size and a heavier low-end
footprint, mitigated by lazy-loading Monaco only in Build windows — a Study-only user on a 4 GB
laptop never pays for it.

| Feature | Design |
|---|---|
| Inline completion | FIM via llama.cpp `/infill` or Ollama; debounce ~300 ms, cancel-on-keystroke, ghost text. Never queued behind chat — two lanes, chat preemptible. |
| Inline edit (`Ctrl/Cmd+K`) | Select → instruct → **diff preview** → accept/reject. Never a blind write. |
| Chat with `@`-mentions | `@file`, `@folder`, `@symbol`, `@codebase`, `@paper`. Explicit context beats implicit retrieval and is far cheaper on a 7B. |
| `@codebase` index | Tree-sitter chunking on symbol boundaries → local embeddings → `sqlite-vec`. Incremental on FS watch, `.gitignore`-aware, never leaves the machine. |
| Agent mode | Multi-step tool loop: read, edit, run, read output, iterate. Every write a reviewable diff. |
| Checkpoints | Before an agent run, snapshot to a **shadow git repo** (separate `--git-dir`, so the user's history and index stay untouched). One-click revert of a whole run. This is what makes an unrestricted agent safe to use. |
| Terminal | `xterm.js` + `node-pty`, Build windows only. |
| Source control | Diff/stage/commit against the user's real repo. |

**"No limits" means no pedagogical withholding — not no safety rails.** The assistant writes whole
files, refactors freely and explains anything. It still shows a diff before writing and can still be
reverted, because those protect the user's work rather than gate their learning. The tutor's
restrictions never apply here, and §2.2's firewall keeps the two from bleeding.

**Study → Build bridge.** "Open in Build Mode" from an exercise scaffolds a scratch project with the
statement as a README, the buffer as source, and the paper attached as `@paper` context. The reverse
is blocked: a Build session cannot inject into a graded exercise buffer.

### 2.11 Agent, memory, tutor

**Storage.** `better-sqlite3` (WAL) for problems, papers, submissions, runs, notes; `sqlite-vec`
vectors in the same file. One database, one backup, no server. Embeddings from the local backend
(`nomic-embed-text`), skipped entirely when no model is present.

**Memory tiers.** Per-problem scratch (ephemeral) · per-paper notes (durable, user-owned, editable) ·
cross-session profile (concepts repeatedly needing hints) · **per-project Build memory** (conventions,
architecture notes; scoped to the project root, never global). All inspectable and deletable in
Settings — silent behavioural profiling contradicts local-first.

**Tools, gated by mode:**

| Tool | Study | Build |
|---|---|---|
| `read_problem`, `read_paper_section`, `search_library` | allow | allow |
| `run_code` (Tier A) | allow | allow |
| `read_file` | **denied** | allow, workspace-confined |
| `write_file` | **denied** | allow + diff preview |
| `run_code_native` / shell | **denied** | allow (announced) |
| `web_fetch` | prompt | prompt |

Workspace confinement is `realpath` then prefix-check, so symlinks cannot escape. Tested in CI, not
asserted.

### 2.12 Tutor guardrails

Apply §1.6 directly:

- Do not call the model when the buffer is unchanged from the template. Nothing to review, and asking
  anyway is what produced the fabricated-`for`-loop failure.
- Send the *diff against the template* plus structured `constraints`; require a quoted line number
  that exists; verify the quote and drop the turn if it does not match.
- "Nothing is wrong yet — run it and let's look at the output" is a first-class response.
- Lower temperature for review/debug than for explanation.

---

## Part 3 — Development roadmap

Phases 1–4 shared foundation; 5–6 Study; 7–8 Build; 9 hardening. Each exits on a demonstrable
behaviour.

### Phase 1 — Shell + OSS foundation (2 wks)
Electron + electron-vite + electron-builder. Renderer over a custom `app://` protocol (no localhost
HTTP server other processes could reach). Preload surface (§2.3) with zod on every channel, **and the
§2.2 mode gate from day one** — retrofitting a privilege boundary is how leaks happen. OSS hygiene
lands here, not last: licence, SPDX headers, CI matrix, SBOM, licence gate, CONTRIBUTING, DCO (§4).
*Exit: reproducible CI installers for Windows/macOS/Linux from a clean public checkout, licence gate
passing, and a Study window provably unable to call `fs:*`.*

### Phase 2 — Local execution (2 wks)
Tier A Pyodide worker; `allowed_imports` enforcement; wall-clock and peak memory in the run panel;
problems in local SQLite.
*Exit: a NumPy exercise runs, grades, and reports 200 ms / 64 MB compliance with networking disabled.*

### Phase 3 — Hardware scanner + model manager (2 wks)
Scanner (§2.4), fit calculator (§2.5) including CPU-only, Ollama detection and pull with progress,
live VRAM telemetry, first-run wizard, status-bar compute indicator (§1.0 point 5).
*Exit: on a machine with no AI tooling, first run ends with a working model and a correct verdict; an
8 GB card predicts offload rather than OOMing; a GPU-less laptop recommends the 1.5B CPU path and the
app stays fully usable if the user declines.*

### Phase 4 — Inference layer (2 wks)
Provider interface with capability flags, Ollama + llama.cpp + OpenRouter, `MessagePort` streaming,
cloud-active indicator.
*Exit: the same chat works against all three; killing the daemon mid-stream degrades cleanly.*

### Phase 5 — Study UI, on our own design language (3 wks)
§1.0 points 1–4 and 6: paper-first IA, activity bar, dockable/tear-off panes, command palette, our
token system. Part 1 fixes: copy-as-LaTeX (§1.1), structured constraints in runner chrome (§1.5),
disabled-with-reason submit (§1.4), visualiser plugin host (§2.9). Native menus, keyboard-first, a11y.
*Exit: paper on one monitor, editor on the other; copying an equation yields clean LaTeX; full
keyboard navigation; and the §1.0 side-by-side distinctness check passes.*

### Phase 6 — Paper pipeline + tutor (4 wks)
arXiv search/fetch, LaTeX-source-first parser with PDF fallback, extraction, authoring, the §2.8
verification gate and **Needs review** queue, reader with equation anchors and provenance chips.
Tutor with §2.12 guardrails; port the existing audit script as a regression gate.
*Exit: paste an unseen arXiv ID → ≥1 verified runnable exercise whose expected outputs came from
executing the reference, anchored to its source equation, unverified candidates visibly marked. The
8-scenario audit passes on a local 7B, including the untouched-template case that currently
fabricates.*

### Phase 7 — Build Mode IDE (3 wks)
Project open, file tree, Monaco + LSP over `MessagePort`, `xterm.js`/`node-pty` terminal, source
control, shadow-git checkpoints.
*Exit: open a real repo, edit with working IntelliSense, run a test suite in the terminal, revert an
entire session from a checkpoint.*

### Phase 8 — Build Mode AI (4 wks)
FIM completion with two-lane scheduling, `Ctrl+K` inline edit with diff preview, `@`-mention context,
tree-sitter + `sqlite-vec` codebase index with incremental FS-watch updates, agent loop with
reviewable diffs.
*Exit: the agent implements a small feature across three files in a real repo, every write reviewed as
a diff, the whole run revertible; completion latency stays usable while chat streams.*

### Phase 9 — Hardening (2 wks)
Permission tiers, workspace confinement tests, memory inspection/deletion UI, accessibility and
performance passes on low-end hardware.
*Exit: symlink-escape test green in CI; app usable on a 4 GB no-GPU laptop.*

**≈24 weeks single-track**, ~18 with a second contributor parallelising Phases 5 and 7. Phase 6 is the
long pole — parser edge cases are unbounded. Phase 8 carries the most quality risk: local 7B agentic
editing is materially weaker than a frontier cloud model, and expectations must be set accordingly
rather than discovered by users.

---

## Part 4 — Open-source readiness

### 4.1 Licences for the project

**Apache-2.0** over MIT: same permissiveness plus an express patent grant, which matters when
implementing published research methods. Avoid AGPL unless deliberate — and see §4.2, because one
popular dependency would force it.

Content licensed separately from code: **CC-BY-SA-4.0** or **CC0** in `content/LICENSE`. Paper text
is never redistributed (§2.8).

### 4.2 Dependency licence audit — two real traps

| Component | Licence | Verdict |
|---|---|---|
| Electron, React, Tailwind, KaTeX, better-sqlite3, electron-builder, **Monaco**, xterm.js, node-pty, tree-sitter | MIT | clear |
| llama.cpp, Ollama | MIT | clear |
| vLLM, sqlite-vec, pypdfium2, pdf.js | Apache-2.0 / BSD | clear |
| Pyodide | MPL-2.0 | fine to bundle; file-level copyleft only. Note in `NOTICE`. |
| **PyMuPDF / `fitz`** | **AGPL-3.0** | **avoid.** The obvious PDF parser would force the whole app to AGPL. Use **pypdfium2** or **pdf.js**. |
| **Nougat / Marker** | code permissive, **weights CC-BY-NC / restricted** | **avoid as bundled defaults.** NC weights are not open source and poison a redistributable build. Opt-in, user-installed. |
| CUDA / cuDNN | proprietary | never bundled; user-installed runtime dependency. Document it. |

If stock shadcn/ui is dropped per §1.0 point 6, its MIT licence stops being relevant — but lucide
(ISC) or whichever icon set replaces it still needs a `NOTICE` entry.

**Model weights are a separate licence surface from code** — the most commonly botched part:

- **Qwen2.5-Coder — Apache-2.0** ✅ default (also has FIM, which Build Mode needs)
- **DeepSeek-Coder — MIT** ✅ alternate
- **Mistral 7B — Apache-2.0** ✅
- Llama 3.x — custom Meta licence, **not OSI-approved** (acceptable-use + 700M MAU clause)
- Gemma — custom Google terms, **not OSI-approved**

Ship only OSI-licensed weights as defaults; others user-installable with the licence shown first.

### 4.3 Repository and release infrastructure

- **CI**: GitHub Actions matrix (windows-latest / macos-14 / ubuntu-22.04) — build, test, package.
- **SBOM**: CycloneDX attached to every release.
- **Licence gate**: `license-checker` or ORT in CI, failing on copyleft/NC creep. This is what stops
  a future contributor quietly re-adding PyMuPDF.
- **Signing**: certs cost money and OSS projects routinely skip them. Ship SHA-256 checksums and
  SLSA provenance; apply to **SignPath** (free for OSS) for Windows. Document the SmartScreen warning
  in the README rather than letting users discover it.
- **Distribution**: GitHub Releases (also the free `electron-updater` feed), AppImage + Flatpak,
  winget, Homebrew cask.
- **Governance**: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, **DCO** sign-off rather than a CLA —
  lighter, and contributors keep their rights.
- **Reproducibility**: pinned lockfile, pinned toolchain, `.nvmrc`.

### 4.4 "Runs on any desktop or laptop"

**The app must be fully useful with no GPU and no model installed.** Reading papers, solving
exercises, Tier A execution and grading all work with zero AI. Tutor and copilot are additive, and
the UI says so rather than dead-ending on a missing model.

| Machine | Experience |
|---|---|
| No GPU, 4 GB RAM | Study Mode, Tier A execution, paper reader. Model recommendations suppressed with a reason. Monaco not loaded. |
| No GPU, 8 GB RAM | Above + optional 1.5B CPU model; Build Mode usable, completion slow but real |
| 8 GB GPU | 7B Q4 comfortable at 4–8k; Build Mode fully featured |
| 16 GB+ GPU | 14B, or FIM + chat resident together |
| Apple Silicon | Unified-memory path (§2.5); Metal via Ollama/llama.cpp |

No account required, and no telemetry. Nothing leaves the machine after install unless the user
signs in or uses a network feature (the VoidCode model, credits, the research library, a remote
provider key, a model download). An offline first run must reach a working IDE, and a signed-out run
makes no request to a VoidCode server — `npm run smoke` counts the requests a loopback API receives
while a signed-out app starts and renders `/models`, and fails on any.

### 4.5 What must not be in an open-source build

- **No telemetry by default.** Opt-in, disclosed on first run, payload documented in the repo. This
  is the claim the whole local-first positioning rests on.
- **No content paywall in the binary.** Their `Solution (Free)` badge (§1.8) cannot be enforced in a
  client users compile; a lock removed by a one-line patch only teaches patching. Monetise hosted
  sync, cloud inference or support.
- **No hardcoded API keys, no required cloud account.**
- **No non-redistributable assets**: paper PDFs, NC weights, proprietary fonts or icons.

---

## Verification

- **Mode gate**: assert `fs:*`, `pty:spawn`, `exec:runNative` all reject from a Study window. CI test.
- **Context firewall**: assert the Study context assembler's DB view cannot reach reference
  implementations or expected outputs — a schema-level test, not a prompt test.
- **Licence gate**: add `pymupdf` on a scratch branch, confirm CI rejects it.
- **Offline**: networking off, clean profile — first run reaches a working IDE and grades a NumPy
  exercise.
- **Sandbox escape**: symlink from workspace to `~/.ssh`, confirm `read_file` refuses; assert Tier A
  has no socket access. Both in CI.
- **Fit calculator**: unit tests for 8 GB RTX 4060 / 24 GB 3090 / M2 16 GB unified / no GPU, with
  expected tier verdicts.
- **Tutor regression**: 8-scenario audit on a local 7B; the untouched-template case must not fabricate.
- **Pipeline honesty**: ingest a known arXiv paper; assert every published exercise's expected outputs
  trace to a recorded execution, and a mutant reference fails ≥1 case.
- **Agent safety**: agent run in a dirty repo → shadow-git checkpoint restores exactly, user's real
  index and history untouched.
- **Design distinctness** (§1.0): side-by-side screenshot review at Phase 5 exit.
- **Cross-platform**: CI matrix installers on all three; smoke-test launch + one exercise each.

## Open decisions

1. **Starting codebase — SETTLED.** The renderer is the real `apps/web`, cloned into
   `desktop/renderer` and edited there. FastAPI/Postgres/Judge0 are dropped rather than bundled.

   The deciding measurement: `apps/api` requires torch, transformers, peft, bitsandbytes and
   accelerate, plus Postgres and Redis — roughly a 3 GB installer and two database servers to
   run an offline IDE, which is the opposite of §4.4. Its torch stack is also redundant, since
   main already carries a full inference layer (Ollama, llama.cpp, OpenRouter) verified against
   a real 7B at 84.8 tok/s.

   Of eleven routers, main already covers the substance of four (problems, drafts, execution,
   submissions/progress). The remaining six — dashboard, notifications, profile, chat, papers,
   interviews — are CRUD over SQLite, which main already has open via `node:sqlite`. They
   migrate behind `IPC_ROUTES` in `renderer/src/lib/api/client.ts`, one router at a time, with
   the UI unchanged; an unmigrated route returns 501 naming the router rather than failing
   vaguely.

   What is genuinely lost: the FastAPI-side tutor prompt assembly (`prepare_messages_hybrid`),
   which has to be rebuilt in main with the §2.12 guardrails, and Judge0 — already superseded
   by the Pyodide tier, which enforces limits Judge0 never did.
2. **Build an agent core, or vendor one?** `continue`-core and Cline are Apache-2.0 and already solve
   FIM, `@`-context and agent loops. Vendoring could cut Phase 8 substantially at the cost of coupling
   to their abstractions. Worth a spike before committing 4 weeks.
3. **Bundled vs. detected llama.cpp.** Recommend detect-first with a bundled CPU-only fallback;
   bundling adds ~100 MB per platform and a CUDA build matrix.
4. **Tier B Python.** Recommend a managed `uv` venv; system Pythons on Windows are a support burden.
5. **One binary or two?** Study and Build could ship separately for a smaller Study-only download.
   Recommend one binary with lazy-loaded Build (§2.10) until download size proves to be a problem.
