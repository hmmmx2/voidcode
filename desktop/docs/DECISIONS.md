# Decisions

Decisions that shaped this app and are not recoverable from the code alone. **Oldest first** — D0 is
at the top and new entries are appended, which is the opposite of what this line claimed until now.

Each entry says what was decided, what the alternative was, and what evidence settled it — so a
future reader can tell a deliberate choice from an accident, and can reopen it knowing why it
closed.

---

## D0 — The desktop is the source of truth for curriculum content

**Decided.** `src/main/content/` is the curriculum. It is edited directly. The web repo's
`apps/api/scripts/interview_content.py` and `interview_problems.py` are no longer upstream of it.

### What the code said

Two files declared themselves generated:

> GENERATED, AND REGENERATED RATHER THAN EDITED. Source of truth is the web API's
> `apps/api/scripts/interview_content.py` … Editing a prompt here makes the two banks disagree
> with no way to tell which is right, so change the Python and re-emit.
> — `content/interview-bank.ts`, and the same instruction in `content/interview-problems.ts`

### Why that could not stand

**There is no emitter.** A repository-wide search for `interview-bank` / `interview-problems` —
every language, whole repo, excluding `node_modules` — returns exactly one file besides the two
themselves: `tests/interviews.test.ts:42`, which *imports* the module and writes nothing. No
script, no Makefile target, no CI step can perform "re-emit". The documented workflow was not
merely unused; it was impossible.

**The desktop copy is not a transcription — it is a correction.** `interview-problems.ts` records
four shape changes made on the way across, *each of which failed silently first*:

- the web's `inputs` field is display metadata and had **wrong arity for 47 cases**; the real
  arguments were recovered by executing each web driver and recording the actual call
- `class Solution` methods were dedented to top-level functions, with `import math` and `self.`
  helpers that raised `NameError` on first call rather than at conversion time
- each driver's final transform — the problem's own definition of equality — was being discarded;
  it is now carried as `normalise`, and `matrix-calculus-backprop` prints three times, so reading
  only the last dropped two of three matrices from grading
- `expectedOutput` was removed deliberately: an interview screen must not show what a passing run
  looks like

So the desktop content is strictly more correct than the thing it called its source. Treating the
Python as upstream would mean re-deriving all four corrections by hand on every change, having
watched each of them fail quietly once already.

**Nothing downstream depends on the link.** `content/verify-interviews.ts` compares the 204 answer
keys against `interview-answer-key.ts`, the values the web shipped. That is a **one-time conversion
check**, not a sync: it proves the port was faithful, and it keeps working as a regression test
against the desktop's own reference solutions regardless of what the web repo does next.

### What follows

- Edit `content/interview-bank.ts`, `content/interview-problems.ts`, `content/problems.ts` and
  `content/curriculum.ts` directly. The "regenerate rather than edit" instructions are removed;
  leaving them would be a comment that contradicts the code.
- `verify-interviews.ts` and `verify-curriculum.ts` remain the gate on content changes.
- The two banks may now diverge from the web platform's. That is the intended consequence, not a
  regression — the web platform is a separate product on a separate branch.

### What this does not decide

Whether the curriculum should eventually move out of TypeScript literals into per-item data files
reviewed in isolation. It probably should — ~4,000 lines of object literals across four modules is
hard to review one problem at a time — but that is a refactor with no behavioural change, and it is
not blocking anything. Reopen it when authoring volume makes it hurt.

---

## Warn when the tutor's model cannot see (D4)

**Decided:** attachments are always allowed; the panel says so when the model that will answer is
known to be text-only, and says nothing when it is not in the catalogue.

### Why there is a decision here at all

D4 was scoped as renderer-only and it was: `chat:open` already validated image blocks, consent
already gated them, and the shim narrowing `content` to `string` was the whole gap. Driving the
real app is what turned up the part the plan could not have known. Attaching a diagram with Qwen3
8B installed produced *"I currently cannot view or access attached images."* Every layer worked —
the block was built, validated, delivered — and the learner got nothing. A feature that hands the
picture perfectly to something with no eyes has still failed.

### Notice, not a block

A hard refusal would be wrong in both directions. OpenRouter ids and custom Ollama tags are not in
the catalogue at all, so refusing on "not known to have vision" would break attachments for exactly
the models most likely to have it. Absence of evidence is not evidence of blindness. So: warn when
the catalogue says text-only, stay silent when it says nothing, never refuse.

### Match on family, not on id

The first version of the notice was correct and completely silent, which is the more interesting
half of this entry. The catalogue lists fully-qualified tags (`qwen3:8b-q4_K_M`); what people have
installed is the plain default (`qwen3:8b`). Exact matching found nothing in the only case the
notice existed for.

Family — the segment before the colon — is the right key, and it is safe here because vision is a
property of the family rather than the quantisation, and because the families that can see are
named apart from the ones that cannot (`qwen3-vl` is not a variant of `qwen3`). Both facts are
asserted against the shipped catalogue in `tests/tutor-images.test.ts`, so adding a vision variant
under an existing family name fails CI rather than silently making the notice wrong.

### Not decided

**Which model the tutor uses.** It is still "first model of the first provider that has any"
(`usableProvider`), so a machine with both a vision and a text model installed may still get the
text one and be told to install what it already has. That is a model-selection defect that predates
D4 and is not renderer-only; the notice makes it visible rather than fixing it.

**No screenshot OCR**, per the plan: pasting the text is cheaper and more accurate, and `vision/`
already covers screenshot-to-code for Build.

---

## How the next item is chosen (D5)

**Decided:** four situations in priority order, each carrying the sentence that made it win. No
learned ranker, no mastery score.

### The reason produces the score, not the other way round

A recommender that cannot be argued with cannot be acted on. So `selection.ts` does not compute a
number and then describe it: each candidate matches one of `finish` / `repair` / `ready` /
`blocked`, that match sets its band, and tie-breakers only move it within the band. Whatever wins
therefore carries a sentence that is a fact about stored data — "you passed 3 of 4 tests here last
time" — rather than a summary of arithmetic.

The band ceiling is enforced by a clamp rather than by three tie-breaker constants continuing to
sum correctly. Measured, the largest tie-breaker the real graph can produce with the per-component
caps removed is exactly 1000 — the band width — at which point a `ready` item ties the `repair`
floor and is then shown the *ready* sentence. True about that item, and the wrong item.

### Demonstrated means a signal the learner did not supply

`solid` — the standing that removes an item from consideration and opens what depends on it —
requires hidden tests passing or an assessor verdict of `correct`. A self-rating tops out at
`shaky` however confident it is, and `unknown` establishes nothing at all: `verdict.ts` documents it
as the *common* case, produced when a teaching-tuned model coaches instead of grading. Reading it as
a soft pass would advance the curriculum on a formatting failure.

A revealed answer caps at `shaky` even when marked correct. The store keeps no reveal timestamp, so
"answered then checked" and "read it then typed it back" are indistinguishable; one extra revisit is
the cheap side of that ambiguity.

### A concept nothing teaches cannot block

Four concepts have no content, kept as the argument for the next authoring batch. 24 of 52 concepts
sit behind one, including attention.

The first version of this note said requiring them would make that content unreachable. **That was
wrong, and mutation testing caught it** — the mutant deleting the rule passed every test. Remove it
and all 52 items are still reached; the `blocked` band picks them up. What changes is that `blocked`
grows from 6 items to 17, each arriving with *"This needs Linear Algebra first, which you have not
demonstrated yet"* — an instruction with nothing behind it. The rule is about honesty, not
reachability.

### Reported, not fixed

**A second kind of hole**, which `coverage()` cannot see: a concept whose prerequisites are met but
whose every item is co-taught with something not yet open, so it reads as available and is not.
`floating-point` and `probability-basics` are both in this shape — single-item roots co-taught with
an advanced concept. `gatedConcepts()` reports them and the suite pins the count. The remedy is a
standalone item for each, which is authoring.

### Both holes above were closed by D8 — the rule stayed

Appended rather than edited into the text above, because the derivation is still the reason the rule
exists and rewriting it would hide that the state it was measured against is gone.

**Every count in this entry has moved.** D8 authored an item for each of the four empty concepts and
a standalone item for each gated root, so `coverage().conceptsWithoutContent` and `gatedConcepts()`
both read `[]` — asserted, not assumed, in `tests/content-census.test.ts`. The "24 of 52", "6 items
to 17" and "four concepts" figures above are historical.

**The rule is now inert and kept anyway.** Nothing has an empty `teaches`, so the branch never fires.
It stays because the next authoring gap recreates the situation, and a hole reappearing should not
also require rediscovering that holes are harmless to the frontier and harmful to the instruction
text. `tests/selection.test.ts` asserts the emptiness rather than the rule's effect — its earlier
version asserted `holes.size > 0` on purpose, so that closing them would break the test and force
this note to be written.

**Two magnitude constants are not observable.** Halving the coverage weight, or removing the unlock
cap, changes no tested behaviour — the directions are pinned, the exact weights are not. That the
ordering is insensitive to hand-tuned numbers is a feature; it also means those numbers have no
evidence behind them beyond their sign.

---

## Route shells are named `placeholder`, and the curriculum mirror is tested

**Decided:** every dynamic route exports its shell under the one name the `app://` handler looks
for, and the renderer's copy of the problem order is asserted against the real one.

### One word, in two programs, with nothing making them agree

`resolveRoute` answers an unmatched route by looking for a sibling directory called `placeholder`
before falling back to the root `index.html`. `/interviews/[slug]` exported one. `/problems/[id]`
exported one called `1`.

So every curriculum problem except the first missed the lookup, was answered by the root, and the
root route redirected to `/build`. **Clicking any problem in the catalogue opened the IDE.** Nothing
threw and nothing 404'd — a real page, rendered successfully, just not the one asked for. The same
failure had already happened once for interviews, which is why the sibling lookup exists; the
problems route was never brought into line and nothing compared them.

`SHELL_NAME` is now the shared word, `resolveRoute` is split out of the handler so it can be tested
at all, and `tests/app-scheme.test.ts` walks `renderer/src/app` asserting every dynamic route still
uses it. A route that enumerates real params instead — `projects/[slug]` maps over a static list —
is distinguishable and allowed.

### The renderer's curriculum was a stale mirror of a retired repo

Fixing the routing exposed the next layer. `renderer/src/lib/curriculum.ts` hardcodes the problem
order, and its header said it mirrored `apps/api/scripts/problem_content.py` — which **D0 retired**.
It had drifted in both ways its own comment warned about: two problems missing, so `TOTAL_PROBLEMS`
read 12 and the last two were unreachable; and entries 9–12 permuted, so `/problems/9` opened
Parallel Reduction while the dashboard linking there meant Broadcast Shapes.

**The duplication stays.** Importing `problems.ts` into the renderer would pull the hidden test cases
into the client bundle, and withholding those is the whole grading design. So it is two copies plus
`tests/curriculum-parity.test.ts`, which is the same arrangement `agent-event-parity.test.ts`
polices elsewhere.

The resume card now links by item id rather than position. `resolveProblemSlug` accepts either, and
the card is the one caller that would have to *translate* — which is the step that can be wrong, and
which carried a `?? 1` fallback that would have silently opened the first problem.

### Worth knowing

`npm run build:renderer` did **not** regenerate the route after the shell was renamed; the stale
`problems/1/` was still there and `problems/placeholder/` was absent. Clearing `renderer/.next` and
`renderer/out` was required. Verifying against an incremental build would have shown the fix
failing.

`curriculum.ts` also had an unchecked index that nothing had caught, because until the parity test
imported it no file outside the renderer did — and the renderer's program does not set
`noUncheckedIndexedAccess`.

---

## Reasoning is model output, and it is not the answer (D6)

**Decided:** Ollama's `thinking` field is read and carried as its own chunk kind; grading asks for
no reasoning at all; and a model that reasoned without answering is reported rather than recorded.

### The bug wore the costume of normal behaviour

`inference/ollama.ts` typed a stream frame as `{ content, tool_calls }` and read only `content`.
A reasoning model streams its deliberation in `message.thinking` and its answer in `content`, so
until it reached content it emitted nothing — and if the budget ran out first, the turn looked
silent.

The interview assessor bounds itself to 700 tokens on the stated grounds that "grading is not
generation". `parse("")` returns `{ verdict: "unknown", feedback: "" }`, and `verdict.ts` documents
`unknown` as the **common, benign** case: a teaching-tuned model coaching instead of marking. So an
empty response was stored as a verdict-shaped record of an event that never happened, and it was
indistinguishable from the documented-normal case.

Measured against `qwen3:8b`, five identical calls with the same answer returned 503, 200, 503 —
non-deterministic, empty feedback on the failures. With reasoning switched off: five verdicts,
identical.

### Three separate decisions came out of it

**A distinct chunk kind, not more tokens.** Reasoning must never reach the learner as an answer. A
model reasoning aloud about an interview question states the reference answer as a matter of course,
and `redactReference` is a best-effort filter over the *answer* that was never meant to police a
transcript of deliberation. `completeChat` therefore reports *whether* the model reasoned, never
what it reasoned — a boolean, so the text cannot leak into stored feedback.

**Grading asks for none.** `reasoning: false` on the assess call, mapped to Ollama's own `think`
flag. A larger token budget cannot fix this, because the right number differs per model; turning off
a mode the task never wanted can. The output wanted is four short fixed-format lines compared
against a reference already in the prompt — there is nothing to work out. Verified harmless on a
model that cannot think: `llama3.1:8b` accepts `think: false` and answers normally.

**Empty-but-reasoned is unavailable, not `unknown`.** The learner's answer is saved either way, so
the honest report costs them nothing. `text === "" && reasoned` specifically — a model that spoke
without naming a verdict has genuinely produced an assessment, and turning *that* into an error
would break the documented common case.

### Two stale smoke probes, and why they mattered more than they looked

CI gates the installer on `npm run smoke`, so a probe asserting a design the app no longer has does
not merely test nothing — it blocks releases.

The split probe asserted a Monaco editor on `/build`, which `WorkspaceSurface.tsx` deliberately does
not have, and autosave through `fs:save`, which has no renderer caller at all. **Retargeted rather
than deleted**: three of its steps still cover live behaviour nothing else smokes — `file.openRecent`
as the one path that opens a folder without a native dialog, the tree rendering from a real
directory, and a row click putting the file in the assistant's context. That last is what opening a
file *means* on this surface now.

The agent probe searched the textarea's `parentElement` for the Send button. `SlashAutocomplete`
wrapped the textarea in a `relative` div, making Send a sibling rather than a child, and the probe
reported "no Send button" about a button that worked. Fixed with an `aria-label` — the house
convention here, and it also gives the button an accessible name during streaming, when its visible
text is the status "Thinking…" rather than an action.

### `OLLAMA_HOST`, which fell out of verifying the fix

`available()` said probing the HTTP endpoint is what lets "a remote or containerised Ollama" be
found. Only the probe was true; the address was hardcoded, so the sole reachable Ollama was the one
on this machine's default port. Honouring Ollama's own variable makes the comment true and is what
allowed the no-model CI path to be verified locally — by pointing the app at a dead port instead of
stopping a daemon on the developer's machine.

### Also

CI's `typecheck` step covers main and the tests only. The renderer was not unchecked — `next build`
runs `tsc` over it inside `npm run smoke` — but a renderer type error failed a step named "Study
window privilege boundary", four minutes and an Electron launch later. Now a named 30-second step.

---

## The rails a new content item runs on (D7)

**Decided:** the frozen answer key stops being a requirement and becomes a cross-check; anything it
does not cover must carry a spec; routes are addressed by slug; and the gaps the curriculum knows it
has are pinned in one file.

### Authoring was blocked, not merely expensive

`verify-interviews.ts` failed any case with no entry in `interview-answer-key.ts`, and **D0 retired
the generator that produced that file.** So authoring one question meant five or six red CI failures
on three platforms, and the only way to green them was hand-typing values into a file whose header
forbids exactly that.

The obvious plan — "build local key derivation" — was already built. `derivedKeyOrReason` executes
every reference in the real Pyodide sandbox and always did, which is the one thing no oracle can
check. What was missing was something to *assert* about a derived key once there was no oracle.

### Three assertions, none needing an oracle

The reference executes; a correct-but-differently-written solution is accepted; a named mutant is
rejected by a named case. The second is **stronger than the key it replaces**: the key came from the
same source as the reference, so agreement proved the port was faithful, never that the reference was
right.

The oracle is frozen rather than deleted — it is the only surviving evidence D0's port was faithful,
and it costs nothing to keep. A missing entry is now `uncovered` and reported.

**New content must carry a spec**, keyed on the oracle rather than on a date or a flag, because the
oracle is the thing that actually stops covering. Without that rule the freeze would be a hole. The
38 legacy items are deliberately not backfilled: their hidden cases were inherited rather than
designed against traps, so retrofitting means first discovering which of the 126 are vacuous.

### The vacuity census, and the number I got wrong

Grading each problem against its own `template` is a stub test at zero cost per item, because a
template is a signature with no body and returns `None`. Measured at the time: **1 vacuous case of
272**, `iq-implement-auc-4`.

Both numbers have since moved, and the replacement written here in the same breath — "308 cases" —
had already drifted to 320 by the time the two hard problems landed. So no figure at all: the live
one is asserted by `tests/content-census.test.ts` and printed by `npm run smoke`. A decision log
records what was measured when the decision was taken; it is not a live count, and trying to keep it
current is how it goes stale twice.

I predicted two, expecting `iq-implement-grad-clip-4` and its `[]` key. Wrong — a stub returns `None`,
`None` is not `[]`, and that case rejects it correctly. The gap between "keys that look empty" and
"keys a stub actually produces" is why this is measured rather than reasoned about.

### Snapshots live on the wrapper, never on `Problem`

`exec/grader.ts` imports only `type { Problem }`, so a `derivedKey` on `InterviewProblem` is
unreachable from there. That makes "the grader cannot grade against a hand-typed value" structural
rather than a convention — §2.6 as a type boundary. `VOIDCODE_DERIVE` is the runner, because a
generated artefact without one becomes a lie, which is the D0 lesson.

### Difficulty had two sources and they disagreed

`Problem` needs a `difficulty`, so every interview workspace carried a second copy of the question's
— disagreeing for **8 of 38**, with both in the same payload. A learner could filter for "hard", open
the result, and read "Medium". The question wins: difficulty describes what an interviewer asks, not
the harness that grades it.

### Measured, so it does not need guessing at

The gate costs **275ms for 38 references**. The Plan agent's concern about sharding a serialised
sandbox across three OS legs was real to raise and does not apply at this cost.

### Deferred, with a reason that changed

**Generating the renderer mirror** was in the plan and is not done. The argument for it was that
adding a curriculum problem touches four files including a hand-maintained mirror — but D8 is
**interview-heavy**, and interview items touch *zero* renderer files. So it buys almost nothing on the
chosen path. `curriculum-parity.test.ts` already makes drift loud. Revisit if the balance shifts.

### Two of my own tests were wrong

The band-margin test computed `400 + 400` from two constants in the same file and compared it to a
third — a tautology dressed as a measurement, which no content growth could ever have failed. It now
walks the real prerequisite graph.

The timing test asserted `total >= slowest`, which holds trivially when both are zero under instant
mocks. Mutation testing caught it by deleting the accumulation and watching the test pass.

---

## Six items, and what closing the gaps changed (D8)

**Decided:** the named gaps are closed. `coverage().conceptsWithoutContent` and `gatedConcepts()`
are both empty, 44 interview questions, and every pick the recommender makes is now `ready`.

### What was authored, and against which reported gap

| Gap | Item | The misconception it corrects |
|---|---|---|
| `probability-basics` gated | `weighted-distribution-moments` | Variance taken over the outcome *labels* rather than under the distribution |
| `floating-point` gated | `ulp-and-absorption` | Machine epsilon as an absolute threshold, when the spacing scales with the exponent |
| `linear-algebra` hole | `matmul-chain-order` | That the reassociated order is always cheaper |
| `backpropagation` hole | `reverse-mode-fan-out` | Assigning instead of accumulating where a value is reused |
| `quantization` hole | `int8-scale-and-zero-point` | An asymmetric scale with the zero point left at zero |
| `kernel-fusion` hole | `fusion-memory-traffic` | That a longer unfused chain becomes compute-bound |

Every one has a named trap case that a *tidy* test suite would miss. That is the pattern worth
keeping: each mutant passes at least one visible case. Uniform weights cannot distinguish a weighted
variance from an unweighted one; `x == y` cannot distinguish accumulating from overwriting; data whose
minimum is already zero cannot detect a missing zero point; one operation cannot show that unfused
intensity is flat.

### Closing a hole makes the curriculum stricter, and that is the point

While `linear-algebra` had no content the hole rule treated it as met, so **attention was reachable
without it**. It now requires `matmul-chain-order` first. That is a real tightening of the learner's
path and the honest consequence of the concept having content at last.

**The hole rule is now dormant.** No concept has an empty `teaches`, so it cannot fire. The code
stays — a concept will be added before its content again, and `coverage()` plus the census pin are
what will notice — but `selection.test.ts` says out loud that it is unexercised rather than passing
vacuously. The earlier version of that test asserted `holes.size > 0` precisely so closing them would
break it.

**`blocked` went from 6 picks to 0.** Walking the whole 58-item catalogue, every recommendation is
now `ready`. Both gated roots being demonstrable early is what removed the stalls.

### Two things the rails caught in content I had just written

**A vacuous case.** `all-zero` returns `None`, and a body-less template returns `None`, so the case
rejects nothing. Unfixable by authoring — `iq-implement-auc-4` has the same shape — so the census now
separates unavoidable vacuity from actionable, and the actionable count became a *failure* rather
than a printed number free to drift — so the total is deliberately not printed here either. `npm run
smoke` names both unavoidable cases and the case total on every run.

**A wrong claim in my own statement.** I wrote that a constant tensor quantizes with zero error. The
derivation said 0.5: with `scale = 1.0` the zero point comes out at -2, outside the unsigned range.
The fix is what real frameworks do — widen the asymmetric range to reach zero, so zero lands exactly
on a code. That matters for padding and for ReLU outputs, so the item teaches something truer than it
did before. **This is the whole argument for checking derived values against the statement by hand
rather than pasting them:** the derivation says what the code does, never that it is right.

### A test-hygiene defect from D6, found here

`availableProviders()` built from the real provider list and never consulted the `scripted` map, so
`firstUsableModel()` probed the developer's actual Ollama over HTTP while only the chat was scripted.
Three assessor tests took 500ms–1.3s against a live daemon and began timing out once it was busy. CI
never noticed: with no Ollama installed the probe fails immediately and the tests take the no-model
path.

The substitution now happens in `providers()`, so there is one override point, and the assessor tests
script all three backends. 6ms of test time instead of three seconds, and no socket leaves the
process.

### Not done

**The `hard` curriculum tier.** Still 0 of 14 curriculum problems are `hard`; the interview bank has
17 now. D8 was interview-heavy by decision, and interview items touch no renderer files, so this is
the remaining named gap from the plan.

**Volume.** Six items, not 40–60. The plan said to close the named gaps first and reassess, and the
named gaps are what closed. Every remaining item is now a judgement about coverage rather than about
a gap the code can point at.

---

## Say only what the app can honour (D9)

**Decided:** no rendered string names a remedy the user does not have; the OpenRouter provider can be
configured; and the references that pointed at a retired repo now point at what actually exists.

### The instruction nobody could follow

Four pages and the tutor panel each said *"The API didn't respond. If you're running this locally,
check that the API server is up on port 8000."* There is no API server — `client.ts` intercepts every
`app://api` request and answers it over IPC, and its header records bundling FastAPI as considered and
rejected.

Five copies, wrong together, which is why they now come from one module. The deeper point is that a
message naming a remedy the user does not have is **worse** than a vague one: it sends them looking
for a process that was never there, and it quietly claims the product is a different shape than it is.

`tests/honest-copy.test.ts` bans "port 8000" and "FastAPI" in rendered strings while allowing them in
comments — `client.ts` must be able to explain why FastAPI was rejected, and `interviews.ts` refers to
FastAPI's `exclude_unset` to explain a wire shape. What is banned is instructing a user.

### A provider nobody could configure, because a type was missing

`vault:set` had a schema, a handler, and Electron safeStorage behind it — and no caller. The cause was
not neglect: **the `vault` namespace was absent from `host.d.ts`**, so to TypeScript the object did not
exist. A channel invisible to the only program allowed to call it is dead by construction.

The effect was OpenRouter listed in the registry, shown in the model manager, and impossible to give a
key to. It now has a field on the page the app already points people at.

### Writing that panel exposed the next claim

`safeStorage.encryptString` encrypts with the OS credential store, but the ciphertext lives in a
**module variable and is never written to disk**. My first version of the copy said "stored with the
operating system's credential store" — true about the encryption, false about the lifetime, and
exactly the shape of thing this phase exists to remove.

The panel now says the key has to be entered again after a restart. **Persisting it is a real
improvement and a separate decision** — where the ciphertext lives, what clears it — and quietly
implying it was already done would have been the same mistake one layer down.

### References that pointed at nothing

- `chat-stream.ts`, cited as the chat dispatcher, does not exist. The dispatcher is `sseFromPort` in
  `renderer/src/lib/api/client.ts`.
- `MIGRATED`, cited as the running score of migrated routers, was renamed `PENDING_ROUTERS`.
- `SGLANG_THINKING_BUDGET` claimed it "must match `apps/api/src/main.py`" — a cross-repo invariant
  against a repo D0 retired, enforceable by nothing, naming a server with no provider in the registry.
  Renamed `DISPLAY_THINKING_BUDGET`, because that is what it is: a denominator for a progress bar that
  no provider is ever told. Storing the real total beside `thinkingBudgetUsed` needs a migration.
- `renderer/src/lib/api/judge0.ts` promised "All calls go through the FastAPI backend… Never calls
  Judge0 directly from the browser." Neither half is true, and the **name** was the worse half: a
  reader looking for how grading works found a file promising a remote service. It is `grading.ts` now,
  and its header says where execution actually happens.

### Left alone deliberately

**The root `README.md`** was the stock Expo Router + NativeWind template, describing neither project
in this checkout, and was left alone because a root README is the one document that would have to
relate two unrelated projects. That is no longer the state: it is now the VoidCode README, it says in
its second paragraph that `desktop/` is the application and the Expo root is a leftover, and it
documents the SmartScreen and Gatekeeper prompts an unsigned installer produces. Whether the Expo root
is deleted outright is `docs/OPEN_QUESTIONS.md` Q-006.

**`LANGUAGE_MAP.judge0Id`** was threaded from `WorkspaceClient` into the submit payload as
`languageId` and serialised as `language_id`, and nothing read it. Now removed — see the entry above.

**Nine channels have handlers and no renderer caller**, and the count in this entry was wrong until
`tests/ipc-callers.test.ts` measured it: `fs:writeWithDiff` and `fs:commitDiff` were missing from the
list. See the entry below, which resolves all nine.

---

## A dead field across five layers, and a dropdown that could not keep its promise

**Decided:** `LANGUAGE_MAP` maps a language name to a Monaco mode and nothing else, and it lists only
Python.

### The field

`judge0Id` was carried per language in `renderer/src/lib/constants.ts`, read by `WorkspaceClient`,
passed to `executeCode` and `submitSolution` as `languageId`, and serialised as `language_id` in a
request body. **The transport seam never read it.** Main separately emitted a matching
`judge0_language_id: 71` on every code template, which the renderer parsed into `judge0LanguageId` on
its client model — a field that was assigned and never read either.

Two independent chains for the same nonexistent consumer, across seven files.

Main's comment said the field was "kept so the renderer's language mapping still resolves". That was
not true: the dropdown keys off the `language` string, so the mapping resolved without it. A comment
justifying dead data with a reason that does not hold is how the data survives.

### The dropdown was the more interesting half

`CodeColumn` filters the language options against `LANGUAGE_MAP`'s keys. It listed JavaScript, C++ and
Java — and a `Problem` names a Python `entry` point, ships a Python `reference` and `template`,
declares `allowedImports` against Python modules, and is executed by Pyodide.

Unreachable today, because main only ever emits a Python template. But the failure it was set up for
is the D9 shape exactly: a template naming JavaScript would be **offered in the dropdown, highlighted
correctly, and then graded as Python**. Removing the entries makes that fail closed — such a template
is filtered out rather than accepted and mis-run. If a second runtime ever ships, the map grows in the
same change as the thing that can execute it.

### The smoke was sending it too

Its submit probe passed `language_id: 71`, which the real client no longer sends. The probe's whole
value is that it sends what the client sends, so it was aligned rather than left as a body shape
nothing produces.

Verified in the app: the dropdown offers Python alone, Monaco still mounts, and a submission through
the slimmed body grades 4 of 4.

---

## "Uncalled" was three different things (the dead channels)

**Decided:** two channels deleted, seven kept with a declared reason each, and the reason is now
asserted rather than written in a comment — `tests/ipc-callers.test.ts`.

### The framing was wrong before the measurement

D9 recorded seven handled-but-uncalled channels and called the state rot to be cleaned up. Both
halves were wrong.

**The count.** There were nine. `fs:writeWithDiff` and `fs:commitDiff` were absent from the list, and
they are the two an unaided reader is most likely to delete: nothing in `renderer/src` calls either,
and `Build/DiffView.tsx` — whose `onApply` would reach `commitDiff` — is rendered `readOnly` by its
only user, so that prop is never wired to anything live. They are in fact where the property that
makes an unrestricted assistant safe to point at a real repository is asserted *through the channel*:
`index.ts:2074` proves a `../escape.txt` write is refused, and `:2773` proposes a diff as the agent
and asserts the commit is refused. Deleting them would have removed the only end-to-end evidence that
the agent cannot write without a human, and left every unit test green.

**The category.** "No renderer caller" turned out to name three situations, and only the last is a
deletion candidate:

| | Channels | Why |
|---|---|---|
| Exercised by the smoke | `mode:get`, `fs:save`, `fs:writeWithDiff`, `fs:commitDiff` | Live assertions, some of them the app's core safety properties |
| Would strand a subsystem | `lint:run` | Deleting it orphans all of `src/main/lint/` |
| Unexercised leftovers | `fs:saveAs`, `fs:confirmDiscard` | Kept only because other files cite them as precedent |
| **Deleted** | `progress:list`, `fs:recentProjects` | Something else already does the job |

`progress:list` went because `dashboard:get` already returns per-problem progress
(`content/dashboard.ts`), and `fs:recentProjects` because `menu.ts` builds its recents submenu from
the store directly and never asks the renderer. A channel with a working replacement is rot; one
waiting for a surface is not.

`fs:save` was first written into the new test as kept-because-cited, which undersold it — the smoke
drives it against a temp project root and asserts three things, including that a save against a stale
`baseline` is refused. That is the app's only optimistic-concurrency check; `fs:writeWithDiff` takes
`{ path, next }` with no baseline at all.

### Why a test and not a comment

The reasons live in `EXPECTED`, and the assertion is that the uncalled set *equals* its keys — so a
new uncalled channel fails, and wiring one up also fails, which is the right amount of friction for
an edit that should delete a line. Two of the reasons are claims about another file ("the smoke
exercises this"), so they are checked against that file; otherwise deleting a smoke case would leave
the channel justified by coverage that no longer exists.

The finder is a regex over source, and the first version of it matched only `host.ns.method(` — which
reported 43 uncalled channels when 13 were, because it could not see `host()`, `host.fs!.method()`,
`host?.ns?.method?.()`, a formatter's line break, or a namespace bound to a local first. The
assertion was measuring the pattern rather than the code. There is now a case that names each shape,
and aliases resolve per file: matching a bare `namespace.method(` anywhere would let `sash.index` and
`resolved.search` mark `memory:index` and `memory:search` as called, and a false "called" hides a dead
channel instead of reporting one.

All eight mutants died — each regex shape, a dropped `EXPECTED` entry, a channel becoming reachable, a
deleted smoke case, and a superseded channel coming back.

---

## Where the key lives, and what clears it

**Decided:** the safeStorage ciphertext goes in a `secrets` table in the app's own SQLite file
(schema 16); `vault:clear` removes it, and so does the vault itself when a row stops decrypting. On a
Linux desktop whose backend is `basic_text`, it is deliberately **not** persisted.

### The two questions this answers

`vault:set` and `vault:has` worked. The panel that calls them said the key was "held in memory only,
so it has to be entered again after a restart" — accurate, because `setOpenRouterKey` encrypted with
safeStorage and kept the ciphertext in a module variable. That copy named the two things that had to
be settled before it could say anything better: *where the ciphertext lives* and *what clears it*.

**Where.** SQLite, beside everything else the user owns, for the reason `recents.ts` gives — a second
durable store for one row is a second thing to back up, migrate and explain. The bytes are not a
secret the file protects; they are a handle to one the OS is holding, which is why there is still no
channel that reads a value back.

**What clears it.** `vault:clear`, and this is the part that had to arrive *with* persistence rather
than after it. While a key died with the process, "remove" was a restart. Once it survives, a wrong
key, a revoked key, or one left on a shared machine survives too — and because the surface is
write-only by design, the user cannot look to see which key is stored. Replacing it was the only
remedy available, and that requires already having another key.

### Persisting is what made two failure modes reachable

Neither existed while the ciphertext died with the process, and both are handled rather than
discovered later:

**A row that outlives its keychain entry.** A keychain reset, an OS reinstall, or a copied profile
all leave bytes that will never decrypt. `hasSecret` therefore *decrypts* to answer rather than
checking whether a row exists, and an undecryptable row is deleted. Reporting "a key is stored" for
one of those is worse than reporting nothing: the user cannot see the key, cannot fix it, and the
panel tells them the field they would use is already filled.

**A backend too weak to write to disk.** `isEncryptionAvailable()` being true is not the claim "these
bytes are safe at rest". On Linux, when Electron does not recognise the desktop environment, it
selects `basic_text` — which its own documentation says encrypts with a hardcoded key. In memory that
distinction did not matter. Writing it to disk is exactly what makes it matter, so this is a risk the
feature would have *introduced*. Under `basic_text`, and under `unknown` (which means `app` was not
ready, so the backend is unidentified), the key stays in memory for the session and `set` returns
`storedDurably: false` so the UI says which of the two happened instead of implying the better one.
`getSelectedStorageBackend()` is Linux-only, so it is not consulted elsewhere.

Two smaller things came with it: `vault:set` threads `input.key` instead of discarding it — with one
enum member and a variable named after the provider, a second member would silently have overwritten
the first — and a missing credential store now raises `E_UNAVAILABLE` with a sentence about keyrings
rather than surfacing as "vault:set failed".

### Verified

19 unit tests, and **14 of 14 mutants killed**. Three survived the first pass and each was a real
gap, not a scoring detail: two were missing tests for the one situation where a session-only key and
a durable one disagree (replace under a changed backend, and Remove when nothing was written), and
the third was a zero-length-blob guard in `readSecret` that turned out to be dead — `decryptString`
already rejects those, *and deletes the row*, which is the better outcome. The guard was removed.

One test of mine was measuring the stub rather than the code: it asserted the stored bytes do not
contain the key, which the reversible test cipher can never satisfy and a real cipher would satisfy
without the code doing anything right. It now asserts byte-equality with the encryptor's output,
which is the property this code actually controls.

Beyond the unit suite, because all of it runs against a stubbed `safeStorage`:

- The smoke sets, reads back and clears a key through the real credential store, and asserts that
  clearing nothing reports `false`. Confirmed to bite by making `clearSecret` report success without
  deleting — the smoke failed.
- Driven in the running app: Save disabled until something is typed, no Remove button while nothing
  is stored, and after saving the panel reads "Saved, so it will still be here after a restart."
- **Four separate processes against real DPAPI and real SQLite**: set, relaunch, `has` → true;
  clear, relaunch, `has` → false. That is the claim the copy now makes, checked the only way it can
  be.

---

## Invariants with nothing on the other end

**Decided:** no file in this repository states an agreement with the web repository. Where one did,
either the claim is now about this repository or the thing it parameterised is gone.

### What "cross-repo invariant" turned out to cover

D9 named two and fixed both (`SGLANG_THINKING_BUDGET`, `judge0.ts`). The rest were not the same
shape, and two of them mattered more than the pair that got named:

**A rendered one.** `AppFooter` printed `Qwen2.5-7B · SGLang · AWQ`, with a comment saying it matched
the marketing footer's — so it was the only cross-repo invariant a *user* could read, and it renders
on `/privacy` and `/terms`. All three parts were false: there is no SGLang provider, nothing serves
AWQ (`lib/models/describe.ts` treats AWQ as what would matter *if* something did), and the app ships
no model — the catalogue even records that the bare `qwen2.5-coder:7b` tag 404s, so it named a model
you cannot pull by that name. It now reads `Local models · Ollama or llama.cpp`, and a test checks
those names against the labels the inference layer declares rather than against a list in the test.

**A shipped one.** `API_BASE` was `isDesktop() ? "app://api" : NEXT_PUBLIC_API_URL || "http://localhost:8000"`
— the retired FastAPI address. Because it is evaluated at module load and `window` is undefined during
the prerender, `localhost:8000` was **compiled into a shipped chunk**. Dead at runtime, since the
preload has set `window.host` by the time it evaluates in the browser, but in the artifact.

`honest-copy.test.ts` had *exempted* `client.ts` from its own "no port 8000" rule for that branch, so
the check could not have found it. The exemption is gone with the branch, and a second test greps the
built chunks — because the source-level rule was necessary and not sufficient, which is the whole
lesson. It skips when there is no build to inspect, so a clean checkout does not fail.

Three false statements, corrected rather than deleted:

- `api/chat.ts` and `api/problems.ts` said calls go to the FastAPI backend. `problems.ts` was wrong
  twice — "replaces hardcoded mock data with database-driven content" has the direction backwards
  since D0 replaced database rows with source files.
- `notifications.ts` said the custom header was needed "for X-User-Id for authentication". Nothing
  authenticates, and **no handler in main reads that header** — the seam does not forward headers at
  all. Claiming a check that is not happening is worse than the header being inert.
- `useUserId.ts` said the data layer "still sends X-User-Id to the bundled API". There is no bundled
  API; bundling one was considered and rejected. The header is a wire shape, not a credential. The
  mechanism is left alone — removing it is a functional change, not a copy fix.

### One invariant was load-bearing for dead code

`MobileMenu` documented itself as "shared by the marketing page and the app", and parameterised what
was marketing-specific. It has one caller, passing `links` and `breakpoint="lg"`. So `actions` — the
sign-in pills — was never passed and had no possible caller, since this app has no sign-in; and the
`md` default was the other repository's value and unreachable. `actions` is deleted and `breakpoint`
is now required, so a caller states it instead of inheriting a value from a repository that is gone.
It stays a prop rather than a constant because `BREAKPOINTS` pairs a Tailwind class with a
`matchMedia` string, and picking a row is what stops those two drifting apart.

**Not fixed, and recorded instead:** the privacy policy still speaks of a "registered email address"
and "the Platform". That is web-era boilerplate rather than an invariant, and rewriting legal copy is
a decision about what the document should say, not a stale-reference cleanup.

### Verified

4 of 4 mutants killed — the footer reverting to the old string, the footer naming a backend the
registry does not declare, `API_BASE` regaining its fallback, and SGLang appearing in a rendered
string elsewhere. Confirmed in the running app on `/privacy`: the bottom bar reads the new line, and
the only model name on screen is the status bar reporting what Ollama actually has installed. The
built bundle contains no `localhost:8000`, no SGLang and no AWQ, and still contains `app://api`.

---

## A privacy policy for the application that exists

**Decided:** the Privacy Policy describes this local-first application, every factual claim in it is
pinned to the code it depends on, and the legal framing was left for a human.

### What it said

It was a hosted-platform policy: OAuth sign-in with Microsoft and Google, session and CSRF cookies,
IP addresses and approximate geolocation, analytics retained 90 days, authentication logs retained 12
months, profile data "deleted within 90 days" of account deletion, anonymised submissions retained
indefinitely for research, conversations reviewed by authorised staff for quality assurance,
disclosure to cloud hosting vendors, and TLS 1.2+ / AES-256 / MFA protecting a server nobody runs.

None of it exists. There is no account, no sign-in, no server, and no "us" that receives anything.

Two things make this worse than ordinary stale copy. It is **the one document a user reads precisely
because they cannot read the source** — every other honesty fix in this repository corrects something
a determined reader could have checked. And section 2 already carried a comment recording that
student IDs and LMS enrolment records had been struck for exactly this reason, so the problem had been
seen, correctly diagnosed, and then fixed only as far as the paragraph in front of it.

Every claim removed described *more* data handling than happens. That is the safer direction to be
wrong in and still wrong: it invites a user to be more careful than they need to be, and it makes the
document useless as a description of the product.

### What it says now

Twelve sections, restructured around what the software does rather than what a SaaS agreement
usually covers: what is stored and where (one SQLite file, named, with its contents listed), what
leaves the computer (nothing by default; three routes, each requiring the user to act first), the
tutor and the assistant, the API key, disclosure, retention and deletion, security, rights,
third parties, changes, contact.

Some of the more useful sentences are ones a hosted policy has no reason to write. That we cannot
restore anything, because we hold no copy — so back up the folder. That a legal demand to us produces
nothing. That most APP rights are things the user performs directly rather than requests. And in
Security, the two honest limits: the import allowlist is pedagogical rather than a boundary against
code written to defeat it, and nothing protects the database from someone who already has the
machine.

### Pinned to code, not just proofread

`honest-copy.test.ts` gained a block that checks both directions. The retired phrasings stay gone —
whole phrases, not keywords, because keywords flagged section 3's *denial* that IP addresses are
collected, and a test that cannot tell "we collect your IP" from "no IP is collected" pushes the
document towards saying less when an explicit negative is the more useful sentence.

The better half asserts each claim against the code that makes it true: no `email` column in the
`profile` table, nothing assigning `document.cookie`, exactly one provider declaring `remote: true`,
and the documentation hosts named in section 3 present in `net/allowlist.ts` — **with the allowlist's
size pinned**. That last one was a mutation-test survivor: checking only that the named hosts are
allowed catches a removal, while an *addition* silently widens what leaves the machine with section 3
still reading as complete. If it fails because a domain was added, the fix is to decide whether the
policy should name it, not to bump the number.

10 of 10 mutants killed, including a schema gaining an email column, a second remote provider, and
the app starting to set a cookie.

### Deliberately not changed

The legal entity and its contact details, the postal address, the Privacy Officer email, the
jurisdiction, and the statutory compliance claims in the badge row. Those are legal and commercial
decisions, not descriptions of software, and they need someone who can make them. The rewrite is
confined to what the application does.

**The Terms of Use has the same defect and was left alone**, because it is a different document and
the user asked for this one. Its section 3, "Account Responsibilities", is entirely fictional —
confidentiality of credentials, notifying us of unauthorised use, not creating multiple accounts,
logging out on shared devices, and VoidCode suspending or terminating accounts. Section 2 also claims
"self-service sign-up", which a previous correction to that file introduced. Worth doing next.

---

## The fine-tune finished; nothing downstream of it survives

**Decided:** record what happened to the model pipeline, because a plan asked for the answer either
way and it went unanswered long enough to be repeatedly re-derived.

`VOIDCODE_PLATFORM_SPEC.md`'s revision asked, as a one-week unblocking item: *"Determine whether
merge, quantize, and vLLM serve ever completed. Record the answer in `docs/DECISIONS.md` either
way."* It was never recorded, in this file or the repository-root one. The evidence:

**Supervised fine-tuning ran.** Eight training logs on `feat/voidcode-platform`
(`llm/logs/training_2026{0226,0310}*.log`), and `llm/outputs/README.md` is an auto-generated TRL SFT
model card naming `Qwen/Qwen2.5-7B-Instruct` as the base.

**Nothing after it survives.** No weight artifact is tracked in git — correct, weights do not belong
there — but none exists on disk either. `~/swinburne_models/`, `~/swinburne_models/awq_model` and
`~/swinburne_models/merged_model` are all absent, and those are precisely the paths the old
`MODEL_PATH` resolution order named. The card's own `model="None"` suggests the run was never carried
to a named artifact.

**So: the fine-tune completed, and the merge → AWQ quantize → vLLM serve chain either did not run or
its outputs are gone.** Either way there is no servable artifact, and no number produced by that
pipeline should be repeated anywhere.

This retroactively justifies a change made for a different reason. D9 deleted the footer reading
`Qwen2.5-7B · SGLang · AWQ` because no SGLang provider exists and nothing serves AWQ. It turns out
the whole line was describing an artifact that was never finished — so the footer was not merely
naming the wrong stack, it was naming a stack that had never run. `tests/honest-copy.test.ts` pins
its absence.

---

## Known-stale document

`docs/ide-parity-plan.md` plans IDE parity with VS Code. That direction was abandoned — the
standalone editor was removed from Build and the app is chat-first. The file is kept only because
its subsystem studies are still accurate reading; nothing in it should be treated as intended work.


## Serving the RL policy: point at a bigger card rather than shrink the model

The GRPO run produced a LoRA adapter for `Qwen/Qwen3-Coder-30B-A3B-Instruct` (r=32, attention-only,
102 MB at `artifacts/policy-30b-uncapped`). Three ways to serve it were considered; the choice is to
run it on a 24-48 GB card and connect to it, not to make it fit locally.

**Local was not a close call, and the numbers are measured rather than estimated.** The AWQ weights
are **16 GB** on disk; the development machine's card is **15.9 GB** total. The weights alone exceed
the card before any KV cache, activations or CUDA context. For a working footprint, training served
this same model at `--vllm-gpu-util 0.40` on a 46 GB A40 with `max_len 5120` — about **18 GB**. That
is the smallest configuration known to work, and it is ~2 GB more than the whole local card.

**Shrinking it was rejected because it changes what was measured.** The adapter is bound to this
base; a different base or a heavier quantisation means retraining, and any result would no longer be
the one `docs/rl/RESULT.md` reports.

**The serving path itself is not new work.** `scripts/train_grpo.py` already builds vLLM with
`enable_lora=True` and dispatches through `LoRARequest`, so the rollout path in training *is* a
serving path. The desktop already has the socket: the `llamacpp` provider exists to be pointed at an
OpenAI-compatible endpoint, which is what vLLM speaks.

Two things do have to change first, and neither is about the model:

- **`docs/OPEN_QUESTIONS.md` Q-009.** That provider declares `remote: false`, and three image-consent
  gates key on it. Pointing it off-box without fixing that sends learners' screenshots to another
  machine with no prompt. This is a prerequisite, not a follow-up.
- **There is no model picker.** `usableProvider()` returns the first provider with any models and its
  first model, and Ollama sorts before this provider — so a vLLM endpoint is ignored entirely while
  Ollama has anything pulled. Selection has to exist, or Ollama has to be stopped.

**Sequencing.** The only suitable card available is the A40 currently running the seed-1 replication
and then the max-cases ablation — roughly two days of occupied GPU. Serving waits for it or needs a
second card; it is not blocked on code.

**What this decision does not claim.** `docs/rl/RESULT.md` measured transfer at **-0.67 SE** on the
60 authored ML/DL problems, flat in every run attempted. The interview curriculum is that content, so
serving this policy is an infrastructure capability and not a quality improvement to the tutor. It is
recorded here so nobody later reads the decision as evidence the tutor got better.

## An optional account, in the desktop app

**Decided:** sign-in moves from the website into the desktop app and stays optional. The IDE, grader,
local models and local profile never ask for it; an account exists for the VoidCode model and the
credits that pay for it. The website's logged-in UI **has since been deleted** — what remains at
`apps/web` is an overview, a pricing page, a download page and the legal documents, holding no
session and calling no API.

### What "optional" is held to

Not a wording choice — a property with a test on each layer:

- **Main:** `platform/http.ts` answers an authenticated call with no session as a synthetic 401 and
  never calls `fetch`; the hosted provider's availability uses an auth-token getter, not extra
  headers. `tests/account-session.test.ts` spies on `fetch` with a configured API address.
- **The running app:** the smoke points the app at a loopback server and counts requests during a
  signed-out start and a `/models` render — zero — then sends one sign-in as a positive control.
  Removing the short-circuit in `http.ts` made it report `GET /v1/credits`.
- **The legal text:** "An account is optional, and without one the application runs entirely on your
  machine" is pinned by `honest-copy.test.ts` to both of the above.

### A 401 means the session ended — so nothing else may answer 401

`http.ts` ends the stored session on any 401 from a request that carried it, which is what makes a
session revoked on another device disappear everywhere. Two API answers used 401 for something else
and would have signed people out: a mistyped *current* password on `change-password`, and a provider
token failing verification while connecting Google or Microsoft with a valid session. Both are 400
now, each with a Postgres test that the session survives.

### What the legal documents now say, and what they refuse to invent

The Privacy Policy lists what the server holds for an account (checked field by field against
`apps/api`), who else handles it (Stripe, Resend, server and GPU hosting), and what it keeps in
passing (logs with email addresses on auth events, access logs with IPs, hashed attempt counters that
lapse within an hour). Writing that section found two log lines keeping the first 60 characters of
every question sent to the hosted model; they log lengths now, and
`apps/api/tests/test_prompts_are_not_logged.py` walks the AST of every logger call.

Three things are stated as **not decided** rather than filled in: how long server logs are kept, and —
in the Terms — refunds, credit expiry, and what happens to credits if the model stops being offered.
There is also no delete-account button; deletion is by email. These are commercial and legal choices
for the owner. A document that invented them would repeat the defect the earlier rewrite removed,
in the other direction.

`TERMS_VERSION` (`src/shared/legal.ts`) is sent at registration and is the "Last updated" date both
documents print; the test fails if either drifts, because a recorded consent to a version nobody was
shown is worth nothing.

### Public client IDs are not secrets

Written before the providers shipped and still the reason it is safe: the Google and Microsoft
client IDs are baked into the build through
`__VOIDCODE_BUILD__` (`electron.vite.config.ts`). They identify the app to the provider and grant
nothing on their own; the only secret in that flow, Google's client secret, stays in the API's
environment because the API — not the app — redeems the authorization code.
---

## Everything the account needed, and the four choices that were not obvious

**Decided.** The optional account is finished: Google and Microsoft sign-in, a credits page with its
history, and the research library — all in the desktop app, against the platform API. Each of the
four entries below is a choice where the obvious option was the wrong one, which is the only reason
any of them is written down.

### The desktop runs the browser half, and the API redeems the code

**Decided:** the app opens the person's own browser at the provider, receives the authorisation code
on a loopback listener, and relays `{code, verifier, redirect_uri, nonce}` to our API, which redeems
it and verifies the ID token. Three alternatives were live:

- **An embedded window.** Rejected: it means somebody typing their Google password into a window
  this application controls and can read, with no address bar to check. That is indistinguishable
  from a phishing page, and RFC 8252 says not to do it. Their own browser also already holds their
  session, so most sign-ins are one click.
- **A custom URI scheme** (`voidcode://`) instead of loopback. Rejected: a scheme is registered with
  the operating system and any other program can register the same one, so on a shared machine a
  second application claiming it would receive the code. An ephemeral loopback port belongs to this
  process and nothing else can bind it.
- **The app redeems the code and sends us the ID token.** Rejected as the default: Google's "Desktop
  app" client type still wants a `client_secret` at the token endpoint, and relaying keeps that in
  server configuration. It also means the ID token arrives at the API *from the provider over TLS in
  response to our own request*, so a client cannot substitute one it obtained elsewhere. Kept as the
  fallback if a provider ever refuses server-side redemption for native clients — the verifier is
  unchanged either way.

**A wrong `state` is answered and ignored, not fatal.** The listener returns 400 and keeps waiting.
Treating it as a failure would hand any page that can guess the port a way to cancel somebody's
sign-in — a denial of service given away for free, and one that would look like the provider
failing. The `Host` header is checked against the authority we published, which is what separates
our own browser's redirect from a page that resolved its own domain to 127.0.0.1.

**Nothing is asked for beyond `openid email profile`, and no refresh token.** A refresh token is
standing permission to act as someone, held for as long as we keep it, in exchange for nothing we
need. `prompt=select_account` because both providers otherwise reuse whichever account the browser is
holding — on a *Connect* button that is the entire question being asked.

### "Has the payment landed" is a new ledger entry, not a bigger balance

**Decided:** the credits page watches for a **new positive ledger entry**, identified by id, and
falls back to comparing the balance only when the history could not be read.

The obvious version compares the balance against what it was before checkout. It is wrong because
the banner invites the buyer to keep using VoidCode while they wait, and using it spends credit: a
question answered mid-settlement writes a negative charge, so the balance can be flat or lower with
the payment already credited. Ids rather than timestamps because two rows written in one transaction
share a `created_at` to the microsecond — which is why the ledger's primary key is a BigInteger
identity.

Two smaller things in the same module, both of which had to be wrong once to be noticed:

- **An unreadable starting balance stays unknown**, not zero. Stored as zero, the next successful
  read — of an unchanged wallet that already held credit — reads as an increase of the whole
  balance, and the page announces a payment that never happened.
- **The deadline is derived from the start and nothing rewrites it.** The equivalent effect in the
  deleted web client needed a comment and an eslint suppression to keep its balance out of a
  dependency array, because including it restarted the interval on every poll and pushed the
  deadline back forever. A value that cannot be recomputed needs neither.

`purchase-watch.ts` is a pure module for exactly this reason: both properties are invisible from a
component test.

### Holds and releases are not shown, and the page says so

**Decided:** the history lists only entries that changed the balance. A `hold` moves credit from
available to reserved and a `release` moves it back, so both carry an amount of zero; listing them
produced several rows per answered question, most of them reading nothing. The footer therefore
counts **movements**, not ledger rows, and says "All 4 movements" when fewer rows came back than
were asked for — telling somebody with a four-movement history about "your last 50 ledger entries"
invites them to wonder what the other forty-six were.

The ledger's own vocabulary stays out of the interface: `grant` and `charge` are accounting terms,
and the column is headed "What". The label map is held to the Postgres enum by test, so a new entry
type fails a build instead of rendering as `chargeback` to a learner.

### The research library sends a session when it has one, and survives not having it

**Decided:** `research:list` and `research:get` send the stored session when there is one and, on a
401, retry **once, anonymously**.

This is the only call in the application that wants a session *optionally*, and it needed a rule of
its own. The papers are public; the reading ticks are the reader's. A 401 means the stored session is
dead — that is what it means everywhere here, and `platform/http.ts` has already cleared it by this
point — but the library was never private, so answering with an authentication error would be
refusing somebody a public catalogue over a credential they did not need. Exactly one retry, and
only for a 401: a loop, or a retry on a 500, turns a server having a bad minute into two.

Marking a section read is the opposite and is refused in the client with no request at all. The
server would refuse it too (`require_user`), and the reason the client refuses first is that a 401
from that call would end a session that is perfectly valid.

**No PDF pane.** The web version framed arXiv's PDF beside the text, which worked there because
arXiv sets no `X-Frame-Options`. This renderer is served from `app://` under a policy that allows no
cross-origin frame at all — a frame is a live page from somebody else's server inside a window that
holds an IDE — so the PDF opens in the reader's own browser, where their reader and annotations
already are. `research:openPdf` takes a **slug**: main resolves the address from the paper our API
returned and checks it is plain https with no embedded credentials, because `shell.openExternal`
launches whatever the operating system has a handler for.

**Marked on open, not on scroll.** A scroll-depth check sounds more honest and is worse: it never
fires for a short section and it fires for somebody who flicks to the bottom. Neither measures
reading, so the library says outright that it counts sections opened rather than sections
understood — and the Privacy Policy repeats it, pinned by `honest-copy.test.ts` to that sentence in
the component.

### What this cost in guards, and one that was already broken

Every one of the above is mutation-tested: 29 mutations for the providers, 17 for credits, 21 for the
library, all killed. Three survivors in the first passes were test gaps rather than inert mutants,
and a fourth found something older:

`curriculum-parity.test.ts` bans addressing a problem route by curriculum position. Its last
alternative was meant to be `\bn\b` — a bare variable called `n` — and had reached the file as
`\x08n\x08`, an ASCII **backspace** either side of the letter, because whatever emitted it resolved
`\b` as a string escape rather than a regex word boundary. A backspace never appears in source, so
that alternative had never matched anything. Fixing the escape was not enough: `indexOf(entry) + 1`
is a position by any reading and matched none of the four names either. A deny-list of ways to spell
"a number" cannot be completed, so the guard is now an allowlist — an interpolated problem route must
name a slug or an id — with comments stripped first, because the prose describing the defect it
fixed would otherwise trip it. It has a positive control over the predicate now, which is what would
have caught the dead alternative on the day it was written.
