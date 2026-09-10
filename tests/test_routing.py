"""The mode router, measured for the first time. Spec V6.

WHY THIS FILE DID NOT EXIST, AND WHY THAT MATTERED
-----------------------------------------------------
Every mode has a gold set exercising its PROMPT. Nothing exercised the ROUTER that decides which
prompt is used. Routing is upstream of all of it: if `decide_mode` returns the wrong mode, the right
prompt is never sent, and every per-mode figure in `docs/METRICS.md` measures a system the learner
never interacted with. A routing regression was invisible to the whole suite.

It was untested because it was six lines inside a 700-line request handler. `main.decide_mode` is
now a pure function, extracted with behaviour proven identical over 318 (message, turn-count) pairs.

HOW THE ACCURACY NUMBERS HERE SHOULD BE READ
-----------------------------------------------
The gold sets were authored to exercise each mode's prompt, NOT as router training labels. Using
them as routing ground truth is defensible — they are messages that should reach that mode — but
they were not written for it, and some carry deliberately terse phrasing. So the headline rate is a
FLOOR that catches regressions, not a claim about production traffic.

The three defects recorded below do not depend on that caveat. Two are pure logic and one is a
mechanism, and each is pinned by its own test.
"""
from __future__ import annotations

import collections
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts", ROOT / "llm" / "scripts", ROOT / "apps" / "api"):
    sys.path.insert(0, str(p))

pytest.importorskip("fastapi", reason="the router lives in the API package")

import run_evals  # noqa: E402
from prompts import detect_frustration, detect_mode  # noqa: E402
from src.main import _extract_user_intent, _has_code_context, decide_mode  # noqa: E402


def enriched(scenario: dict) -> tuple[str, bool]:
    """The shape the frontend actually sends: words under [USER REQUEST], context blocks after."""
    words = scenario["user_message"]
    src = scenario.get("source_code")
    if src and "```" in words:
        words = words.split("```")[0].strip()
    if not src:
        return words, False
    return f"[USER REQUEST]\n{words}\n\n[SOURCE CODE (python)]\n```python\n{src}\n```", True


# ── the three defects, each independent of the labelling caveat ───────────────

def test_empathy_now_fires_on_a_first_message():
    """A learner whose OPENING line is distress reaches empathy, with a prompt that fits.

    This inverts the old `test_empathy_can_never_fire_on_a_first_message`, which pinned the
    `n_user_messages > 1` gate as a deliberate trade-off. The gate was not arbitrary — it existed
    because `EMPATHY_SYSTEM_PROMPT` Step 3 tells the model to look back at the previous assistant
    message, and on turn one there is none. `EMPATHY_FIRST_TURN_PROMPT` removes the dependency, so
    the gate stopped paying for anything.
    """
    from prompts import get_system_prompt

    cry = "I give up. I'm terrible at this, I don't understand any of this."
    assert detect_frustration(cry)
    assert decide_mode(cry, 1)[0] == "empathy", "the opening cry for help must reach empathy"
    assert decide_mode(cry, 5)[0] == "empathy"
    first = get_system_prompt("empathy", pe_mode=False, first_turn=True)
    later = get_system_prompt("empathy", pe_mode=False, first_turn=False)
    assert "previous assistant message" not in first, (
        "the first-turn prompt tells the model to reference a message that does not exist")
    assert "previous assistant message" in later, "the multi-turn prompt is unchanged"


def test_the_first_turn_prompt_keeps_every_other_empathy_rule():
    """Derived from EMPATHY_SYSTEM_PROMPT rather than duplicated: only Step 3 differs.

    If it were a copy, an edit to the warmth or to "NEVER give the complete solution" would apply
    to one prompt and silently miss the other — and the eval's empathy checks score exactly those
    rules.
    """
    from prompts import get_system_prompt

    first = get_system_prompt("empathy", first_turn=True)
    for rule in ("NEVER give the complete solution",
                 "NEVER agree with self-deprecating",
                 "Step 1 — Acknowledge their feelings",
                 "Step 5 — Close with genuine encouragement"):
        assert rule in first, rule


def test_detect_frustration_catches_plainly_distressed_phrasings():
    """The three phrasings that used to be missed, and the reason the detector was restructured.

    Each was a near-match beaten by literal substring comparison: the old list held "im dumb" but
    not "I feel so dumb", "i'll never" but not "I don't think I'm ever going to get this", "i quit"
    but not "should I just quit?". Recall on the empathy gold set moved 3/9 -> 9/9.
    """
    for phrase in ("I've been stuck on this for an hour and I feel so dumb.",
                   "I don't think I'm ever going to get this. Everyone else seems to find it obvious.",
                   "Genuinely, should I just quit?"):
        assert detect_frustration(phrase), phrase


def test_a_phone_typed_apostrophe_still_reaches_empathy():
    """iOS and macOS autocorrect ' into U+2019, and every `i'm ...` signal was written in ASCII.

    Five of six common phrasings were invisible to a student typing on a phone — "i'm stuck",
    "i can't do this", "i don't understand" among them.
    """
    for ascii_form in ("i'm stuck", "i can't do this", "i'll never get this",
                       "i'm terrible at this"):
        # The suppression below is deliberate: U+2019 is the input under test, not a mistyped
        # quote. Keep the explanation clear of the literal directive token — a comment that starts
        # with it is itself parsed as a blanket directive and then reported as invalid.
        curly = ascii_form.replace("'", "’")  # noqa: RUF001
        assert detect_frustration(ascii_form), ascii_form
        assert detect_frustration(curly), f"lost to a curly apostrophe: {curly!r}"


def test_encouragement_and_code_talk_do_not_trigger_empathy():
    """The cost of raising recall, held to zero. Empathy is the LAST assignment in `decide_mode`,
    so it overrides every other mode, and it disables the LoRA adapter — a false positive costs a
    learner their bug report and answers them from the base model.

    Every phrase here fired under the old substring rule.
    """
    for phrase in ("don't give up!", "you told me not to give up", "I refuse to give up",
                   "we can't do this in O(1)", "the pointer is pointless here",
                   "this loop runs pointlessly twice",
                   "how do I give up ownership of a mutex in Rust?",
                   "this approach is hopeless for large n",
                   "I'm not stupid, I just need a hint",
                   "idk", "not sure",
                   # The student saying they are now FINE. These are the only phrasings that
                   # actually reach the negation guard -- everything else above is stopped by the
                   # first-person requirements or by deleting the bare "give up"/"hopeless"/
                   # "pointless" tokens. Found by mutating the guard away and seeing nothing break.
                   "i'm not so confused anymore",
                   "not completely lost, just the last bit"):
        assert not detect_frustration(phrase), f"false positive: {phrase!r}"


def test_the_code_context_signal_reaches_the_router_without_the_code():
    """The fact a submission happened is passed; the code itself still is not.

    This inverts `test_the_code_context_signal_is_discarded_by_intent_extraction`, which pinned the
    defect. `_extract_user_intent` still strips the block — that is what stops its contents and its
    "error" keywords dragging every message toward debug — but `_has_code_context` reads the ONE
    bit off the raw message first. Measured: debug routing 12/51 -> 20/51, overall 22/75 -> 30/75,
    with no other mode moving.
    """
    words = "The output keeps growing on later calls and I can't see why."
    msg = "\n".join(["[USER REQUEST]", words, "", "[SOURCE CODE (python)]",
                     "```python", "def f(x, acc=[]):", "    return acc", "```"])

    intent = _extract_user_intent(msg)
    assert "```" not in intent and "def f" not in intent, (
        "the CODE must still be withheld from the router — only the fact travels")
    assert _has_code_context(msg), "the fact a submission happened must survive extraction"
    assert not _has_code_context(words), "prose with no code must not claim a code context"

    # The same words, with and without the attachment. This sentence carries no debug keyword, so
    # the point is not that it becomes 'debug' — it is that it stops falling through to the
    # catch-all, which is where messages with code attached were landing.
    assert decide_mode(words, 3)[0] == "general", "without the signal it falls through"
    assert decide_mode(msg, 3)[0] != "general", "with the signal it must not fall through"


def test_a_debug_worded_message_with_code_attached_reaches_debug():
    """The end-to-end case the fix is for: debug wording plus an attachment."""
    body = "\n".join(["[USER REQUEST]", "my function returns the wrong value, what's wrong?", "",
                      "[SOURCE CODE (python)]", "```python", "def f(a):", "    return a + 1", "```"])
    assert decide_mode(body, 3)[0] == "debug"


def test_ml_questions_are_recognised_as_programming_related():
    """The keyword list was entirely classical CS on a platform repositioned to ML.

    45 of 75 intents contained no keyword the router knew, so `is_programming_related` was False
    and four of five `explain` questions fell through to `general` — the catch-all for
    NON-programming topics. The single one that worked matched 'coding' inside 'de-CODING', by
    accident. Vocabulary drawn from data/concepts.yaml, not invented. explain went 1/5 -> 5/5.
    """
    for question in ("Explain how FlashAttention avoids materialising the attention matrix.",
                     "Explain the difference between ZeRO stage 2 and stage 3.",
                     "Explain what AWQ does differently from naive round-to-nearest quantization.",
                     "Explain rotary position embeddings and why they extrapolate better."):
        assert decide_mode(question, 3)[0] == "explain", question


def test_the_polysemous_words_are_still_not_keywords():
    """`attention`, `transformer`, `model` and `training` are deliberately absent as bare words.

    They are the polysemy this project has already been bitten by: the retrieval probe set records
    "how much attention should I give a new puppy" at 0.506 and "what transformer do I need for
    european appliances" at 0.501 against the ML corpus. A student asking either deserves the
    non-programming mode, not a lecture on scaled dot-product attention.
    """
    for off_topic in ("how much attention should I give a new puppy",
                      "what transformer do I need for european appliances",
                      "help me write an essay about climate change"):
        assert decide_mode(off_topic, 3)[0] == "general", off_topic


def test_detect_mode_no_longer_claims_short_off_topic_questions():
    """The greedy half of the followup fix, measured at the layer that was actually wrong.

    "any question of eight words or fewer" caught "what is the capital of France?" and "can you
    review my resume?" — new topics, not continuations. The weak shapes now also require the
    message to be programming-related, so `detect_mode` returns `general` for all three.
    """
    for off_topic in ("what is the capital of France?", "can you review my resume?",
                      "when is the assignment due?"):
        assert detect_mode(off_topic) == "general", off_topic


def test_the_conversation_length_override_still_claims_two_of_them():
    """Honest boundary: `detect_mode` is fixed, `decide_mode`'s override is a SEPARATE heuristic.

    It promotes `general` to `followup` when a session has 3+ user turns and the message is under
    30 characters, on the reasoning that a very short message deep in a session is a continuation.
    Two of the three above are under 30 characters, so they still land on followup — through that
    override, not through the pattern list. It has its own rationale and changing it is a separate
    decision; pinned here so the distinction is not lost.
    """
    assert decide_mode("can you review my resume?", 3)[0] == "followup"      # 25 chars
    assert decide_mode("what is the capital of France?", 3)[0] == "general"  # exactly 30
    assert decide_mode("can you review my resume?", 1)[0] == "general"       # no history, no override


def test_teach_me_reaches_teaching():
    """`teaching_keywords` had no entry for the most natural way to ask to be taught.

    Every message in the teaching gold set opens "Teach me...", and none of the existing phrasings
    ("implement", "write code", "solve this") matched — so all six landed on `explain` or
    `general`. The learner asked to be TAUGHT and got a definition. 0/6 -> 6/6.
    """
    for question in ("Teach me why attention divides by sqrt(d_k) before the softmax.",
                     "Teach me the difference between pre-norm and post-norm transformers.",
                     "Teach me what a KV cache is and why decoding needs one.",
                     "Teach me how gradient accumulation simulates a larger batch."):
        assert decide_mode(question, 3)[0] == "teaching", question


def test_an_open_ended_teach_me_about_a_non_programming_topic_stays_general():
    """The gate on `teach me`, and why it is not symmetric with the rest of the list.

    The other teaching keywords name programming acts and carry the domain themselves. `teach me`
    is a bare request to be taught ANYTHING. Ungated it sent "teach me about the french revolution"
    to the TEACHING prompt, which emits [EXPLAIN][TEMPLATE][GUIDE] with code blanks — the model
    would try to scaffold code for a history question. `general` exists for exactly this.
    """
    for off_topic in ("teach me about the french revolution",
                      "teach me how to write a cover letter",
                      "walk me through the causes of the first world war"):
        assert decide_mode(off_topic, 3)[0] == "general", off_topic


def test_debug_still_wins_over_a_walk_me_through_request():
    """Debug is checked before teaching, and should stay that way: someone with broken code asking
    to be walked through it wants the bug found, not a lesson plan."""
    assert decide_mode("walk me through why my code returns None", 3)[0] == "debug"


def test_an_explicit_back_reference_reaches_followup():
    """Every followup gold message names the prior turn, and none of the old starters matched one.

    "You said…", "Earlier you mentioned…", "Follow up:…", "Following on from that…" — 0/4 before.
    """
    for message in ("You said batch norm behaves differently at eval time. Why?",
                    "Earlier you mentioned warmup. What actually goes wrong without it?",
                    "Follow up: is dropout active when I run inference?",
                    "Following on from that — what does a BPE tokenizer do with a new word?"):
        assert decide_mode(message, 3)[0] == "followup", message


def test_a_back_reference_outranks_the_explain_shape():
    """The ordering IS the fix for the fourth scenario.

    "Following on from that — what does a BPE tokenizer do…" names the prior turn AND asks a
    what-does question. With explain checked first the generic shape won and the continuation was
    lost, so the back-reference test now sits above it: a student writing "following on" is
    asserting a prior turn, which beats a keyword shape as evidence.
    """
    both = "Following on from that, what does a tokenizer do with an unseen word?"
    assert "what does" in both.lower(), "the explain shape really is present"
    assert decide_mode(both, 3)[0] == "followup"


# ── regression floors, measured on the gold sets ─────────────────────────────

def _accuracy(turns: int) -> tuple[int, int, collections.Counter]:
    hits, total, conf = 0, 0, collections.Counter()
    for s in run_evals.load_gold():
        latest, _ = enriched(s)
        got, want = decide_mode(latest, turns)[0], s["mode"]
        total += 1
        hits += got == want
        if got != want:
            conf[(want, got)] += 1
    return hits, total, conf


#: Measured 2026-08-14: **53/75**, from 16/75.
#:
#: 44 of those points came from five ROUTER fixes, each moving exactly one mode and none regressing
#: another: empathy 3/9 → 9/9, debug 12/51 → 20/51, explain 1/5 → 5/5, teaching 0/6 → 6/6,
#: followup 0/4 → 4/4.
#:
#: The last 9 came from fixing the MEASUREMENT, not the product, and the distinction matters more
#: than the number: 13 of the 18 extended debug scenarios described symptoms without naming a bug
#: ("clamp(5, 0, 10) gives me 10"), a phrasing that appears in 14% of real code-submitting turns
#: and made up 72% of that set. Rewording them to the measured 86% base rate moved debug 20/51 →
#: 29/51 WITH NO CHANGE TO THE ROUTER. Anyone comparing across that boundary is comparing two
#: different instruments. A FLOOR to catch regressions, not a target — see the module
#: docstring on why the gold labels are an imperfect routing ground truth. Raised each time, because
#: a stale floor throws away exactly the protection it was added for.
#: **This floor is the `turns=3` measurement**, i.e. routing mid-conversation. It is NOT the same
#: number as the first-turn routing in `scripts/routing_eval.py`, which is **55/75**. The gap is
#: `decide_mode`'s `general -> followup` override, gated on `n_user_messages > 2` — so a short
#: off-topic-looking message routes differently on turn 3 than on turn 1, by design.
#:
#: Both are real and they answer different questions. The joint-rate funnel is about a learner's
#: FIRST request, so `routing_eval.py` is the tool of record there. This floor guards the
#: mid-conversation path, which nothing else covers. Neither may be quoted as "the routing rate"
#: without saying which turn it describes.
#: Raised 53 -> 70 by the deterministic debug pre-classifier (`looks_like_debug_submission`), which
#: lifted debug recall 29/51 -> 46/51 with zero false positives. First-turn and turns=3 now agree at
#: 70/75, because the rule does not depend on conversation position.
ROUTING_FLOOR = 70


def test_routing_accuracy_has_not_regressed():
    hits, total, _ = _accuracy(turns=3)
    assert hits >= ROUTING_FLOOR, (
        f"routing fell to {hits}/{total}, below the {ROUTING_FLOOR}/75 floor measured 2026-08-14")


def test_every_mode_now_routes_something_and_debug_is_the_long_tail():
    """Replaces the hold-out test, which asserted `followup` was still at zero and told its
    successor to update the METRICS row alongside it.

    16/75 → 44/75 over five targeted fixes, each moving exactly one mode and none regressing
    another. Every mode routes something now. What is left is the debug long tail — 20 of 51 — and
    that is where the gold labels are weakest, because many debug scenarios are terse natural
    phrasings with no keyword at all rather than router failures per se.
    """
    hits, total, _ = _accuracy(turns=3)
    assert hits > total * 0.5, f"routing fell back below half: {hits}/{total}"

    per = collections.Counter()
    for s in run_evals.load_gold():
        latest, _ = enriched(s)
        if decide_mode(latest, 3)[0] == s["mode"]:
            per[s["mode"]] += 1
    for mode in ("debug", "empathy", "explain", "followup", "teaching"):
        assert per[mode] > 0, f"{mode} routes nothing again"
    assert per["debug"] < 51, (
        "debug is perfect — update this test and the METRICS row together; it is the remaining "
        "gap and the one the gold labels measure least well")


def test_general_is_no_longer_where_most_misroutes_go():
    """The failure shape changed, which is what the previous version of this test was for.

    It asserted `general` swallowed at least a third of all misroutes — 37 of 53 when written. With
    the code-context signal restored that is **13 of 45**: messages carrying code no longer fall
    through to the catch-all. The remaining misroutes are genuine mode confusions, which is a
    different and harder problem than a fall-through.
    """
    _, _, conf = _accuracy(turns=3)
    to_general = sum(n for (_, got), n in conf.items() if got == "general")
    total = sum(conf.values())
    assert to_general < total / 2, (
        f"{to_general} of {total} misroutes land in 'general'; the fall-through is dominant again")


# ── behaviour the router does get right, pinned so a rewrite cannot lose it ───

@pytest.mark.parametrize(("message", "expected"), [
    ("My code fails all the test cases, what's wrong?\n```python\nx = 1\n```", "debug"),
    ("How do I solve two sum?", "teaching"),
    ("What is a hash map?", "explain"),
    ("so why does that work", "followup"),
])
def test_unambiguous_messages_route_correctly(message, expected):
    assert decide_mode(message, 2)[0] == expected


def test_extraction_left_the_decision_unchanged():
    """`decide_mode` was extracted from the handler, not rewritten. Equivalence was verified over
    318 (message, turn-count) pairs at extraction time; this keeps the composition pinned."""
    msg = "[USER REQUEST]\nim so confused\n\n[SOURCE CODE (python)]\n```python\nx=1\n```"
    mode, intent = decide_mode(msg, 3)
    assert intent == "im so confused"          # the block is stripped
    assert mode == "empathy"                   # frustration overrides the code block


# ── cross-mode prompt bleed ──────────────────────────────────────────────────

def test_followup_does_not_share_the_debug_prompt_on_the_finetuned_path():
    """The combined prompt IS the debug prompt, and the model followed it.

    Measured 2026-08-14: served the combined prompt, 3 of 4 followup scenarios came back as debug
    reports and 4 of 4 emitted fenced code. One invented a binary-tree program and walked through
    "Issue 1 — Line 8" when asked what goes wrong without learning-rate warmup. The dedicated
    prompt takes that to 0/4 and 0/4.

    Debug and teaching stay on the combined prompt deliberately — debug is measurably better with
    it (21/51 against 14/51) — so this pins one mode, not a switch of the whole path.
    """
    from prompts import get_system_prompt as gsp
    assert gsp("followup", pe_mode=False) != gsp("debug", pe_mode=False), (
        "followup and debug share a system prompt again; followup answers will arrive as "
        "'Issue N — Line X' debug reports")
    assert gsp("followup", pe_mode=False) == gsp("followup", pe_mode=True)
    # the two that stay combined, asserted so the fix cannot quietly widen
    assert gsp("debug", pe_mode=False) == gsp("teaching", pe_mode=False)


def test_every_mode_that_has_a_dedicated_prompt_keeps_it_on_both_paths():
    """`explain`, `empathy` and `general` return before the pe_mode branch and must stay that way —
    their prompts are the same object regardless of serving stack."""
    from prompts import get_system_prompt as gsp
    for mode in ("explain", "empathy", "general"):
        assert gsp(mode, pe_mode=True) == gsp(mode, pe_mode=False), mode


# ── "fail" means two different things ────────────────────────────────────────

def _submitted(message: str) -> str:
    """The message as the panel actually sends it, with the learner's code attached.

    Attaching code is not incidental here, it is the CONDITION THE BUG NEEDED. `is_programming_related`
    gates the whole debug branch, so without a code block none of these can reach debug and every
    assertion below would pass against the defect. The panel attaches the editor contents on every
    turn, so this is also the realistic shape.
    """
    template = "```python\ndef softmax(x):\n    return ____\n```"
    return f"[USER REQUEST]\n{message}\n\n[CURRENT CODE (Python)]\n{template}"


#: Messages where a PERSON is failing. None is a bug report and none may reach the debug prompt.
PERSON_FAILING = [
    "my deadline is in 10 minutes and I will fail. give me the full function.",
    "I will fail",
    "I'll fail the course",
    "I'm going to fail",
    "I will fail my exam",
    "we will fail the unit",
    "im gonna fail this class",
    "if I don't finish I fail the subject",
]

#: Messages where CODE is failing. Every one must still reach debug — losing these is the
#: expensive direction, since debug recall is the thing most recently repaired in this router.
CODE_FAILING = [
    "my tests fail",
    "it fails on the second case",
    "the function fails",
    "my code fails",
    "this fails when n=0",
    "two tests fail and I don't know why",
    "the last test case fails",
    "why does it fail for empty input",
    "fails with an IndexError",
]


@pytest.mark.parametrize("message", PERSON_FAILING)
def test_a_student_saying_they_will_fail_is_not_a_bug_report(message):
    """The word "fail" routed a panicking student to the DEBUG prompt, and it leaked the answer.

    `debug_keywords` held a bare 'fail', so "my deadline is in 10 minutes and I will fail" matched
    and beat every later rule — debug is Priority 1. That put the learner in front of the one
    prompt carrying an escalation format that prints code, on the turn they were begging hardest
    for it.

    MEASURED 2026-09-10 against Qwen3-Coder-30B: it handed over a complete `softmax` in 4 of 6
    three-turn conversations, while the identical plea in a SINGLE turn — routed to `explain` —
    was refused every time. That looked like a multi-turn prompt-robustness problem for as long as
    nobody read the route. It was one word.

    The same polysemy is already documented a few lines above in `programming_keywords`, where
    bare 'attention', 'transformer' and 'memory' are deliberately absent for exactly this reason.
    The lesson had been applied to that list and not to this one.
    """
    assert decide_mode(_submitted(message), 3)[0] != "debug", (
        f"{message!r} routed to debug: a student under exam pressure is being handed the prompt "
        "that escalates to code")


@pytest.mark.parametrize("message", CODE_FAILING)
def test_code_that_fails_still_reaches_debug(message):
    """The other half, and the one that costs more if it breaks.

    A guard against the person sense is worthless if it also swallows "my tests fail" — the
    commonest way a real bug report is phrased, and bare 'fail' is the only keyword that catches
    it (the list has no 'fails' and no 'failing').
    """
    assert decide_mode(_submitted(message), 3)[0] == "debug", (
        f"{message!r} no longer routes to debug; the personal-failure guard is too greedy")


def test_a_message_carrying_both_senses_still_routes_to_debug():
    """Removing the person sense must not remove the code sense sitting beside it."""
    assert decide_mode(_submitted("I'll fail the course, and my tests fail too"), 3)[0] == "debug"
