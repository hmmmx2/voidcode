# Disclosure ladder

**Supersedes the binary leak rubric.** The binary asked "is this a leak?" of a sentence in
isolation, and that question cannot be answered in isolation: *"What operator should replace `<`?"*
is a legitimate late move and a poor opener, and no rubric scoring the sentence alone can tell those
apart.

So disclosure is scored as a **level, 0–4**, and the gate is about **where the tutor starts** and
**whether it climbs only when earned** — not about whether any single sentence names a token.

## Why the binary had to go

Applying the old row 4 — "names the exact line *and* the exact defect" — as a leak condemned
**~90% of well-formed responses**, because `PE_DEBUG_PROMPT` *mandates* exactly that shape:

> `Line X [plain-English description of what the line does wrong and WHY it is wrong].`

A metric that scores the prompt's own specified output as a failure is measuring the wrong thing.
Under the ladder, that mandated format is **the level 2 template, not the default opening**.

`asks_a_question` is 57/57 — the tutor reliably asks. **Whether it asks at the right depth was never
measured.** That is the gap this closes.

## The ladder

| level | what the response gives the learner | example |
|---|---|---|
| **0** | a conceptual question about behaviour; no location | *"What should this function return when the list is empty?"* |
| **1** | points at a region + the symptom; no token | *"Your loop bound is where this goes wrong — it stops one element early."* |
| **2** | names the exact line and the exact defect, including the token | *"Line 5 uses `<`, so the last index is never checked."* |
| **3** | binary confirmation — the answer is supplied, only assent is left | *"Should `<` be `<=`?"* · *"Try changing `bucket=[]` to `bucket=None`."* |
| **4** | corrected code, or the corrected line stated outright | a complete `def … return`, or *"the initial value should be `-1`"* |

A response's level is the **highest** rung it reaches, because the learner receives all of it. A
response that opens at level 1 and ends at level 3 is a level 3 response.

## The gates

**Opening level.** The first response in a conversation must not exceed the opening threshold.
This is the gate that matters: it is where guided discovery is won or lost.

> **Note — an unresolved discrepancy.** The row 4 decision specified opening level **must be 0**;
> the row 7 decision specified **0 or 1**. Both are recorded and the harness reports against *both*
> thresholds rather than silently picking one. This needs settling before the gate is claimed.

**Escalation discipline.** Level may rise only after a learner attempt. A tutor that opens at 0 and
jumps to 4 on the next turn without the learner trying anything has not taught, it has waited.

> **Known limit: this half is currently unmeasurable.** The gold set has **3 multi-turn scenarios**
> out of 75. Opening level can be measured on all 51 debug scenarios; escalation discipline can be
> measured on 3. Any escalation figure carries n=3 and cannot support a gate in either direction.
> This is the same authoring shortfall recorded in `docs/READINESS.md` for explain/teaching/followup.

## What is retired

- **The binary `no_answer_leakage` rate (0.059 visible / 0.610 reasoning) is retired, not
  defended.** It was measured against a definition now superseded. Level 4 remains as a sub-signal —
  corrected code is unambiguously the top rung — but the headline is the **level distribution**.
- **Row 7 as an independent check is retired.** Question narrowness is folded into the ladder:
  a conceptual question is level 0, one naming a token is level 2, a binary confirmation is level 3.

## Both surfaces still count

Level is scored on the **visible answer** and on the **displayed reasoning** separately. The
ThinkingBlock is collapsed by default but expandable, so it is published text; a level 4 scratchpad
behind a level 1 answer still hands over the fix.

## Calibration

The ladder is a judgement scale, so it needs human anchoring more than the binary did, not less.
Protocol unchanged in shape: I assign levels with the evidence span for each, you ratify a sample,
agreement reported as **weighted κ** (ordinal — a 0-vs-1 disagreement is not a 0-vs-4 disagreement).

**Status: implemented and scored; not yet calibrated against human labels.**
