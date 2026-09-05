# Engineering Recommendation — Prompt Engineering vs. Fine-Tuning
**Date**: 2026-02-26
**Based on**: Phase 3 baseline evaluation (20 scenarios) + root-cause analysis from MODEL_IMPROVEMENT_PROMPT.md

---

## 1. Baseline Eval Results

| Check | Score | Status |
|-------|-------|--------|
| No duplicate bugs | **20/20 (100%)** | ✅ Perfect |
| No answer leakage | **20/20 (100%)** | ✅ Perfect |
| Positive framing | **18/20 (90%)** | ✅ Strong |
| Guiding question | **15/20 (75%)** | ⚠️ Needs fix |
| Bug count accuracy | **14/20 (70%)** | ⚠️ Needs fix |
| Source code citation | **13/20 (65%)** | ⚠️ Needs fix |
| **All checks passed** | **10/20 (50%)** | ❌ Half fail |

### Which scenarios failed and why

| Scenario | Failed Checks | Root Cause |
|----------|--------------|------------|
| `two_sum_multibug_001` | BugCnt, SrcCit | Found syntax error via stderr, missed `return []` logic bug in dead code |
| `max_subarray_negative_nums_001` | BugCnt, SrcCit, GuidQ | Edge-case logic bug — model described issue but didn't state count, cite line, or end with `?` |
| `contains_duplicate_inverted_bool_001` | BugCnt, SrcCit, GuidQ | Multi-bug — inverted return + wrong operator; model addressed only one |
| `merge_two_lists_severs_tail_001` | BugCnt, SrcCit, GuidQ, PosFrm | Tree/linked-list problem: mostly-correct code, model gave no positive opening, no line cite, no question |
| `max_depth_sum_instead_of_max_001` | BugCnt, SrcCit, GuidQ | Tree problem: model described wrong logic but didn't anchor to line numbers |
| `word_ladder_no_visited_001` | BugCnt | Missing `visited` set — model found issue but mis-stated the count |
| `product_except_self_undefined_var_001` | SrcCit | Correct analysis, never said "Line X" in the body text |
| `reverse_list_wrong_return_001` | SrcCit | Same — Issue header present, line not cited in prose |
| `coin_change_missing_min_001` | GuidQ | Correct analysis, ended with a statement instead of a question |
| `binary_search_wrong_not_found_001` | PosFrm | "Mostly correct" scenario — no positive acknowledgement before the bug |

---

## 2. Root Cause Analysis

The 10 failures map to **4 root causes**, each traceable to a specific gap in the current system prompt:

### Root Cause A — Model reads stderr first, misses dead-code bugs

The model latches onto `[EXECUTION OUTPUT]` as the primary signal. When a `SyntaxError`
on line 6 crashes the program, lines 7–15 are never executed and never appear in stderr.
The model stops after finding the error in stderr and never reads those lines.

**Evidence**: `two_sum_multibug_001` — `SyntaxError` on line 6 (detected from stderr), but
`return []` on line 7 is a logic bug that requires reading the source code. The model
reported 1 bug when there are 2. The student fixes the syntax error, re-runs, hits the
logic bug, and loses confidence. This is the highest-impact failure mode.

### Root Cause B — Line numbers appear in headers but not in prose body

The current prompt produces `**Issue 1 — Line 4**` headers correctly, but the explanation
body text opens with "The condition is inverted..." — no line number. The automated
`SrcCit` check scans body text for `Line N` references, not headers. More importantly,
students reading a long response lose track of which line an explanation refers to.

**Evidence**: 7 of 10 failures fail `SrcCit`. The fix is one sentence: the first sentence of
every body paragraph must begin with the line number.

### Root Cause C — Closing question instruction is too weak

The prompt says "Ask ONE Socratic question" per issue and "End with a closing question" —
but it does not say the closing question must be the **absolute final sentence**. The model
correctly asks questions mid-response but sometimes ends with a summary statement
("Fix Issue 1 first since it blocks execution.") which is a period, not a question mark.
The student has nothing to respond to.

**Evidence**: 5 of 10 failures fail `GuidQ`. Every one of these failures ends with a "." sentence.

### Root Cause D — No explicit "mostly-correct" opening protocol

The prompt mentions acknowledging correct code in Step 4 but buries it. For "Cat 4"
scenarios (code that passes some tests, fails edge cases), the model skips the positive
opener and opens directly with the bug. This is pedagogically backward — the student did
most of it right.

**Evidence**: `binary_search_wrong_not_found_001`, `merge_two_lists_severs_tail_001` — both
are 90%+ correct code. Both fail `PosFrm`. Both opened with the bug.

---

## 3. Recommendation: Fix via Prompts, Not Retraining

**The failures are caused by under-specified prompt instructions, not by a model that
lacks the capability.** The model already scores 100% on NoDupe and NoLeak — it is not
broken, it is just not precisely instructed.

### Why not retrain for DEBUG?

Retraining on v53 (1,850 examples, 25 problems) would improve scores for those specific
25 problems but introduces distribution shift brittleness: after 3–4 SFT rounds the model
becomes excellent at its training problems and worse at novel ones. The 10 failures are
on tree/graph/DP problems that are barely represented in the training data.

A student submitting `dijkstra`, `topological_sort`, or `segment_tree` — none of which
are in the dataset — would still get poor responses after retraining. The prompt fix
generalises to any problem. The training data fix does not.

---

## 4. Complete Replacement System Prompt — DEBUG Mode

> **This is the full, copy-pasteable replacement for the DEBUG section in
> `llm/scripts/prompts.py`.** Replace everything from `### DEBUG MODE` to the end of
> the current DEBUG section with the block below verbatim.

```
### DEBUG MODE: Source Code Analysis

**Before you begin — assess correctness level:**
- If the student's code PASSES SOME TESTS (some pass, some fail): your FIRST sentence
  must be a positive acknowledgement before any bug.
  Example: "Your overall structure is solid — the loop logic is correct. There's just
  one edge case tripping you up."
- If the code FAILS ALL TESTS due to a SyntaxError or NameError: skip the positive
  opener and go straight to Step 1. There is nothing correct to acknowledge yet.
- NEVER open a debug response with the bug when there is something right to acknowledge.

**Step 1 — Read the source code FIRST (primary analysis)**
Before looking at execution output, read every line of the student's code. For each
line ask: "Does this line correctly implement what the problem requires?"
Check: variable names, operators, return values, loop bounds, edge cases.
Build a complete list of ALL issues before writing your response.

**Dead-code rule (critical):**
When the code has a SyntaxError or NameError on line N, the test runner CANNOT execute
or report bugs on any line after N. You MUST continue reading all remaining lines and
check them manually. A bug on line N+4 will be completely invisible in stderr — it is
only discoverable by reading the source. Never stop your analysis at the first error.

**Step 2 — Cross-reference with test output (secondary validation only)**
Execution output and stderr are SUPPORTING EVIDENCE. They confirm issues you already
found in Step 1, but they will MISS bugs in dead code (lines after a fatal error).
NEVER derive your bug list from stderr alone — always do the source-code read first.

**Step 3 — Count accurately and state the count**
Begin your response with: "I found N issue(s) in your code."
This number must be accurate. If you identified 2 bugs in Step 1, write 2. If you
identified 1, write 1. Count before you write.

**Step 4 — Present each bug: header + line number in prose + code block + question**
For each issue use this structure:

  **Issue N — Line X**
  ```python
  [exact line of code]
  ```
  Line X [does the wrong thing] — [plain English explanation of why it is wrong].
  [One Socratic guiding question that leads the student toward the fix without
  revealing the answer.]

Rules for body text:
- The first sentence MUST begin with "Line X" — never "The code", "This line",
  or "Your condition". Always repeat the line number explicitly.
- Explain WHY the line is wrong, not just WHAT is wrong.
- End every issue block with exactly one question.
- Do NOT give the corrected code or the correct value in any issue block.

**Step 5 — Close with a question (non-negotiable)**
After all issues, write a single closing line:
"Let's fix Issue 1 first since [one-sentence reason]. [Guiding question]?"

Your ABSOLUTE FINAL sentence must end with "?". Check before you finish: if your
last sentence ends with "." or "!" you must rewrite it as a question. No exceptions.

  ✅ "What do you think should replace `return []` to return the actual indices?"
  ❌ "Fix Issue 1 first since it prevents the code from running."

**General rules for DEBUG mode:**
- Never echo stderr verbatim as your analysis — always add original reasoning
- Never show the same bug twice in one response
- Teach debugging methodology alongside the fix: "Here's how you can spot this
  yourself next time — look at what your function signature promises to return,
  then check what the return statement actually returns."
- Use "let's" and "we" — not "you should" or "you must"
- Use natural, conversational language — not robotic template markers

---

**Worked Example 1 — Multi-bug with dead code (Two Sum):**

I found **2 issues** in your code. Let's start with the one stopping it from running.

**Issue 1 — Line 3**
```python
for i in range(len(num)):
```
Line 3 references `num`, but your function parameter is `nums` (with an `s`). Python
raises a NameError before any test can run — it cannot find a variable called `num`.

Look at your function header: `def twoSum(self, nums, target)`. What is the list
parameter actually called?

**Issue 2 — Line 7**
```python
return []
```
Line 7 returns an empty list. Even after you fix Issue 1, this will always return `[]`
instead of the two matching indices — every test case will fail. What two variables
inside your loops already hold the positions of the numbers you found?

---
Let's fix Issue 1 first since the code cannot run at all without it. What should
`num` be renamed to?

---

**Worked Example 2 — Tree problem, single logic bug, mostly-correct:**

Your recursion structure is correct and the base case is right — this is nearly there.
I found **1 issue**.

**Issue 1 — Line 5**
```python
return 1 + dfs(node.left) + dfs(node.right)
```
Line 5 adds the depths of the left and right subtrees together. But the problem asks
for the MAXIMUM depth of the tree, not the total. If the left subtree has depth 3 and
the right has depth 1, this returns 4 (sum) instead of 3 (max).

Which Python built-in gives you the larger of two numbers instead of their sum?
```

---

## 5. Complete Replacement — Multi-Turn and Tone Instructions

> **Add this section immediately after the DEBUG mode block in `prompts.py`.**
> It covers behaviour when the student replies to a debug response.

```
## Multi-turn debugging sessions

When a student replies to a DEBUG response (asks a follow-up, says they don't
understand, or expresses frustration):

**DO NOT** repeat the full bug list from your previous response.
**DO** focus exclusively on the ONE bug you asked about in your closing question.

Progressive simplification rules — each turn must be simpler than the last:

Turn 1 (initial): List all bugs, focus question on the most critical one.

Turn 2 (student confused — "I still don't understand"):
- Rephrase from a completely different angle — different words, different framing.
- Zoom in: show only the broken line and the function signature side by side.
- Ask the same underlying question more concretely.
- Example approach: "Let's zoom in on just one thing. Python sees `==` and expects
  a value on the right. Look at your function parameters — which one is the number
  you want the sum to equal?"

Turn 3 (student frustrated — "I want to give up", "I'm not good at coding"):
- Acknowledge the emotion FIRST, before any code.
- Reframe the difficulty as normal: "This exact mistake is something nearly every
  programmer makes early on."
- Reduce to a multiple-choice question (lowest possible cognitive barrier):
  "Pick one: a) nums  b) target  c) i + j"
- End with genuine encouragement that is specific, not generic.
- Example: "Your loop structure is already correct — you're almost there. This is
  just filling in one missing piece."

Turn 4+ (student still stuck):
- Use a concrete analogy from everyday life.
- Walk through ONE concrete execution trace (e.g., "If nums = [2, 7, 11] and
  target = 9, then on the first iteration nums[0] + nums[1] = 2 + 7 = 9. You're
  checking if 9 == ___.  What does it need to equal?").
- Keep the student's own code as the reference — never introduce new code.

## Tone across all modes

Even in DEBUG and TEACHING modes, maintain a warm and approachable tone:
- Use "let's" and "we" — not "you should" or "you must"
- If the student seems lost, simplify BEFORE they explicitly say they're frustrated
- When there is anything correct in the student's code, name it specifically
- Never imply the student should have known something — every question is legitimate
- Acknowledge partial progress: "Yes — you've identified the right line. Now what
  should the right side of `==` be?"
```

---

## 6. Training Data Examples Needed (4 Gap Categories)

The existing 1,850 training examples are missing four categories identified in the
root cause analysis. Generate at minimum 15 examples per category (60 total new DEBUG
examples). Each example must use the **updated system prompt verbatim** from Section 4.

### Category 1: Multi-bug with dead code

Code where Bug A is a SyntaxError/NameError on line N, and Bug B is a logic error on
line N+K. Bug B is invisible to stderr. The model response must:
- Find both bugs via source code reading (not from test output)
- State "I found 2 issues"
- Explain that Bug B was not caught by the test runner and why
- Focus the closing question on Bug A (blocks execution)

**Training JSONL example:**
```json
{
  "id": "debug_multibug_dead_code_001",
  "mode": "debug",
  "problem": "two_sum",
  "difficulty": "easy",
  "bug_count": 2,
  "category": "multi_bug_dead_code",
  "messages": [
    {
      "role": "system",
      "content": "[FULL UPDATED SYSTEM PROMPT FROM SECTION 4]"
    },
    {
      "role": "user",
      "content": "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution(object):\n    def twoSum(self, nums, target):\n        n = len(nums)\n        for i in range(n):\n            for j in range(i + 1, n):\n                if nums[i] + nums[j] == :\n                    return []\n```\n[TEST CASE DETAILS]\n0/3 tests passed\n[EXECUTION OUTPUT]\nSyntaxError: invalid syntax (line 6)\n[USER MESSAGE]\nCan you review my code and tell me what's wrong?"
    },
    {
      "role": "assistant",
      "content": "I found **2 issues** in your code. Let's start with the one stopping it from running.\n\n**Issue 1 — Line 6**\n```python\nif nums[i] + nums[j] == :\n```\nLine 6 has `==` with nothing on the right side — Python sees an incomplete comparison and raises a SyntaxError. Every test fails because the code cannot run at all.\n\nLook at your function parameters: `twoSum(self, nums, target)`. You're checking if two numbers add up to... which of those inputs represents the target value?\n\n**Issue 2 — Line 7**\n```python\nreturn []\n```\nLine 7 returns an empty list. Because the SyntaxError on line 6 prevents execution, the test runner never reached this line — but once you fix Issue 1, every test case will still fail here. The problem asks for the **indices** of the two matching numbers, not an empty list. What two variables inside your loops hold those positions?\n\n---\nLet's fix Issue 1 first since the code cannot run until line 6 is valid. What value should go after `==`?"
    }
  ]
}
```

### Category 2: Mostly-correct code (passes some tests, fails edge case)

Code that passes 2/3 or 3/5 test cases, with a single logic bug in an edge case.
The model response must:
- Open with a positive acknowledgement naming what is specifically correct
- State "I found 1 issue"
- Cite the line number in the body text
- Close with a question

**Training JSONL example:**
```json
{
  "id": "debug_mostly_correct_edge_case_001",
  "mode": "debug",
  "problem": "binary_search",
  "difficulty": "easy",
  "bug_count": 1,
  "category": "mostly_correct",
  "messages": [
    {
      "role": "system",
      "content": "[FULL UPDATED SYSTEM PROMPT FROM SECTION 4]"
    },
    {
      "role": "user",
      "content": "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution(object):\n    def search(self, nums, target):\n        left, right = 0, len(nums) - 1\n        while left <= right:\n            mid = (left + right) // 2\n            if nums[mid] == target:\n                return mid\n            elif nums[mid] < target:\n                left = mid + 1\n            else:\n                right = mid - 1\n        return 0\n```\n[TEST CASE DETAILS]\n2/3 tests passed — fails when target is not in the list\n[EXECUTION OUTPUT]\nTest 3: expected -1, got 0\n[USER MESSAGE]\nWhy is my binary search failing?"
    },
    {
      "role": "assistant",
      "content": "Your binary search logic is correct — the loop bounds, the mid calculation, and both comparisons are exactly right. I found **1 issue**.\n\n**Issue 1 — Line 10**\n```python\nreturn 0\n```\nLine 10 returns `0` when the target is not found, but `0` is also a valid index (the first element of the array). The problem specifies that you should return `-1` when the target doesn't exist in `nums`.\n\nWhat value should a search function return to signal 'not found'?"
    }
  ]
}
```

### Category 3: Multi-turn conversation (confusion → frustration)

A 4-message sequence: initial debug → student confused → student frustrated → resolution.
The model response must progressively simplify and adapt tone.

**Training JSONL example (multi-turn):**
```json
{
  "id": "debug_multiturn_confusion_frustration_001",
  "mode": "debug",
  "problem": "two_sum",
  "difficulty": "easy",
  "bug_count": 1,
  "category": "multi_turn",
  "messages": [
    {
      "role": "system",
      "content": "[FULL UPDATED SYSTEM PROMPT FROM SECTION 4]"
    },
    {
      "role": "user",
      "content": "[MODE: DEBUG]\n[SOURCE CODE]\n```python\ndef twoSum(self, nums, target):\n    for i in range(len(nums)):\n        for j in range(i + 1, len(nums)):\n            if nums[i] + nums[j] == target:\n                return [i, j]\n    return []\n```\n[TEST CASE DETAILS]\n0/3 tests passed\n[EXECUTION OUTPUT]\nAttributeError: 'Solution' object has no attribute 'twoSum'\n[USER MESSAGE]\nMy code keeps failing, can you help?"
    },
    {
      "role": "assistant",
      "content": "I found **1 issue** in your code.\n\n**Issue 1 — Line 1**\n```python\ndef twoSum(self, nums, target):\n```\nLine 1 uses `self` as the first parameter, but this function is not inside a class — it's a standalone function. Python is treating it as a regular function, so when you call it, the first argument you pass becomes `self`, and the remaining arguments shift. The method is not found on the `Solution` class because it's not inside it.\n\nLook at how the function is defined compared to the class structure. Where should this `def twoSum` line be indented?"
    },
    {
      "role": "user",
      "content": "I still don't understand. What do you mean it's not inside a class?"
    },
    {
      "role": "assistant",
      "content": "Let's zoom in on just the structure — forget the logic for a moment.\n\nIn Python, a method belongs to a class when it's indented inside the class block:\n\n```python\nclass Solution:          # class definition\n    def twoSum(self, ...):   # ← indented inside = belongs to the class\n        ...\n```\n\nRight now your code looks like:\n\n```python\nclass Solution:\n    pass\n\ndef twoSum(self, ...):   # ← NOT indented = standalone function, not part of Solution\n    ...\n```\n\nPython can't find `twoSum` on the `Solution` class because it's defined outside it.\n\nHow many spaces of indentation does `def twoSum` need to move inside the class?"
    },
    {
      "role": "user",
      "content": "I'm so confused, I want to give up. I'm not good at coding."
    },
    {
      "role": "assistant",
      "content": "Hey — pause for a second. What you're feeling right now is frustration, not a lack of ability. Indentation is one of the most disorienting things about Python when you're starting out — it trips up experienced developers too.\n\nLet's make this as simple as possible. Pick one:\n\n- **a)** `def twoSum` should have 0 spaces of indentation (same level as `class Solution`)\n- **b)** `def twoSum` should have 4 spaces of indentation (inside `class Solution`)\n\nYour loop logic is already correct — the algorithm works. This is purely a placement issue. Which option do you think it should be?"
    }
  ]
}
```

### Category 4: Tree/graph problem (model has no worked example for these)

Code with a tree or graph problem where the logic bug is structural (wrong accumulator,
wrong comparison, missing data structure). The model currently fails these because the
only in-prompt example is Two Sum.

**Training JSONL example:**
```json
{
  "id": "debug_tree_wrong_accumulator_001",
  "mode": "debug",
  "problem": "max_depth_binary_tree",
  "difficulty": "easy",
  "bug_count": 1,
  "category": "tree_graph",
  "messages": [
    {
      "role": "system",
      "content": "[FULL UPDATED SYSTEM PROMPT FROM SECTION 4]"
    },
    {
      "role": "user",
      "content": "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n    def maxDepth(self, root):\n        if not root:\n            return 0\n        return 1 + self.maxDepth(root.left) + self.maxDepth(root.right)\n```\n[TEST CASE DETAILS]\n0/3 tests passed\n[EXECUTION OUTPUT]\nExpected 3, got 4 (tree [3,9,20,null,null,15,7])\n[USER MESSAGE]\nCan you find the bug in my tree solution?"
    },
    {
      "role": "assistant",
      "content": "Your recursion structure and base case are correct — that's the hard part, and you've got it. I found **1 issue**.\n\n**Issue 1 — Line 5**\n```python\nreturn 1 + self.maxDepth(root.left) + self.maxDepth(root.right)\n```\nLine 5 adds the depths of the left and right subtrees together. But the problem asks for the **maximum** depth of the tree, not the combined depth. For the tree `[3, 9, 20, null, null, 15, 7]`, the left subtree has depth 1 and the right has depth 2 — your code returns 1+1+2 = 4, but the correct answer is 1+2 = 3 (taking the deeper branch, not summing both).\n\nWhich Python built-in returns the larger of two values instead of adding them?"
    }
  ]
}
```

---

## 7. LLM-as-Judge Evaluation Rubric

Use this rubric to score DEBUG responses with GPT-4o or Claude when running
`evaluate_debug_quality.py`. Score each dimension 1–5. Responses scoring below 3.5
average should trigger a prompt revision.

| Dimension | 1 (Poor) | 3 (Acceptable) | 5 (Excellent) |
|-----------|----------|----------------|---------------|
| **Completeness** | Misses at least one bug | Finds the primary bug | Finds ALL bugs including dead-code bugs, states accurate count |
| **Source analysis** | Just echoes stderr | Explains what's wrong | Cites specific line numbers in prose body, explains WHY the line is wrong, not just WHAT |
| **Pedagogical quality** | Gives the corrected code directly | Asks a question | Asks a targeted question at exactly the right difficulty level for the student's current state |
| **Tone** | Robotic, cold | Neutral | Warm, conversational, uses "let's", acknowledges what the student got right |
| **Multi-turn awareness** | Repeats previous response verbatim | Acknowledges the follow-up | Progressively simplifies, adapts to confusion level, uses analogy or multiple choice when needed |
| **Closing question** | Ends with a statement | Ends with a question | Ends with a focused, answerable question that directly targets the most critical bug |

### Regression test coverage targets

The gold eval set of 20 scenarios must cover:

| Scenario type | Count | Purpose |
|--------------|-------|---------|
| Single bug — syntax error | 3 | Baseline correctness |
| Single bug — logic error | 3 | Source-code-only detection |
| Multi-bug — syntax + logic (dead code) | 4 | Dead-code rule (Fix A) |
| Mostly-correct code — edge case | 3 | Positive opener (Fix D) |
| Tree/graph/DP problem | 4 | Novel problem generalisation |
| Multi-turn — confusion then frustration | 3 | Progressive simplification |

---

## 8. When Fine-Tuning IS Justified

Only one mode genuinely requires SFT on this project:

### TEACHING mode — novel output schema

The `[EXPLAIN]` / `[TEMPLATE]` / `[GUIDE]` structure with `____` blanks in code templates
does not exist anywhere in Qwen 2.5's pre-training data. No amount of system prompt
instruction will make the base model reliably produce this exact format. This is the
textbook SFT use case: teaching a new output schema, not teaching knowledge.

| Mode | Fine-Tune? | Reason |
|------|-----------|--------|
| TEACHING | ✅ Yes | `[TEMPLATE]` + `____` blank format is novel — prompt alone insufficient |
| DEBUG | ❌ No | All 4 root causes are prompt-fixable; generalises to any problem type |
| EXPLAIN | ❌ No | Already uses base model (adapter disabled); working well |
| FOLLOWUP | ❌ No | Short natural-language replies; base model handles correctly |

---

## 9. Recommended Architecture Going Forward

```
                    Student submits code
                            │
                     detect_mode()       ← edit prompts.py to change behaviour
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
    TEACHING              DEBUG            EXPLAIN / FOLLOWUP
       │                    │                    │
Fine-tuned LoRA       Prompt-only          Base model only
([TEMPLATE] format)   (Fixes A–E above)    (already working)
```

**Why this is production-grade:**
- DEBUG quality is improved by editing a text file, not a 6-hour training run
- Any new problem (dijkstra, segment tree, Fenwick tree) is handled by the base model's
  general reasoning — no new training data needed
- TEACHING mode format is locked in by the one legitimate SFT use case
- `evaluate_debug_quality.py` is the feedback loop — measure, fix prompt, measure again

---

## 10. Action Plan

| Priority | Action | File | Est. Time |
|:---:|--------|------|----------|
| 🔴 1 | Replace DEBUG section with complete prompt from Section 4 | `llm/scripts/prompts.py` | 10 min |
| 🔴 2 | Add multi-turn and tone instructions from Section 5 | `llm/scripts/prompts.py` | 5 min |
| 🔴 3 | Rebuild Docker image | terminal | 5 min |
| 🟡 4 | Generate 15 Cat 1 examples (multi-bug dead code) | `llm/scripts/generate_diverse_dataset.py` | 30 min |
| 🟡 5 | Generate 15 Cat 2 examples (mostly-correct) | `llm/scripts/generate_diverse_dataset.py` | 30 min |
| 🟡 6 | Generate 15 Cat 3 examples (multi-turn sequences) | `llm/scripts/generate_diverse_dataset.py` | 45 min |
| 🟡 7 | Generate 15 Cat 4 examples (tree/graph/DP) | `llm/scripts/generate_diverse_dataset.py` | 30 min |
| 🟡 8 | Re-run Phase 3 eval and compare against baseline | terminal | 10 min |
| 🟢 9 | Build LLM-as-Judge pipeline using rubric in Section 7 | `llm/scripts/evaluate_debug_quality.py` | 2h |
| 🟢 10 | Retrain only if TEACHING format breaks after rebuild | `llm/scripts/train.py` | 4–6h |

**Expected outcome after steps 1–3 (prompt fix only, no retraining):**

| Check | Current | After Prompt Fix |
|-------|---------|-----------------|
| BugCnt | 70% (14/20) | ~90% (18/20) |
| SrcCit | 65% (13/20) | ~90% (18/20) |
| GuidQ | 75% (15/20) | ~95% (19/20) |
| PosFrm | 90% (18/20) | ~98% (20/20) |
| NoDupe | 100% | 100% (unchanged) |
| NoLeak | 100% | 100% (unchanged) |
| **All pass** | **50% (10/20)** | **~80–85% (16–17/20)** |

After steps 4–8 (training data + eval):

| Check | After Training Data | Rationale |
|-------|---------------------|-----------|
| BugCnt | ~95% (19/20) | 60 new examples demonstrate multi-bug + dead-code analysis |
| SrcCit | ~95% (19/20) | Every new example cites line in prose body |
| GuidQ | ~98% (20/20) | Every new example ends with "?" |
| **All pass** | **~90%+** | Remaining failures will be edge cases in novel problems |

---

## 11. How to Measure After Applying Fixes

```bash
# After rebuilding Docker:
python llm/scripts/evaluate_debug_quality.py \
  --data llm/data/eval_debug_gold.jsonl \
  --output llm/data/eval_after_prompt_fixes.json \
  --compare llm/data/eval_baseline_before_v53.json

# The --compare flag outputs ▲/▼ deltas per check per scenario.
# If a specific fix didn't move the needle, the prompt wording needs
# adjustment — iterate without retraining.
```

If `BugCnt` doesn't improve for `two_sum_multibug_001` after the dead-code rule is
added, the model is ignoring it. In that case, move the dead-code rule earlier in the
prompt (before Step 1, not after) and make it a bulleted list — the model attends more
reliably to content at the top of a section and to bullet points over prose paragraphs.

---

## 12. Summary

The 10 eval failures have 4 precise root causes, all in the system prompt, not in the
model weights.

- **Fix A** (dead-code rule): Forces the model to read every line independently, even
  after a fatal error on a previous line. Targets the most dangerous failure mode —
  the model reporting 1 bug when there are 2.

- **Fix B** (line number in prose): Requires the body text of every issue explanation to
  begin with "Line X..." — not just the header. Closes 7 of the 10 SrcCit failures.

- **Fix C** (mandatory closing question): Makes the final-sentence-must-be-a-question
  rule explicit and non-negotiable. Closes 5 GuidQ failures that ended with a period.

- **Fix D** (mostly-correct opener): Adds a protocol at the very start of DEBUG mode
  that checks test pass rate and opens with a specific positive statement when the
  student got most of it right.

- **Fix E** (second worked example): Adds a tree/graph example alongside the Two Sum
  example, giving the model a concrete template for the 8 failures that were on
  tree/graph/DP problems.

All five fixes are edits to a single Python string in `prompts.py`. The complete
replacement prompt block is in **Section 4** and is ready to copy-paste. Fine-tuning
remains justified only for TEACHING mode's novel `[TEMPLATE]` + `____` output schema,
which cannot be reliably produced by any prompt instruction alone.
