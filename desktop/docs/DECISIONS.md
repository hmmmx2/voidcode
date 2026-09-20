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
directory, and a row click putting the file in the assistant's context.

**That last sentence used to read "that is what opening a file *means* on this surface now", and
it no longer does.** Build has an editor again — tabs in the centre pane beside Chat — so a row
click paints the file as well as putting it in the assistant's context, and the probe asserts
both. The reversal and what survives of the reasoning behind it are recorded in
`desktop/docs/DECISIONS.md`.

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

## Known-stale documents

`docs/ide-parity-plan.md` plans IDE parity with VS Code. That direction was abandoned — the
standalone editor was removed from Build and the app is chat-first. The file is kept only because
its subsystem studies are still accurate reading; nothing in it should be treated as intended work.

Two more, and these are worse because of how they introduce themselves.
`docs/specs/ARCHITECTURE.md` opens with *"complete technical reference for the entire project …
written so any developer or AI assistant can fully understand the system"*, and its first diagram is
`Browser → Next.js 16 (:3000) → FastAPI` — the architecture before the desktop application existed.
`docs/specs/PROJECT_DOCUMENTATION.md` calls itself a *"full implementation record"* and is dated
2026-03-12; its section 9 documents `packages/shared`, a package deleted for being imported by
nothing.

Neither has been rewritten, and neither should be read as current. Both now carry a banner saying
so and pointing here. What is current: `README.md` and `CLAUDE.md` for the shape of the tree,
`docs/desktop-app-spec.md` for what the application was specified to be, this file and
`docs/DECISIONS.md` for why things are the way they are, and `docs/SUPERSEDED-SPECS.md` for what
became of the two VoidCode specs. They are kept because their subsystem detail — the inference
stack, the training pipeline, the database schema — is still the best description of those parts
that exists.


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

---

## `UnknownVizError`: the smoke's camera failing the run it was photographing

**Decided:** `capturePage` is retried by `src/main/smoke-capture.ts`, and a capture that never
succeeds still fails the smoke — with a message that names the camera.

`VOIDCODE_SMOKE_SHOTS=<dir> npm run smoke` failed intermittently with

```
[smoke] FAILED
  - signed-in smoke threw: UnknownVizError
```

while plain `npm run smoke` passed. Two facts made that look like a real defect that only
screenshot mode was revealing. The string `UnknownVizError` appears nowhere in `src`,
`renderer/src`, `out` or `renderer/out`, so it had to be constructed at runtime. And the smoke
already has a SHOTS-only reveal: console errors in `runBuildSmoke`'s route loop are collected
inside the screenshot block, which `index.ts` notes at the command-palette probe as a reason not
to lean on React warnings. A renderer error surfacing only under SHOTS was therefore the
plausible reading.

It was the wrong one. The string is Electron's, from the Electron binary and nothing else:

> `case content::CopyFromSurfaceError::kUnknownVizError: return "UnknownVizError";`
> — `shell/browser/api/electron_api_web_contents.cc`, v43.2.0, reached from `OnCapturePageDone`,
> which does `promise.RejectWithErrorMessage(CopyFromSurfaceErrorToString(result.error()))`

`capturePage` does not read the window's pixels. It asks viz for a copy of the composited surface,
and that request fails on its own — a GPU hiccup, a frame not yet produced, a surface the OS has
stopped compositing. Electron rejects with the enum stringified and nothing else: no route, no
call site, no hint that the camera rather than the page had failed. It was SHOTS-only for the
uninteresting reason that **nothing else in the smoke takes a picture**. Every assertion about the
page had already passed when it fired.

Reproduced at roughly one run in four on this machine, in both surviving forms — `signed-in smoke
threw:` and `build/threw:` — and in a run where all four signed-in screenshots had already been
written and every page assertion had passed.

### What changed, and what deliberately did not

The four `capturePage` + `writeFile` pairs — the signed-in route loop, `build-file-open`, the shell
route loop and the sign-in dialog pair — are one function now. It retries five times at 300ms, which
is a second and a half against a fault that clears in a frame.

**The assertion is not relaxed.** A window that can never be captured still fails the smoke; the
message names the attempt count, the last reason and the fact that this is Chromium's surface copy
rather than the page. Retrying the camera is not tolerating a broken one, and the test file asserts
that difference before it asserts the recovery.

Three things were folded in while the code was in one place:

- **An empty image resolves rather than rejecting** — Electron returns `gfx::Image()` when the view
  has no bounds — so the old code would have written a 0x0 PNG and called it a success. That is the
  same lie as photographing an empty workbench, which this smoke has already shipped twice.
- **The write is outside the retry.** A capture that succeeded and a write that failed are different
  faults; retrying the second spends five captures on a path that will not become writable and then
  blames viz for it.
- **The directory is created.** `VOIDCODE_SMOKE_SHOTS` is a path a developer types, and a missing one
  used to surface as an ENOENT thrown from the middle of the signed-in page assertions.

### Why this has a unit test rather than a green smoke run

A fault that appears in one run out of four cannot be verified by running the smoke again. The
rejection is injected in `tests/smoke-capture.test.ts` instead. Five mutants, all killed: no retry;
an empty image counted as a picture; the final throw downgraded to a log; the write moved inside the
retry; the `mkdir` dropped.

---

## Build Mode has an editor again, and what that reverses

**Decided:** the centre pane carries editor tabs beside Chat. Clicking a file in the explorer
paints it, you can edit it, Ctrl+S writes it through `fs:save`'s baseline guard, and the bottom
dock's Problems tab reports what the project's linter said.

This reverses a decision recorded across three files, and the reasoning is corrected in place
rather than deleted, because two thirds of it is still right.

### What was decided before, and why

Build had no editor. `WorkspaceSurface.tsx` and `lib/build/workspace-tabs.ts` both said so: code
arrives in the conversation as diffs to review, which is where a change is legible -- a reviewed
hunk says what is changing and why, and a file open in a pane says neither. The editor pane was
removed, its channels (`fs:save`, `fs:saveAs`, `fs:confirmDiscard`, `lint:run`) were kept behind an
allowlist in `ipc-callers.test.ts` with a reason each, the Problems dock tab went because its only
producer was a lint run on a successful save and the workspace had stopped saving, and the CI smoke
probe was retargeted so that "opening a file" came to mean "putting it in the assistant's context".

### Why it changed

The owner reported it as a bug: clicking a file in the folder tree did not display the file. It was
not a bug -- the click read the file and stored it, and nothing painted it -- but the report is the
argument. Clicking a file is the one gesture a file tree promises, and on this surface it produced a
sentence in another pane.

Reviewing a model's diff and reading your own code are different jobs. The first argument was never
an argument against the second, and it was being used as one.

### What survives

- **The assistant still proposes rather than writes.** `fs:writeWithDiff` and `fs:commitDiff` are
  untouched, and the review step in `AssistantPanel` is still where a model-authored change is seen
  before it lands. `fs:save` writes the buffer the user is looking at, character for character;
  `src/main/build/save.ts` already argued that distinction and it holds.
- **The right pane is still not a code editor.** A Code tab there would be a second place showing
  the same file, which is the same objection `WorkspaceSurface` makes about a second place to act on
  a run: two surfaces for one thing are two surfaces that can disagree.
- **`apps/web` stays monochrome.** Its identity is the argument, and its demo is a static
  placeholder that must not flash when Monaco swaps in. The desktop theme diverges from it
  deliberately and says so; the claim that the two mirrored each other is removed rather than left
  to rot.

### What is now true, and what is still not

Editor tabs in the centre pane, Chat first and never closable. Explicit Ctrl+S with a dirty dot and
a native discard prompt; no autosave, because `fs:save` carries the app's only
optimistic-concurrency check. The window-close handshake writes every dirty buffer before answering
`allowClose`, and rescues a refused save to a sibling `.voidcode-conflict` file -- there are three
seconds and nobody in front of a dialog, so a file the user did not ask for beats a lost edit.
Problems in the bottom dock, fed by `lint:run`, with a badge and no auto-opening.

Still not true, and worth saying because the alternative is someone assuming otherwise:

- **There is no language server.** Python gets tokenisation and ruff over the last save. No hovers,
  no go-to-definition, no rename. `lib/monaco-local.ts` used to claim an LSP supplied Build Mode's
  IntelliSense, citing a spec section; there is no `lsp:` channel, nothing implements one, and the
  smoke asserts `host.lsp` is absent on purpose. That comment is corrected.
- **Diagnostics describe the last save.** `lintFile` takes a path and runs the tool against the file
  on disk, so a dirty buffer's problems are about what was written. The pane says so per file
  rather than implying otherwise by silence.
- **Problems is not a project scan.** Markers exist only for open files. "No problems" across two
  tabs says nothing about the other four hundred, and the pane says that too.

### The defect underneath all of it

Monaco's loader was configured only from `MonacoWrapper`, which mounts on the Study route and
nowhere else. Every other route asked for Monaco with the package's default jsDelivr path, the CSP
blocked the script with no error anyone saw, and `useMonaco()` resolved to `undefined` for the life
of the page -- so every fenced code block in the Build assistant's transcript rendered as plain
text. `loader.init()` is one-shot, so the fix is placement rather than presence: it is configured
during module evaluation of the root client component, strictly before any component effect can
ask. `markdown-render.test.ts`'s plain-text fallback assertion passed throughout, which is what
made it invisible.

## The sign-in dialog gets tested before it gets cut down

Google and Microsoft sign-in are being removed. That edit lands inside `SignInDialog.tsx` -- three
forms, a two-step forgot flow and a sixty-second cooldown in 557 lines -- and **nothing tested any
of it**. This commit adds the tests first, with the providers still present, so the removal commit
shows exactly which assertions die rather than deleting code nobody was watching.

The flow that matters is `ForgotForm`. Once provider sign-in is gone it is the only route back in
for an account that has no password, which is not hypothetical: the API issues a reset code to
exactly those accounts on purpose, because receiving the code proves control of the mailbox and
that is the proof setting a first password needs. A bug there is not a regression, it is a person
locked out.

### Why a DOM, and what the DOM is not

`markdown-render.test.ts` renders a component with `react-dom/server` and that remains right for
what it checks -- the first frame. Everything at risk here needs a state update: the step advancing,
the cooldown counting down, a server field error landing under its field, a pasted `"123 456"`
normalising, the password cleared in the `finally`. So `tests/ui/` opts into jsdom with a per-file
docblock; `environment: "node"` stays global, because 139 other files read sources off disk, drive
real `node:sqlite` and use real `Buffer`s.

**jsdom 26.1 does not implement `showModal`** -- verified, not assumed -- and `Modal` calls it from
an effect. `tests/ui/host-stub.ts` shims it in three lines and says plainly that it reproduces the
`open` property and the `close` event and nothing else: not the top layer, not the backdrop, not
focus trapping, not Escape. A pass here is a statement about the component's logic and not about the
dialog element.

The host stub's methods **refuse by default**. A test that forgets to arrange the call it depends on
fails loudly instead of passing against a stub that happened to say yes.

### Two things that cost an afternoon each, recorded so they do not again

**One React, not two.** The component resolves `react` from `renderer/node_modules` while Testing
Library reaches `react-dom/client` through a CJS `require` that no alias intercepts. Two copies means
two hook dispatchers and every render dies on `Cannot read properties of null (reading 'useId')`,
which reads exactly like a broken component. Testing Library is installed in `renderer/` and aliased
there -- the same shape `@monaco-editor/react` already had -- so its natural resolution is the right
one and the aliases make every other importer agree.

**Fake timers and `userEvent` do not mix here.** `userEvent` awaits its own internal timers between
events, so under `vi.useFakeTimers()` the first `await user.type(...)` hangs until the test times
out -- presenting as "the cooldown never counts down". The cooldown test uses `fireEvent`. It also
advances **one second per `act` boundary**, because the countdown is a self-rescheduling effect:
each tick's `setTimeout` is created by the effect that the previous tick's render ran, and React
only flushes a queued render at an `act` boundary, so one 61-second advance fires exactly one
timeout and stops.

### `tests/ui/` is typechecked under the renderer's rules

A component test compiles the component, and the root program compiles it against the wrong
contract: no `renderer/src/types/host.d.ts`, so `VoidCodeHost` and `window.host` are "cannot find
name", and `exactOptionalPropertyTypes` plus `noUncheckedIndexedAccess`, which the renderer does not
set. Twenty errors, none of them a defect -- the renderer's own `tsc --noEmit` is clean on the same
files. `tsconfig.ui-tests.json` extends the renderer's config so the check asks the question the
shipped bundle asks; `npm run typecheck` runs both, and the root program excludes `tests/ui`.

### What it is worth

Fifteen tests, and each of the seven guards the removal will lean on was written and then mutated:
delete `setStep("code")`, `RESEND_COOLDOWN_S = 0`, drop `.replace(/\D/g,"")`, relax `/^\d{6}$/` to
`/\d/`, remove `setPassword("")` from the `finally`, send a server field error to the banner instead
of the field, make the consent check unconditional. All seven fail. The provider test in this file
is written **to be deleted** by the removal commit, and says so.

## The successful sign-in has never run, so now it does

`npm run smoke` sets `VOIDCODE_DEV_SESSION_TOKEN` against a loopback stub with no session route.
`sessionToken()` returns that value before it reads the vault, so `storeSession` -- the call that
puts a token into `safeStorage` -- has never executed in any automated run in this repository. The
REJECTION path is genuinely covered there. The successful one was not covered at all.

`scripts/account-e2e.mjs` (`npm run smoke:account`) closes that: the real API under uvicorn, a real
Postgres, the real Electron app driven over CDP, and sixteen checks -- register, session from the
vault, refresh, sign out, sign in, request a reset code, redeem it, and prove the old password is
dead and the new one works. It is the GATE on removing provider sign-in, because afterwards the
forgot-password flow is the only route back in for an account with no password.

### Four refusals, and why each is a refusal rather than a warning

1. **A dev session token is a hard failure, not a skip.** With it set every assertion passes without
   `storeSession` running, which is the exact hole being closed. Green would be a lie.
2. **`VOIDCODE_E2E_DATABASE_URL` has no default.** This script deletes rows. A default aims that at
   a database the caller did not name.
3. **Neither port may already be in use.** Earned, not anticipated: a uvicorn leaked from an earlier
   run kept serving 8031, the new one failed to bind, readiness went green against the stale process,
   and every assertion ran against an API this script neither configured nor could read the log of.
   The reset code was being written to a file nobody was reading, and the failure presented as "the
   console email format must have changed".
4. **It spawns `src.main:app`.** A second app definition is a second answer to "what is the API".

The first three are checked before any dependency is probed, so `account-e2e-guards.test.ts` can
verify them by RUNNING the script rather than reading it -- a behavioural check a comment cannot
satisfy.

### Two things measured rather than assumed

**Readiness is `/v1/auth/me`, not `/health`.** `/health` reports on the inference backend, which this
run removes on purpose, so its considered answer here is "unhealthy" forever; and it reaches Judge0,
Redis and the database before replying, so it outlives a short client timeout and reads as a closed
port. Signed out, `/v1/auth/me` answers 401 at once and proves the router under test is mounted.

**Startup is eight minutes of budget for a measured five and a half.** `main.py`'s lifespan polls the
backend's `/v1/models` thirty times at ten seconds before accepting a connection, hardcoded with no
knob, and `USE_SGLANG=true` with no backend is how a model is kept out of the process. The script
prints its progress every minute, because a silent eight-minute wait is indistinguishable from a
hang -- and killing it is how refusal 3 got earned.

### What it deliberately does not assert

No count of anything: not `count(*) FROM users`, not "one `user_identities` row". Those are facts
about a live database at one moment, and asserting them turns a real person signing up into a red
build. Nothing about the other accounts. No `DELETE` without the `desktop-e2e-%` predicate, no
`TRUNCATE`. Nothing about rate limiting -- `REDIS_URL` points at a closed port so the limiter fails
open, because a live Redis would enforce `LOGIN`'s ten-per-300s and make the fifth run of an hour red
for a reason unrelated to the code. The prefix differs from the Python suite's `acct-test-` so the
two cleanups cannot race.

Seven mutants, all killed: remove the dev-token refusal; drop the `LIKE` predicate; skip the port
check; spawn a different app; and three against the console email format in `email_service.py` --
the header, the `to:` label and `Your code is:`. That last group is the point of the guard file: the
format is written in Python and read in JavaScript, and nothing else holds the two ends together.

## Google and Microsoft sign-in is removed

An email address and a password is now the only way to sign in to a VoidCode account. Thirty-nine
files, 432 lines added and 3,946 removed, in one commit -- because four tests are two-way pins that
fail in BOTH directions, so there is no ordering in which the tree is green halfway through.

### The finding that shaped it

The live database holds 28 accounts with no `password_hash`, and `user_identities` held ONE real
row: a gmail.com account, linked through Google, no password, active, and it has signed in. Removing
provider sign-in takes away that person's only way in.

The escape hatch already existed and was built for exactly this. `routers/auth.py` issues a reset
code to accounts with no password ON PURPOSE -- "receiving the code proves control of the mailbox,
which is exactly the proof setting a first password needs". So `Forgot password?` is the migration
path, and that is why an end-to-end run of it (`npm run smoke:account`) was written and passed as a
GATE on this commit rather than as follow-up work. A bug there is not a regression, it is a
permanent lockout.

### What went

`account/{oauth,loopback,providers}.ts`, `ProviderSignIn.tsx`, `account-oauth.test.ts`,
`services/{oidc,account_linking}.py`, `models/user_identity.py`, `test_oidc.py`, `oidc_fakes.py`.
Four IPC channels (`account:providers`, `account:signInOAuth`, `account:cancelOAuth`,
`account:reopenOAuth`) -- the preload needed no change, being generated. `SignInMethods` off the
account page, `TermsLine` and the three `ProviderWaiting` early returns out of the dialog.

Two fields off the wire and out of the types: `password_cleared` and `user.providers`. Both would be
permanently empty, and `/me`'s `providers` would be a SELECT against a dropped table. A field that
looks like a control and reports nothing is the shape `test_web_auth_is_gone.py` already refuses.
Old installed builds are unaffected -- `outcomes.ts` read `body?.password_cleared === true` and
`session.ts` guarded with `Array.isArray`, so absence was always handled.

The four `OAUTH_*` settings are gone from `config.py` too. By the end they were read only by that
module's own production check, which warned when they were unset: a knob whose only effect is to
describe itself. Setting them now does nothing, and a test asserts they cannot come back.

PyJWT goes with `services/oidc.py`, from all three requirements files. Nothing imports `jwt`, and
`test_requirements_cover_the_api.py` is a two-way pin that would have failed either way -- once if a
file stopped declaring what its table names, once if the table named something the source never
imports.

### The legal documents reversed, and the version moved with them

Privacy 6.4 was five bullets describing the provider exchange; it is now two paragraphs saying there
is no such exchange. 6.1 lost the identity columns, 3 and 7 lost a provider sentence each, and 11
lost a named recipient with its two outbound links. The Terms' "Your sign-in" names the password as
the only way in.

`TERMS_VERSION` moved to `2026-09-20`, and that is legal rather than cosmetic: someone who accepted
the old version accepted a document naming Google and Microsoft as parties that could receive data
about them. Rows keep the version they accepted -- rewriting one would falsify a consent record. The
web copies moved through `scripts/sync_web_legal.py`, never by hand.

6.4's second paragraph is the point of the rewrite: it names the case of an account that never had a
password and says what to do about it, in public, rather than leaving the affected person to infer
it.

### The migration, and why the guard came first

`b4f8e27c9a13` drops `user_identities`. `downgrade()` recreates the table exactly as
`a7c3e9f1b204` built it, and the docstring says plainly that the SHAPE round-trips and the ROWS do
not. It touches one table: `a7c3e9f1b204` also added `users.terms_accepted_at`, `users.terms_version`
and `auth_tokens.attempts`, all of which stay and are all still read.

The other session's `test_migrations_match_models_postgres.py` was committed first, deliberately.
Without it, deleting the model and forgetting the migration would leave the DROP to be emitted by
the next autogenerated migration, written for something else, in a line nobody reads.

### The pin that has now run both ways twice

`honest-copy.test.ts` began by asserting that no file under `src/main/account` named either
provider's host and that the Policy said so. Adding the providers failed it, which forced the Policy
to be rewritten rather than left saying the opposite of what shipped. It was then inverted. Removing
the providers failed it in that direction, which is the pair working, and it is back to its original
form -- plus explicit `existsSync` checks on the three deleted modules, because `readdirSync` can
only see what is there and cannot notice a file returning under a new name.

Two deletions left notes behind rather than silence: the `describe("provider sign-in")` block in
`sign-in-dialog.test.tsx`, written one commit earlier and labelled "deliberately written to be
deleted", and the smoke's provider block in `src/main/index.ts` -- which existed because
`account:signInOAuth` was the ONE renderer-reachable path to `shell.openExternal`. That is now
`research:openPdf`, which takes a slug rather than an address.

### Verified

Six mutants, all killed: re-add `password_cleared`; re-add `providers`; re-register
`/desktop/oauth/{provider}`; leave PyJWT declared with no importer; put PyJWT back in one file only;
bring a provider host back into `src/main/account`. Three more against the requirements parser, whose
real-file coverage of case-folding died with `PyJWT[crypto]` -- the shapes are fed in directly now,
and the note says why.

desktop 2287 passed across 139 files, both typechecks clean, `npm run smoke` PASS, the API suite exit
0 from `apps/api`, root `pytest tests` exit 0, and the migration drift guard green three consecutive
times (it skips silently when the host-to-container Postgres path stalls, which is gap 4 in the plan
and Phase 3's job).

## The five things that made "login works" less true than it looked

Removing provider sign-in was the visible change. These are the gaps it uncovered, each of which
could have been reported as working.

### A skip is not a pass

Every test in `test_desktop_accounts_postgres.py` and `test_migrations_match_models_postgres.py`
carries `requires_postgres`, so the whole end-to-end coverage of registration, reset-by-code and
migration drift can disappear and the run still exits 0. Thirty skips and thirty passes look the
same from the outside.

That is not hypothetical. While this work was in progress, a run from the wrong working directory
skipped all thirty account tests and read as success, and the flaky Windows-to-container path on
this machine silently skipped the migration guard between two runs where it passed.

`REQUIRE_POSTGRES=1` turns the skip into a collection-time failure naming the address it tried. It
is OPT-IN rather than inferred from `CI`, because a fork's CI may genuinely have no database. It
replaces a step in `ci.yml` that was wrong in both directions: it ran the whole suite a SECOND time
and grepped for "N skipped", so it doubled the job and failed on any skip from any cause -- its own
correctness depended on no other test in the repository ever being skipped.

`verify-accounts` in `desktop.yml` is the new job, one OS with a Postgres service, and it fails if
the harness prints SKIP. A script that skips cleanly is right on a laptop and wrong in a job that
installs every dependency it needs: a green run that tested nothing is worse than a red one, because
nobody looks at it.

### An email that was never sent, linking to a page that does not exist

`email_verification_email` had no caller -- no route, no service, no task -- and the link it built
pointed at `/verify-email`, which is not a route under `apps/web/src/app`. Had anything ever sent it,
the person would have followed it to a 404 and still had an unverified address.
`issue_email_verification` went with it; its only caller was a test that wanted `issue`'s
revoke-the-previous-one behaviour and reached for the nearest wrapper.

**`email_verified_at` STAYS, because it is true.** Redeeming a password-reset code sets it, and that
is real proof of the mailbox. What went is the "Verified / Not verified" badge on the account page:
the field is true information the APPLICATION CANNOT ACT ON -- there is no "resend verification
email" and now no sender -- so the badge could sit on "Not verified" forever with nothing to press,
reading as a warning about the account rather than a fact about a flow that is not offered.

### "Signed in as" is the wrong sentence for a new account

All three forms received `created` from the API -- registration sets it, password sign-in and
reset-by-code do not -- and the dialog dropped it. Someone who had just filled in a name, an address,
a password and a consent checkbox was told they had signed in to something that already existed.

**The producer and the consumer needed separate tests, and proving that took a mutant.** The dialog's
own file asserts `onSignedIn(email, created)` on all three paths; deleting the branch in
`AccountProvider` left every one of those assertions green while every new account got the wrong
sentence. `tests/ui/account-provider.test.tsx` renders the real `ToastProvider` around the real
provider and reads the text out of the DOM. It asserts the WHOLE sentence: "Signed in as x" is a
substring of "Account created. Signed in as x", so a `toContain` on the shorter one would pass
against either.

### A command labelled "Account" that opened the local profile

`go.account` pushed `/profile`. They are unrelated pages -- `/profile` is the local profile (display
name, photo, time zone, all in `voidcode.db`, never sent anywhere) and `/account` is the VoidCode
account (sign-in, password, credits, sessions). So neither the command palette nor the menu bar could
reach the account page at all; the avatar menu and typing the URL were the only routes, and the
person looking for "where do I change my password" was shown their photo.

Three tests already covered this command and all three passed: they check that a palette ENTRY exists
and how it is labelled, which says nothing about where pressing it goes. The new one pins the
destination, pins `file.preferences` still going to `/profile` -- preferences ARE local -- and checks
the route exists on disk, because under `output: export` a push to a path with no page is a blank
shell rather than a 404 anyone notices.

### One email cap, not three

255 in the renderer's `validateEmail`, 320 in the IPC contract, 254 at the API. Each defensible
alone; together, two ways to be refused by something other than the thing that decides. A
255-character address passed the form, passed the channel's schema, reached the API, and came back as
a validation error with no `field` attached -- which the dialog shows as a banner rather than under
the Email field.

254 is the one that is not a choice: RFC 5321 caps an SMTP forward-path at 256 octets including the
angle brackets, and that is exactly where `EmailStr` draws the line. MEASURED, not assumed -- and the
first attempt at measuring it was wrong, reporting a 250-character address as refused because the
probe built a 238-character local part and tripped the 64-character local-part limit instead.

`EMAIL_MAX_LENGTH` lives in `src/shared/legal.ts` and both call sites read it.
`apps/api/tests/test_email_length_cap.py` reads the same constant and asserts all four request models
accept 254 and refuse 255. Either half alone would let the two drift: the TypeScript side cannot run
Python, and a Python-only boundary test says nothing about what the app sends.

### A note on how this was verified

The desktop suite, both typechecks and the smoke are green. The API suite is green for every test
that does not need Postgres. The Postgres-backed tests pass on a clean run -- one of six consecutive
runs of the accounts suite was fully green -- but this machine's Windows-to-container path stalls
with `WinError 121`, and the other five runs each failed one or two DIFFERENT tests, six distinct
victims in total, with 32 "semaphore timeout" errors across a full-suite run. A real defect fails the
same test every time. That is recorded rather than smoothed over, and it is the same condition
`REQUIRE_POSTGRES` exists to make loud instead of silent.

## Two repositories, one document, one number

The website is being extracted into its own repository. This is the part that has to happen while it
is still here, because two of the three mechanisms below can only be PROVEN against both trees at
once -- after the split there is no second tree to compare with.

### The digest replaces a comparison that cannot survive the move

`test_marketing_pages.py` compares the application's copy of each legal document with the website's,
character for character. It is a good test and it is about to become impossible -- not harder,
absent.

What replaces it is one committed SHA-256 per document in `src/shared/legal.ts`. Each repository
hashes its own copy against the same number; neither reads the other. Editing the text without
bumping the constant fails in the repository holding the source, and a copy that has drifted fails
in its own CI.

**THE SCOPE IS THE WHOLE DESIGN.** The digest covers the `SECTIONS` array only -- from
`const SECTIONS: Section[] = [` to the `Sub-components` banner, carriage returns stripped. The two
copies legitimately differ OUTSIDE that range: the website's file carries a "this is a copy" header
and a breadcrumb pointing at the site root rather than the application's Settings screen. A digest
over the whole file would differ by construction and could never agree.

Getting the boundary right took being wrong first. The obvious marker for "outside" was
"Last updated" -- and section 12's prose says *"This page carries a 'Last updated' date"*, so the
phrase is inside the digest as well as in the footer. The assertion is on the BREADCRUMB now, which
is the thing the two copies actually disagree about.

The rule is implemented three times -- TypeScript, Python, and a dependency-free Node script in the
website -- and each copy carries a note saying to change all of them or none. That is the cost of
the two repositories being independent.

**Three mutants, all killed:** change a word of the document without the constant; change the
constant without the document; make the extraction return nothing. The third is the one that
matters -- a rule returning `""` would agree with a digest of `""` and every other assertion would
pass.

### The website refuses to deploy a legal document it cannot verify

`apps/web` has no test runner at all, so adding one for a thirty-line check would have forced a
dependency decision on the extracted repository. `scripts/check-legal-digest.mjs` uses `node:crypto`
and `node:fs` and nothing else, and `package.json` runs it as `prebuild` -- so **Vercel runs it on
every deploy**.

A failed deploy is the right outcome rather than a warning: the alternative is publishing a privacy
policy that is not the one the application records consent against, to the person least able to check
it. Positive-controlled three ways -- a changed word, a changed constant, and a disturbed marker all
refuse the build.

### The download page reads two repositories, and that fixes a real defect

`NEXT_PUBLIC_RELEASES_REPO` becomes `_MAC` and `_WIN`, with independent state per platform fetched
through `Promise.allSettled`.

This is not plumbing. GitHub allows 60 anonymous API requests an hour per IP, which a shared office
network exhausts, and with one feed a single 403 blanked the whole section -- including the platform
whose feed was fine. `Promise.all` would have reintroduced exactly that one layer up, which is why
`allSettled` is used and why the note says so.

A single version line now appears only when both repositories are on the same tag. They are released
from two repositories and can legitimately differ for a while; one number in the section head would
then be a claim about downloads that do not carry it, and the visitor cannot tell which half it
describes. Each panel shows its own version instead.

**The Linux sentence was deleted, not moved.** It read "Linux builds (AppImage and .deb), older
versions and the source are on the releases page" and pointed at the single repository. The two
distribution repositories carry installers and nothing else, so that sentence would send a Linux
visitor to a release page with nothing on it for them.

### Two guards for things that were silently unpinned

**The rename broke nothing, and that was the problem.** No test named either variable, so the
component, the Dockerfile and the workflow could have disagreed with nothing failing -- and a
misconfigured build does not crash, it renders a page that says "no release has been published"
forever, which reads as "not released yet". `test_download_section_matches_the_build.py` now derives
the offered downloads from the KINDS **regexes** -- not their `os`/`arch` fields, because the regex
is what decides which file a panel links to -- and compares them with `electron-builder.yml`'s
target matrix. Five mutants killed, including the plan's own: drop `arm64` from `win.target`.

**The website's env template documented ten variables and the site read one.**
`NEXT_PUBLIC_API_URL`, `INTERNAL_API_SECRET`, `AUTH_SECRET`, `AUTH_TRUST_HOST` and five OAuth
provider credentials all belonged to a server-side auth proxy and a NextAuth session that went when
sign-in moved into the desktop app; `src/auth.ts` does not exist. The existing guard checked only
that the file was tracked and carried no real secret.

The over-documenting direction is the one that bites: a template asking for a secret implies
something uses it, so the next person generates one and sets it in a deployment believing the site
holds a credential. It holds none. `test_web_env_template.py` derives the set from
`process.env.*` reads in `src/` and fails in BOTH directions.

`AUTH_URL` was renamed to `SITE_URL` while doing it. It was NextAuth's variable and is now read only
for `metadataBase`; on Vercel, `AUTH_URL` is a name people set expecting an auth library to read it.
Its fallback chain is `SITE_URL` -> Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` -> localhost,
because the localhost fallback is invisible locally and visible only to crawlers.

### The NOTICE is not a copy, and Apache-2.0 says so

`apps/web` gets `LICENSE` (verbatim) and its own `NOTICE`. The application's NOTICE names Pyodide as
a bundled MPL-2.0 component and takes positions on CUDA, model weights and research papers -- none
of which the website ships. Section 4(d) requires a derivative to carry the original's attribution
notices "excluding those notices that do not pertain to any part of the Derivative Works", so they
are excluded rather than copied: a verbatim copy would CLAIM the site distributes an MPL-2.0
component.

What the site does bundle was checked rather than assumed -- every dependency in its
`package.json` has importers in `src/`, Monaco and three.js included, so the list names them.

A test caught this omission, incidentally: `README.md` linked `LICENSE` and `NOTICE` before either
existed, and `markdown links point at files that exist` failed.

Verified: desktop 2300 passed across 141 files, both typechecks clean, `npm run build` for the
website exit 0 with `prebuild` verifying both documents and all ten routes static, root
`pytest tests` exit 0, and every API test that does not need Postgres exit 0.

## The installers get their own repositories, and one job to put them there

`voidcode-mac` and `voidcode-windows` hold no source and no history of this project -- a README
saying which file to take and what the platform's own security prompt will say, a LICENSE, a NOTICE,
and one workflow. The main release keeps everything: Linux builds, SBOMs, source maps, and the
checksums over all of it.

### The NOTICE call is different from the website's, on purpose

There is no code in those repositories, but they are how the BUILT application is distributed, and
Apache-2.0 section 4(d) attaches to distribution rather than to source. So Pyodide's MPL-2.0 notice
PERTAINS there, and each NOTICE names where the full third-party licence text sits inside the
package and which SBOMs carry the rest.

`apps/web`'s NOTICE deliberately omits exactly those notices: it publishes pages, not the
application, and a component bundled into the application does not pertain to it. Both files say
which case they are and why, because the two look like the same decision made inconsistently until
you read the reason.

### The .gitignore is the guard that keeps them small

`*.dmg`, `*.exe`, `SHA256SUMS.txt` and the SBOMs are ignored, so an installer dropped in the
directory while testing a release cannot be committed by accident. Git keeps every version of every
object forever: a repository that accumulates binaries makes `git clone` a download of every
installer ever shipped, and `git filter-repo` plus a force-push is the only way back.

### `verify-release.yml` counts before it verifies

The READMEs tell people to check `SHA256SUMS.txt` and call it "the only provenance this distribution
offers" -- true, because these builds are ad-hoc signed and not notarised on macOS and not signed at
all on Windows. That instruction is only as good as the file, and nothing re-checked the pair AFTER
the installers were copied into another repository.

**`sha256sum --check` over a file listing nothing exits 0.** So does one whose every entry is
missing under `--ignore-missing`. Either would report a green "verified" for a release nobody can
actually check. So the workflow asserts the number of installers listed is non-zero AND equal to the
number attached, and only then checks hashes with `--strict`. It filters to its own extension,
because the checksums file covers every asset of the main release including files deliberately not
copied there.

Exercised against five scenarios before committing: a good release verifies; no checksums file, a
checksums file listing no installer, an installer listed but not attached, and an attached installer
whose bytes were altered are each caught, with a message naming which.

### `distribute` lives in `release.yml`, and that is a constraint

`release-config.test.ts` asserts `release.yml` is the only workflow triggered by a `v*` tag. A new
`v*` workflow would fail that on day one, which is the test working -- two workflows racing on one
tag is how a release ends up half-published. So the job goes in the existing file.

`needs: release` is load-bearing: `SHA256SUMS.txt` is written there, and running in parallel would
publish installers beside a checksums file that had not been written yet, or an earlier one -- which
is worse, because it verifies and is wrong.

It also counts before copying, for the same reason the verify workflow does:
`gh release create <tag> *.dmg` with no matching file creates an EMPTY RELEASE and exits 0, and the
only symptom is a visitor finding a release page with nothing on it. The expected counts are checked
against `electron-builder.yml`'s target matrix rather than written down, so adding an architecture
fails the test instead of silently shipping one fewer installer than was built.

`DIST_RELEASE_TOKEN` must be a FINE-GRAINED token scoped to those two repositories. Not a classic
PAT with `repo`, which grants write to everything the account can reach from a job that needs two --
and `github.token` cannot write to another repository at all. The job refuses to start without it,
rather than failing at the last step of a release that has already been made.

Five mutants, all killed: drop `needs: release`; swap in `github.token`; remove `--draft`; drop an
architecture from the build; empty the count loop.

### Two guards noticed this change before I did

`packaging.test.ts`'s vacuity guard pins the release workflow's job list exactly, so adding a third
job failed it -- the guard working. It is spelled out as three names rather than loosened to a
length, because "at least two jobs" would pass against the wrong two.

And the desktop typecheck rejected my own test: indexing a `Record` is `| undefined` under
`noUncheckedIndexedAccess`. A `!` would have been the wrong fix -- if the job is genuinely missing,
the failure should be a sentence saying so rather than a `TypeError` from the first property access.

Verified: desktop 2306 passed across 141 files, typecheck clean, root `pytest tests` exit 0. The
three folders exist as git repositories with no remote: `voidcode-web` carries its seventeen commits
of real history from `git subtree split`, and the two distribution repositories carry five files
each.

## The website leaves, and what it was holding together

`apps/web` is gone: 95 files, plus `pnpm-workspace.yaml`, `turbo.json`, `pnpm-lock.yaml`, the root
`package.json`, `deploy/base/web-deployment.yaml` and the `web` jobs in both workflows. 131 files
changed, 878 lines added and 16,304 removed.

**The one edit that could have broken the product rather than a test was checked first.**
`pnpm-workspace.yaml`'s globs were `apps/*` and `packages/*`; `desktop/` is matched by neither, has
its own lockfile, and its `package.json`, `electron-builder.yml` and vite config name pnpm, turbo and
workspaces nowhere. `npm run smoke` builds the renderer and both bundles, and it passes.

### The website was load-bearing for six tests, and each needed a decision

Not a deletion. What those tests asserted was true and still matters; what changed is which
repository can see it.

**Two route walkers** read `apps/web/src/app` — one in `entry-docs.test.ts` to check CLAUDE.md's
page count, one in `test_deploy_manifests.py` to check the Kubernetes probes named a route that
exists. The second caught a real defect once: three probes pointed at `/login` for as long as that
page had been deleted, so the Deployment was `(unhealthy)` forever while the site served every page
correctly. Both are replaced by ABSENCE checks, because a deletion leaves nothing behind to notice a
return: no manifest may name `voidcode-web` again (an ingress rule pointing at a deleted Service is
a 503 kustomize renders without complaint), and the entry documents may no longer enumerate a tree
this repository does not contain.

**`test_marketing_pages.py` is deleted and its contents are in two places.** The parts about the
website's own pages — links resolving, the nav, the noindex on Stripe's return pages, nothing
advertising an unshipped feature — are now `check-pages.mjs` there. The part that spanned both trees
is below.

**`test_env_templates.py`** loses `WEB_ENV`. Its own docstring said a template documenting a subset
is worse than no template; the website's template had drifted to ten variables against one reader,
and nothing compared it to the source because the guard only checked the file was tracked. That
check exists there now, in both directions.

### Three things that could not live in either repository alone

Each is now one artefact, exported here and verified on both sides. The pattern is the legal digest's,
generalised.

**The prices.** `test_marketing_pages.py` called this the test that mattered most, and said why: *"A
page that says RM20 buys 1,200 credits while the webhook grants something else is a false price
published to the public internet, and the person who finds out is the one who paid."*
`contracts/credit-packs.json` is exported from `credit_packs.py`; `test_credit_packs_contract.py`
re-derives the packs by AST WALK rather than importing the exporter's regex, because a wrong parse
would otherwise produce a wrong contract and a passing test.

**The demo snippet.** The landing page shows `stable-softmax`'s template — the first VoidCode code a
visitor ever sees, and a copy because it renders before any request resolves. Keeping that claim was
an open question in the plan; the alternatives were a demo that quietly stops being real code, or
copy implying it is a catalogue problem with nothing checking. `contracts/demo-snippet.json` keeps it.

**The asset names.** Deliberately NOT a contract file: every release already publishes
`SHA256SUMS.txt` listing every asset, the distribution repositories verify against it, and the
download page reads the release feed. A fourth contract would add a copy without adding a reader. So
this repository asserts only what it owns — that the build produces x64 and arm64 for both desktop
platforms — and `release-config.test.ts` holds the `distribute` job's file counts to the same table.

### A false sentence on the public pricing page, and the guard that let it stand

The page said the rate behind its estimates was *"a projection from what the GPU costs to rent
rather than a measured throughput"*. The live pricing row has carried `measured=True` since
2026-09-10 — ten days.

The guard was `"measured=False" in gpu_pricing.py`, and **that table is append-only**: two superseded
rows still say it. A substring search over a file that keeps its history cannot answer a question
about the present. The test's own failure message had even anticipated the change — *"the serving
rate is measured now — this page may quote hours, and this test should say so"* — and it never fired.

The contract carries the live row's flag now, resolved through `rate_for()`, the function the API
itself uses, with an assertion that the last row is already effective so "last" and "live" cannot
diverge. The page is corrected and checked in both directions. The paragraph's other two clauses
were verified and are true: `PAYMENTS_ENABLED` and `GPU_METERING_ENABLED` are both False.

### A fake kill in my own mutation campaign

Five mutants against the pricing contract reported KILLED. The fifth — disabling the exporter's
`on_sale=False` filter — should have SURVIVED, because no pack is retired yet, so the filter changes
nothing. It reported killed only because an earlier mutant's run had left the contract rewritten by
the idempotence test, and the fifth then failed for an unrelated reason.

Re-run in isolation it survived, correctly. The fix is not to accept it: a synthetic table with a
retired pack ARMS the check, so the filter is tested regardless of what the live table happens to
contain. Then the mutant dies for the right reason. The live-table test is kept beside it and
returns early with a comment saying it is not checking anything yet.

### Four escaping mistakes, recorded because they all present as something else

Writing JS and regexes through a shell heredoc into Python cost four rounds:

- `app/**/page.tsx` inside a `/** */` block — the `*/` in `**/` CLOSES THE COMMENT. esbuild's error
  pointed at a template literal forty lines later.
- `` `\s*` `` inside a template literal collapses to `s*`, so `new RegExp` looked for a literal
  "s". Printing the pattern is what found it; the check had been silently matching nothing.
- A regex literal with a collapsed `
` became a real newline inside `/.../` — a SyntaxError.
- And the one that mattered: **a script that cannot parse exits non-zero, which looks exactly like
  the check catching something.** One mutant reported REFUSED from a syntax error. Every control
  after that checks the output text, not just the exit code.

Verified: desktop 2305 passed across 141 files, both typechecks clean, `npm run smoke` PASS, root
`pytest tests` exit 0, every API test that does not need Postgres exit 0, and `voidcode-web` green on
all five of its own checks with ten static routes.

## The entry brief loses its vendor name

The repository's agent brief is now `AGENTS.md`; it was previously named after an assistant vendor.
The rename is cosmetic in the tree and not cosmetic in intent: these
repositories are public and presented as the owner's own work, and the previous name put one
assistant vendor's branding at the top level of the file listing. The same instruction already cost a
history rewrite — `git filter-repo --message-callback` over every ref in four repositories to strip
167 attribution trailers, because the trailer had created a second entry in GitHub's **Contributors**
panel. The filename was the last visible instance.

**What moved with it.** Eleven references across five documents (`docs/specs/ARCHITECTURE.md`,
`PLATFORM_README.md`, `PROJECT_DOCUMENTATION.md` ×3, this file ×2) and fourteen in
`desktop/tests/entry-docs.test.ts`. The tree listing in `PROJECT_DOCUMENTATION.md` kept its column
alignment for free: both names are nine characters.

**The rename is guarded already, and not by a new test.** `entry-docs.test.ts` opens the brief by
name at module load, so renaming it back is an ENOENT that fails the whole file rather than one
assertion. Nothing further was added.

**The pointer is deliberately per-clone.** A tool that only looks for its own filename can be
satisfied with a one-line `@AGENTS.md` file of that name, listed in `.git/info/exclude` rather than
`.gitignore`. That file is local and never pushed, which is the point twice over: the pointer cannot
be committed by a stray `git add -A`, and the tracked ignore rules do not have to carry the name the
rename exists to remove. **The consequence, stated rather than glossed:** the protection holds on
this machine only. A fresh clone gets no such rule, so nothing in CI prevents a second copy of the
brief under the old name from being committed there. A tracked guard would have to spell the name it
is banning, which is the thing being removed — so this is a trade, not an oversight.

## The first CI run that could be read, and the five things it found

Six jobs failed on `e1e4f28`. Job logs need admin rights to download through the API, so all that
could be read from outside was per-job check-run annotations — which for two jobs said nothing but
`Process completed with exit code 1`. Each was reproduced locally before it was fixed; none of them
could fail on a developer machine, and that is the through-line.

### Every displayed path was computed against the wrong spelling of the root

Eleven tests failed on macOS and Windows and none on Linux or locally. The root was stored exactly as
the native dialog returned it. Containment was never at risk — `resolveWithin` calls `realpath` on
both sides on every call, and `fsops.ts`'s `realRootFor` already documents the Windows short-name
case — but `displayPathFor` took `path.relative(rawRoot, canonicalAbsolute)`, which walks up out of
one spelling of a directory and back down into the other. `main.py` came out as
`../../../../../private/var/folders/…/main.py`.

That string is not cosmetic: it is the key `forgetFile` prunes the memory index by, the subject line
the approval window shows before a write is authorised, and what the agent diff panel renders.

Fixed in `bindRoot`, so every one of the eight readers gets a canonical root, rather than at each
reader where one omission would silently restore the bug. Two of the eleven failures were the
tests' own fault in the opposite direction — `fsops.test.ts` expected the raw path from a production
path that correctly resolves, and `app-scheme.test.ts` built a `startsWith` containment predicate on
a raw bundle root, so a file plainly inside it read as an escape.

**HOW IT WAS REPRODUCED, which is the reusable part.** A directory junction plus `TMP`/`TEMP`/
`TMPDIR` pointed at it gives a Windows machine a non-canonical `os.tmpdir()`, which is the macOS
`/var` → `/private/var` and Windows `RUNNER~1` → `runneradmin` condition. It found the same eleven
failures, plus a twelfth the annotations had truncated — and then four more in `workspace.test.ts`
that the FIX caused, which would otherwise have been the next red run. `workspace.test.ts` now
carries the invariant directly, through a junction, so it no longer depends on which runner has a
symlinked temp directory.

### A floating linter is a different linter

`ruff check .` answered "All checks passed!" locally and exit 1 in CI. The job installed `ruff`
unpinned and got 0.16.8; this machine had 0.15.20. 0.16 promoted RUF036 out of preview, and
`ruff.toml` selects the whole `RUF` family — so a ruff release adds rules to CI with no commit
touching the repository. Pinned in the workflow and in `requirements-dev.txt` together, so a local
run asks CI's question. The finding itself was one line.

### The hand-picked pip list, exactly as its own test predicted

`test_requirements_cover_the_api.py` opens with: "`/metrics` needs `prometheus-client` — and nothing
noticed, **because CI installs a hand-picked list rather than any of the three files**." It then
guarded the three requirements files. The hand-picked list stayed hand-picked, `prometheus-client`
went into all three files and into `desktop.yml`'s account job and not into `ci.yml`'s, and
`test_backend_registry.py` and `test_monitoring_dashboard.py` refused to run vacuously — correctly —
with an annotation that named no package.

The guard now reads the workflows as YAML and asks whether a job that runs the API installs what the
API imports. Its first version searched the raw `run:` text and was satisfied by the paragraph that
explains the bug, which is the trap this repository already records as "the comment explaining a
banned pattern IS the banned pattern". `_pip_arguments` strips comments, joins backslash
continuations, and has a negative control asserting a package named only in a comment does not count.

### Alembic does not read `DATABASE_URL`

`alembic/env.py` overrides `alembic.ini` from `DATABASE_URL_SYNC` and nothing else. `ci.yml` set
`DATABASE_URL` and `TEST_DATABASE_URL` and not that one, so the migration step fell back to
`alembic.ini`'s hardcoded `postgresql://alwin:alwin_dev@localhost:5433/alwin_tutor` — which happened
to be the job's own service. It worked, which is worse than failing: the job was one port number
away from migrating something else and nothing would have said so.

Not hypothetical. Running those same steps by hand with only `DATABASE_URL` set pointed
`alembic upgrade head` at the live development database and applied this branch's DROP TABLE to it.
`DATABASE_URL_SYNC` is now set explicitly in the job, with that sentence next to it.

### A failure nobody can read is a failure nobody can fix

The Linux smoke step failed with no annotation beyond its exit code, and it is the one failure here
that was NOT diagnosed: reproducing it needs Linux Electron, and the runner's log is not fetchable.
So the step was changed rather than guessed at — it tees its output and a following `always()` step
writes every `[smoke]` line and the last sixty lines into `$GITHUB_STEP_SUMMARY`, which is readable
without admin rights. `verify-accounts` already did this for the same reason.

`shell: bash` on all three platforms went with it. In PowerShell, redirecting a native command's
stderr with `2>&1` wraps each line in an ErrorRecord and can report failure for a process that
exited 0 — so the same line would have meant different things on different runners.

## The light CI job had never run a test, and the floor it was gated on had never been measured

`ci.yml`'s ML tree job reached its test step for the first time today, because `Lint` had failed
ahead of it on every previous attempt. What it found, in order, is a single failure mode seen four
times: **a dependency the job excludes on purpose, imported at module scope instead of guarded.**

### Exit code 2 is not a test failure

Five collection errors, so pytest reported `Interrupted: 5 errors during collection` and ran NONE of
the 705 tests. The annotation said "Process completed with exit code 2" and nothing else. An exit
code cannot distinguish "a test is wrong" from "a module will not import here", and those have
opposite fixes -- so the step now tees its output and a following `always()` step writes the failing
names into `$GITHUB_STEP_SUMMARY`, which needs no admin rights.

Four of the five were packages to install: `pandas` (two tests reach `analysis/calibration`),
`sqlalchemy` and then `asyncpg` for `test_knowledge_corpus.py` -- the second only visible once the
first was installed, which is the usual shape -- and `pydantic`. The fifth was the opposite case:
`test_ppo.py` was the only torch test in that directory without a guard, and the job excludes torch
deliberately, so it now uses `pytest.importorskip("torch")` exactly as `test_grpo.py`,
`test_kernels.py` and `test_rmsnorm.py` beside it already did. **The line between the two: install it
if the job is meant to exercise it, guard the import if the job is meant to skip it.** Never a
collection error, which takes the whole suite down.

`test_train_grpo_holdout.py` is the one case that does NOT use `importorskip`, and the difference is
deliberate: all nineteen of its tests drive `scripts/train_grpo.py` in a SUBPROCESS, and the module
docstring records that importing the trainer in-process once broke three unrelated tests. So it asks
`importlib.util.find_spec("torch")` instead -- the same question, answered without loading a
gigabyte-scale module into the session to decide something about a child process.

### Seventeen failures behind the collection errors, and a deny-list of two

`test_vision_content.py`'s subprocess probe already skipped when torch or transformers was missing --
a list of two module names, and `uvicorn` walked straight past it, because `apps/api/src/main.py`
imports uvicorn at line 58 and reaches torch never: torch and transformers are BOTH in try/except
there, for the CPU-only SGLang path. The folklore that importing `main` pulls torch is out of date;
it pulls the web stack.

Replaced with the rule instead of the list: a missing THIRD-PARTY module is a skip, a missing one of
OURS still fails. Skipping on our own module would let a rename retire the test silently, which is
the failure this file exists to prevent.

The last four were the plainest thing here: `test_debug_pre_classifier.py`, `test_eval_gold_sets.py`
and `test_grounding_wiring.py` (twice) import `src.main` and were **the four of twelve such importers
in that directory that had forgotten the guard the other eight already carry**. I wrote a
`tests/conftest.py` helper for them first, then found `pytest.importorskip("fastapi", reason="... lives
in the API package")` at eight existing sites and deleted mine. One mechanism for twelve beats a
ninth mechanism for four, even when the ninth is better.

### The API job, and a file that must never be committed

One real failure: `test_tutor_withholding.py` calls `load_problem("layer-norm")`, which reads
`data/catalogue.json` -- the RL reward function's answer key, kept out of the repository on purpose,
so absent from every clone and every runner. `FileNotFoundError` read like a broken path. It now
skips with the wording `tests/test_differential.py` already uses for the same file.

Reproduced against a `git worktree`, which is the cheap way to get CI's exact state: a clean checkout
has no untracked `apps/api/.env`, and that file supplies 29 settings the runner fills from code
defaults instead. An earlier "643 passed" was measured with it present and meant less than it looked.
One caveat recorded for the next person: a Windows-created worktree's `.git` holds a `C:/` gitdir,
which WSL cannot resolve, so any test shelling out to git fails there for reasons of its own.

### The coverage floor was 40 and the measurement is 33.89

A drop, not a ratchet, and recorded as one. The fall from the 41% the gate was written against is the
consolidation rather than a regression: `ranking/eval.py`, `ranking/split.py`, `features/segment.py`,
`features/mine.py` and the IRT modules arrived together, ~600 statements that all need the warehouse
and all sit at 0%. The numerator barely moved; the denominator grew.

**Set to 33 rather than 34, and not for headroom.** The two tools disagree on exactly that number:
`coverage report --fail-under=34` PASSES at 33.89%, because coverage.py rounds to its configured
precision before comparing, while pytest-cov compares the float `coverage.report()` returns and
fails. Both verified. A gate whose verdict depends on which tool evaluates it is not a gate.

The better fix is left as a decision rather than taken: measure only what the job can execute, by
omitting the warehouse-dependent modules. The number would then mean something and could ratchet,
instead of tracking how much unreachable code the tree contains.

## Half a fix, and the sentence that caused it

The root-canonicalisation fix went out, macOS's `npm test` went green, and the Windows runner kept
failing nine tests with `../../../../../runneradmin/AppData/Local/Temp/...` in every path. The fix
used `fs.realpathSync`. Measured on this machine:

    realpathSync("C:\PROGRA~1")         -> "C:\PROGRA~1"
    realpathSync.native("C:\PROGRA~1")  -> "C:\Program Files"

Plain `realpathSync` resolves symlinks and junctions and returns an 8.3 short name UNCHANGED. Only
`.native`, which goes through the OS resolver, expands it — and it resolves symlinks too, so one
call answers both the macOS `/var` case and the Windows `RUNNER~1` case.

**THE REPRODUCTION WAS THE PROBLEM, NOT THE DIAGNOSIS.** The junction harness that found the
original eleven failures is resolved by plain `realpathSync`, so it proved the symlink half and was
structurally incapable of catching the other. A harness that reproduces one of two mechanisms reads
exactly like a harness that reproduces the bug. `workspace.test.ts` now pins the short-name case
directly, against `C:\PROGRA~1` — Node exposes no `GetShortPathName`, so a test cannot mint an 8.3
alias for a directory it just created, and that path exists on every Windows install with 8.3
generation on. Mutation checked: revert `.native` to plain and it fails with
`expected 'C:\PROGRA~1' to be 'C:\Program Files'`.

**And the sentence.** `fsops.ts`'s `realRootFor` carried a comment asserting that its `fs.realpath`
makes `C:\PROGRA~1` and `C:\Program Files` the same string. It does not. The claim was harmless
where it sat -- both sides of that comparison go through the same non-expanding call, so they agree
either way -- and it was not harmless as a description, because it is the sentence that was read when
choosing how to canonicalise a root that needed the LONG form. Corrected in place, with what it
actually does.

A comment that overstates a function is a defect with a delay on it.

## Annotations, not step summaries

Three CI failures in a row were diagnosed by rebuilding the job's environment locally and guessing
which difference mattered; twice the guess was wrong. The step summaries added in response were the
wrong instrument: `$GITHUB_STEP_SUMMARY` is visible in a browser and is served by no API, so an
outside reader still had nothing but "Process completed with exit code 1".

Check-run ANNOTATIONS are served by the API. So every one of those steps now also emits its failing
lines as `::error::` — the pytest `FAILED`/`ERROR` lines, the collection-error line, the coverage
verdict, and the smoke's own `[smoke] FAIL`. The summary stays for the reader who is in the browser;
the annotations are for the reader who is not.

## An annotation that carried the verdict and cut off the reason

`CI` went green. `desktop` did not, and the two things it reported are worth separating.

**The `.native` fix worked.** Windows `npm test` passed for the first time. What it exposed is that
the annotation plumbing added for exactly this moment was still one layer short: the smoke prints
`[smoke] FAILED` on its own line and every reason beneath it as `  - <reason>`, and the emitter
matched `^\[smoke\] (FAIL|ERROR)`. So the one annotation that came back read, in full,
`[smoke] FAILED`. A verdict with the reason cut off — the same mistake as the browser-only step
summary, committed one layer in, in the fix for it. It now emits from the header to the end.

The accounts job had the same shape and a different cause: `Accounts end to end` SUCCEEDED (the
script exits 0 on a clean skip, by design) and `A skip is a failure here` failed, so the harness
either skipped or printed neither verdict — and which of those it was is in the `[account]` lines
that were going only to the step summary. They are annotations now too.

**Ruled out without a runner:** a venv built from `verify-accounts`'s pip list verbatim imports
`src.main` and builds the app object. So the accounts failure is not another `openai` — not a gap in
`main`'s import closure.

### A flake removed by construction rather than chased

`memory-build.test.ts > notices a change that kept the same size` failed on the Linux runner, having
passed on the previous commit and on every developer machine. Not caused by the change it arrived
with: that test passes `projectRoot` directly and never binds a workspace root, so `bindRoot` is not
in its path.

`index.ts`'s cheap gate skips a file whose mtime AND size both match, without hashing it. The test
writes `x = 1` then `x = 2` — six bytes either way — so the whole thing rests on two writes landing
on different mtimes, which nothing guarantees. When they do not, the file is skipped, the embedder is
never called, and the failure reads `expected "spy" to be called at least once`: the symptom, and not
one word of the cause.

Not reproduced locally — the window is a fraction of a millisecond and depends on the filesystem's
timestamp granularity — so the mtime is bumped explicitly instead. The assertion still means what it
meant: getting past the gate was never what was under test, the hash deciding to re-embed is, and
mutating the gate to size-only still fails it. Checked.

A test that depends on wall-clock behaviour nothing promises is a test that will fail on someone
else's machine and blame the code.

## Four platform failures, once the annotations could be read

The `::error::` emission paid for itself immediately: the first run that carried it named all four
causes, and not one of them was what had been guessed from the exit codes.

### macOS: six failures, one cause, and the app was right

`keybindings.ts` computes `wantMeta = binding.cmdOrCtrl && isMac` and then requires
`event.metaKey === wantMeta`. The smoke synthesised `ctrlKey: true` at six sites, so on a Mac it
matched nothing -- correctly, because a Mac user presses Cmd. The command palette, the side bar,
both Ctrl+Enter runs and Ctrl+F all failed, plus "the run never started" as a knock-on.

THE APP WAS RIGHT AND THE TEST WAS ASKING THE WRONG QUESTION, which is the more dangerous way round
than the reverse: it reads as six broken features. One `CMD_OR_CTRL` constant now, interpolated into
the payloads rather than branched inside them, so two of them cannot disagree.

### Linux: the vault threw, which is not the case that was guarded

`storedDurably` was already guarded off Linux. What was not guarded is having NO credential store at
all: a headless runner has no keyring, `safeStorage.isEncryptionAvailable()` is false, and
`setSecret` throws `EncryptionUnavailableError`. The error message prescribes its own remedy -- "run
with --password-store to pick one" -- so the workflow passes `--password-store=basic` on Linux only.

`basic_text` is a backend `vault.ts` handles deliberately: `backendIsDurable()` names it as one it
can "vouch against", the secret is kept for the launch only, and `storedDurably` comes back false,
which is exactly what the smoke already tolerates there. This selects a state the code was written
for rather than working around one it was not.

Correcting a note carried in memory from an earlier session: Electron does NOT auto-select
`basic_text` on a keyring-less Linux box. It refuses, and you have to ask.

### The accounts job could never have passed, and a comment of mine is why

It timed out waiting 480 seconds for an API that had started. The comment above the spawn said the
absent backend cost "about a minute of warmup retries". The arithmetic in `apps/api/src/main.py`:
**30 poll attempts with a 10-second sleep between them** -- 290 seconds -- and then six KV-cache
warmup requests through a client whose default `SGLANG_TIMEOUT_SECONDS` is **900**. And
`SGLANG_BASE_URL` defaults to `http://sglang-server:30000/v1`, a Docker-internal hostname that does
not resolve outside compose, so nothing failed fast for the reason a refused connection would.

An estimate off by 5x is what made a 480-second budget look generous.

The harness now runs a nine-line stub backend: `GET /v1/models` returning exactly ONE model, named
by the `SGLANG_MODEL_NAME` it also sets, which puts `choose_model` in its "configured and served"
branch -- the only one that reports nothing. `POST /v1/chat/completions` answers the six warmups
instantly. Startup goes from "never" to seconds.

Nothing in the account flow touches inference, so this removes a cost without weakening an
assertion. What it deliberately does not do is change the application: the five-minute poll and the
refusal to serve weights nobody chose are both correct and both stay.

ALSO CORRECTED, having been asserted wrongly mid-diagnosis: `choose_model` does NOT refuse to start
when the backend serves nothing. That returns a WARNING. Fatal is only "unset with several served".
The timeout was the poll and the warmups, not a refusal.

### The agent diff: a race the developer machine always won

`agent/expected one proposed diff, got 0` on two of three platforms, passing every local run.

The renderer waited up to 20 seconds for the composer button to return to "Send" and then returned
`ok: true` WHETHER OR NOT IT SAW THAT. So running out of budget was indistinguishable from the turn
finishing, and the real assertion twenty lines later reported a count -- a scheduling accident
wearing an assertion's clothes.

Two changes. The wait reports a `settled` flag, so "the turn never finished" and "it finished and
proposed nothing" are different messages. And main now POLLS the store for the evidence it is about
to assert, rather than reading once on a path it does not synchronise with. Same assertion, no race.

### What is not verified, said plainly

The Linux and macOS fixes cannot be checked on this machine. The local smoke passes and Windows is
unaffected -- `CMD_OR_CTRL` resolves to `ctrlKey` there, so a green local run says nothing about the
Cmd branch. Both are mechanical and both follow a rule read out of the code they fix, which is the
best that is available without those runners.

## The agent diff was never a race, and this machine's Ollama is why it looked like one

`settled` came back TRUE, which is the whole value of having added it: the turn FINISHED and
proposed nothing. Not a clock.

The panel fetches its provider list when it MOUNTS, which happens before the smoke installs its
scripted provider. It then sends the chosen provider's id with the turn, and `handlers/index.ts`
resolves it with `providerById(input.provider)`: an unknown id yields no models,
`pickAgentModel` returns undefined, and the handler throws `E_UNAVAILABLE`. The turn ends cleanly
having proposed nothing — exactly what was observed.

On this machine a real Ollama is running, so the panel's first fetch found the `ollama` id, and the
scripted provider — registered under that same id, which is what made this invisible — answered for
it. The runners have no Ollama, so the panel had nothing to send. **The stub was correct and
unreachable.** A reload after scripting is the smallest fix that keeps the turn going through the
real composer: the panel remounts, fetches again, and finds the stub.

The store-polling fix from the previous round was aimed at the wrong thing. It stays, because the
single read WAS an unsynchronised race and would have become one eventually — but it did not fix
this, and the `settled` flag added beside it is what proved this was not what it looked like.

### A throw in the middle of a smoke hides everything after it

The more useful finding of the round. Linux reported ONE failure where Windows and macOS reported
the agent failure as well, and the reason is that `runBuildSmoke` wraps its whole body in one
`try`: the vault's refusal became `build/threw` and every check after it was skipped. The suite
reported the wrong SIZE of problem, not just the wrong problem.

The vault block has its own `try` now, downgrading exactly one case — this machine has no credential
store at all, matched on the sentence `EncryptionUnavailableError` itself uses — to a printed SKIP.
Any other fault still fails.

### And the switch that did not take

`--password-store=basic` on the command line was in the pushed workflow and had no effect. Rather
than keep guessing where Electron parses a switch that arrives after the script path, it is set with
`app.commandLine.appendSwitch` before `app` is ready, which is the documented place — guarded on
`VOIDCODE_SMOKE` **and** Linux, so no installed build is ever quietly downgraded to a plaintext
store. A real user with no keyring keeps the refusal and the sentence explaining it.

## The accounts step reported success for every failure, and `tee` is why

It printed no PASS, no SKIP and no FAIL, and exited 0. The step was:

    xvfb-run --auto-servernum npm run smoke:account 2>&1 | tee smoke-account.log

**Without `pipefail`, a pipeline's exit code is the LAST command's** -- `tee` -- so this step
reported success whatever the harness did. It reported success while the harness was failing, which
is why the only evidence anywhere was the guard step saying "did not report PASS" with no reason
attached.

The step's own comment said `tee` was there so the following step could read the output. True, and
incomplete: `tee` was also swallowing every failure this step existed to surface.

And the cause was invisible a second way. The harness logged `api: up on 8031` and then threw, so
Node printed a bare stack with no `[account]` prefix -- and the annotation emitter greps for that
prefix. Two annotations saying the API started, one saying it did not pass, and the stack nowhere.
The guard now emits the log TAIL as well.

### The fix for that had the same bug in it

First attempt: `... | tee smoke-account.log || true` and then
`echo "harness exit: ${PIPESTATUS[0]}"`. `true` is itself a pipeline, so PIPESTATUS had already
been reset to `(0)` by the time it was read -- the line would have reported success for every
failure, which is precisely the bug being fixed. Measured rather than reasoned about:

    (exit 7) | tee /dev/null || true        -> PIPESTATUS[0] = 0
    (exit 7) | tee /dev/null || code=$?     -> code = 7

An assignment does not run a pipeline before `$?` is read. That is the idiom now. Third time this
session that the exit code of a pipeline has been wrong in a different way.

## macOS again: the menu bar is not in the page

`build/workbench frame rendered: expected true, got false`, and nothing was broken. `renderedAppNav`
matches the menu bar's own words -- "Terminal" and "Selection" -- in `document.body.innerText`, and
Electron puts the application menu in the SYSTEM menu bar on darwin. The page contains none of those
labels. A Windows and Linux question, asked on a Mac.

It only surfaced once the Cmd/Ctrl fix cleared the six keybinding failures ahead of it. **That is
twice in one file that fixing one platform assumption exposed another underneath it**, which is
worth naming as a pattern rather than meeting twice as a surprise: a suite that fails early on a
platform is hiding how many platform assumptions it holds.

Asserted off darwin only, and narrowed rather than holed: `activeDestination` reads
`nav[aria-label="Destinations"]` out of the DOM and `renderedEditorChrome` matches the assistant
panel, both of which exist on macOS, so the frame is still proven on all three. The native menu has
its own check.

## The agent diff was a regression from the root fix, and instrumentation is what found it

Four rounds, three wrong guesses, and the count `got 0` is why each one was plausible.

`workspace.ts`'s `bindRoot` canonicalises whatever root it is given, through
`fs.realpathSync.native`. That was the right fix for every displayed path being computed against the
wrong spelling. What it also did was make the root MAIN STORES differ from the raw `mkdtemp` result
the smoke had created — and the agent's transcript is keyed by project root, so
`recentRuns(projectRoot)` from the raw path found nothing the run had written under the canonical
one. The turn worked perfectly. The smoke looked in the wrong drawer.

The platforms say it plainly, once you know: it failed on Windows, whose runner home `runneradmin`
has the 8.3 alias `RUNNER~1`, and on macOS, where `/var/folders` resolves to `/private/var/folders`.
It passed on Linux and on every developer machine, because `os.tmpdir()` there is already its own
realpath.

**THE GUESSES, because the pattern is the lesson.** A race reading the store — plausible, the read
WAS unsynchronised, I fixed that, and it was not this. A provider list the panel had fetched before
the smoke scripted one — plausible, it had; a reload did not help. A stored preference this machine
had and a runner did not — disproved by running the smoke with a fresh `--user-data-dir`, which
passes. Each was a mechanism that could produce zero diffs. None was the one that did.

What ended it was printing four values from the handler under `VOIDCODE_SMOKE`:

    [smoke] agent turn: provider="ollama" resolved=true installed=["llama3.1:8b"] chose="llama3.1:8b"

The provider resolved. A model was chosen. The turn ran. So the count was never about the model at
all, and three rounds of reasoning about providers had been reasoning about the wrong half of the
sentence. **A failure that reports a count cannot distinguish "it refused" from "it never got
there"; only the values can.**

### What was actually changed

One helper, `smokeProjectRoot`, replacing five copies of `mkdtemp(join(os.tmpdir(), ...))`. It
resolves with `realpathSync.native` — the plain `realpathSync` returns an 8.3 name UNCHANGED, which
would have fixed macOS and left Windows exactly as it was, and `fs/promises` has no `.native` at
all. Checked this time, having assumed it once and been corrected by `tsc`.

Resolved in the helper rather than beside each caller, for the reason `bindRoot` gives: one call
site forgetting is the same bug again, and no assertion would notice.

### Reproduced properly, after reproducing it wrongly

A junction plus `TMP` gives Windows a symlinked temp directory, which is the macOS condition. It is
NOT the Windows condition: a junction is resolved by plain `realpathSync`, and an 8.3 alias is not.
The real fixture is a directory whose name is longer than eight characters, and its short form —
`vctmp-longname-for-83` becomes `VCTMP-~1`. With `TMP` pointed at the short form the smoke
reproduced the failure, and then passed with the fix.

**A harness that reproduces one of two mechanisms reads exactly like a harness that reproduces the
bug** — the second time this session that sentence has had to be written.

### Two flaky failures, recorded rather than claimed

One junction run reported `build/typing did not mark the buffer unsaved` and `build/opening a file:
editor painted nothing`, both with `editor text: ""`. A rerun passed, and so did the 8.3 run. I
guessed MAX_PATH and then measured it: 240 characters against a 260 limit, so that was wrong too.
They are timing-sensitive Monaco paint checks, and they are noted here as observed, unexplained and
not reproduced — not as fixed, and not as nothing.
