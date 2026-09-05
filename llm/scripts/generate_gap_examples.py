#!/usr/bin/env python3
"""
generate_gap_examples.py  —  Section 6 Gap Training Data Generator (v5.3)

Generates 60 new DEBUG training examples covering the 4 gap categories identified
in ENGINEERING_RECOMMENDATION.md Section 6.  Each example uses the current
FINETUNED_SYSTEM_PROMPT verbatim so training data and inference are in sync.

Categories (15 examples each):
  Cat 1 — Multi-bug with dead code   (SyntaxError/NameError masks a second bug)
  Cat 2 — Mostly-correct edge case   (passes some tests, fails 1 edge case)
  Cat 3 — Multi-turn sequences       (confusion → frustration → resolution)
  Cat 4 — Tree / Graph / DP problems (novel domains the model sees no worked example for)

Output: llm/data/gap_debug_examples.jsonl (appended to existing training data by
        update_system_prompts.py in a later step)

Usage:
  cd llm
  python scripts/generate_gap_examples.py
  python scripts/generate_gap_examples.py --output data/my_custom_output.jsonl
  python scripts/generate_gap_examples.py --validate   # dry-run: validate without writing
"""

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Import the canonical system prompt
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from prompts import FINETUNED_SYSTEM_PROMPT

_DEFAULT_OUTPUT = _SCRIPTS_DIR.parent / "data" / "gap_debug_examples.jsonl"

SYS = FINETUNED_SYSTEM_PROMPT   # shorthand used throughout


# ===========================================================================
# CATEGORY 1 — Multi-bug with dead code (15 examples)
# At least one SyntaxError or NameError that makes the test runner miss a
# second bug hiding in unreachable code.
# ===========================================================================

CAT1 = [
    # ---- 1 ----------------------------------------------------------------
    {
        "id": "gap_cat1_two_sum_syntax_plus_return_001",
        "mode": "debug", "problem": "two_sum", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def twoSum(self, nums, target):\n"
                "        for i in range(len(nums)):\n"
                "            for j in range(i + 1, len(nums)):\n"
                "                if nums[i] + nums[j] == :\n"
                "                    return []\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: invalid syntax (line 5)\n"
                "[USER MESSAGE]\nCan you find the bugs?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code. Let's start with the one stopping it from running.\n\n"
                "**Issue 1 — Line 5**\n```python\nif nums[i] + nums[j] == :\n```\n"
                "Line 5 has `==` with nothing on the right — Python raises a SyntaxError because "
                "the comparison is incomplete. Every test fails before any logic runs.\n\n"
                "Your function header is `twoSum(self, nums, target)`. You're comparing the sum to... "
                "which of those parameters is the value you're looking for?\n\n"
                "**Issue 2 — Line 6**\n```python\nreturn []\n```\n"
                "Line 6 returns an empty list. Because line 5's SyntaxError prevents execution, "
                "the test runner never reached this line — but once you fix Issue 1, every test will "
                "still fail here. The problem asks for the **indices** of the matching numbers. "
                "What two variables inside your loops already hold those positions?\n\n"
                "---\nLet's fix Issue 1 first since the code cannot run at all until line 5 is valid. "
                "What value should go after `==`?"
            )},
        ]
    },
    # ---- 2 ----------------------------------------------------------------
    {
        "id": "gap_cat1_binary_search_nameerror_plus_return_001",
        "mode": "debug", "problem": "binary_search", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def search(self, nums, target):\n"
                "        left, right = 0, len(num) - 1\n"
                "        while left <= right:\n"
                "            mid = (left + right) // 2\n"
                "            if nums[mid] == target:\n"
                "                return mid\n"
                "            elif nums[mid] < target:\n"
                "                left = mid + 1\n"
                "            else:\n"
                "                right = mid - 1\n"
                "        return 0\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'num' is not defined (line 3)\n"
                "[USER MESSAGE]\nWhat's wrong with my code?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 3**\n```python\nleft, right = 0, len(num) - 1\n```\n"
                "Line 3 references `num`, but your parameter is `nums` (with an `s`). Python raises a "
                "NameError before any test can run. Look at your function signature: "
                "`def search(self, nums, target)` — what is the list parameter called?\n\n"
                "**Issue 2 — Line 12**\n```python\nreturn 0\n```\n"
                "Line 12 returns `0` when the target is not found. But `0` is also a valid index — "
                "the first position in the array. The test runner never reached this line because of "
                "the NameError on line 3, but once you fix that, tests where the target doesn't exist "
                "will still fail. What value conventionally signals 'not found' in a search function?\n\n"
                "---\nLet's fix Issue 1 first. What one-letter change does `num` on line 3 need?"
            )},
        ]
    },
    # ---- 3 ----------------------------------------------------------------
    {
        "id": "gap_cat1_contains_duplicate_syntax_plus_logic_001",
        "mode": "debug", "problem": "contains_duplicate", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def containsDuplicate(self, nums):\n"
                "        seen = {}\n"
                "        for num in nums:\n"
                "            if num in seen\n"
                "                return True\n"
                "            seen[num] = 1\n"
                "        return False\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 5)\n"
                "[USER MESSAGE]\nI get a syntax error, help?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 5**\n```python\nif num in seen\n```\n"
                "Line 5 is missing the colon at the end of the `if` statement — Python requires every "
                "`if` line to end with `:`. This SyntaxError prevents any test from running.\n\n"
                "What single character needs to be added to the end of line 5?\n\n"
                "**Issue 2 — Line 3**\n```python\nseen = {}\n```\n"
                "Line 3 creates `seen` as a **dictionary** (`{}`), not a **set** (`set()`). Both work "
                "for membership testing, but a set is the conventional choice for tracking presence "
                "without extra values. More importantly, when you add to `seen` on line 7 with "
                "`seen[num] = 1`, that's a dict operation — using `set()` with `.add()` would be "
                "cleaner and faster. The test runner hasn't reached this line yet due to Issue 1, "
                "but it's worth fixing at the same time. "
                "Which Python type stores unique items with no associated values?\n\n"
                "---\nLet's fix Issue 1 first since it blocks everything. What goes at the end of line 5?"
            )},
        ]
    },
    # ---- 4 ----------------------------------------------------------------
    {
        "id": "gap_cat1_valid_parentheses_nameerror_plus_return_001",
        "mode": "debug", "problem": "valid_parentheses", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def isValid(self, s):\n"
                "        stck = []\n"
                "        pairs = {')': '(', '}': '{', ']': '['}\n"
                "        for char in s:\n"
                "            if char in pairs:\n"
                "                if not stack or stack[-1] != pairs[char]:\n"
                "                    return False\n"
                "                stack.pop()\n"
                "            else:\n"
                "                stack.append(char)\n"
                "        return stack == []\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'stack' is not defined (line 7)\n"
                "[USER MESSAGE]\nWhat's the bug?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 3 / Lines 7–11**\n```python\nstck = []\n```\n"
                "Line 3 names the stack `stck` (missing the `a`), but lines 7, 9, and 11 all reference "
                "`stack`. Python raises NameError on line 7 because `stack` was never defined — only "
                "`stck` was. Compare line 3 carefully with lines 7, 9, and 11: do those two names match?\n\n"
                "**Issue 2 — Line 12**\n```python\nreturn stack == []\n```\n"
                "Line 12 checks `stack == []` to return `True` when everything is balanced. But `[]` "
                "evaluates as falsy — you could write `return not stack` instead, and more importantly "
                "the variable name here will also fail once you fix Issue 1 (it needs to match line 3). "
                "The test runner never reached this line because of the NameError, so both issues need "
                "fixing. What does an empty stack tell us about the validity of the input?\n\n"
                "---\nLet's fix Issue 1 first. What should `stck` on line 3 be renamed to so it "
                "matches lines 7, 9, and 11?"
            )},
        ]
    },
    # ---- 5 ----------------------------------------------------------------
    {
        "id": "gap_cat1_reverse_list_syntax_plus_pointer_001",
        "mode": "debug", "problem": "reverse_linked_list", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def reverseList(self, head):\n"
                "        prev = None\n"
                "        curr = head\n"
                "        while curr\n"
                "            nxt = curr.next\n"
                "            curr.next = prev\n"
                "            prev = curr\n"
                "            curr = nxt\n"
                "        return prev\n```\n"
                "[TEST CASE DETAILS]\n0/2 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 5)\n"
                "[USER MESSAGE]\nIt doesn't work!"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 5**\n```python\nwhile curr\n```\n"
                "Line 5 is missing the colon at the end of the `while` statement. Every compound "
                "statement in Python (`while`, `for`, `if`, `def`, etc.) must end with `:`. "
                "This SyntaxError stops all tests from running.\n\n"
                "What single character is missing at the end of line 5?\n\n"
                "**Issue 2 — Line 6**\n```python\nnxt = curr.next\n```\n"
                "Line 6 saves the next node into `nxt`. This is correct and necessary — but once you "
                "fix Issue 1 and the code runs, you'll notice that `nxt` is a variable name that "
                "doesn't cause an error yet. However, reading the full loop: "
                "line 7 does `curr.next = prev` (reversing the pointer), line 8 advances `prev`, "
                "and line 9 does `curr = nxt` — so the temporary variable on line 6 is actually "
                "correct. The algorithm is structurally fine once the syntax issue is resolved. "
                "Let's focus on line 5 first.\n\n"
                "---\nWhat character needs to be added to the end of `while curr` on line 5?"
            )},
        ]
    },
    # ---- 6 ----------------------------------------------------------------
    {
        "id": "gap_cat1_merge_lists_nameerror_plus_tail_001",
        "mode": "debug", "problem": "merge_two_sorted_lists", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def mergeTwoLists(self, l1, l2):\n"
                "        dummy = ListNode(0)\n"
                "        cur = dummi\n"
                "        while l1 and l2:\n"
                "            if l1.val <= l2.val:\n"
                "                cur.next = l1\n"
                "                l1 = l1.next\n"
                "            else:\n"
                "                cur.next = l2\n"
                "                l2 = l2.next\n"
                "            cur = cur.next\n"
                "        cur.next = l1 or l2\n"
                "        return dummy\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'dummi' is not defined (line 4)\n"
                "[USER MESSAGE]\nPlease fix my code"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 4**\n```python\ncur = dummi\n```\n"
                "Line 4 references `dummi` (typo — missing the `y`), but the variable created on "
                "line 3 is `dummy`. Python raises NameError immediately. "
                "What does line 3 name the sentinel node?\n\n"
                "**Issue 2 — Line 14**\n```python\nreturn dummy\n```\n"
                "Line 14 returns `dummy`, which is the sentinel node you created as a placeholder — "
                "its `val` is `0` and it sits before the actual merged list. The test runner never "
                "reached this line because of Issue 1, but once you fix the typo, every test will "
                "still return a list starting with a spurious `0`. "
                "What property of `dummy` gives you the actual start of the merged list?\n\n"
                "---\nLet's fix Issue 1 first. What should `dummi` on line 4 be corrected to?"
            )},
        ]
    },
    # ---- 7 ----------------------------------------------------------------
    {
        "id": "gap_cat1_three_sum_syntax_plus_dedup_001",
        "mode": "debug", "problem": "three_sum", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def threeSum(self, nums):\n"
                "        nums.sort()\n"
                "        result = []\n"
                "        for i in range(len(nums) - 2)\n"
                "            left, right = i + 1, len(nums) - 1\n"
                "            while left < right:\n"
                "                s = nums[i] + nums[left] + nums[right]\n"
                "                if s == 0:\n"
                "                    result.append([nums[i], nums[left], nums[right]])\n"
                "                    left += 1\n"
                "                    right -= 1\n"
                "                elif s < 0:\n"
                "                    left += 1\n"
                "                else:\n"
                "                    right -= 1\n"
                "        return result\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 5)\n"
                "[USER MESSAGE]\nI get a syntax error, can you help?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 5**\n```python\nfor i in range(len(nums) - 2)\n```\n"
                "Line 5 is missing the colon at the end of the `for` statement. "
                "Python requires every loop header to end with `:`. "
                "This SyntaxError prevents any tests from running.\n\n"
                "What character is missing at the very end of line 5?\n\n"
                "**Issue 2 — Lines 11–12**\n```python\nleft += 1\nright -= 1\n```\n"
                "Lines 11–12 advance the two pointers after finding a valid triplet — but there's no "
                "duplicate-skipping logic. If `nums = [-2, 0, 0, 2, 2]`, your code will add `[-2, 0, 2]` "
                "twice. The test runner never reached this point because of Issue 1, so you wouldn't "
                "have seen this failure yet. After fixing Issue 1, you'll need to skip over duplicate "
                "values for `left` and `right` whenever you find a match. "
                "How would you move `left` forward past duplicate values after appending a result?\n\n"
                "---\nLet's fix Issue 1 first — add the missing character to line 5. What is it?"
            )},
        ]
    },
    # ---- 8 ----------------------------------------------------------------
    {
        "id": "gap_cat1_climbing_stairs_syntax_plus_init_001",
        "mode": "debug", "problem": "climbing_stairs", "difficulty": "easy",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def climbStairs(self, n):\n"
                "        if n <= 1\n"
                "            return n\n"
                "        a, b = 0, 1\n"
                "        for _ in range(n):\n"
                "            a, b = b, a + b\n"
                "        return b\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 3)\n"
                "[USER MESSAGE]\nWhat's wrong?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 3**\n```python\nif n <= 1\n```\n"
                "Line 3 is missing the colon at the end of the `if` statement. "
                "This SyntaxError stops all tests immediately.\n\n"
                "What character needs to go at the end of line 3?\n\n"
                "**Issue 2 — Line 5**\n```python\na, b = 0, 1\n```\n"
                "Line 5 initialises `a = 0, b = 1`. For Fibonacci-based stair climbing the base "
                "values should be `1, 1` (one way to reach step 1, one way to reach step 2). "
                "With `a = 0`, after `n` iterations the loop produces `b` that is off by one for "
                "most inputs. The test runner never reached line 5 because of Issue 1, but this "
                "logic bug will surface once you fix the syntax. "
                "If there is exactly `1` way to climb 1 stair and `1` way to climb 2 stairs, "
                "what should `a` and `b` start as?\n\n"
                "---\nFix Issue 1 first. What single character is missing from the end of line 3?"
            )},
        ]
    },
    # ---- 9 ----------------------------------------------------------------
    {
        "id": "gap_cat1_max_subarray_nameerror_plus_init_001",
        "mode": "debug", "problem": "maximum_subarray", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def maxSubArray(self, nums):\n"
                "        current = num[0]\n"
                "        best = nums[0]\n"
                "        for n in nums[1:]:\n"
                "            current = max(n, current + n)\n"
                "            best = max(best, current)\n"
                "        return best\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'num' is not defined (line 3)\n"
                "[USER MESSAGE]\nI can't figure out what's wrong"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 3**\n```python\ncurrent = num[0]\n```\n"
                "Line 3 references `num[0]`, but your parameter is `nums` (plural). "
                "Python raises NameError before any logic runs. "
                "Compare line 3 with lines 4 and 5 — what is the parameter called in those lines?\n\n"
                "**Issue 2 — Line 3 / Line 4**\n```python\ncurrent = num[0]\nbest = nums[0]\n```\n"
                "Even after fixing the typo, initialising both `current` and `best` to `nums[0]` is "
                "correct for the general case — but will fail on the all-negative input test. "
                "Actually, `nums[0]` initialisation is fine for Kadane's algorithm; the algorithm "
                "itself on lines 5–7 is correct. Once you fix Issue 1 the logic should pass. "
                "Let's focus on the NameError.\n\n"
                "---\nWhat should `num` on line 3 be corrected to?"
            )},
        ]
    },
    # ---- 10 ---------------------------------------------------------------
    {
        "id": "gap_cat1_product_except_self_syntax_plus_prefix_001",
        "mode": "debug", "problem": "product_of_array_except_self", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def productExceptSelf(self, nums):\n"
                "        n = len(nums)\n"
                "        result = [1] * n\n"
                "        prefix = 1\n"
                "        for i in range(n)\n"
                "            result[i] *= prefix\n"
                "            prefix *= nums[i]\n"
                "        suffix = 1\n"
                "        for i in range(n - 1, -1, -1):\n"
                "            result[i] *= suffix\n"
                "            suffix *= nums[i]\n"
                "        return result\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 6)\n"
                "[USER MESSAGE]\nMy code has a bug, help!"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 6**\n```python\nfor i in range(n)\n```\n"
                "Line 6 is missing the colon at the end of the `for` loop header. "
                "This SyntaxError prevents execution entirely.\n\n"
                "What is missing at the end of line 6?\n\n"
                "**Issue 2 — Lines 7–8 (prefix loop order)**\n```python\nresult[i] *= prefix\nprefix *= nums[i]\n```\n"
                "Lines 7–8 look correct at first glance — multiply result by prefix, then update prefix. "
                "This is the standard prefix-product pattern: you use the prefix **before** including "
                "`nums[i]`, which is exactly what you want. So once you fix Issue 1, the prefix pass "
                "is actually correct. The suffix pass on lines 10–12 follows the same correct pattern. "
                "The algorithm is fine — just the missing colon is blocking everything.\n\n"
                "---\nAdd the colon to line 6. What should the end of that line look like?"
            )},
        ]
    },
    # ---- 11 ---------------------------------------------------------------
    {
        "id": "gap_cat1_word_search_nameerror_plus_bounds_001",
        "mode": "debug", "problem": "word_search", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def exist(self, board, word):\n"
                "        rows, cols = len(bord), len(board[0])\n"
                "        visited = set()\n"
                "        def dfs(r, c, idx):\n"
                "            if idx == len(word): return True\n"
                "            if r < 0 or r >= rows or c < 0 or c >= cols: return False\n"
                "            if (r, c) in visited or board[r][c] != word[idx]: return False\n"
                "            visited.add((r, c))\n"
                "            res = (dfs(r+1,c,idx+1) or dfs(r-1,c,idx+1) or\n"
                "                   dfs(r,c+1,idx+1) or dfs(r,c-1,idx+1))\n"
                "            visited.remove((r, c))\n"
                "            return res\n"
                "        for r in range(rows):\n"
                "            for c in range(cols):\n"
                "                if dfs(r, c, 0): return True\n"
                "        return False\n```\n"
                "[TEST CASE DETAILS]\n0/2 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'bord' is not defined (line 3)\n"
                "[USER MESSAGE]\nWhat's the bug?"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 3**\n```python\nrows, cols = len(bord), len(board[0])\n```\n"
                "Line 3 references `bord` (missing the `a`), but your parameter is `board`. "
                "Python raises NameError before any search runs. "
                "What is the parameter called in your function signature on line 2?\n\n"
                "**Issue 2 — Lines 9–11 (visited set vs board mutation)**\n"
                "```python\nvisited.add((r, c))\n...\nvisited.remove((r, c))\n```\n"
                "Lines 9 and 12 use a separate `visited` set for backtracking. This is correct "
                "and works, but uses O(m×n) extra memory. The test runner never reached this code "
                "because of Issue 1. Once you fix the typo, the algorithm itself is sound — "
                "the backtracking (add before recursion, remove after) is implemented correctly. "
                "This is a style/memory note, not a correctness bug.\n\n"
                "---\nLet's fix Issue 1: what should `bord` be corrected to on line 3?"
            )},
        ]
    },
    # ---- 12 ---------------------------------------------------------------
    {
        "id": "gap_cat1_number_of_islands_syntax_plus_count_001",
        "mode": "debug", "problem": "number_of_islands", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def numIslands(self, grid):\n"
                "        count = 0\n"
                "        def dfs(r, c)\n"
                "            if r < 0 or r >= len(grid) or c < 0 or c >= len(grid[0]): return\n"
                "            if grid[r][c] != '1': return\n"
                "            grid[r][c] = '0'\n"
                "            dfs(r+1,c); dfs(r-1,c); dfs(r,c+1); dfs(r,c-1)\n"
                "        for r in range(len(grid)):\n"
                "            for c in range(len(grid[0])):\n"
                "                if grid[r][c] == '1':\n"
                "                    dfs(r, c)\n"
                "        return count\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 4)\n"
                "[USER MESSAGE]\nHelp me find what's wrong"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 4**\n```python\ndef dfs(r, c)\n```\n"
                "Line 4 defines the `dfs` helper function but is missing the colon. "
                "Every `def` statement must end with `:`. This SyntaxError blocks everything.\n\n"
                "What character is missing at the end of line 4?\n\n"
                "**Issue 2 — Line 3 / Line 12**\n```python\ncount = 0\n...\n# count never incremented\n```\n"
                "Line 3 initialises `count = 0`, and line 12 calls `dfs` when an island is found — "
                "but nowhere does the code do `count += 1`. Once you fix Issue 1, the function will "
                "run and correctly mark visited cells, but it will always return `0`. "
                "The test runner never reached line 12 because of the SyntaxError, so this bug "
                "was invisible. Where in the outer loop should `count` be incremented?\n\n"
                "---\nFix Issue 1 first — add the colon to line 4. What should the line end with?"
            )},
        ]
    },
    # ---- 13 ---------------------------------------------------------------
    {
        "id": "gap_cat1_longest_substring_nameerror_plus_window_001",
        "mode": "debug", "problem": "longest_substring_without_repeating", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def lengthOfLongestSubstring(self, s):\n"
                "        char_set = set()\n"
                "        left = 0\n"
                "        max_len = 0\n"
                "        for right in range(len(stri)):\n"
                "            while s[right] in char_set:\n"
                "                char_set.remove(s[left])\n"
                "                left += 1\n"
                "            char_set.add(s[right])\n"
                "            max_len = max(max_len, right - left)\n"
                "        return max_len\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nNameError: name 'stri' is not defined (line 6)\n"
                "[USER MESSAGE]\nMy code doesn't work, please help"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 6**\n```python\nfor right in range(len(stri)):\n```\n"
                "Line 6 references `stri`, but your parameter is `s`. "
                "Python raises NameError immediately. "
                "What is the string parameter called in your function signature on line 2?\n\n"
                "**Issue 2 — Line 11**\n```python\nmax_len = max(max_len, right - left)\n```\n"
                "Line 11 calculates the window size as `right - left`. But the window from index "
                "`left` to `right` (inclusive) has length `right - left + 1`, not `right - left`. "
                "The test runner never reached this line because of Issue 1, but once you fix the "
                "NameError, every result will be off by 1. "
                "If `left = 0` and `right = 2`, how many characters are in the window?\n\n"
                "---\nLet's fix Issue 1 first. What should `stri` on line 6 be changed to?"
            )},
        ]
    },
    # ---- 14 ---------------------------------------------------------------
    {
        "id": "gap_cat1_coin_change_syntax_plus_init_001",
        "mode": "debug", "problem": "coin_change", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def coinChange(self, coins, amount):\n"
                "        dp = [float('inf')] * (amount + 1)\n"
                "        dp[0] = 0\n"
                "        for coin in coins\n"
                "            for a in range(coin, amount + 1):\n"
                "                dp[a] = min(dp[a], dp[a - coin] + 1)\n"
                "        return dp[amount] if dp[amount] != float('inf') else -1\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 5)\n"
                "[USER MESSAGE]\nSyntax error on line 5?"
            )},
            {"role": "assistant", "content": (
                "I found **1 issue** in your code (the algorithm logic is correct).\n\n"
                "**Issue 1 — Line 5**\n```python\nfor coin in coins\n```\n"
                "Line 5 is missing the colon at the end of the `for` statement. "
                "Once you add it, the DP logic on lines 6–7 is correct: you iterate from `coin` to "
                "`amount` (bottom-up), take the minimum of keeping `dp[a]` or using one more `coin` "
                "to reach `dp[a - coin]`, and the final check on line 8 correctly returns `-1` when "
                "no solution exists.\n\n"
                "What single character needs to be added to the end of line 5?"
            )},
        ]
    },
    # ---- 15 ---------------------------------------------------------------
    {
        "id": "gap_cat1_jump_game_syntax_plus_logic_001",
        "mode": "debug", "problem": "jump_game", "difficulty": "medium",
        "bug_count": 2, "category": "multi_bug_dead_code",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def canJump(self, nums):\n"
                "        max_reach = 0\n"
                "        for i, n in enumerate(nums)\n"
                "            if i > max_reach:\n"
                "                return False\n"
                "            max_reach = min(max_reach, i + n)\n"
                "        return True\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nSyntaxError: expected ':' (line 4)\n"
                "[USER MESSAGE]\nHelp!"
            )},
            {"role": "assistant", "content": (
                "I found **2 issues** in your code.\n\n"
                "**Issue 1 — Line 4**\n```python\nfor i, n in enumerate(nums)\n```\n"
                "Line 4 is missing the colon at the end of the `for` loop header. "
                "This SyntaxError prevents any test from running.\n\n"
                "What character is missing at the end of line 4?\n\n"
                "**Issue 2 — Line 7**\n```python\nmax_reach = min(max_reach, i + n)\n```\n"
                "Line 7 uses `min` to update `max_reach`. But `max_reach` should track the furthest "
                "index you **can** reach — that's the **maximum** of the current reach and `i + n`, "
                "not the minimum. With `min`, you'd shrink your reach on every step, making the "
                "function almost always return `False`. The test runner never reached this line "
                "because of Issue 1, so you wouldn't have seen this failure yet. "
                "Which Python built-in should replace `min` on line 7?\n\n"
                "---\nLet's fix Issue 1 first. What character goes at the end of line 4?"
            )},
        ]
    },
]


# ===========================================================================
# CATEGORY 2 — Mostly-correct code, single edge-case bug (15 examples)
# Code that passes some tests. Opener must acknowledge what is correct.
# ===========================================================================

CAT2 = [
    # ---- 1 ----------------------------------------------------------------
    {
        "id": "gap_cat2_binary_search_wrong_not_found_001",
        "mode": "debug", "problem": "binary_search", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def search(self, nums, target):\n"
                "        left, right = 0, len(nums) - 1\n"
                "        while left <= right:\n"
                "            mid = (left + right) // 2\n"
                "            if nums[mid] == target:\n"
                "                return mid\n"
                "            elif nums[mid] < target:\n"
                "                left = mid + 1\n"
                "            else:\n"
                "                right = mid - 1\n"
                "        return 0\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — fails when target is not in the list\n"
                "[EXECUTION OUTPUT]\nTest 3: expected -1, got 0\n"
                "[USER MESSAGE]\nWhy is my binary search failing?"
            )},
            {"role": "assistant", "content": (
                "Your binary search logic is exactly right — the loop bounds, the `mid` calculation, "
                "and both comparison branches are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Line 12**\n```python\nreturn 0\n```\n"
                "Line 12 returns `0` when the target is not found. But `0` is also a valid index — "
                "it's the first position in the array. If the target is missing and you return `0`, "
                "the caller cannot tell the difference between 'found at index 0' and 'not found'.\n\n"
                "What value does the problem specification say to return when the target is absent?"
            )},
        ]
    },
    # ---- 2 ----------------------------------------------------------------
    {
        "id": "gap_cat2_max_subarray_all_negative_001",
        "mode": "debug", "problem": "maximum_subarray", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def maxSubArray(self, nums):\n"
                "        current = 0\n"
                "        best = 0\n"
                "        for n in nums:\n"
                "            current = max(0, current + n)\n"
                "            best = max(best, current)\n"
                "        return best\n```\n"
                "[TEST CASE DETAILS]\n3/4 tests passed — fails on all-negative input\n"
                "[EXECUTION OUTPUT]\nTest 4: input=[-3,-2,-1], expected=-1, got=0\n"
                "[USER MESSAGE]\nMy code fails on one test case"
            )},
            {"role": "assistant", "content": (
                "Your Kadane's algorithm structure is correct for positive-sum cases — "
                "the `max(0, current + n)` reset and the running `best` are the right approach "
                "for most inputs. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 3–4 and Line 6**\n```python\ncurrent = 0\nbest = 0\n```\n"
                "Lines 3 and 4 initialise both `current` and `best` to `0`. When all numbers in "
                "`nums` are negative, every element is worse than `0`, so `current` resets to `0` "
                "each iteration and `best` never moves above `0`. The correct answer for `[-3, -2, -1]` "
                "is `-1` (the least-negative element), but your code returns `0`.\n\n"
                "The fix is to initialise `best` to `nums[0]` and start the loop from `nums[1:]`, "
                "so the worst possible answer is the first element rather than `0`. "
                "What should `best` be initialised to so it can correctly represent an all-negative input?"
            )},
        ]
    },
    # ---- 3 ----------------------------------------------------------------
    {
        "id": "gap_cat2_climbing_stairs_base_case_001",
        "mode": "debug", "problem": "climbing_stairs", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def climbStairs(self, n):\n"
                "        if n == 1:\n"
                "            return 1\n"
                "        a, b = 1, 1\n"
                "        for _ in range(n - 1):\n"
                "            a, b = b, a + b\n"
                "        return b\n```\n"
                "[TEST CASE DETAILS]\n4/5 tests passed — fails for n=2\n"
                "[EXECUTION OUTPUT]\nTest 2: input=2, expected=2, got=1\n"
                "[USER MESSAGE]\nWhy does n=2 fail?"
            )},
            {"role": "assistant", "content": (
                "Your Fibonacci-based approach and the iterative update `a, b = b, a + b` are correct. "
                "I found **1 issue**.\n\n"
                "**Issue 1 — Line 6**\n```python\nfor _ in range(n - 1):\n```\n"
                "Line 6 runs `n - 1` iterations. When `n = 2`, that's 1 iteration: starting from "
                "`a=1, b=1`, after one step `a=1, b=2` — so `b` becomes `2`, which is correct. "
                "Actually, let's trace more carefully: `range(n - 1)` for `n = 2` gives `range(1)`, "
                "which is one iteration. `a, b = b, a + b` → `a=1, b=2`. Returns `2`. "
                "That seems right. Let me re-read...\n\n"
                "The actual issue is the range: for `n = 2`, `range(n - 1) = range(1)` runs once, "
                "giving `b = 2` — correct. For `n = 1`, the early return catches it. "
                "The loop should run `n - 1` times for n ≥ 2, which it does. "
                "Actually looking again at the test failure — let me check the initialisation: "
                "`a, b = 1, 1` means step 1 = 1 way, step 2 = 1 way. After 1 iteration for n=2: "
                "`b = 1 + 1 = 2`. That is correct. Could the test runner be off?\n\n"
                "Wait — the range is `n - 1` but should it be `n - 2`? For n=3: "
                "`range(2)` → 2 iterations from `(1,1)` → `(1,2)` → `(2,3)` → returns 3. Correct. "
                "The logic appears sound. Can you paste the full test output so we can "
                "investigate exactly which assertion is failing?"
            )},
        ]
    },
    # ---- 4 ----------------------------------------------------------------
    {
        "id": "gap_cat2_valid_palindrome_case_001",
        "mode": "debug", "problem": "valid_palindrome", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def isPalindrome(self, s):\n"
                "        cleaned = [c for c in s if c.isalnum()]\n"
                "        return cleaned == cleaned[::-1]\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — fails on mixed-case input\n"
                "[EXECUTION OUTPUT]\nTest 3: input='A man a plan a canal Panama', expected=True, got=False\n"
                "[USER MESSAGE]\nWhy does 'A man a plan a canal Panama' return False?"
            )},
            {"role": "assistant", "content": (
                "Your approach is clean and concise — filtering alphanumeric characters and comparing "
                "against the reverse is exactly the right strategy. I found **1 issue**.\n\n"
                "**Issue 1 — Line 3**\n```python\ncleaned = [c for c in s if c.isalnum()]\n```\n"
                "Line 3 keeps alphanumeric characters but doesn't normalise their case. "
                "For `'A man a plan a canal Panama'`, `cleaned` will contain `['A', 'm', 'a', 'n', ...]` "
                "with uppercase `A` and `P`. When compared to the reverse, `'A'` does not equal `'a'`, "
                "so the palindrome check fails even though the string is logically a palindrome.\n\n"
                "What method converts a character to lowercase in Python, and where in line 3 "
                "would you apply it?"
            )},
        ]
    },
    # ---- 5 ----------------------------------------------------------------
    {
        "id": "gap_cat2_merge_lists_returns_dummy_001",
        "mode": "debug", "problem": "merge_two_sorted_lists", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def mergeTwoLists(self, l1, l2):\n"
                "        dummy = ListNode(0)\n"
                "        cur = dummy\n"
                "        while l1 and l2:\n"
                "            if l1.val <= l2.val:\n"
                "                cur.next = l1\n"
                "                l1 = l1.next\n"
                "            else:\n"
                "                cur.next = l2\n"
                "                l2 = l2.next\n"
                "            cur = cur.next\n"
                "        cur.next = l1 or l2\n"
                "        return dummy\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected [1,1,2,3,4,4], got [0,1,1,2,3,4,4]\n"
                "[USER MESSAGE]\nWhy does it add a 0 at the start?"
            )},
            {"role": "assistant", "content": (
                "Your merge logic is correct — the while loop, the pointer comparisons, and "
                "attaching the remaining tail on line 13 all work exactly right. I found **1 issue**.\n\n"
                "**Issue 1 — Line 14**\n```python\nreturn dummy\n```\n"
                "Line 14 returns `dummy`, which is the sentinel node you created on line 3 with "
                "`val = 0`. It exists only as a placeholder so `cur` has somewhere to start — "
                "the actual merged list begins at `dummy.next`. "
                "That extra `0` you see in the output is `dummy.val`.\n\n"
                "What attribute of `dummy` gives you the first real node of the merged list?"
            )},
        ]
    },
    # ---- 6 ----------------------------------------------------------------
    {
        "id": "gap_cat2_reverse_list_returns_head_001",
        "mode": "debug", "problem": "reverse_linked_list", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def reverseList(self, head):\n"
                "        prev = None\n"
                "        curr = head\n"
                "        while curr:\n"
                "            nxt = curr.next\n"
                "            curr.next = prev\n"
                "            prev = curr\n"
                "            curr = nxt\n"
                "        return head\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected [5,4,3,2,1], got [1]\n"
                "[USER MESSAGE]\nIt returns only one node?"
            )},
            {"role": "assistant", "content": (
                "Your reversal logic is perfect — saving `nxt`, reversing the pointer, advancing "
                "`prev` and `curr` is exactly the classic in-place reversal. I found **1 issue**.\n\n"
                "**Issue 1 — Line 10**\n```python\nreturn head\n```\n"
                "Line 10 returns `head`, which still points to the original first node of the list. "
                "After reversal, that node is now the **last** node — its `.next` was set to `None` "
                "in the loop. The new head of the reversed list is `prev` (which ends up pointing to "
                "the original last node). Returning `head` gives you a one-node list.\n\n"
                "Which variable holds the new head of the reversed list when the loop ends?"
            )},
        ]
    },
    # ---- 7 ----------------------------------------------------------------
    {
        "id": "gap_cat2_contains_dup_inverted_return_001",
        "mode": "debug", "problem": "contains_duplicate", "difficulty": "easy",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def containsDuplicate(self, nums):\n"
                "        return len(nums) != len(set(nums))\n```\n"
                "[TEST CASE DETAILS]\n3/4 tests passed — fails when all elements are unique\n"
                "[EXECUTION OUTPUT]\nTest 4: input=[1,2,3,4], expected=False, got=False\n"
                "[USER MESSAGE]\nWait this looks right to me but one test fails?"
            )},
            {"role": "assistant", "content": (
                "Your one-liner using `set` to detect duplicates is a smart approach — comparing "
                "lengths is the right idea. I found **1 issue**.\n\n"
                "**Issue 1 — Line 3**\n```python\nreturn len(nums) != len(set(nums))\n```\n"
                "Line 3 returns `True` when lengths differ (i.e., duplicates exist), and `False` "
                "when lengths are equal. Actually — that logic is correct. `!=` means 'there are "
                "duplicates'. Let me re-read the failing test: "
                "`input=[1,2,3,4], expected=False, got=False`. That test is **passing** — both "
                "expected and got are `False`. The test output you pasted shows agreement.\n\n"
                "Can you double-check which test is actually failing and paste the exact input and "
                "expected vs. got values? Your current implementation of line 3 looks logically correct."
            )},
        ]
    },
    # ---- 8 ----------------------------------------------------------------
    {
        "id": "gap_cat2_word_ladder_no_visited_001",
        "mode": "debug", "problem": "word_ladder", "difficulty": "hard",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import deque\nclass Solution:\n"
                "    def ladderLength(self, beginWord, endWord, wordList):\n"
                "        word_set = set(wordList)\n"
                "        if endWord not in word_set: return 0\n"
                "        queue = deque([(beginWord, 1)])\n"
                "        while queue:\n"
                "            word, length = queue.popleft()\n"
                "            for i in range(len(word)):\n"
                "                for c in 'abcdefghijklmnopqrstuvwxyz':\n"
                "                    new_word = word[:i] + c + word[i+1:]\n"
                "                    if new_word == endWord: return length + 1\n"
                "                    if new_word in word_set:\n"
                "                        queue.append((new_word, length + 1))\n"
                "        return 0\n```\n"
                "[TEST CASE DETAILS]\n1/3 tests passed — times out on larger inputs\n"
                "[EXECUTION OUTPUT]\nTest 2: Time Limit Exceeded\n"
                "[USER MESSAGE]\nWhy does it time out?"
            )},
            {"role": "assistant", "content": (
                "Your BFS structure is correct — building a word set, checking neighbors by "
                "substituting each character, and returning the path length are all right. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 13–14**\n```python\nif new_word in word_set:\n    queue.append((new_word, length + 1))\n```\n"
                "Lines 13–14 add `new_word` to the queue but never remove it from `word_set`. "
                "This means the same word can be added to the queue multiple times, causing the "
                "BFS to revisit words it has already explored. On large word lists, this creates "
                "exponential growth in queue size — hence the time limit exceeded.\n\n"
                "The standard BFS fix is to remove a word from `word_set` when you first enqueue it, "
                "so it can never be added again. After line 14 appends to the queue, what should "
                "you do with `new_word` in `word_set` to prevent revisiting it?"
            )},
        ]
    },
    # ---- 9 ----------------------------------------------------------------
    {
        "id": "gap_cat2_product_self_off_by_one_001",
        "mode": "debug", "problem": "product_of_array_except_self", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def productExceptSelf(self, nums):\n"
                "        n = len(nums)\n"
                "        result = [1] * n\n"
                "        prefix = 1\n"
                "        for i in range(n):\n"
                "            result[i] = prefix\n"
                "            prefix *= nums[i]\n"
                "        suffix = 1\n"
                "        for i in range(n - 1, -1, -1):\n"
                "            result[i] *= suffix\n"
                "            suffix *= nums[i + 1]\n"
                "        return result\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: IndexError: list index out of range (line 12)\n"
                "[USER MESSAGE]\nI get an index error on one test"
            )},
            {"role": "assistant", "content": (
                "Your prefix-product pass (lines 5–8) is correct, and the suffix pattern is the "
                "right idea. I found **1 issue**.\n\n"
                "**Issue 1 — Line 12**\n```python\nsuffix *= nums[i + 1]\n```\n"
                "Line 12 updates the suffix by multiplying `nums[i + 1]`. But the suffix pass "
                "iterates `i` from `n-1` down to `0`. When `i = n-1` (the last element), "
                "`nums[i + 1]` is `nums[n]` — which is out of bounds. The correct update "
                "for a suffix pass is `suffix *= nums[i]` (the current element, not the next one), "
                "applied **after** updating `result[i]`, following the same 'use first, then update' "
                "pattern as the prefix pass.\n\n"
                "What index into `nums` should be used to update `suffix` on line 12?"
            )},
        ]
    },
    # ---- 10 ---------------------------------------------------------------
    {
        "id": "gap_cat2_min_stack_wrong_pop_001",
        "mode": "debug", "problem": "min_stack", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass MinStack:\n"
                "    def __init__(self):\n"
                "        self.stack = []\n"
                "        self.min_stack = []\n"
                "    def push(self, val):\n"
                "        self.stack.append(val)\n"
                "        if not self.min_stack or val <= self.min_stack[-1]:\n"
                "            self.min_stack.append(val)\n"
                "    def pop(self):\n"
                "        val = self.stack.pop()\n"
                "        if val == self.min_stack[-1]:\n"
                "            self.min_stack.pop()\n"
                "    def top(self):\n"
                "        return self.stack[-1]\n"
                "    def getMin(self):\n"
                "        return self.min_stack[-1]\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — fails when pushing duplicates of the minimum\n"
                "[EXECUTION OUTPUT]\nTest 3: getMin after popping a duplicate min returns wrong value\n"
                "[USER MESSAGE]\nFails with duplicate minimums"
            )},
            {"role": "assistant", "content": (
                "Your MinStack design is solid — a parallel `min_stack` that tracks running minimums "
                "is the right approach. I found **1 issue**.\n\n"
                "**Issue 1 — Line 7**\n```python\nif not self.min_stack or val <= self.min_stack[-1]:\n```\n"
                "Line 7 pushes to `min_stack` when `val <= self.min_stack[-1]` (less than **or equal**). "
                "That correctly handles duplicates. But then `pop()` on lines 10–12 pops `min_stack` "
                "only when `val == self.min_stack[-1]`. If you pushed `[2, 2]` and both `2`s went into "
                "`min_stack`, popping one `2` from `stack` correctly removes one `2` from `min_stack`. "
                "That logic is actually consistent.\n\n"
                "Let me re-read: the push condition is `<=` (pushes both copies of a duplicate min). "
                "The pop condition is `==` (pops one copy per pop). This is correct. "
                "Can you paste the exact sequence of operations in the failing test — "
                "specifically the push order and which pop triggers the wrong `getMin`?"
            )},
        ]
    },
    # ---- 11 ---------------------------------------------------------------
    {
        "id": "gap_cat2_rotate_image_transpose_only_001",
        "mode": "debug", "problem": "rotate_image", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def rotate(self, matrix):\n"
                "        n = len(matrix)\n"
                "        for i in range(n):\n"
                "            for j in range(i + 1, n):\n"
                "                matrix[i][j], matrix[j][i] = matrix[j][i], matrix[i][j]\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected [[7,4,1],[8,5,2],[9,6,3]], got [[1,4,7],[2,5,8],[3,6,9]]\n"
                "[USER MESSAGE]\nIt transposes but doesn't rotate"
            )},
            {"role": "assistant", "content": (
                "You've correctly identified the issue yourself — your code transposes the matrix "
                "(swaps rows and columns), which is the first step of a 90-degree clockwise rotation. "
                "I found **1 issue**.\n\n"
                "**Issue 1 — Missing step after lines 4–6**\n"
                "A 90-degree clockwise rotation = **transpose + reverse each row**. "
                "Your transpose (lines 4–6) is correct. What's missing is reversing each row after "
                "the transpose. For a 3×3 matrix, transposing `[[1,2,3],[4,5,6],[7,8,9]]` gives "
                "`[[1,4,7],[2,5,8],[3,6,9]]` — exactly what you got. Then reversing each row gives "
                "`[[7,4,1],[8,5,2],[9,6,3]]` — the expected output.\n\n"
                "What Python operation reverses a list in place, and how would you apply it to each row "
                "of `matrix` after the transpose loop?"
            )},
        ]
    },
    # ---- 12 ---------------------------------------------------------------
    {
        "id": "gap_cat2_spiral_matrix_missing_last_row_001",
        "mode": "debug", "problem": "spiral_matrix", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def spiralOrder(self, matrix):\n"
                "        result = []\n"
                "        top, bottom = 0, len(matrix) - 1\n"
                "        left, right = 0, len(matrix[0]) - 1\n"
                "        while top <= bottom and left <= right:\n"
                "            for c in range(left, right + 1): result.append(matrix[top][c])\n"
                "            top += 1\n"
                "            for r in range(top, bottom + 1): result.append(matrix[r][right])\n"
                "            right -= 1\n"
                "            for c in range(right, left - 1, -1): result.append(matrix[bottom][c])\n"
                "            bottom -= 1\n"
                "            for r in range(bottom, top - 1, -1): result.append(matrix[r][left])\n"
                "            left += 1\n"
                "        return result\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — fails on non-square matrices\n"
                "[EXECUTION OUTPUT]\nTest 3: input=[[1,2,3],[4,5,6]], expected=[1,2,3,6,5,4], got=[1,2,3,6,4,5,6]\n"
                "[USER MESSAGE]\nFails on a 2x3 matrix"
            )},
            {"role": "assistant", "content": (
                "Your spiral logic handles square matrices perfectly — the four directional passes and "
                "boundary shrinking are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 11 and 13**\n"
                "```python\nfor c in range(right, left - 1, -1): result.append(matrix[bottom][c])\nbottom -= 1\nfor r in range(bottom, top - 1, -1): result.append(matrix[r][left])\n```\n"
                "Lines 11 and 13 run the bottom-row pass and left-column pass without first checking "
                "if there are still rows or columns remaining. For a 2×3 matrix, after the top row "
                "and right column are consumed, `top > bottom` — there's no bottom row left to traverse. "
                "But line 11 still runs, adding duplicates. "
                "The fix is to guard the bottom-row pass with `if top <= bottom` and the left-column "
                "pass with `if left <= right` before executing each of those loops.\n\n"
                "Where would you add an `if top <= bottom:` guard in the current code?"
            )},
        ]
    },
    # ---- 13 ---------------------------------------------------------------
    {
        "id": "gap_cat2_set_matrix_zeroes_marks_as_zero_001",
        "mode": "debug", "problem": "set_matrix_zeroes", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def setZeroes(self, matrix):\n"
                "        rows, cols = len(matrix), len(matrix[0])\n"
                "        for r in range(rows):\n"
                "            for c in range(cols):\n"
                "                if matrix[r][c] == 0:\n"
                "                    for i in range(rows): matrix[i][c] = 0\n"
                "                    for j in range(cols): matrix[r][j] = 0\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: entire matrix set to zeros\n"
                "[USER MESSAGE]\nEverything becomes zero"
            )},
            {"role": "assistant", "content": (
                "Your intent is right — find zeros, then zero out their row and column. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 6–8**\n```python\nif matrix[r][c] == 0:\n    for i in range(rows): matrix[i][c] = 0\n    for j in range(cols): matrix[r][j] = 0\n```\n"
                "Lines 6–8 zero out the row and column immediately when a zero is found. But those "
                "newly written zeros then trigger the same check on later iterations, causing "
                "a cascade that zeros out the entire matrix.\n\n"
                "The standard fix is a two-pass approach: first collect the row and column indices "
                "of all original zeros into separate sets, then do a second pass to zero those rows "
                "and columns. That way, you never modify the matrix while you're still reading it "
                "to find zeros. "
                "How would you store the zero positions before making any modifications to the matrix?"
            )},
        ]
    },
    # ---- 14 ---------------------------------------------------------------
    {
        "id": "gap_cat2_group_anagrams_wrong_key_001",
        "mode": "debug", "problem": "group_anagrams", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import defaultdict\nclass Solution:\n"
                "    def groupAnagrams(self, strs):\n"
                "        groups = defaultdict(list)\n"
                "        for s in strs:\n"
                "            key = sorted(s)\n"
                "            groups[key].append(s)\n"
                "        return list(groups.values())\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTypeError: unhashable type: 'list' (line 7)\n"
                "[USER MESSAGE]\nTypeError with sorted?"
            )},
            {"role": "assistant", "content": (
                "Your anagram-grouping strategy is exactly right — sorting the characters gives a "
                "canonical key for each anagram group. I found **1 issue**.\n\n"
                "**Issue 1 — Line 6**\n```python\nkey = sorted(s)\n```\n"
                "Line 6 produces a **list** from `sorted(s)`. Lists are mutable and cannot be used "
                "as dictionary keys — hence the `unhashable type: 'list'` error on line 7. "
                "You need to convert the sorted list to an immutable, hashable type before using "
                "it as a key.\n\n"
                "Which Python built-in converts a list to an immutable sequence that can be "
                "used as a dictionary key?"
            )},
        ]
    },
    # ---- 15 ---------------------------------------------------------------
    {
        "id": "gap_cat2_top_k_frequent_wrong_order_001",
        "mode": "debug", "problem": "top_k_frequent_elements", "difficulty": "medium",
        "bug_count": 1, "category": "mostly_correct",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nimport heapq\nfrom collections import Counter\nclass Solution:\n"
                "    def topKFrequent(self, nums, k):\n"
                "        count = Counter(nums)\n"
                "        return heapq.nsmallest(k, count, key=count.get)\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: input=[1,1,1,2,2,3], k=2, expected=[1,2], got=[3,2]\n"
                "[USER MESSAGE]\nWhy does it return the wrong elements?"
            )},
            {"role": "assistant", "content": (
                "Your use of `Counter` and `heapq` together is the right approach. I found **1 issue**.\n\n"
                "**Issue 1 — Line 6**\n```python\nreturn heapq.nsmallest(k, count, key=count.get)\n```\n"
                "Line 6 uses `heapq.nsmallest`, which returns the `k` elements with the **smallest** "
                "frequency counts. But the problem asks for the `k` **most frequent** elements — "
                "you want the largest counts, not the smallest. For `[1,1,1,2,2,3]`, "
                "`count = {1:3, 2:2, 3:1}`. `nsmallest(2)` returns `[3, 2]` (lowest counts); "
                "`nlargest(2)` returns `[1, 2]` (highest counts).\n\n"
                "Which `heapq` function should replace `nsmallest` on line 6?"
            )},
        ]
    },
]


# ===========================================================================
# CATEGORY 3 — Multi-turn sequences (15 examples)
# Each example has 4+ messages: initial debug → confused → frustrated → assist.
# ===========================================================================

def _mt(id_, problem, difficulty, messages):
    return {
        "id": id_, "mode": "debug", "problem": problem,
        "difficulty": difficulty, "bug_count": 1,
        "category": "multi_turn", "messages": messages,
    }


CAT3 = [
    _mt("gap_cat3_two_sum_confusion_to_frustration_001", "two_sum", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\ndef twoSum(self, nums, target):\n"
            "    for i in range(len(nums)):\n"
            "        for j in range(i + 1, len(nums)):\n"
            "            if nums[i] + nums[j] == target:\n"
            "                return [i, j]\n"
            "    return []\n```\n"
            "[TEST CASE DETAILS]\n0/3 tests passed\n"
            "[EXECUTION OUTPUT]\nAttributeError: 'Solution' object has no attribute 'twoSum'\n"
            "[USER MESSAGE]\nMy code keeps failing, help?"
        )},
        {"role": "assistant", "content": (
            "I found **1 issue** in your code.\n\n"
            "**Issue 1 — Line 1**\n```python\ndef twoSum(self, nums, target):\n```\n"
            "Line 1 defines `twoSum` with `self` as the first parameter, but this function is not "
            "indented inside a class. Python treats it as a standalone function, so when you call "
            "`solution.twoSum(...)`, Python can't find the method on the `Solution` object.\n\n"
            "Look at how the function is structured relative to `class Solution`. Where should "
            "`def twoSum` be indented so it belongs to the class?"
        )},
        {"role": "user", "content": "I still don't understand. What do you mean it's not inside a class?"},
        {"role": "assistant", "content": (
            "Let's zoom in on just the structure — forget the logic for a moment.\n\n"
            "In Python, a method belongs to a class when it's indented inside it:\n"
            "```python\nclass Solution:          # class definition\n"
            "    def twoSum(self, ...):   # ← 4 spaces of indentation = belongs to Solution\n"
            "        ...\n```\n\n"
            "Right now your code has:\n"
            "```python\nclass Solution:\n    pass\n\n"
            "def twoSum(self, ...):   # ← 0 spaces = standalone function, NOT in Solution\n"
            "    ...\n```\n\n"
            "Python can't find `twoSum` on `Solution` because it lives outside the class.\n\n"
            "How many spaces of indentation does `def twoSum` need to move inside `Solution`?"
        )},
        {"role": "user", "content": "I'm so confused, I want to give up. I'm not good at this."},
        {"role": "assistant", "content": (
            "Hey — pause for a second. What you're feeling is frustration, not a lack of ability. "
            "Indentation is one of the most disorienting things about Python when you're starting "
            "out — it trips up experienced developers too.\n\n"
            "Let's make this as simple as possible. Pick one:\n\n"
            "- **a)** `def twoSum` should have 0 spaces (same level as `class Solution`)\n"
            "- **b)** `def twoSum` should have 4 spaces (indented inside `class Solution`)\n\n"
            "Your loop logic and the `return [i, j]` are already correct — the algorithm works. "
            "This is purely a placement issue. Which option do you think it should be?"
        )},
    ]),
    _mt("gap_cat3_binary_search_confusion_001", "binary_search", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def search(self, nums, target):\n"
            "        left, right = 0, len(nums)\n"
            "        while left < right:\n"
            "            mid = (left + right) // 2\n"
            "            if nums[mid] == target: return mid\n"
            "            elif nums[mid] < target: left = mid + 1\n"
            "            else: right = mid\n"
            "        return -1\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 2: IndexError: list index out of range\n"
            "[USER MESSAGE]\nIndex error on test 2?"
        )},
        {"role": "assistant", "content": (
            "Your binary search approach is correct. I found **1 issue**.\n\n"
            "**Issue 1 — Line 3**\n```python\nleft, right = 0, len(nums)\n```\n"
            "Line 3 sets `right = len(nums)`. But valid indices go from `0` to `len(nums) - 1`. "
            "When `mid = (left + right) // 2` evaluates to `len(nums) - 1` in the early search "
            "steps, this is fine — but the initial `right` can cause `nums[mid]` to go out of "
            "bounds in certain edge cases.\n\n"
            "What should `right` be initialised to so it always points to a valid last index?"
        )},
        {"role": "user", "content": "But I thought len(nums) is the length, why is that wrong?"},
        {"role": "assistant", "content": (
            "Great question — let's look at a tiny example.\n\n"
            "Say `nums = [1, 2, 3]`. Then `len(nums) = 3`.\n\n"
            "Valid indices are `0, 1, 2` — so the last valid index is `2`, not `3`.\n\n"
            "If `right = 3` and the loop calculates `mid = (0 + 3) // 2 = 1`, that's fine. "
            "But in some iterations `right` stays at `3` and `mid` can reach index `3`, "
            "which doesn't exist — giving you an `IndexError`.\n\n"
            "The last valid index is always `len(nums)` minus what number?"
        )},
        {"role": "user", "content": "I don't get it still, I keep getting confused with indexing"},
        {"role": "assistant", "content": (
            "That's completely normal — off-by-one errors in indexing are the most common Python "
            "mistake, even for experienced engineers.\n\n"
            "Think of it like a numbered list of seats in a row:\n"
            "- 3 seats total\n- Seat numbers: 1, 2, 3 (in everyday counting)\n"
            "- Python index numbers: 0, 1, 2\n\n"
            "The **last** seat is seat number 3, but Python calls it index **2** (always one less).\n\n"
            "Pick one for `right`:\n"
            "- **a)** `len(nums)` → 3 (points past the last seat)\n"
            "- **b)** `len(nums) - 1` → 2 (points to the last valid seat)\n\n"
            "Which one should `right` start at?"
        )},
    ]),
    _mt("gap_cat3_climbing_stairs_partial_answer_001", "climbing_stairs", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def climbStairs(self, n):\n"
            "        if n <= 2: return n\n"
            "        dp = [0] * (n + 1)\n"
            "        dp[1] = 1; dp[2] = 2\n"
            "        for i in range(3, n + 1):\n"
            "            dp[i] = dp[i-1] + dp[i-2]\n"
            "        return dp[n - 1]\n```\n"
            "[TEST CASE DETAILS]\n2/4 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: input=4, expected=5, got=3\n"
            "[USER MESSAGE]\nWhy does n=4 give wrong answer?"
        )},
        {"role": "assistant", "content": (
            "Your DP approach and recurrence `dp[i] = dp[i-1] + dp[i-2]` are exactly right. I found **1 issue**.\n\n"
            "**Issue 1 — Line 8**\n```python\nreturn dp[n - 1]\n```\n"
            "Line 8 returns `dp[n - 1]` instead of `dp[n]`. You built the table up to index `n`, "
            "but then returned one position too early. For `n = 4`, "
            "`dp = [0, 1, 2, 3, 5]` — `dp[4] = 5` is correct, but `dp[3] = 3` is what you return.\n\n"
            "What index of `dp` holds the answer for `n` stairs?"
        )},
        {"role": "user", "content": "Oh is it dp[n]?"},
        {"role": "assistant", "content": (
            "Yes — exactly right! `dp[n]` is the answer for `n` stairs. "
            "You built the table correctly and filled it to index `n`, so returning `dp[n]` gives "
            "the right result for every input.\n\n"
            "Change line 8 from `return dp[n - 1]` to `return dp[n]` and all your tests should pass. "
            "Does that make sense — why `dp[n]` rather than `dp[n - 1]`?"
        )},
    ]),
    _mt("gap_cat3_contains_dup_frustration_001", "contains_duplicate", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def containsDuplicate(self, nums):\n"
            "        for i in range(len(nums)):\n"
            "            for j in range(len(nums)):\n"
            "                if i != j and nums[i] == nums[j]:\n"
            "                    return True\n"
            "        return False\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed — TLE on large input\n"
            "[EXECUTION OUTPUT]\nTest 3: Time Limit Exceeded\n"
            "[USER MESSAGE]\nTime limit exceeded!"
        )},
        {"role": "assistant", "content": (
            "Your logic is correct — comparing every pair and returning `True` on a match works. I found **1 issue**.\n\n"
            "**Issue 1 — Lines 3–4**\n```python\nfor i in range(len(nums)):\n    for j in range(len(nums)):\n```\n"
            "Lines 3 and 4 create a nested loop that checks every pair — that's O(n²) operations. "
            "For large inputs (100,000 elements), that's 10 billion comparisons, which exceeds the time limit.\n\n"
            "There's a data structure that can tell you in O(1) whether you've seen a value before. "
            "Instead of checking every element against every other, you could track values you've "
            "already visited as you go. What Python data structure gives O(1) lookup for membership?"
        )},
        {"role": "user", "content": "I have no idea what O(1) means, I'm going to fail this course"},
        {"role": "assistant", "content": (
            "Hey — O(1) is just notation, and not knowing it yet is completely fine. "
            "You're learning algorithms, not failing — struggling with new concepts is the learning.\n\n"
            "Here's what O(1) means in plain English: 'it takes the same amount of time no matter "
            "how big the list is.' Checking if a name is in a phonebook takes longer if the book "
            "is bigger — that's O(n). But checking if a number is in a set in Python always takes "
            "the same tiny amount of time — that's O(1).\n\n"
            "Pick one — which Python type checks membership in one step regardless of size:\n"
            "- **a)** list → `if x in my_list` (scans the whole list)\n"
            "- **b)** set → `if x in my_set` (instant lookup)\n\n"
            "Your understanding of the problem is correct. This is just a tool swap."
        )},
    ]),
    _mt("gap_cat3_valid_paren_partial_001", "valid_parentheses", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def isValid(self, s):\n"
            "        stack = []\n"
            "        for c in s:\n"
            "            if c in '({[':\n"
            "                stack.append(c)\n"
            "            elif c == ')' and stack[-1] == '(':\n"
            "                stack.pop()\n"
            "            elif c == '}' and stack[-1] == '{':\n"
            "                stack.pop()\n"
            "            elif c == ']' and stack[-1] == '[':\n"
            "                stack.pop()\n"
            "        return len(stack) == 0\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: IndexError: list index out of range\n"
            "[USER MESSAGE]\nIndex error on some inputs?"
        )},
        {"role": "assistant", "content": (
            "Your stack-based matching approach is correct and the bracket pairs are right. I found **1 issue**.\n\n"
            "**Issue 1 — Lines 7, 9, 11**\n```python\nelif c == ')' and stack[-1] == '(':\n```\n"
            "Lines 7, 9, and 11 access `stack[-1]` without first checking if `stack` is empty. "
            "When the input starts with a closing bracket like `')'`, `stack` is empty and "
            "`stack[-1]` raises an IndexError.\n\n"
            "Before checking `stack[-1]`, what condition should you verify?"
        )},
        {"role": "user", "content": "Is it like... check if stack is not empty first?"},
        {"role": "assistant", "content": (
            "Exactly right — you've got it. Before accessing `stack[-1]`, you need to confirm that "
            "`stack` is not empty.\n\n"
            "In Python, `if stack` is `True` when the list has at least one element, and `False` "
            "when it's empty. So on line 7 you'd write:\n\n"
            "```python\nelif c == ')' and stack and stack[-1] == '(':\n```\n\n"
            "The same `and stack` guard needs to be added to lines 9 and 11 as well. "
            "Does that make sense — why does `and stack` need to come before `stack[-1]`?"
        )},
    ]),
    _mt("gap_cat3_max_subarray_confusion_001", "maximum_subarray", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def maxSubArray(self, nums):\n"
            "        best = nums[0]\n"
            "        current = nums[0]\n"
            "        for n in nums[1:]:\n"
            "            current = max(current, current + n)\n"
            "            best = max(best, current)\n"
            "        return best\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: input=[-2,1,-3,4,-1,2,1,-5,4], expected=6, got=5\n"
            "[USER MESSAGE]\nOff by one on some inputs?"
        )},
        {"role": "assistant", "content": (
            "Your Kadane's structure and initialisation are correct. I found **1 issue**.\n\n"
            "**Issue 1 — Line 6**\n```python\ncurrent = max(current, current + n)\n```\n"
            "Line 6 takes the maximum of `current` (keep existing subarray) and `current + n` "
            "(extend it). But there's a third option: **start fresh from `n`**. When `current` "
            "is very negative and `n` is positive, both `current` and `current + n` are worse "
            "than just `n` alone. Your line 6 would keep the negative `current` instead of "
            "restarting.\n\n"
            "Kadane's algorithm should take the max of `n` (start fresh) and `current + n` (extend). "
            "Which of those two should replace the current expression on line 6?"
        )},
        {"role": "user", "content": "I'm not sure, maybe max(n, current)?"},
        {"role": "assistant", "content": (
            "You're very close — but let's be precise.\n\n"
            "The two options are:\n"
            "- **Start fresh**: just `n` (drop everything before)\n"
            "- **Extend**: `current + n` (include the previous subarray)\n\n"
            "Your suggestion `max(n, current)` would pick between the current element and the "
            "**old subarray total** — that's not quite right because extending the old subarray "
            "gives `current + n`, not just `current`.\n\n"
            "The correct expression is `max(n, current + n)`. Can you spot the difference between "
            "`max(n, current)` and `max(n, current + n)`?"
        )},
    ]),
    _mt("gap_cat3_longest_sub_window_001", "longest_substring_without_repeating", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def lengthOfLongestSubstring(self, s):\n"
            "        left = 0\n"
            "        best = 0\n"
            "        seen = {}\n"
            "        for right, c in enumerate(s):\n"
            "            if c in seen:\n"
            "                left = seen[c] + 1\n"
            "            seen[c] = right\n"
            "            best = max(best, right - left + 1)\n"
            "        return best\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: input='abba', expected=2, got=3\n"
            "[USER MESSAGE]\nFails on 'abba'"
        )},
        {"role": "assistant", "content": (
            "Your sliding window approach and the `right - left + 1` window size calculation are correct. "
            "I found **1 issue**.\n\n"
            "**Issue 1 — Line 8**\n```python\nleft = seen[c] + 1\n```\n"
            "Line 8 moves `left` to `seen[c] + 1` when a repeated character is found. "
            "For `'abba'`, when the second `'a'` is at index 3, `seen['a'] = 0`, so `left = 1`. "
            "But `left` was already moved to `2` when the second `'b'` was processed. "
            "Line 8 moves `left` **backwards** to `1`, which allows the window to include the "
            "first `'b'` again — giving a window of `'bba'` with size 3 instead of `'ba'` with size 2.\n\n"
            "The fix is to only move `left` forward, never backward. What Python function "
            "ensures `left` only increases?"
        )},
        {"role": "user", "content": "Is it max()?"},
        {"role": "assistant", "content": (
            "Exactly right! `max(left, seen[c] + 1)` ensures `left` only ever moves forward — "
            "if `seen[c] + 1` is less than the current `left`, we keep `left` where it is.\n\n"
            "Change line 8 to:\n```python\nleft = max(left, seen[c] + 1)\n```\n\n"
            "For `'abba'`: when we hit the second `'a'` at index 3, "
            "`seen['a'] + 1 = 1`, but `left` is already `2`, so `max(2, 1) = 2` — "
            "`left` stays at `2`, giving window `'ba'` with length `2`. Correct!\n\n"
            "Does that trace make sense?"
        )},
    ]),
    _mt("gap_cat3_product_self_turn_001", "product_of_array_except_self", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def productExceptSelf(self, nums):\n"
            "        n = len(nums)\n"
            "        result = [1] * n\n"
            "        for i in range(1, n):\n"
            "            result[i] = result[i-1] * nums[i-1]\n"
            "        suffix = 1\n"
            "        for i in range(n - 2, -1, -1):\n"
            "            suffix *= nums[i + 1]\n"
            "            result[i] *= suffix\n"
            "        return result\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: input=[1,2,3,4], expected=[24,12,8,6], got=[24,12,8,6]\n"
            "[USER MESSAGE]\nI think it's correct but why does one test fail?"
        )},
        {"role": "assistant", "content": (
            "Your prefix-product pass and suffix-product pass are both correct for the examples "
            "I can trace. I found **no clear bug** from the code alone for the standard cases.\n\n"
            "Can you paste the full details of the failing test? The output you shared "
            "(`got=[24,12,8,6]`) matches the expected output (`expected=[24,12,8,6]`) — "
            "so either the test runner is reporting the wrong case, or the actual failure is on "
            "a different input (like an array with zeros). "
            "What does the full test failure message say?"
        )},
        {"role": "user", "content": "Oh wait it includes a zero: input=[1,0,3,4]"},
        {"role": "assistant", "content": (
            "That changes things — and you found it yourself, which is great debugging instinct!\n\n"
            "For `nums = [1, 0, 3, 4]`:\n"
            "- Expected: `[0, 12, 0, 0]` (everything except the `0` at index 1 should multiply to `0`)\n\n"
            "Let's trace your prefix pass:\n"
            "- `result[0] = 1` (no elements before index 0)\n"
            "- `result[1] = result[0] * nums[0] = 1 * 1 = 1`\n"
            "- `result[2] = result[1] * nums[1] = 1 * 0 = 0` ✅\n"
            "- `result[3] = result[2] * nums[2] = 0 * 3 = 0` ✅\n\n"
            "Now trace the suffix pass for index 0 (`result[0]`). After the suffix loop, "
            "what value does `suffix` hold when it multiplies `result[0]`?"
        )},
    ]),
    _mt("gap_cat3_coin_change_turn_001", "coin_change", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def coinChange(self, coins, amount):\n"
            "        dp = [float('inf')] * (amount + 1)\n"
            "        dp[0] = 0\n"
            "        for a in range(1, amount + 1):\n"
            "            for coin in coins:\n"
            "                if a >= coin:\n"
            "                    dp[a] = max(dp[a], dp[a - coin] + 1)\n"
            "        return dp[amount] if dp[amount] != float('inf') else -1\n```\n"
            "[TEST CASE DETAILS]\n0/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 1: input=coins=[1,5,10],amount=11, expected=2, got=-1\n"
            "[USER MESSAGE]\nWhy does it return -1 when there is a solution?"
        )},
        {"role": "assistant", "content": (
            "Your DP table setup and the final check are correct. I found **1 issue**.\n\n"
            "**Issue 1 — Line 8**\n```python\ndp[a] = max(dp[a], dp[a - coin] + 1)\n```\n"
            "Line 8 uses `max` to update the DP table. But coin change asks for the **minimum** "
            "number of coins to reach amount `a`, not the maximum. With `max`, you're keeping the "
            "worst solution at each step, so `dp[amount]` ends up being `float('inf')` and you "
            "return `-1`. Which Python built-in should replace `max` on line 8?"
        )},
        {"role": "user", "content": "Oh, min?"},
        {"role": "assistant", "content": (
            "Yes — exactly right! `min` is what you need.\n\n"
            "Change line 8 to:\n```python\ndp[a] = min(dp[a], dp[a - coin] + 1)\n```\n\n"
            "Let's quickly trace for `coins = [1, 5, 10]`, `amount = 11`:\n"
            "- `dp[1] = min(inf, dp[0] + 1) = 1` (one coin of 1)\n"
            "- `dp[5] = min(..., dp[0] + 1) = 1` (one coin of 5)\n"
            "- `dp[10] = min(..., dp[0] + 1) = 1` (one coin of 10)\n"
            "- `dp[11] = min(dp[10] + 1, ...) = 2` (10 + 1)\n\n"
            "Returns `2`. Does that make sense now?"
        )},
    ]),
    _mt("gap_cat3_three_sum_confusion_001", "three_sum", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def threeSum(self, nums):\n"
            "        nums.sort()\n"
            "        result = []\n"
            "        for i in range(len(nums) - 2):\n"
            "            left, right = i + 1, len(nums) - 1\n"
            "            while left < right:\n"
            "                s = nums[i] + nums[left] + nums[right]\n"
            "                if s == 0:\n"
            "                    result.append([nums[i], nums[left], nums[right]])\n"
            "                    left += 1; right -= 1\n"
            "                elif s < 0: left += 1\n"
            "                else: right -= 1\n"
            "        return result\n```\n"
            "[TEST CASE DETAILS]\n1/3 tests passed — duplicate triplets returned\n"
            "[EXECUTION OUTPUT]\nTest 2: expected [[-1,-1,2],[-1,0,1]], got [[-1,-1,2],[-1,0,1],[-1,0,1]]\n"
            "[USER MESSAGE]\nDuplicate triplets in the output"
        )},
        {"role": "assistant", "content": (
            "Your sorting, two-pointer setup, and sum logic are all correct. I found **1 issue**.\n\n"
            "**Issue 1 — Lines 11 / 5**\n"
            "After finding a valid triplet and advancing `left` and `right`, there's no logic to "
            "skip over duplicate values. If `nums[left]` appears multiple times, you'll add the "
            "same triplet again on the next iteration.\n\n"
            "The fix is: after `left += 1; right -= 1`, while `left < right`, keep advancing `left` "
            "if `nums[left] == nums[left - 1]`. Similarly skip `right` if it equals `nums[right + 1]`. "
            "The same deduplication is also needed for the outer `i` loop.\n\n"
            "Where in the code would you add `while left < right and nums[left] == nums[left-1]: left += 1`?"
        )},
        {"role": "user", "content": "Right after the left += 1 on line 11?"},
        {"role": "assistant", "content": (
            "Exactly — right after `left += 1; right -= 1` on line 11, inside the `if s == 0` block:\n\n"
            "```python\nif s == 0:\n"
            "    result.append([nums[i], nums[left], nums[right]])\n"
            "    left += 1; right -= 1\n"
            "    while left < right and nums[left] == nums[left - 1]:\n"
            "        left += 1\n"
            "    while left < right and nums[right] == nums[right + 1]:\n"
            "        right -= 1\n```\n\n"
            "You also need a similar skip for the outer `i` loop to avoid processing duplicate "
            "values at position `i`. Can you see where to add that deduplication for `i`?"
        )},
    ]),
    _mt("gap_cat3_number_of_islands_turn_001", "number_of_islands", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def numIslands(self, grid):\n"
            "        count = 0\n"
            "        def dfs(r, c):\n"
            "            if r < 0 or r >= len(grid) or c < 0 or c >= len(grid[0]): return\n"
            "            if grid[r][c] != '1': return\n"
            "            grid[r][c] = '0'\n"
            "            dfs(r+1,c); dfs(r-1,c); dfs(r,c+1); dfs(r,c-1)\n"
            "        for r in range(len(grid)):\n"
            "            for c in range(len(grid[0])):\n"
            "                if grid[r][c] == '1':\n"
            "                    dfs(r, c)\n"
            "        return count\n```\n"
            "[TEST CASE DETAILS]\n0/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 1: expected 3, got 0\n"
            "[USER MESSAGE]\nAlways returns 0?"
        )},
        {"role": "assistant", "content": (
            "Your DFS logic and boundary checks are correct. I found **1 issue**.\n\n"
            "**Issue 1 — Lines 3 and 12**\n```python\ncount = 0\n...\ndfs(r, c)  # count never incremented\n```\n"
            "Line 3 initialises `count = 0`. Line 12 calls `dfs(r, c)` each time a new island is found — "
            "but `count` is never incremented. The DFS correctly marks the island cells as visited, "
            "but the counter stays at 0. The function always returns 0.\n\n"
            "On line 12, right after `dfs(r, c)`, what statement should you add?"
        )},
        {"role": "user", "content": "count = count + 1?"},
        {"role": "assistant", "content": (
            "Exactly right — `count += 1` (or equivalently `count = count + 1`) goes right after `dfs(r, c)` on line 12.\n\n"
            "One small Python gotcha: since `count` is defined in the outer function and you're "
            "modifying it inside the nested `dfs`, you'd want to use `nonlocal count` at the top "
            "of `dfs` if you ever increment inside the helper. But since you're incrementing in "
            "the outer loop (not inside `dfs`), `nonlocal` isn't needed here.\n\n"
            "The corrected block:\n"
            "```python\nif grid[r][c] == '1':\n    dfs(r, c)\n    count += 1\n```\n\n"
            "Does that make sense?"
        )},
    ]),
    _mt("gap_cat3_reverse_list_turn_001", "reverse_linked_list", "easy", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
            "    def reverseList(self, head):\n"
            "        prev = None\n"
            "        curr = head\n"
            "        while curr:\n"
            "            curr.next = prev\n"
            "            prev = curr\n"
            "            curr = curr.next\n"
            "        return prev\n```\n"
            "[TEST CASE DETAILS]\n0/3 tests passed — infinite loop\n"
            "[EXECUTION OUTPUT]\nTime Limit Exceeded\n"
            "[USER MESSAGE]\nInfinite loop?"
        )},
        {"role": "assistant", "content": (
            "I found **1 issue** in your code.\n\n"
            "**Issue 1 — Lines 6–8**\n```python\ncurr.next = prev\nprev = curr\ncurr = curr.next\n```\n"
            "Line 6 sets `curr.next = prev` — it immediately overwrites the pointer to the next node. "
            "Then line 8 does `curr = curr.next`, but `curr.next` was just changed to `prev` on line 6. "
            "So `curr` moves to `prev`, not the original next node — creating a two-node cycle.\n\n"
            "You need to save `curr.next` into a temporary variable **before** overwriting it on line 6. "
            "What name would you give this temporary variable, and where in the loop does it go?"
        )},
        {"role": "user", "content": "Like nxt = curr.next before line 6?"},
        {"role": "assistant", "content": (
            "Exactly — save it before you overwrite the pointer:\n\n"
            "```python\nwhile curr:\n"
            "    nxt = curr.next      # save before overwriting\n"
            "    curr.next = prev     # reverse the pointer\n"
            "    prev = curr          # advance prev\n"
            "    curr = nxt           # advance curr using the saved next\n```\n\n"
            "Now `curr` advances to the original next node (saved in `nxt`) instead of looping back. "
            "Does that sequence make sense?"
        )},
    ]),
    _mt("gap_cat3_group_anagrams_turn_001", "group_anagrams", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import defaultdict\nclass Solution:\n"
            "    def groupAnagrams(self, strs):\n"
            "        groups = defaultdict(list)\n"
            "        for s in strs:\n"
            "            key = tuple(sorted(s))\n"
            "            groups[key].append(s)\n"
            "        return groups.values()\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: TypeError: Object of type dict_values is not JSON serializable\n"
            "[USER MESSAGE]\nNot JSON serializable?"
        )},
        {"role": "assistant", "content": (
            "Your grouping logic is correct — tuple key, sorted characters, `defaultdict`. I found **1 issue**.\n\n"
            "**Issue 1 — Line 8**\n```python\nreturn groups.values()\n```\n"
            "Line 8 returns `groups.values()`, which is a `dict_values` view object, not an actual list. "
            "The test runner (and LeetCode) expect a `list` of lists. Converting it is one word.\n\n"
            "What function wraps `groups.values()` to return an actual list?"
        )},
        {"role": "user", "content": "list(groups.values())?"},
        {"role": "assistant", "content": (
            "Exactly right — `return list(groups.values())`.\n\n"
            "`dict.values()` gives you a live view of the values, which is efficient for iteration "
            "but not accepted as a return type when the judge expects a concrete list. Wrapping it "
            "in `list()` materialises it into a proper list of lists.\n\n"
            "Make that change on line 8 and all tests should pass."
        )},
    ]),
    _mt("gap_cat3_word_ladder_turn_001", "word_ladder", "hard", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import deque\nclass Solution:\n"
            "    def ladderLength(self, beginWord, endWord, wordList):\n"
            "        word_set = set(wordList)\n"
            "        queue = deque([(beginWord, 1)])\n"
            "        while queue:\n"
            "            word, length = queue.popleft()\n"
            "            if word == endWord: return length\n"
            "            for i in range(len(word)):\n"
            "                for c in 'abcdefghijklmnopqrstuvwxyz':\n"
            "                    new_word = word[:i] + c + word[i+1:]\n"
            "                    if new_word in word_set:\n"
            "                        word_set.remove(new_word)\n"
            "                        queue.append((new_word, length + 1))\n"
            "        return 0\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed\n"
            "[EXECUTION OUTPUT]\nTest 3: input=beginWord='hit',endWord='cog',wordList=['hot','dot','dog','lot','log','cog'], expected=5, got=0\n"
            "[USER MESSAGE]\nReturns 0 when cog is in the word list?"
        )},
        {"role": "assistant", "content": (
            "Your BFS and the visited-removal pattern are correct. I found **1 issue**.\n\n"
            "**Issue 1 — Line 8**\n```python\nif word == endWord: return length\n```\n"
            "Line 8 checks if the current word equals `endWord` — but `endWord` is not in `word_set` "
            "after being removed (or it's never enqueued as a neighbour). Actually, let me re-read: "
            "the issue is that line 8 checks `word == endWord` when you **dequeue** a word. "
            "But line 12 only enqueues words that are `in word_set`. If `endWord` is in `word_set`, "
            "it gets removed and enqueued on line 12–13. Then on the next dequeue, line 8 catches it. "
            "That should work...\n\n"
            "Actually — does your `wordList` contain `endWord`? If `endWord` is missing from "
            "`wordList`, line 12 never enqueues it and `0` is returned. "
            "The problem requires a check: if `endWord not in word_set`, return `0` immediately. "
            "Is `'cog'` present in the `wordList` you're testing with?"
        )},
        {"role": "user", "content": "Yes cog is in the list, I checked"},
        {"role": "assistant", "content": (
            "Let me trace more carefully with `beginWord='hit'`, `endWord='cog'`.\n\n"
            "Starting BFS from `('hit', 1)`. Neighbours of `'hit'` in `word_set`: `'hot'` (change i → o). "
            "Enqueue `('hot', 2)`, remove `'hot'` from `word_set`.\n"
            "From `'hot'`: neighbours `'dot'`, `'lot'`. Enqueue both at length 3.\n"
            "From `'dot'`: `'dog'`. Enqueue at 4. From `'lot'`: `'log'`. Enqueue at 4.\n"
            "From `'dog'`: `'cog'`. Enqueue at 5. From `'log'`: `'cog'` — but `'cog'` was just "
            "removed from `word_set` when enqueued from `'dog'`, so it's not added again. ✅\n"
            "Dequeue `'cog'` at length 5. Line 8: `'cog' == 'cog'` → return 5. ✅\n\n"
            "This trace gives `5`. Can you run the code in isolation with just this input and "
            "print intermediate queue states? The algorithm looks correct to me — the issue "
            "might be in how the test is calling your function."
        )},
    ]),
    _mt("gap_cat3_top_k_turn_001", "top_k_frequent_elements", "medium", [
        {"role": "system", "content": SYS},
        {"role": "user", "content": (
            "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nimport heapq\nfrom collections import Counter\nclass Solution:\n"
            "    def topKFrequent(self, nums, k):\n"
            "        count = Counter(nums)\n"
            "        heap = []\n"
            "        for num, freq in count.items():\n"
            "            heapq.heappush(heap, (freq, num))\n"
            "            if len(heap) > k:\n"
            "                heapq.heappop(heap)\n"
            "        return [num for freq, num in heap]\n```\n"
            "[TEST CASE DETAILS]\n2/3 tests passed — order wrong on some inputs\n"
            "[EXECUTION OUTPUT]\nTest 3: expected=[1,2], got=[2,1] (order differs)\n"
            "[USER MESSAGE]\nOrder is wrong?"
        )},
        {"role": "assistant", "content": (
            "Your min-heap approach for top K is correct. I found a likely **non-issue**.\n\n"
            "The problem asks for the `k` most frequent elements — but it does **not** require "
            "them in any specific order. LeetCode explicitly says the answer can be in any order. "
            "If the test runner is marking `[2,1]` as wrong when `[1,2]` is expected, that's a "
            "test configuration issue, not a bug in your code.\n\n"
            "Both `[1, 2]` and `[2, 1]` are valid answers for 'top 2 most frequent'. "
            "Is the judge on your platform requiring a specific ordering, or does it accept any order?"
        )},
        {"role": "user", "content": "Oh it accepts any order, I was confused"},
        {"role": "assistant", "content": (
            "That's the most common source of confusion on frequency problems — the output looks "
            "wrong but both orderings are valid. Your solution is correct.\n\n"
            "Your min-heap approach is a clean O(n log k) solution: push every element with its "
            "frequency, pop when the heap exceeds size `k` to evict the least frequent, and "
            "what remains are the top `k`. Well done — nothing to fix here!"
        )},
    ]),
]


# ===========================================================================
# CATEGORY 4 — Tree / Graph / DP problems (15 examples)
# Novel domains where the only in-prompt example is Two Sum.
# ===========================================================================

CAT4 = [
    # ---- 1 ----------------------------------------------------------------
    {
        "id": "gap_cat4_max_depth_sum_not_max_001",
        "mode": "debug", "problem": "max_depth_binary_tree", "difficulty": "easy",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def maxDepth(self, root):\n"
                "        if not root: return 0\n"
                "        return 1 + self.maxDepth(root.left) + self.maxDepth(root.right)\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: tree=[3,9,20,null,null,15,7], expected=3, got=4\n"
                "[USER MESSAGE]\nCan you find the bug in my tree solution?"
            )},
            {"role": "assistant", "content": (
                "Your recursion structure and base case are correct — that's the hard part, and "
                "you've got it. I found **1 issue**.\n\n"
                "**Issue 1 — Line 4**\n```python\nreturn 1 + self.maxDepth(root.left) + self.maxDepth(root.right)\n```\n"
                "Line 4 adds the depths of the left and right subtrees together. But the problem "
                "asks for the **maximum** depth of the tree, not the combined total. "
                "For the tree `[3, 9, 20, null, null, 15, 7]`, the left subtree has depth 1 and "
                "the right has depth 2 — your code returns `1 + 1 + 2 = 4`, but the correct answer "
                "is `1 + max(1, 2) = 3`.\n\n"
                "Which Python built-in returns the larger of two values instead of adding them?"
            )},
        ]
    },
    # ---- 2 ----------------------------------------------------------------
    {
        "id": "gap_cat4_invert_tree_returns_none_001",
        "mode": "debug", "problem": "invert_binary_tree", "difficulty": "easy",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def invertTree(self, root):\n"
                "        if not root: return None\n"
                "        root.left, root.right = root.right, root.left\n"
                "        self.invertTree(root.left)\n"
                "        self.invertTree(root.right)\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected [4,7,2,9,6,3,1], got None\n"
                "[USER MESSAGE]\nReturns None?"
            )},
            {"role": "assistant", "content": (
                "Your swap on line 4 and recursive calls on lines 5–6 are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Missing return statement**\n"
                "After recursively inverting both subtrees, the function doesn't return anything — "
                "Python functions implicitly return `None` when there's no `return`. "
                "The caller receives `None` instead of the (now correctly inverted) tree.\n\n"
                "After line 6, what should the function return so the caller gets the inverted tree?"
            )},
        ]
    },
    # ---- 3 ----------------------------------------------------------------
    {
        "id": "gap_cat4_same_tree_wrong_and_001",
        "mode": "debug", "problem": "same_tree", "difficulty": "easy",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def isSameTree(self, p, q):\n"
                "        if not p and not q: return True\n"
                "        if not p or not q: return False\n"
                "        if p.val != q.val: return False\n"
                "        return self.isSameTree(p.left, q.left) or \\\n"
                "               self.isSameTree(p.right, q.right)\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: trees that differ on the right subtree returned True\n"
                "[USER MESSAGE]\nReturns True when trees differ?"
            )},
            {"role": "assistant", "content": (
                "Your base cases and value comparison are all correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 6–7**\n```python\nreturn self.isSameTree(p.left, q.left) or \\\n"
                "       self.isSameTree(p.right, q.right)\n```\n"
                "Lines 6–7 use `or` to combine the left and right subtree checks. With `or`, the "
                "function returns `True` if **either** subtree is the same — meaning a tree where "
                "only the left subtrees match would incorrectly return `True`. You need **both** "
                "subtrees to match.\n\n"
                "Which logical operator should replace `or` so both conditions must be true?"
            )},
        ]
    },
    # ---- 4 ----------------------------------------------------------------
    {
        "id": "gap_cat4_level_order_wrong_level_001",
        "mode": "debug", "problem": "binary_tree_level_order_traversal", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import deque\nclass Solution:\n"
                "    def levelOrder(self, root):\n"
                "        if not root: return []\n"
                "        result, queue = [], deque([root])\n"
                "        while queue:\n"
                "            node = queue.popleft()\n"
                "            result.append([node.val])\n"
                "            if node.left: queue.append(node.left)\n"
                "            if node.right: queue.append(node.right)\n"
                "        return result\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected [[3],[9,20],[15,7]], got [[3],[9],[20],[15],[7]]\n"
                "[USER MESSAGE]\nEach node is in its own list"
            )},
            {"role": "assistant", "content": (
                "Your BFS structure and queue operations are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 7–8**\n```python\nnode = queue.popleft()\nresult.append([node.val])\n```\n"
                "Lines 7–8 process one node at a time and create a new level list for each node. "
                "But level order traversal should group **all nodes at the same depth** into one list. "
                "The fix is to capture the current queue length at the start of each iteration "
                "(`level_size = len(queue)`), then process exactly that many nodes in a loop, "
                "collecting their values into a single `level` list before appending to `result`.\n\n"
                "How would you use `len(queue)` to process all nodes of the current level before "
                "moving to the next?"
            )},
        ]
    },
    # ---- 5 ----------------------------------------------------------------
    {
        "id": "gap_cat4_validate_bst_no_bounds_001",
        "mode": "debug", "problem": "validate_bst", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def isValidBST(self, root):\n"
                "        def validate(node):\n"
                "            if not node: return True\n"
                "            if node.left and node.left.val >= node.val: return False\n"
                "            if node.right and node.right.val <= node.val: return False\n"
                "            return validate(node.left) and validate(node.right)\n"
                "        return validate(root)\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: tree [5,1,4,null,null,3,6] returned True, expected False\n"
                "[USER MESSAGE]\nReturns True for an invalid BST"
            )},
            {"role": "assistant", "content": (
                "Your recursion structure is correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 5–6**\n```python\nif node.left and node.left.val >= node.val: return False\nif node.right and node.right.val <= node.val: return False\n```\n"
                "Lines 5–6 only check the **immediate** child against the current node. "
                "But a valid BST requires every node in the left subtree to be less than "
                "the current node — not just the direct child. For `[5,1,4,null,null,3,6]`, "
                "node 5's right child is 4 (correctly fails the local check), but your code passes "
                "because the check at node 5 only looks at its direct right child. Wait — actually "
                "`4 <= 5` IS caught by line 6... let me re-read.\n\n"
                "Actually the issue is subtler: for the left subtree rooted at `4`, node `4` passes "
                "its own local check (left child `3 < 4`, right child `6 > 4`). But `4 < 5` — "
                "being in the right subtree of `5`, node `4` should be `> 5`. The local comparison "
                "at node `5` catches `4 <= 5`, so this should fail at the root check...\n\n"
                "Can you paste the exact tree structure? The tree `[5,1,4,null,null,3,6]` has `4` as "
                "the right child of `5`, and line 6 should catch `4 <= 5`. What does your test output "
                "show at each node?"
            )},
        ]
    },
    # ---- 6 ----------------------------------------------------------------
    {
        "id": "gap_cat4_course_schedule_no_cycle_check_001",
        "mode": "debug", "problem": "course_schedule", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def canFinish(self, numCourses, prerequisites):\n"
                "        graph = [[] for _ in range(numCourses)]\n"
                "        for a, b in prerequisites:\n"
                "            graph[b].append(a)\n"
                "        visited = set()\n"
                "        def dfs(node):\n"
                "            if node in visited: return False\n"
                "            visited.add(node)\n"
                "            for nei in graph[node]:\n"
                "                if not dfs(nei): return False\n"
                "            return True\n"
                "        for i in range(numCourses):\n"
                "            if not dfs(i): return False\n"
                "        return True\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: no cycle but returns False\n"
                "[USER MESSAGE]\nReturns False when there's no cycle?"
            )},
            {"role": "assistant", "content": (
                "Your graph construction and DFS approach are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 6 and 9**\n```python\nvisited = set()\n...\nvisited.add(node)\n```\n"
                "Lines 6 and 9 use a single `visited` set across all DFS calls. Once a node is "
                "added to `visited` (because it was safely processed in one DFS call), a later "
                "DFS that reaches the same node will incorrectly return `False` — as if it found "
                "a cycle. The `visited` set should track nodes in the **current DFS path**, not "
                "all previously visited nodes.\n\n"
                "The standard approach uses two sets: one for nodes in the current path (`cycle_set`) "
                "and one for fully processed nodes (`done_set`). When a node finishes DFS without "
                "finding a cycle, remove it from `cycle_set` and add it to `done_set`. "
                "What should happen when DFS reaches a node already in `done_set`?"
            )},
        ]
    },
    # ---- 7 ----------------------------------------------------------------
    {
        "id": "gap_cat4_num_of_connected_components_wrong_union_001",
        "mode": "debug", "problem": "number_of_connected_components", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def countComponents(self, n, edges):\n"
                "        parent = list(range(n))\n"
                "        def find(x):\n"
                "            while parent[x] != x:\n"
                "                x = parent[x]\n"
                "            return x\n"
                "        def union(x, y):\n"
                "            px, py = find(x), find(y)\n"
                "            if px != py:\n"
                "                parent[px] = py\n"
                "        for x, y in edges:\n"
                "            union(x, y)\n"
                "        return sum(1 for i in range(n) if parent[i] == i)\n```\n"
                "[TEST CASE DETAILS]\n1/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 2: expected 2, got 3\n"
                "[USER MESSAGE]\nWrong count?"
            )},
            {"role": "assistant", "content": (
                "Your Union-Find structure is mostly correct. I found **1 issue**.\n\n"
                "**Issue 1 — Line 15**\n```python\nreturn sum(1 for i in range(n) if parent[i] == i)\n```\n"
                "Line 15 counts nodes where `parent[i] == i` (i.e., they are their own root). "
                "But your `find` function without path compression can leave intermediate nodes "
                "pointing to non-root parents after `union`. After union, `parent[px] = py` makes "
                "`px` point to `py`, but `py` might not be its own root yet — future `find` calls "
                "will still work by traversal, but the count on line 15 checks raw `parent` values, "
                "not the `find` result.\n\n"
                "The fix: count components by counting nodes where `find(i) == i` (using the `find` "
                "function), not just `parent[i] == i`. What's the difference between `parent[i]` and `find(i)`?"
            )},
        ]
    },
    # ---- 8 ----------------------------------------------------------------
    {
        "id": "gap_cat4_coin_change_2_wrong_order_001",
        "mode": "debug", "problem": "coin_change_2", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def change(self, amount, coins):\n"
                "        dp = [0] * (amount + 1)\n"
                "        dp[0] = 1\n"
                "        for a in range(1, amount + 1):\n"
                "            for coin in coins:\n"
                "                if a >= coin:\n"
                "                    dp[a] += dp[a - coin]\n"
                "        return dp[amount]\n```\n"
                "[TEST CASE DETAILS]\n1/3 tests passed — counts permutations instead of combinations\n"
                "[EXECUTION OUTPUT]\nTest 2: amount=5, coins=[1,2,5], expected=4, got=9\n"
                "[USER MESSAGE]\nReturns too many combinations"
            )},
            {"role": "assistant", "content": (
                "Your DP approach is right for counting ways. I found **1 issue**.\n\n"
                "**Issue 1 — Loop order: Lines 5–6**\n```python\nfor a in range(1, amount + 1):\n    for coin in coins:\n```\n"
                "Lines 5–6 iterate amounts in the outer loop and coins in the inner loop. "
                "This counts **ordered** ways (permutations): `[1,2]` and `[2,1]` are counted "
                "as different. For amount `3`, this gives 4 ways instead of 2. The problem "
                "asks for **unordered** combinations.\n\n"
                "The fix is to swap the loops: iterate **coins** in the outer loop and "
                "**amounts** in the inner loop. This way, each coin is considered 'in order', "
                "preventing the same combination from being counted multiple times. "
                "Why does putting coins in the outer loop prevent counting `[1,2]` and `[2,1]` separately?"
            )},
        ]
    },
    # ---- 9 ----------------------------------------------------------------
    {
        "id": "gap_cat4_longest_increasing_subsequence_wrong_init_001",
        "mode": "debug", "problem": "longest_increasing_subsequence", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def lengthOfLIS(self, nums):\n"
                "        dp = [0] * len(nums)\n"
                "        for i in range(len(nums)):\n"
                "            for j in range(i):\n"
                "                if nums[j] < nums[i]:\n"
                "                    dp[i] = max(dp[i], dp[j] + 1)\n"
                "        return max(dp)\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: input=[7,7,7,7,7], expected=1, got=0\n"
                "[USER MESSAGE]\nFails on all-duplicate arrays"
            )},
            {"role": "assistant", "content": (
                "Your O(n²) DP approach and the recurrence are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Line 3**\n```python\ndp = [0] * len(nums)\n```\n"
                "Line 3 initialises all `dp` values to `0`. But every element alone is an "
                "increasing subsequence of length `1`. When all elements are equal (like `[7,7,7]`), "
                "the inner loop's condition `nums[j] < nums[i]` (strict less-than) is never true, "
                "so `dp[i]` stays `0` for every `i`. `max(dp)` returns `0` instead of `1`.\n\n"
                "Each position should start at `1` (the element itself is always a subsequence of length 1). "
                "What should `dp` be initialised to instead of `[0] * len(nums)`?"
            )},
        ]
    },
    # ---- 10 ---------------------------------------------------------------
    {
        "id": "gap_cat4_unique_paths_wrong_dimension_001",
        "mode": "debug", "problem": "unique_paths", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def uniquePaths(self, m, n):\n"
                "        dp = [[1] * m for _ in range(n)]\n"
                "        for r in range(1, n):\n"
                "            for c in range(1, m):\n"
                "                dp[r][c] = dp[r-1][c] + dp[r][c-1]\n"
                "        return dp[n-1][m-1]\n```\n"
                "[TEST CASE DETAILS]\n3/4 tests passed — fails on non-square grids\n"
                "[EXECUTION OUTPUT]\nTest 4: m=7,n=3, expected=28, got=28\n"
                "[USER MESSAGE]\nI pass most tests but one fails strangely"
            )},
            {"role": "assistant", "content": (
                "Your DP logic, initialisation, and return value are correct for this setup. "
                "The algorithm is right. I found **no clear bug** from the code alone — your "
                "trace gives the right answer for `m=7, n=3` (28 paths).\n\n"
                "Can you paste the exact failing test case, including the input `m` and `n` values "
                "and what the test runner reports as the wrong output? The test you shared "
                "(`expected=28, got=28`) shows the test passing — so the actual failure must be "
                "on a different grid dimension."
            )},
        ]
    },
    # ---- 11 ---------------------------------------------------------------
    {
        "id": "gap_cat4_house_robber_wrong_transition_001",
        "mode": "debug", "problem": "house_robber", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def rob(self, nums):\n"
                "        if not nums: return 0\n"
                "        if len(nums) == 1: return nums[0]\n"
                "        dp = [0] * len(nums)\n"
                "        dp[0] = nums[0]\n"
                "        dp[1] = nums[1]\n"
                "        for i in range(2, len(nums)):\n"
                "            dp[i] = max(dp[i-1], dp[i-2] + nums[i])\n"
                "        return dp[-1]\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 3: input=[2,1,1,2], expected=4, got=3\n"
                "[USER MESSAGE]\nWrong answer on [2,1,1,2]"
            )},
            {"role": "assistant", "content": (
                "Your DP recurrence on line 9 is correct: `max(skip this house, rob this house + best two houses ago)`. "
                "I found **1 issue**.\n\n"
                "**Issue 1 — Line 7**\n```python\ndp[1] = nums[1]\n```\n"
                "Line 7 initialises `dp[1] = nums[1]` — the value of the second house alone. "
                "But `dp[1]` should represent the best you can do considering the **first two** "
                "houses: either rob house 1 (`nums[0]`) or rob house 2 (`nums[1]`), whichever is larger.\n\n"
                "For `[2, 1, 1, 2]`: `dp[1]` should be `max(2, 1) = 2`, not `1`. "
                "With `dp[1] = 1`, the rest of the DP builds on a wrong foundation.\n\n"
                "What should `dp[1]` be initialised to so it captures the best choice among the first two houses?"
            )},
        ]
    },
    # ---- 12 ---------------------------------------------------------------
    {
        "id": "gap_cat4_pacific_atlantic_wrong_bfs_direction_001",
        "mode": "debug", "problem": "pacific_atlantic_water_flow", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import deque\nclass Solution:\n"
                "    def pacificAtlantic(self, heights):\n"
                "        rows, cols = len(heights), len(heights[0])\n"
                "        pac, atl = set(), set()\n"
                "        def bfs(starts, visited):\n"
                "            queue = deque(starts)\n"
                "            visited.update(starts)\n"
                "            while queue:\n"
                "                r, c = queue.popleft()\n"
                "                for dr, dc in [(0,1),(0,-1),(1,0),(-1,0)]:\n"
                "                    nr, nc = r + dr, c + dc\n"
                "                    if 0 <= nr < rows and 0 <= nc < cols and \\\n"
                "                       (nr, nc) not in visited and \\\n"
                "                       heights[nr][nc] < heights[r][c]:\n"
                "                       visited.add((nr, nc))\n"
                "                       queue.append((nr, nc))\n"
                "        pac_starts = [(r, 0) for r in range(rows)] + [(0, c) for c in range(cols)]\n"
                "        atl_starts = [(r, cols-1) for r in range(rows)] + [(rows-1, c) for c in range(cols)]\n"
                "        bfs(pac_starts, pac)\n"
                "        bfs(atl_starts, atl)\n"
                "        return [[r, c] for r in range(rows) for c in range(cols) if (r,c) in pac and (r,c) in atl]\n```\n"
                "[TEST CASE DETAILS]\n0/3 tests passed\n"
                "[EXECUTION OUTPUT]\nTest 1: expected cells, got []\n"
                "[USER MESSAGE]\nReturns empty list"
            )},
            {"role": "assistant", "content": (
                "Your BFS structure and the final intersection are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Line 15**\n```python\nheights[nr][nc] < heights[r][c]:\n```\n"
                "Line 15 checks that the neighbour is **lower** than the current cell. "
                "But this BFS runs in reverse — you start from ocean borders and expand inland. "
                "Water flows from high to low, so in reverse you should expand to cells that are "
                "**equal or higher** (water could have flowed down from there to where you are now). "
                "The condition should be `>=` (neighbour is at least as high), not `<` (neighbour is lower).\n\n"
                "With `<`, the BFS can only move to lower cells from the ocean borders — it immediately "
                "gets stuck at the border cells, finding no reachable interior cells. "
                "What comparison operator should replace `<` on line 15?"
            )},
        ]
    },
    # ---- 13 ---------------------------------------------------------------
    {
        "id": "gap_cat4_graph_bfs_missing_visited_001",
        "mode": "debug", "problem": "clone_graph", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nfrom collections import deque\nclass Solution:\n"
                "    def cloneGraph(self, node):\n"
                "        if not node: return None\n"
                "        clones = {node: Node(node.val)}\n"
                "        queue = deque([node])\n"
                "        while queue:\n"
                "            curr = queue.popleft()\n"
                "            for nei in curr.neighbors:\n"
                "                if nei not in clones:\n"
                "                    clones[nei] = Node(nei.val)\n"
                "                    queue.append(nei)\n"
                "                clones[curr].neighbors.append(clones[nei])\n"
                "        return clones[node]\n```\n"
                "[TEST CASE DETAILS]\n3/4 tests passed — TLE on cyclic graphs\n"
                "[EXECUTION OUTPUT]\nTest 4: Time Limit Exceeded\n"
                "[USER MESSAGE]\nTime limit on graph with cycles?"
            )},
            {"role": "assistant", "content": (
                "Your clone creation and neighbour linking logic are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Lines 10–12**\n```python\nif nei not in clones:\n    clones[nei] = Node(nei.val)\n    queue.append(nei)\n```\n"
                "Lines 10–12 only enqueue a neighbour if it's not yet in `clones`. Since `clones` is "
                "populated when the node is first seen, this correctly avoids enqueuing duplicates. "
                "So why is there a TLE?\n\n"
                "Actually, tracing carefully: `clones` is checked before enqueue, and `clones[nei]` "
                "is created when `nei` is first seen — this looks like it prevents infinite loops. "
                "The algorithm appears correct.\n\n"
                "Can you share more about the graph structure in Test 4? Is it a single node with "
                "a self-loop? Or a cycle between 2+ nodes? Some edge cases in `Node` construction "
                "can cause unexpected recursion outside this code."
            )},
        ]
    },
    # ---- 14 ---------------------------------------------------------------
    {
        "id": "gap_cat4_decode_ways_zero_handling_001",
        "mode": "debug", "problem": "decode_ways", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def numDecodings(self, s):\n"
                "        n = len(s)\n"
                "        dp = [0] * (n + 1)\n"
                "        dp[0] = 1\n"
                "        dp[1] = 1\n"
                "        for i in range(2, n + 1):\n"
                "            if s[i-1] != '0':\n"
                "                dp[i] += dp[i-1]\n"
                "            two_digit = int(s[i-2:i])\n"
                "            if 10 <= two_digit <= 26:\n"
                "                dp[i] += dp[i-2]\n"
                "        return dp[n]\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — fails when string starts with '0'\n"
                "[EXECUTION OUTPUT]\nTest 3: input='06', expected=0, got=1\n"
                "[USER MESSAGE]\nFails when string starts with 0"
            )},
            {"role": "assistant", "content": (
                "Your DP recurrence and two-digit check are correct. I found **1 issue**.\n\n"
                "**Issue 1 — Line 6**\n```python\ndp[1] = 1\n```\n"
                "Line 6 always sets `dp[1] = 1`, meaning 'one way to decode the first character'. "
                "But if `s[0] == '0'`, there is no valid decoding — `'0'` by itself does not map "
                "to any letter (letters map to 1–26). For `'06'`, `dp[1]` should be `0` (can't "
                "decode `'0'` alone), so the result should be `0`. Instead, `dp[1] = 1` tells "
                "the DP there's a valid path through the first character.\n\n"
                "What condition should gate the assignment on line 6 so `dp[1]` is `0` when `s[0] == '0'`?"
            )},
        ]
    },
    # ---- 15 ---------------------------------------------------------------
    {
        "id": "gap_cat4_jump_game_2_wrong_greedy_001",
        "mode": "debug", "problem": "jump_game_2", "difficulty": "medium",
        "bug_count": 1, "category": "tree_graph",
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": (
                "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution:\n"
                "    def jump(self, nums):\n"
                "        jumps = 0\n"
                "        current_end = 0\n"
                "        farthest = 0\n"
                "        for i in range(len(nums)):\n"
                "            farthest = max(farthest, i + nums[i])\n"
                "            if i == current_end:\n"
                "                jumps += 1\n"
                "                current_end = farthest\n"
                "        return jumps\n```\n"
                "[TEST CASE DETAILS]\n2/3 tests passed — off by one on some inputs\n"
                "[EXECUTION OUTPUT]\nTest 3: input=[2,3,1,1,4], expected=2, got=3\n"
                "[USER MESSAGE]\nOff by one on jumps?"
            )},
            {"role": "assistant", "content": (
                "Your greedy BFS-level approach is correct — tracking `farthest` and incrementing "
                "`jumps` at each level boundary is the right strategy. I found **1 issue**.\n\n"
                "**Issue 1 — Line 6**\n```python\nfor i in range(len(nums)):\n```\n"
                "Line 6 iterates through every index including the last one. When `i` reaches the "
                "last index (`len(nums) - 1`), if it equals `current_end`, `jumps += 1` fires — "
                "counting an extra jump to 'leave' the last position, when you've already arrived. "
                "The loop should stop **before** the last index.\n\n"
                "Change `range(len(nums))` to `range(len(nums) - 1)` so the final position doesn't "
                "trigger an extra jump increment. Why is it correct to exclude the last index from "
                "this loop?"
            )},
        ]
    },
]


# ===========================================================================
# Write output
# ===========================================================================

ALL_EXAMPLES = CAT1 + CAT2 + CAT3 + CAT4


def validate(examples: list) -> list[str]:
    """Return list of validation error strings (empty = all good)."""
    errors = []
    seen_ids = set()
    for ex in examples:
        eid = ex.get("id", "<missing>")
        if eid in seen_ids:
            errors.append(f"Duplicate id: {eid}")
        seen_ids.add(eid)

        if ex.get("mode") != "debug":
            errors.append(f"{eid}: mode must be 'debug'")

        msgs = ex.get("messages", [])
        if not msgs or msgs[0].get("role") != "system":
            errors.append(f"{eid}: first message must be system role")
        elif msgs[0]["content"] != FINETUNED_SYSTEM_PROMPT:
            errors.append(f"{eid}: system prompt does not match FINETUNED_SYSTEM_PROMPT")

        cat = ex.get("category", "")
        if cat not in {"multi_bug_dead_code", "mostly_correct", "multi_turn", "tree_graph"}:
            errors.append(f"{eid}: unknown category '{cat}'")
    return errors


def main():
    parser = argparse.ArgumentParser(description="Generate 60 gap DEBUG training examples (Section 6).")
    parser.add_argument("--output", default=str(_DEFAULT_OUTPUT),
                        help=f"Output JSONL path (default: {_DEFAULT_OUTPUT})")
    parser.add_argument("--validate", action="store_true",
                        help="Validate only — do not write output file")
    args = parser.parse_args()

    # Validate
    errors = validate(ALL_EXAMPLES)
    if errors:
        print(f"[ERROR] Validation failed ({len(errors)} errors):", file=sys.stderr)
        for e in errors:
            print(f"  • {e}", file=sys.stderr)
        sys.exit(1)

    cats = {"multi_bug_dead_code": 0, "mostly_correct": 0, "multi_turn": 0, "tree_graph": 0}
    for ex in ALL_EXAMPLES:
        cats[ex["category"]] += 1

    print(f"Validated {len(ALL_EXAMPLES)} examples:")
    for cat, n in cats.items():
        print(f"  {cat:<30} {n:>3} examples")

    if args.validate:
        print("Validation passed. (--validate flag set, no file written.)")
        return

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for ex in ALL_EXAMPLES:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"\nWrote {len(ALL_EXAMPLES)} examples to: {out_path}")
    print("\nNext steps:")
    print("  1. python scripts/update_system_prompts.py   # sync prompts in existing training files")
    print("  2. python scripts/validate_prompt_match.py   # verify all prompts match")
    print("  3. Append gap_debug_examples.jsonl to voidcode_training_data_v53.jsonl if retraining TEACHING mode")


if __name__ == "__main__":
    main()
