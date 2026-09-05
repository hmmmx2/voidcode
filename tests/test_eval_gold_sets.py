"""Structural validation of the tutor gold sets, and the empathy checks. Spec V6.

WHY A WRONG GOLD LINE IS WORSE THAN A MISSING SCENARIO
--------------------------------------------------------
`check_bug_localisation` scores a response by comparing the line numbers it cites against
`ground_truth_bugs`. If a gold line is wrong, a tutor that correctly identifies the real bug is
marked as missing it — so the metric gets WORSE as the product gets BETTER, and nothing in the
output says so. That is this repo's signature failure with the sign flipped, and it is the reason
these tests exist at all rather than trusting the file that was generated.

The frozen-set assertions are the other half. `eval_baseline_before_v53.json` records 11/33 against
the original scenarios; if that file grows, every comparison against 11/33 silently becomes a
comparison of two different populations.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import run_evals  # noqa: E402

FROZEN = ROOT / "llm" / "data" / "eval_debug_gold.jsonl"
EXTENDED = ROOT / "llm" / "data" / "eval_debug_gold_extended.jsonl"
EMPATHY = ROOT / "llm" / "data" / "eval_empathy_gold.jsonl"

#: The count the published baseline was measured against. Not a magic number — it is the
#: denominator of 11/33, and changing it invalidates the only comparable figure V6 has.
FROZEN_SCENARIO_COUNT = 33


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


# ── the frozen baseline ──────────────────────────────────────────────────────

def test_the_frozen_debug_set_still_has_its_baseline_denominator():
    assert len(rows(FROZEN)) == FROZEN_SCENARIO_COUNT, (
        "eval_debug_gold.jsonl is the set eval_baseline_before_v53.json's 11/33 was measured on. "
        "New scenarios belong in eval_debug_gold_extended.jsonl, or the baseline stops meaning "
        "anything while still looking comparable.")


def test_extended_scenarios_are_marked_as_not_baseline():
    assert all(r.get("baseline_set") is False for r in rows(EXTENDED))


def test_loader_marks_the_frozen_set_and_only_the_frozen_set():
    scenarios = run_evals.load_gold(modes=["debug"])
    frozen = [s for s in scenarios if s["baseline_set"]]
    assert len(frozen) == FROZEN_SCENARIO_COUNT
    assert len(scenarios) > FROZEN_SCENARIO_COUNT, "the extended file did not load"


def test_the_frozen_subset_gets_its_own_reported_bucket():
    """Without this bucket the 11/33 reference has nothing to compare against post-expansion."""
    scored = [{"scenario": {"mode": "debug", "difficulty": "easy", "baseline_set": True},
               "score": {"all_passed": True, "checks": {}}},
              {"scenario": {"mode": "debug", "difficulty": "hard", "baseline_set": False},
               "score": {"all_passed": False, "checks": {}}}]
    buckets = run_evals.summarise(scored)["by_bucket"]
    assert any("FROZEN-BASELINE" in k for k in buckets)
    frozen = next(v for k, v in buckets.items() if "FROZEN-BASELINE" in k)
    assert frozen["n"] == 1 and frozen["passed"] == 1, "the extended row leaked into the baseline"


# ── ground-truth integrity, both debug files ─────────────────────────────────

@pytest.mark.parametrize("path", [FROZEN, EXTENDED], ids=["frozen", "extended"])
def test_every_ground_truth_line_exists_in_its_source(path):
    for row in rows(path):
        src = row["source_code"].split("\n")
        for bug in row["ground_truth_bugs"]:
            line = bug["line"]
            assert 1 <= line <= len(src), (
                f"{row['id']}: line {line} is outside a {len(src)}-line source")
            assert src[line - 1].strip(), (
                f"{row['id']}: line {line} is blank, so no answer can ever cite it correctly")


#: `-1` is the frozen set's sentinel for "do not score the count", used by the multi-turn scenarios
#: where the bug count is not what is being tested. Discovered by this test rather than documented
#: anywhere, so it is pinned here.
COUNT_NOT_CHECKED = -1


@pytest.mark.parametrize("path", [FROZEN, EXTENDED], ids=["frozen", "extended"])
def test_expected_bug_count_matches_the_ground_truth_list(path):
    for row in rows(path):
        if row["expected_bug_count"] == COUNT_NOT_CHECKED:
            assert row["id"].startswith("eval_mt_"), (
                f"{row['id']}: the -1 sentinel is for multi-turn scenarios; on a single-turn one it "
                "silently disables count scoring")
            continue
        assert row["expected_bug_count"] == len(row["ground_truth_bugs"]), row["id"]


def test_no_ground_truth_entry_describes_a_line_that_is_actually_correct():
    """`check_bug_localisation` requires EVERY ground-truth line to be cited. An entry describing a
    correct line therefore makes the scenario unpassable, so a right answer scores as a miss and the
    metric degrades as the tutor improves.

    This is not hypothetical: `eval_is_anagram_syntax_logic_001` carried an author's note in
    `ground_truth_bugs` reading "Logic is sound once syntax is fixed", which demanded that a tutor
    cite line 9 — a correct line — in order to pass.
    """
    for path in (FROZEN, EXTENDED):
        for row in rows(path):
            for bug in row["ground_truth_bugs"]:
                text = bug["description"].lower()
                assert "actually correct" not in text and "logic is sound" not in text, (
                    f"{row['id']} line {bug['line']}: a note is filed as a bug")


def test_no_scenario_puts_two_bugs_on_one_line():
    """Scoring compares SETS of line numbers, so two bugs on one line collapse to one and the
    declared count becomes unreachable. Caught a real scenario during authoring."""
    for path in (FROZEN, EXTENDED):
        for row in rows(path):
            lines = [b["line"] for b in row["ground_truth_bugs"]]
            assert len(set(lines)) == len(lines), f"{row['id']}: duplicate ground-truth line"


def test_ids_are_unique_across_every_gold_file():
    seen: dict[str, str] = {}
    for path in (FROZEN, EXTENDED, EMPATHY):
        for row in rows(path):
            assert row["id"] not in seen, f"{row['id']} appears in {seen.get(row['id'])} and {path.name}"
            seen[row["id"]] = path.name


# ── the rebalance itself ─────────────────────────────────────────────────────

def test_debug_difficulty_is_no_longer_overwhelmingly_easy():
    """The plan's complaint: 26 easy / 6 medium / 1 hard cannot support a claim about hard cases.

    Asserting the SHAPE rather than exact counts, so adding scenarios does not fail the test — but
    regressing to a mostly-easy set does.
    """
    combined = rows(FROZEN) + rows(EXTENDED)
    counts = {d: sum(1 for r in combined if r["difficulty"] == d)
              for d in ("easy", "medium", "hard")}
    assert counts["easy"] / len(combined) < 0.60, counts
    assert counts["hard"] >= 8, f"a claim about hard cases needs more than a handful: {counts}"
    assert counts["medium"] >= 12, counts


def test_the_extended_set_carries_real_multi_bug_scenarios():
    """Single-bug scenarios cannot distinguish a tutor that finds one bug from one that finds all."""
    multi = [r for r in rows(EXTENDED) if r["expected_bug_count"] > 1]
    assert len(multi) >= 5, f"only {len(multi)} multi-bug scenarios"


# ── empathy checks ───────────────────────────────────────────────────────────

def test_empathy_gold_set_loads_and_is_balanced():
    scenarios = run_evals.load_gold(modes=["empathy"])
    assert len(scenarios) >= 8
    for d in ("easy", "medium", "hard"):
        assert sum(1 for s in scenarios if s["difficulty"] == d) >= 2, d


def test_a_debug_report_fails_empathy_even_when_the_debugging_is_correct():
    """THE empathy failure mode. A frustrated learner is usually mid-debug, so the model producing
    a well-formed debug report is the regression this check exists to catch."""
    reply = "Issue 1 — Line 4: you used `=` instead of `==`. 🔴 Fix that and re-run."
    out = run_evals.check_no_debug_markers(reply, {})
    assert not out["passed"]
    assert out["issue_header"] and out["markers"]


def test_markers_in_the_scenario_prompt_do_not_fail_the_response():
    """The hard scenarios deliberately CONTAIN [MODE: DEBUG] in the user message. Matching against
    the input rather than the output would fail every one of them."""
    scenario = {"user_message": "[MODE: DEBUG]\n[SOURCE CODE]\nx = 1\n\nI'm really stuck"}
    warm = "That's a rough spot to be in, and it's completely normal. What does `x` hold here?"
    assert run_evals.check_no_debug_markers(warm, scenario)["passed"]


def test_agreeing_with_self_deprecation_fails():
    assert not run_evals.check_does_not_agree_with_self_deprecation(
        "Honestly, maybe this isn't for you.", {})["passed"]
    assert run_evals.check_does_not_agree_with_self_deprecation(
        "You're closer than you think — this trips everyone up.", {})["passed"]


def test_an_encouraging_close_passes_without_a_question_mark():
    """The empathy contract accepts a question OR an encouragement. Requiring a question mark, as
    `check_asks_a_question` does, would fail a reply that follows the specification exactly."""
    reply = "That feeling is normal. Look at the operator on the update line. One step at a time — you've got this!"
    assert run_evals.check_invites_continuation(reply, {})["passed"]
    assert not run_evals.check_invites_continuation(reply, {})["asks_question"]


def test_a_flat_close_with_neither_question_nor_encouragement_fails():
    assert not run_evals.check_invites_continuation(
        "The operator on line 4 is wrong. Change it to +=.", {})["passed"]


def test_empathy_never_runs_the_question_mark_check():
    """Wiring assertion: `check_asks_a_question` is deliberately absent from the empathy mode."""
    names = [c.__name__ for c in run_evals.CHECKS_BY_MODE["empathy"]]
    assert "check_asks_a_question" not in names
    assert "check_invites_continuation" in names


def test_every_routed_mode_has_a_gold_set():
    """prompts.py routes six modes. `general` has no gold set by design — it is the fallback with no
    contract to check — so the five with contracts must all be covered."""
    assert set(run_evals.CHECKS_BY_MODE) == set(run_evals.GOLD_FILES)
    assert {"debug", "teaching", "explain", "followup", "empathy"} <= set(run_evals.GOLD_FILES)


def test_every_gold_file_is_tracked_by_git():
    """An untracked gold set is not reproducible from a clone, and its numbers cannot be compared
    across machines — while everything still passes locally.

    Asks git rather than reading `.gitignore`, because the pattern is what went wrong: the negation
    was written as `eval_*_gold.jsonl` when every file ended that way, and then silently dropped
    `eval_debug_gold_extended.jsonl`. That was the second occurrence of this exact trap, the first
    being `eval_debug_gold.jsonl` itself, untracked from the day it was written.
    """
    import subprocess

    paths = []
    for value in run_evals.GOLD_FILES.values():
        paths.extend([value] if isinstance(value, Path) else value)
    untracked = []
    for path in paths:
        if not path.exists():
            continue
        result = subprocess.run(["git", "ls-files", "--error-unmatch", str(path)],
                                cwd=ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            untracked.append(path.name)
    assert not untracked, f"gold sets exist on disk but are not in git: {untracked}"


@pytest.mark.parametrize("path", [FROZEN, EXTENDED], ids=["frozen", "extended"])
def test_the_model_always_receives_the_source(path):
    """Whatever shape a scenario stores its code in, the composed messages must contain it.

    Not hypothetical: it voided an eval run. All 18 extended scenarios kept their code in
    `source_code` only and the harness sent `user_message` alone, so the tutor was asked "why does
    the output keep growing?" with nothing to look at. It invented plausible code and critiqued
    that, scoring 1/18 — a number that read as "these are harder" and meant "it never saw them".
    The three `eval_mt_*` scenarios failed the same way, with their code in `messages[0]`.

    Asserting on `build_messages` output rather than on `user_message` is the point: the invariant
    is what the model RECEIVES, not which field the code happens to live in.
    """
    for row in rows(path):
        src = (row.get("source_code") or "").strip()
        if not src:
            continue
        sent = "".join(m["content"] for m in run_evals.build_messages(row, "SYS"))
        first = src.splitlines()[0].strip()
        assert first in sent, f"{row['id']}: the model never receives its source ({first!r})"


@pytest.mark.parametrize("path", [FROZEN, EXTENDED], ids=["frozen", "extended"])
def test_the_api_payload_also_carries_the_source(path):
    """The same invariant as above, on the OTHER generation path.

    `build_messages` was fixed and `_generate_direct` was fixed with it, but `_generate` -- the path
    that measures production, where the API detects the mode and injects the prompt -- kept posting
    `user_message` alone for months afterwards. The earlier test passed the whole time, because it
    asserts on `build_messages` and `_generate` was not calling it.

    So this asserts on the bytes actually sent. A fix applied to one path is not evidence about the
    other.
    """
    for row in rows(path):
        src = (row.get("source_code") or "").strip()
        if not src:
            continue
        sent = "".join(m["content"] for m in run_evals.api_payload(row)["messages"])
        first = src.splitlines()[0].strip()
        assert first in sent, f"{row['id']}: production path never receives its source ({first!r})"


def test_the_api_payload_overrides_nothing_production_decides():
    """No sampling key may be sent to the API, and no system prompt.

    Both are one-word regressions with no visible symptom. `max_tokens: 1024` cannot raise a mode's
    budget -- the server takes `min(request.max_tokens or cfg, cfg)` -- so it can only ever truncate,
    and on a thinking model it truncates the answer rather than the reasoning. A system message from
    here would compete with the one `get_system_prompt(pe_mode=USE_SGLANG)` injects, which is the
    single thing this path exists to exercise.
    """
    row = {"user_message": "why is this wrong?", "source_code": "def f(a):\n    return a + 1"}
    payload = run_evals.api_payload(row)
    sent = sorted(set(payload) & set(run_evals.SERVER_OWNED_KEYS))
    assert not sent, f"harness overrides what the server decides: {sent}"
    roles = [m["role"] for m in payload["messages"]]
    assert "system" not in roles, f"harness sends its own system prompt: {roles}"


def test_multi_turn_scenarios_keep_their_conversation():
    """Dropping the history turns a follow-up into an opening question with no context."""
    mt = [r for r in rows(FROZEN) if r.get("messages")]
    assert mt, "no multi-turn scenarios found"
    for row in mt:
        built = run_evals.build_messages(row, "SYS")
        assert [m["role"] for m in built] == ["system"] + [m["role"] for m in row["messages"]]


def test_every_scenario_with_source_reaches_the_model_in_the_workspace_shape():
    """REPLACES `test_separate_source_is_fenced_like_the_embedded_scenarios`, whose premise was that
    both shapes should look alike so a score gap measures difficulty rather than presentation.

    Right principle, wrong direction: they were made alike by matching the EMBEDDED shape — a bare
    fence — which production never sends. `VoidCodeAIPanel.tsx` sends `[SOURCE CODE]` with line
    numbers, and the gap was real. Measured in one run, same model and prompt: localisation 0.702 on
    the numbered scenarios against 0.396 on the unnumbered ones. Two thirds of the debug set was
    scored on a message a learner does not produce.

    Now they are made alike by matching PRODUCTION. The embedded fence is stripped so the question
    survives and the source is re-attached numbered.
    """
    embedded = {"user_message": "why is this wrong?\n```python\ndef f(a):\n    return a + 1\n```",
                "source_code": "def f(a):\n    return a + 1"}
    separate = {"user_message": "why is this wrong?", "source_code": "def f(a):\n    return a + 1"}
    for row in (embedded, separate):
        sent = run_evals.build_messages(row, "SYS")[-1]["content"]
        assert "[USER REQUEST]" in sent and "[SOURCE CODE" in sent
        assert "  1 | def f(a):" in sent, "the source must arrive line-numbered"
        assert sent.count("def f(a):") == 1, "the code must not appear twice"
        assert "why is this wrong?" in sent, "the learner's question must survive the strip"


def test_skip_checks_is_honoured():
    """The frozen multi-turn scenarios mark checks inapplicable; scoring was ignoring the field."""
    scenario = {"user_message": "x", "skip_checks": ["asks_a_question"]}
    out = run_evals.score_one("no question here.", scenario, "teaching")
    assert out["checks"]["asks_a_question"]["applicable"] is False


def test_invented_code_is_flagged_and_real_quotes_are_not():
    src = "def clamp(value, low, high):\n    if value < high:\n        return high"
    scenario = {"source_code": src}
    real = "Look here:\n```python\n    if value < high:\n```\nWhat does that compare?"
    fake = "Look here:\n```python\n    return max(min(value, high), low)\n```"
    assert run_evals.check_no_invented_code(real, scenario)["passed"]
    out = run_evals.check_no_invented_code(fake, scenario)
    assert not out["passed"] and out["n_invented"] == 1


def test_invented_code_check_is_wired_into_debug():
    names = [c.__name__ for c in run_evals.CHECKS_BY_MODE["debug"]]
    assert "check_no_invented_code" in names, (
        "the check existed in audit_tutor.py and was never wired in, which is why a run full of "
        "invented code was reported as poor bug localisation")


def test_direct_vllm_refuses_to_run_without_an_explicit_prompt_mode(capsys, monkeypatch):
    """The mismatch that cost 50% of the localisation rate must not be reachable by omission.

    `get_system_prompt(mode, pe_mode=True)` defaults to the prompt-engineered prompts for stock
    Qwen3.5-9B. An entire eval of the FINE-TUNED model ran with that default: measured back to back
    on one server, overall localisation was 14/51 with the PE prompt and 21/51 with the one the
    LoRA was actually trained on, mean recall 0.333 against 0.510. Nothing in the output said so.
    So the flag has no default and the run aborts without it.
    """
    monkeypatch.setattr(sys, "argv",
                        ["run_evals.py", "--direct-vllm", "http://127.0.0.1:9", "--modes", "debug"])
    assert run_evals.main() == 2
    assert "--prompt-mode" in capsys.readouterr().out


def test_the_two_prompt_modes_actually_differ_for_debug():
    """If they were the same string the flag would be theatre."""
    sys.path.insert(0, str(ROOT / "llm" / "scripts"))
    from prompts import get_system_prompt
    assert get_system_prompt("debug", pe_mode=True) != get_system_prompt("debug", pe_mode=False)


def test_bug_count_is_scored_separately_from_localisation():
    """Counting and enumerating are different abilities; the tutor does the first far more often.

    Measured: it claimed two issues 7 times in 51 while emitting two Issue blocks once, writing
    "Let's tackle the first one first" and stopping well short of the token cap. Conflating the two
    hid which ability was actually weak.
    """
    sc = {"expected_bug_count": 2}
    assert run_evals.check_bug_count_accuracy("I found **2 issue(s)** in your code.", sc)["passed"]
    wrong = run_evals.check_bug_count_accuracy("I found **1 issue** in your code.", sc)
    assert not wrong["passed"] and wrong["claimed"] == 1
    silent = run_evals.check_bug_count_accuracy("Line 4 looks wrong.", sc)
    assert not silent["passed"] and silent["stated_a_count"] is False


def test_bug_count_respects_the_minus_one_sentinel():
    out = run_evals.check_bug_count_accuracy("I found **2 issues**", {"expected_bug_count": -1})
    assert out["applicable"] is False


def test_bug_count_check_is_wired_into_debug():
    assert "check_bug_count_accuracy" in [c.__name__ for c in run_evals.CHECKS_BY_MODE["debug"]]


# ── grounding fidelity ───────────────────────────────────────────────────────

def test_grounded_modes_match_production():
    """The harness reproduces production's grounding, so the two lists must not drift.

    `_ground()` is called at exactly one place — inside the FastAPI handler — so a harness posting
    straight to vLLM got no retrieval at all. Every explain and teaching figure measured that way
    was the ungrounded model, which is a different system from the one learners use.

    Compared as BEHAVIOUR rather than as a list. The two were previously checked by comparing a
    `GROUNDED_MODES` tuple, and when production moved to a "ground unless it would harm" predicate
    that comparison kept passing against a constant production no longer used — certifying a match
    while the harness grounded two modes and production grounded four.
    """
    sys.path.insert(0, str(ROOT / "apps" / "api"))
    from src.main import _should_ground as production_should_ground

    for mode in ("debug", "explain", "teaching", "followup", "empathy", "general"):
        assert run_evals.should_ground(mode) is production_should_ground(mode), (
            f"harness and production disagree on grounding {mode}")


def test_a_grounded_mode_gets_the_ungrounded_instruction_when_retrieval_finds_nothing():
    """Production's FAIL-OPEN path, which the harness used to skip entirely.

    Three behaviours are possible and only two are production's: grounded (REFERENCE MATERIAL
    block), fail-open (UNGROUNDED_INSTRUCTION telling the model to flag time-sensitive claims), and
    nothing at all. The harness used to do the third, which production never does for these modes.
    """
    sys.path.insert(0, str(ROOT))
    from features.retrieval import UNGROUNDED_INSTRUCTION, ground_prompt

    assert UNGROUNDED_INSTRUCTION.strip() in ground_prompt("SYS", [])
    assert "REFERENCE MATERIAL" not in ground_prompt("SYS", [])


def test_the_corpus_adapter_satisfies_what_retrieval_requires():
    """`_CorpusDocument` plays the role `knowledge_cache.CachedDocument` plays for the DB path.
    If it drifts from the Protocol, retrieval silently skips every document and the run fails open
    while looking correctly configured."""
    class _Doc:
        slug, title, body = "s", "t", "b"
        source_name, source_url = "src", "https://example.test"

    adapted = run_evals._CorpusDocument(_Doc(), [0.1, 0.2, 0.3])
    for attribute in ("slug", "title", "body", "is_current", "embedding", "embedding_dim"):
        assert hasattr(adapted, attribute), attribute
    assert adapted.is_current is True
    assert adapted.embedding_dim == 3
    assert "https://example.test" in adapted.citation()


# ── the gold set must look like real traffic ─────────────────────────────────

#: Measured over 2,020 real user turns that submit code: 86% contain debug vocabulary
#: ("debug", "what's wrong", "fix", "error", "doesn't work", "bug" are the top six).
CORPUS_DEBUG_VOCABULARY_RATE = 0.86

DEBUG_VOCABULARY = ("fix", "debug", "what's wrong", "doesn't work", "does not work", "error",
                    "bug", "issue", "fail", "broken", "wrong", "incorrect", "crash",
                    "exception", "traceback")


def test_the_extended_set_reports_bugs_the_way_learners_actually_do():
    """The gold set has to resemble the traffic it stands in for, in BOTH directions.

    As first authored, only 28% of these messages named the problem — they described symptoms
    ("clamp(5, 0, 10) gives me 10", "always returns 0") and left the reader to infer a bug report.
    Measured against 2,020 real code-submitting turns, 86% carry debug vocabulary, so the set
    over-represented a rare phrasing by roughly 3x and made the router look far worse than it is.

    THE FIRST CORRECTION OVERSHOT to 100%, which is the same error mirrored: it would have erased
    the 14% who genuinely report a bug without naming it, and flattered the router instead. Three
    were put back. The window below is deliberately two-sided for that reason.
    """
    scenarios = rows(EXTENDED)
    with_vocab = sum(any(k in r["user_message"].lower() for k in DEBUG_VOCABULARY)
                     for r in scenarios)
    rate = with_vocab / len(scenarios)
    assert abs(rate - CORPUS_DEBUG_VOCABULARY_RATE) <= 0.10, (
        f"{with_vocab}/{len(scenarios)} = {rate:.0%} carry debug vocabulary; the corpus rate is "
        f"{CORPUS_DEBUG_VOCABULARY_RATE:.0%}. Too low makes the router look broken, too high "
        "makes it look fixed — neither measures the product.")


def test_relabelling_changed_only_the_wording():
    """Ground truth, source and counts are the same scenarios; only how the learner phrases it
    moved. If a relabelling ever alters a bug or a line, the eval and the routing numbers stop
    being comparable across it and nothing says so."""
    scenarios = rows(EXTENDED)
    assert len(scenarios) == 18
    assert all(r["ground_truth_bugs"] for r in scenarios)
    assert sum(1 for r in scenarios if r["expected_bug_count"] > 1) == 6
    for r in scenarios:
        for bug in r["ground_truth_bugs"]:
            assert 1 <= bug["line"] <= len(r["source_code"].split("\n"))

