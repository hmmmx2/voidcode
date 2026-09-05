#!/usr/bin/env python3
"""
generate_debug_examples_v53.py  —  Phase 2b

Generates 160 new DEBUG training examples in the v5.3 "Issue N — Line X" format:
  Cat 1: Multi-bug identification         (65  examples — 15 scenarios × 4 variants + 5 <think> examples)
  Cat 2: Hidden-bug source-code analysis  (30  examples — 10 scenarios × 3 user msg variants)
  Cat 3: Multi-turn conversational debug  (45  examples — 10 scenarios × 4 paths + 5 frustration escalations)
  Cat 4: Mostly-correct encouragement     (20  examples — 20 unique scenarios)
  ─────────────────────────────────────────────────────────────
  Total                                   160 examples

Cat 1 <think> examples (5) use the exact Section 5.3 user message format from
MODEL_IMPROVEMENT_PROMPT.md ([MODE: DEBUG] / [SOURCE CODE] / [TEST CASE DETAILS] /
[USER MESSAGE]) and include <think> reasoning traces in assistant responses,
implementing the core insight from Section 8: teach analysis, not just format.

Run order (from project root):
  1. python llm/scripts/update_system_prompts.py        # creates v53 base (1,700 updated examples)
  2. python llm/scripts/generate_debug_examples_v53.py  # appends 150 new → 1,850 total
"""

import json
import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LLM_DIR     = os.path.dirname(SCRIPTS_DIR)
DATA_DIR    = os.path.join(LLM_DIR, "data")
OUTPUT_FILE = os.path.join(DATA_DIR, "voidcode_training_data_v53.jsonl")

sys.path.insert(0, SCRIPTS_DIR)
from prompts import FINETUNED_SYSTEM_PROMPT  # noqa: E402

SYS = FINETUNED_SYSTEM_PROMPT


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def build_example(eid: str, problem: str, difficulty: str, turns: list) -> dict:
    """turns = list of {"role": ..., "content": ...} excluding the system message."""
    return {
        "id": eid,
        "mode": "debug",
        "problem": problem,
        "difficulty": difficulty,
        "messages": [{"role": "system", "content": SYS}, *turns],
    }


def mt(eid, problem, difficulty, *turn_pairs):
    """Build a multi-turn example. turn_pairs = (user_msg, assistant_msg) tuples."""
    turns = []
    for user_msg, asst_msg in turn_pairs:
        turns.append({"role": "user",      "content": user_msg})
        turns.append({"role": "assistant", "content": asst_msg})
    return build_example(eid, problem, difficulty, turns)


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY 1: MULTI-BUG IDENTIFICATION  (15 scenarios × 4 variants = 60 examples)
# ─────────────────────────────────────────────────────────────────────────────

_U = [  # 4 user-message templates (rotate per scenario)
    lambda code, err: f"My code keeps failing, can you help?\n```python\n{code}\n```\nError: {err}",
    lambda code, err: f"What's wrong with my solution? It's not passing the tests.\n```python\n{code}\n```\nTest output: {err}",
    lambda code, err: f"I'm getting this error and can't figure it out:\n```python\n{code}\n```\n{err}",
    lambda code, err: f"Can you debug this for me?\n```python\n{code}\n```\nFailing with: {err}",
]

CAT1 = [
    # ── 1. Two Sum: variable name confusion (num vs nums) ────────────────────
    {
        "problem": "two_sum", "difficulty": "easy",
        "code": (
            "def twoSum(self, nums, target):\n"
            "    seen = {}\n"
            "    for i, num in enumerate(num):\n"
            "        complement = target - nums\n"
            "        if complement in seen:\n"
            "            return [seen[complement], i]\n"
            "        seen[num] = i\n"
            "    return []"
        ),
        "error": "NameError: name 'num' is not defined (line 3)",
        "response": (
            "I found **2 issues** in your code. Let's start with the crash.\n\n"
            "**Issue 1 — Line 3**\n"
            "```python\n"
            "for i, num in enumerate(num):\n"
            "```\n"
            "You're iterating over `num`, but that variable doesn't exist yet — "
            "it's the loop variable *being created* by this line. "
            "The list you want to iterate over is `nums` (the parameter). "
            "Python raises `NameError` before the loop body ever executes.\n\n"
            "What is the parameter name in the function signature for the input list?\n\n"
            "**Issue 2 — Line 4**\n"
            "```python\n"
            "complement = target - nums\n"
            "```\n"
            "Once Issue 1 is fixed, this line will raise `TypeError` — "
            "you're subtracting `nums` (the whole list) from `target` (an integer). "
            "You want the *current element* from the loop. "
            "What's the loop variable called after `i` in `for i, num in ...`?\n\n"
            "---\n"
            "Let's fix Issue 1 first since the code can't even start without it. "
            "What should `enumerate(num)` be changed to?"
        ),
    },
    # ── 2. Valid Parentheses: .push() + inverted final return ────────────────
    {
        "problem": "valid_parentheses", "difficulty": "easy",
        "code": (
            "def isValid(self, s):\n"
            "    stack = []\n"
            "    for char in s:\n"
            "        if char in '([{':\n"
            "            stack.push(char)\n"
            "        else:\n"
            "            if not stack:\n"
            "                return False\n"
            "            top = stack.pop()\n"
            "            if (top == '(' and char != ')') or \\\n"
            "               (top == '[' and char != ']') or \\\n"
            "               (top == '{' and char != '}'):\n"
            "                return False\n"
            "    return len(stack) != 0"
        ),
        "error": "AttributeError: 'list' object has no attribute 'push'",
        "response": (
            "I found **2 issues** in your code. The first crashes immediately.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "stack.push(char)\n"
            "```\n"
            "Python lists don't have `.push()` — that's JavaScript. "
            "The equivalent in Python is `.append()`. "
            "This raises `AttributeError` the moment any opening bracket is encountered.\n\n"
            "What Python list method adds an element to the end?\n\n"
            "**Issue 2 — Line 14**\n"
            "```python\n"
            "return len(stack) != 0\n"
            "```\n"
            "Your logic is inverted. An *empty* stack after scanning all of `s` means "
            "every bracket was matched and closed — that's a valid string, so return `True`. "
            "But `len(stack) != 0` returns `True` when the stack is *not* empty (unmatched brackets!). "
            "Flip `!=` to `==`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What method should replace `.push()`?"
        ),
    },
    # ── 3. Binary Search: out-of-bounds right + no progress on left ──────────
    {
        "problem": "binary_search", "difficulty": "easy",
        "code": (
            "def search(self, nums, target):\n"
            "    left, right = 0, len(nums)\n"
            "    while left <= right:\n"
            "        mid = (left + right) // 2\n"
            "        if nums[mid] == target:\n"
            "            return mid\n"
            "        elif nums[mid] < target:\n"
            "            left = mid\n"
            "        else:\n"
            "            right = mid - 1\n"
            "    return -1"
        ),
        "error": "IndexError: list index out of range (line 5)",
        "response": (
            "I found **2 issues** in your code. The first causes an immediate crash.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "left, right = 0, len(nums)\n"
            "```\n"
            "`right` is set to `len(nums)` — one past the last valid index. "
            "When `mid` reaches that boundary, `nums[mid]` raises `IndexError`. "
            "The safe upper bound is `len(nums) - 1`.\n\n"
            "What's the index of the last element in a Python list of length `n`?\n\n"
            "**Issue 2 — Line 8**\n"
            "```python\n"
            "left = mid\n"
            "```\n"
            "Even after fixing Issue 1, this creates an infinite loop. "
            "When `nums[mid] < target` we know the answer is to the right of `mid`, "
            "so we must move *past* it. Setting `left = mid` keeps the window the same size — "
            "the search never narrows. The standard fix is `left = mid + 1`.\n\n"
            "---\n"
            "Let's fix Issue 1 so the code can run. What should `right` be initialised to?"
        ),
    },
    # ── 4. Maximum Subarray: zero init + comparison instead of assignment ─────
    {
        "problem": "max_subarray", "difficulty": "medium",
        "code": (
            "def maxSubArray(self, nums):\n"
            "    max_sum = 0\n"
            "    current_sum = 0\n"
            "    for num in nums:\n"
            "        current_sum = current_sum + num\n"
            "        if current_sum > max_sum:\n"
            "            max_sum = current_sum\n"
            "        if current_sum < 0:\n"
            "            current_sum == 0\n"
            "    return max_sum"
        ),
        "error": "Wrong answer: expected -2, got 0 (all-negative input [-3,-2,-1])",
        "response": (
            "I found **2 issues** in your code. Neither crashes, but both corrupt the result.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "max_sum = 0\n"
            "```\n"
            "Starting `max_sum` at `0` fails for all-negative arrays. "
            "If every number is negative, the largest subarray sum is the least-negative element — never `0`. "
            "The correct starting value is `nums[0]`, and the loop should begin from index 1.\n\n"
            "If the input is `[-3, -1, -2]`, what is the correct answer "
            "and why doesn't `0` capture it?\n\n"
            "**Issue 2 — Line 9**\n"
            "```python\n"
            "current_sum == 0\n"
            "```\n"
            "This is a *comparison* (`==`), not an *assignment* (`=`). "
            "It evaluates to `True` or `False` and discards the result — `current_sum` is never reset. "
            "The running sum keeps accumulating negatives and the subarray never restarts. "
            "Change `==` to `=`.\n\n"
            "---\n"
            "Let's tackle Issue 1 first. What should `max_sum` be initialised to?"
        ),
    },
    # ── 5. Climbing Stairs: incomplete recurrence + off-by-one return ─────────
    {
        "problem": "climbing_stairs", "difficulty": "easy",
        "code": (
            "def climbStairs(self, n):\n"
            "    if n <= 1:\n"
            "        return n\n"
            "    dp = [0] * (n + 1)\n"
            "    dp[1] = 1\n"
            "    dp[2] = 2\n"
            "    for i in range(3, n + 1):\n"
            "        dp[i] = dp[i-1]\n"
            "    return dp[n-1]"
        ),
        "error": "Wrong answer: expected 3, got 2 (n=3)",
        "response": (
            "I found **2 issues** in your code. Both affect the final answer.\n\n"
            "**Issue 1 — Line 8**\n"
            "```python\n"
            "dp[i] = dp[i-1]\n"
            "```\n"
            "This only counts arrivals via a 1-step from `i-1`, "
            "completely ignoring the 2-step option from `i-2`. "
            "The climbing stairs recurrence adds *both* options: "
            "`dp[i] = dp[i-1] + dp[i-2]`.\n\n"
            "What do you need to add to `dp[i-1]` to count both jump sizes?\n\n"
            "**Issue 2 — Line 9**\n"
            "```python\n"
            "return dp[n-1]\n"
            "```\n"
            "Off-by-one: you want the number of ways to reach step `n`, stored at `dp[n]`. "
            "Returning `dp[n-1]` gives the answer for `n-1` steps. Change `n-1` to `n`.\n\n"
            "---\n"
            "Let's fix Issue 1 first — it's the heart of the algorithm. "
            "What is the complete recurrence formula for `dp[i]`?"
        ),
    },
    # ── 6. Coin Change: missing min() + wrong impossible return ───────────────
    {
        "problem": "coin_change", "difficulty": "medium",
        "code": (
            "def coinChange(self, coins, amount):\n"
            "    dp = [float('inf')] * (amount + 1)\n"
            "    dp[0] = 0\n"
            "    for coin in coins:\n"
            "        for i in range(coin, amount + 1):\n"
            "            dp[i] = dp[i - coin] + 1\n"
            "    return dp[amount] if dp[amount] != float('inf') else 1"
        ),
        "error": "Wrong answer: expected 3, got 1 (coins=[1,5,10], amount=11)",
        "response": (
            "I found **2 issues** in your code. Neither crashes, but both corrupt the result.\n\n"
            "**Issue 1 — Line 6**\n"
            "```python\n"
            "dp[i] = dp[i - coin] + 1\n"
            "```\n"
            "This *overwrites* `dp[i]` with the current coin's cost, "
            "discarding any better answer from a previous coin. "
            "The whole point of DP is to keep the *minimum*. "
            "Wrap this in `min(dp[i], ...)` so you only update when the new path is cheaper.\n\n"
            "If a previous coin found `dp[11] = 2`, and the current coin calculates 6, "
            "what should `dp[11]` become?\n\n"
            "**Issue 2 — Line 7**\n"
            "```python\n"
            "return dp[amount] if dp[amount] != float('inf') else 1\n"
            "```\n"
            "The problem asks for `-1` when the amount can't be made, not `1`. "
            "Returning `1` looks like a valid one-coin answer. Change `else 1` to `else -1`.\n\n"
            "---\n"
            "Let's fix Issue 1 first — it's the more impactful bug. "
            "How would you use `min()` on line 6?"
        ),
    },
    # ── 7. Reverse Linked List: pointer overwrite loses rest of list ──────────
    {
        "problem": "reverse_linked_list", "difficulty": "easy",
        "code": (
            "def reverseList(self, head):\n"
            "    prev = None\n"
            "    curr = head\n"
            "    while curr:\n"
            "        curr.next = prev\n"
            "        prev = curr\n"
            "        curr = curr.next\n"
            "    return prev"
        ),
        "error": "Wrong answer: output list is [1] instead of [5,4,3,2,1]",
        "response": (
            "I found **1 issue** in your code — but it destroys every node after the first.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "curr.next = prev\n"
            "```\n"
            "You're overwriting `curr.next` *before* saving it. "
            "The moment line 5 executes, the pointer to the rest of the list is gone. "
            "Line 7 (`curr = curr.next`) then reads back the pointer you just set to `prev`, "
            "bouncing you backward instead of forward. The loop terminates after one node.\n\n"
            "The fix is to save `next_node = curr.next` as the *first* statement inside the loop, "
            "then do the reversal, and finally set `curr = next_node`.\n\n"
            "What should be the very first line inside the `while curr:` body?"
        ),
    },
    # ── 8. Contains Duplicate: both return values swapped ────────────────────
    {
        "problem": "contains_duplicate", "difficulty": "easy",
        "code": (
            "def containsDuplicate(self, nums):\n"
            "    seen = set()\n"
            "    for num in nums:\n"
            "        if num in seen:\n"
            "            return False\n"
            "        seen.add(num)\n"
            "    return True"
        ),
        "error": "Wrong answer: expected True, got False ([1,2,3,1])",
        "response": (
            "I found **2 issues** in your code — both return values are swapped.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "return False\n"
            "```\n"
            "This fires when `num in seen` — meaning we *found* a duplicate. "
            "But the function should return `True` when a duplicate exists. "
            "You're returning the opposite. Swap `False` to `True`.\n\n"
            "When `num` is already in `seen`, does the array have duplicates?\n\n"
            "**Issue 2 — Line 7**\n"
            "```python\n"
            "return True\n"
            "```\n"
            "Reaching this line means the whole array was scanned without finding any repeated element — "
            "so there are *no* duplicates. Return `False`. Swap `True` to `False`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. When you *find* a duplicate, what should you return?"
        ),
    },
    # ── 9. Product of Array Except Self: [0] init + += instead of *= ─────────
    {
        "problem": "product_except_self", "difficulty": "medium",
        "code": (
            "def productExceptSelf(self, nums):\n"
            "    n = len(nums)\n"
            "    result = [0] * n\n"
            "    prefix = 1\n"
            "    for i in range(n):\n"
            "        result[i] = prefix\n"
            "        prefix *= nums[i]\n"
            "    suffix = 1\n"
            "    for i in range(n - 1, -1, -1):\n"
            "        result[i] += suffix\n"
            "        suffix *= nums[i]\n"
            "    return result"
        ),
        "error": "Wrong answer: expected [24,12,8,6], got [1,2,6,1] ([1,2,3,4])",
        "response": (
            "I found **2 issues** in your code. Both corrupt the final products.\n\n"
            "**Issue 1 — Line 3**\n"
            "```python\n"
            "result = [0] * n\n"
            "```\n"
            "Initialising with zeros means any multiplication will stay zero. "
            "The neutral starting value for multiplication is `1`, not `0`. "
            "Change to `result = [1] * n`.\n\n"
            "What is the multiplicative identity — the number that leaves any product unchanged?\n\n"
            "**Issue 2 — Line 10**\n"
            "```python\n"
            "result[i] += suffix\n"
            "```\n"
            "`+=` *adds* the suffix to `result[i]`, but you want to *multiply* the prefix "
            "(already stored in `result[i]`) by the suffix. Use `*=` instead of `+=`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What should `[0] * n` be changed to?"
        ),
    },
    # ── 10. Find Min Rotated: out-of-bounds right + wrong boundary update ─────
    {
        "problem": "find_min_rotated_sorted_array", "difficulty": "medium",
        "code": (
            "def findMin(self, nums):\n"
            "    left, right = 0, len(nums)\n"
            "    while left < right:\n"
            "        mid = (left + right) // 2\n"
            "        if nums[mid] > nums[right]:\n"
            "            left = mid + 1\n"
            "        else:\n"
            "            right = mid + 1\n"
            "    return nums[left]"
        ),
        "error": "IndexError: list index out of range (line 5)",
        "response": (
            "I found **2 issues** in your code. The first crashes immediately.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "left, right = 0, len(nums)\n"
            "```\n"
            "`right = len(nums)` is one past the last valid index. "
            "Line 5 accesses `nums[right]` directly — when `right == len(nums)` that's `IndexError`. "
            "Set `right = len(nums) - 1`.\n\n"
            "What is the index of the last element in a list of length `n`?\n\n"
            "**Issue 2 — Line 8**\n"
            "```python\n"
            "right = mid + 1\n"
            "```\n"
            "The minimum *could* be at `mid` (when `nums[mid] <= nums[right]`), "
            "so we can't exclude it. Setting `right = mid + 1` skips over the potential minimum. "
            "The correct update is `right = mid`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What should `right` be set to?"
        ),
    },
    # ── 11. 3Sum: both pointer movements in wrong direction ───────────────────
    {
        "problem": "three_sum", "difficulty": "medium",
        "code": (
            "def threeSum(self, nums):\n"
            "    nums.sort()\n"
            "    result = []\n"
            "    for i in range(len(nums) - 2):\n"
            "        if i > 0 and nums[i] == nums[i-1]:\n"
            "            continue\n"
            "        left, right = i + 1, len(nums) - 1\n"
            "        while left < right:\n"
            "            total = nums[i] + nums[left] + nums[right]\n"
            "            if total == 0:\n"
            "                result.append([nums[i], nums[left], nums[right]])\n"
            "                left += 1\n"
            "                right -= 1\n"
            "            elif total < 0:\n"
            "                left -= 1\n"
            "            else:\n"
            "                right += 1\n"
            "    return result"
        ),
        "error": "Wrong answer: infinite loop / incorrect result",
        "response": (
            "I found **2 issues** — both are pointer movement bugs that prevent convergence.\n\n"
            "**Issue 1 — Line 15**\n"
            "```python\n"
            "left -= 1\n"
            "```\n"
            "When `total < 0`, the sum is too small — we need a *larger* value. "
            "Since the array is sorted, moving `left` *right* (toward larger numbers) increases the sum. "
            "Decrementing `left` moves it toward smaller numbers, making the total even smaller "
            "and causing an infinite loop. Change `left -= 1` to `left += 1`.\n\n"
            "When the three-pointer sum is too small, which pointer moves and in which direction?\n\n"
            "**Issue 2 — Line 17**\n"
            "```python\n"
            "right += 1\n"
            "```\n"
            "When `total > 0`, the sum is too large — move `right` *left* to get a smaller value. "
            "`right += 1` moves out of bounds and makes the total larger. Change to `right -= 1`.\n\n"
            "---\n"
            "Let's fix Issue 1 since it causes the infinite loop. "
            "What should `left -= 1` be changed to?"
        ),
    },
    # ── 12. Longest Substring: wrong char removed + window size off-by-one ────
    {
        "problem": "longest_substring_without_repeating", "difficulty": "medium",
        "code": (
            "def lengthOfLongestSubstring(self, s):\n"
            "    char_set = set()\n"
            "    left = 0\n"
            "    max_len = 0\n"
            "    for right in range(len(s)):\n"
            "        while s[right] in char_set:\n"
            "            char_set.discard(s[left + 1])\n"
            "            left += 1\n"
            "        char_set.add(s[right])\n"
            "        max_len = max(max_len, right - left)\n"
            "    return max_len"
        ),
        "error": "Wrong answer: expected 3, got 2 ('abcabcbb')",
        "response": (
            "I found **2 issues** in your code. Both affect the recorded window size.\n\n"
            "**Issue 1 — Line 7**\n"
            "```python\n"
            "char_set.discard(s[left + 1])\n"
            "```\n"
            "When shrinking the window you remove `s[left + 1]` — the character *after* "
            "the current left boundary. But the character to evict is `s[left]` (the current leftmost). "
            "You're removing the wrong character, leaving a stale entry in the set.\n\n"
            "When contracting the left side of the window, which index's character should be removed?\n\n"
            "**Issue 2 — Line 10**\n"
            "```python\n"
            "max_len = max(max_len, right - left)\n"
            "```\n"
            "A window spanning indices `left` to `right` inclusive has length "
            "`right - left + 1`, not `right - left`. "
            "Every window's size is undercounted by 1. Add `+ 1`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What should the argument to `discard()` be?"
        ),
    },
    # ── 13. Two Sum II: out-of-bounds + missing 1-indexing ───────────────────
    {
        "problem": "two_sum_ii", "difficulty": "medium",
        "code": (
            "def twoSum(self, numbers, target):\n"
            "    left, right = 0, len(numbers)\n"
            "    while left < right:\n"
            "        current = numbers[left] + numbers[right]\n"
            "        if current == target:\n"
            "            return [left, right]\n"
            "        elif current < target:\n"
            "            left += 1\n"
            "        else:\n"
            "            right -= 1\n"
            "    return []"
        ),
        "error": "IndexError: list index out of range (line 4)",
        "response": (
            "I found **2 issues** in your code. The first crashes before producing any output.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "left, right = 0, len(numbers)\n"
            "```\n"
            "`right = len(numbers)` is one past the last valid index. "
            "Line 4 immediately accesses `numbers[right]`, raising `IndexError`. "
            "Set `right = len(numbers) - 1`.\n\n"
            "What index should `right` start at?\n\n"
            "**Issue 2 — Line 6**\n"
            "```python\n"
            "return [left, right]\n"
            "```\n"
            "The problem says the answer must be **1-indexed** (first position is 1, not 0). "
            "Returning the zero-based indices will be off by one. "
            "You need `[left + 1, right + 1]`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What should `right` be initialised to?"
        ),
    },
    # ── 14. Merge Sorted Array: wrong pointer start + missing p2 decrement ────
    {
        "problem": "merge_sorted_array", "difficulty": "easy",
        "code": (
            "def merge(self, nums1, m, nums2, n):\n"
            "    p1, p2 = m, n\n"
            "    p = m + n - 1\n"
            "    while p1 >= 0 and p2 >= 0:\n"
            "        if nums1[p1] >= nums2[p2]:\n"
            "            nums1[p] = nums1[p1]\n"
            "            p1 -= 1\n"
            "        else:\n"
            "            nums1[p] = nums2[p2]\n"
            "            p2 -= 1\n"
            "        p -= 1\n"
            "    while p2 >= 0:\n"
            "        nums1[p] = nums2[p2]\n"
            "        p -= 1"
        ),
        "error": "IndexError: list index out of range (line 5)",
        "response": (
            "I found **2 issues** in your code.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "p1, p2 = m, n\n"
            "```\n"
            "`p1` and `p2` should point to the *last valid elements* of `nums1` and `nums2`. "
            "The last element of `nums1`'s filled portion is at index `m - 1`, "
            "and `nums2`'s last is at `n - 1`. "
            "Starting at `m` and `n` immediately accesses out-of-bounds indices on line 5.\n\n"
            "If `nums1` has `m` filled elements, what is the index of its last filled element?\n\n"
            "**Issue 2 — Line 13 (missing statement)**\n"
            "```python\n"
            "nums1[p] = nums2[p2]\n"
            "```\n"
            "The second `while` loop copies remaining `nums2` elements but never decrements `p2`. "
            "Every iteration writes `nums2[p2]` but `p2` stays fixed — "
            "you'll copy the same element into every remaining position. "
            "Add `p2 -= 1` after line 13.\n\n"
            "---\n"
            "Let's fix Issue 1 first. What should `p1` and `p2` start at?"
        ),
    },
    # ── 15. Palindrome Number: return values swapped + pointer direction wrong ─
    {
        "problem": "palindrome_number", "difficulty": "easy",
        "code": (
            "def isPalindrome(self, x):\n"
            "    if x < 0:\n"
            "        return False\n"
            "    s = str(x)\n"
            "    left, right = 0, len(s) - 1\n"
            "    while left < right:\n"
            "        if s[left] != s[right]:\n"
            "            return True\n"
            "        left += 1\n"
            "        right += 1\n"
            "    return True"
        ),
        "error": "Wrong answer: expected True, got False (x=121)",
        "response": (
            "I found **2 issues** in your code. Both invert the check.\n\n"
            "**Issue 1 — Line 8**\n"
            "```python\n"
            "return True\n"
            "```\n"
            "This fires when `s[left] != s[right]` — the characters at those positions "
            "*don't* match, meaning the number is **not** a palindrome. "
            "But you return `True` (saying it IS a palindrome). Swap `True` to `False`.\n\n"
            "When two mirrored characters don't match, is the number a palindrome?\n\n"
            "**Issue 2 — Line 10**\n"
            "```python\n"
            "right += 1\n"
            "```\n"
            "`right` should move *inward* (toward the center) each step, not outward. "
            "Incrementing `right` sends it past the end of the string and the pointers never meet. "
            "Change `right += 1` to `right -= 1`.\n\n"
            "---\n"
            "Let's fix Issue 1. When `s[left] != s[right]`, what should be returned?"
        ),
    },
]


def _cat1_think_examples():
    """
    5 single-turn examples using the exact Section 5.3 user message format from
    MODEL_IMPROVEMENT_PROMPT.md, with <think> reasoning traces in assistant responses.

    These implement the core engineering insight from Section 8:
    the model must ANALYSE source code before formatting a response.

    User message format:  [MODE: DEBUG] / [SOURCE CODE] / [TEST CASE DETAILS] /
                          [USER MESSAGE]
    Assistant format:     <think>N-step reasoning</think> then Issue N — Line X response.
    """
    examples = []

    # ── 1. Two Sum — canonical scenario from MODEL_IMPROVEMENT_PROMPT Section 5.3 ──
    _TS2_USER = (
        "[MODE: DEBUG]\n"
        "[SOURCE CODE]\n"
        "```python\n"
        "class Solution(object):\n"
        "    def twoSum(self, nums, target):\n"
        "        n = len(nums)\n"
        "        for i in range(n):\n"
        "            for j in range(i + 1, n):\n"
        "                if nums[i] + nums[j] == :\n"
        "                    return []\n"
        "```\n"
        "[TEST CASE DETAILS]\n"
        "0/3 tests passed\n"
        "Test 1: nums=[2,7,11,15], target=9 → Expected [0,1], Got SyntaxError: invalid syntax (line 6)\n"
        "Test 2: nums=[3,2,4], target=6 → Expected [1,2], Got SyntaxError: invalid syntax (line 6)\n"
        "Test 3: nums=[3,3], target=6 → Expected [0,1], Got SyntaxError: invalid syntax (line 6)\n"
        "[USER MESSAGE]\n"
        "Can you review my code and tell me what's wrong?"
    )
    _TS2_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 6: `if nums[i] + nums[j] == :` — missing comparison value after `==`. SyntaxError.\n"
        "3. Line 7: `return []` — returns empty list, should return `[i, j]`.\n"
        "4. Test output shows SyntaxError on line 6 — confirms Bug 1.\n"
        "5. Test output does NOT mention Bug 2 — because code never reaches line 7.\n"
        "6. I'll explain both bugs but focus on Bug 1 first (blocks execution).\n"
        "7. I'll ask a guiding question about the function parameters.\n"
        "</think>\n\n"
        "I found **2 issues** in your code. Let's start with the one that's stopping it from running.\n\n"
        "**Issue 1 — Line 6**\n"
        "```python\n"
        "if nums[i] + nums[j] == :\n"
        "```\n"
        "Python sees `==` and expects a value on the right side, but there's nothing there. "
        "That's why every test case is failing with `SyntaxError`.\n\n"
        "Think about it: you're checking if two numbers add up to... what? "
        "Look at your function parameters — which one represents the target value?\n\n"
        "**Issue 2 — Line 7**\n"
        "```python\n"
        "return []\n"
        "```\n"
        "Even after you fix the line above, this will return an empty list instead of the answer. "
        "The problem asks you to return the **indices** of the matching numbers. "
        "What two variables already hold those positions inside your loops?\n\n"
        "---\n"
        "Let's fix Issue 1 first since the code can't run without it. "
        "What do you think should go after `==`?"
    )
    examples.append(build_example(
        "debug_v53_cat1_think_two_sum_01", "two_sum", "easy",
        [
            {"role": "user",      "content": _TS2_USER},
            {"role": "assistant", "content": _TS2_AI},
        ],
    ))

    # ── 2. Maximum Subarray — init to 0 + missing Kadane reset ────────────────
    _MS_USER = (
        "[MODE: DEBUG]\n"
        "[SOURCE CODE]\n"
        "```python\n"
        "class Solution(object):\n"
        "    def maxSubArray(self, nums):\n"
        "        max_sum = 0\n"
        "        current_sum = 0\n"
        "        for num in nums:\n"
        "            current_sum += num\n"
        "            if current_sum > max_sum:\n"
        "                max_sum = current_sum\n"
        "        return max_sum\n"
        "```\n"
        "[TEST CASE DETAILS]\n"
        "1/3 tests passed\n"
        "Test 1: nums=[-2,1,-3,4,-1,2,1,-5,4] → Expected 6, Got 6 ✓\n"
        "Test 2: nums=[-3,-1,-2] → Expected -1, Got 0\n"
        "Test 3: nums=[-1] → Expected -1, Got 0\n"
        "[USER MESSAGE]\n"
        "My solution passes the first test but fails the all-negative cases. What am I doing wrong?"
    )
    _MS_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 3: `max_sum = 0` — initialised to 0. If all numbers are negative, `max_sum` is never updated and the function returns 0, which is wrong.\n"
        "3. Line 6: `current_sum += num` — no reset when `current_sum` goes negative. Kadane's algorithm should restart the running sum at 0 when it drops below 0.\n"
        "4. Test 2: nums=[-3,-1,-2], expected -1, got 0 — confirms Bug 1 directly (max_sum starts at 0 and is never beaten by any negative subarray sum).\n"
        "5. Test 3: nums=[-1], expected -1, got 0 — also confirms Bug 1. Bug 2 affects mixed-sign inputs as well but is harder to isolate from test output alone.\n"
        "6. I'll explain Bug 1 first (clearest from test output), then Bug 2.\n"
        "7. I'll ask: what should max_sum start as so it can represent the best value even when all numbers are negative?\n"
        "</think>\n\n"
        "I found **2 issues** in your code.\n\n"
        "**Issue 1 — Line 3**\n"
        "```python\n"
        "max_sum = 0\n"
        "```\n"
        "Initialising `max_sum` to 0 means you'll never return a negative answer. "
        "For all-negative input like `[-3, -1, -2]`, no subarray sum ever exceeds 0, "
        "so `max_sum` stays at 0 and you return 0 instead of -1.\n\n"
        "What should `max_sum` start as so it can represent the best answer even when all numbers are negative?\n\n"
        "**Issue 2 — Line 6**\n"
        "```python\n"
        "current_sum += num\n"
        "```\n"
        "When `current_sum` drops below 0, adding more numbers only drags future subarrays down. "
        "Kadane's algorithm resets `current_sum` to 0 whenever it goes negative, "
        "because starting fresh from the next element is always better than carrying a negative running total.\n\n"
        "The fix: `current_sum = max(0, current_sum) + num`\n\n"
        "---\n"
        "Let's fix Issue 1 first — it's directly causing the failing tests. "
        "If `max_sum` shouldn't start at 0, what safe initial value works for any array?"
    )
    examples.append(build_example(
        "debug_v53_cat1_think_max_subarray_01", "maximum_subarray", "easy",
        [
            {"role": "user",      "content": _MS_USER},
            {"role": "assistant", "content": _MS_AI},
        ],
    ))

    # ── 3. Reverse Linked List — missing next_node save (2 bugs, 1 root cause) ──
    _RL2_USER = (
        "[MODE: DEBUG]\n"
        "[SOURCE CODE]\n"
        "```python\n"
        "class Solution(object):\n"
        "    def reverseList(self, head):\n"
        "        prev = None\n"
        "        curr = head\n"
        "        while curr:\n"
        "            curr.next = prev\n"
        "            prev = curr\n"
        "            curr = curr.next\n"
        "        return prev\n"
        "```\n"
        "[TEST CASE DETAILS]\n"
        "2/3 tests passed\n"
        "Test 1: head=[1,2,3,4,5] → Expected [5,4,3,2,1], Got [1]\n"
        "Test 2: head=[1,2] → Expected [2,1], Got [1]\n"
        "Test 3: head=[] → Expected [], Got [] ✓\n"
        "[USER MESSAGE]\n"
        "My code only returns the first node. What's going wrong?"
    )
    _RL2_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 6: `curr.next = prev` — immediately overwrites `curr.next` with `prev`. The link to the next original node is destroyed.\n"
        "3. Line 8: `curr = curr.next` — at this point `curr.next` is `prev` (set on line 6), not the original next node. Traversal is broken.\n"
        "4. Test output: expected [5,4,3,2,1], got [1] — confirms traversal terminates after one node.\n"
        "5. Trace for [1,2,3]: line 6 sets node1.next=None, line 8 sets curr=None, loop exits. prev=node1 → returns [1].\n"
        "6. Both bugs share one root cause: the next node must be saved BEFORE overwriting curr.next.\n"
        "7. I'll explain both bugs together since they're caused by one missing line, then ask what should be saved.\n"
        "</think>\n\n"
        "Your pointer-reversal approach is right — I found **2 issues**, both caused by the same missing step.\n\n"
        "**Issue 1 — Line 6**\n"
        "```python\n"
        "curr.next = prev\n"
        "```\n"
        "This overwrites `curr.next` with `prev` before you've saved what `curr.next` was originally pointing to. "
        "The link to the next node in the original list is destroyed.\n\n"
        "**Issue 2 — Line 8**\n"
        "```python\n"
        "curr = curr.next\n"
        "```\n"
        "By the time we reach this line, `curr.next` is already `prev` (set on line 6 — not the original next node). "
        "So `curr` moves backward into the already-reversed portion, and the loop exits immediately.\n\n"
        "Trace for `[1, 2, 3]`:\n"
        "- Line 6: `node1.next = None` (link to node2 is gone)\n"
        "- Line 8: `curr = node1.next = None`\n"
        "- Loop exits. `prev = node1` → returns `[1]`\n\n"
        "Both issues disappear if you save the original next node **before** overwriting `curr.next`.\n\n"
        "What one line should be inserted before line 6 to fix both issues?"
    )
    examples.append(build_example(
        "debug_v53_cat1_think_reverse_list_01", "reverse_linked_list", "easy",
        [
            {"role": "user",      "content": _RL2_USER},
            {"role": "assistant", "content": _RL2_AI},
        ],
    ))

    # ── 4. Binary Search — wrong mid formula + wrong left update ──────────────
    _BS_USER = (
        "[MODE: DEBUG]\n"
        "[SOURCE CODE]\n"
        "```python\n"
        "class Solution(object):\n"
        "    def search(self, nums, target):\n"
        "        left, right = 0, len(nums) - 1\n"
        "        while left <= right:\n"
        "            mid = left + right // 2\n"
        "            if nums[mid] == target:\n"
        "                return mid\n"
        "            elif nums[mid] < target:\n"
        "                left = mid\n"
        "            else:\n"
        "                right = mid - 1\n"
        "        return -1\n"
        "```\n"
        "[TEST CASE DETAILS]\n"
        "0/3 tests passed\n"
        "Test 1: nums=[1,3,5,7,9,11], target=3 → Expected 1, Got TLE (infinite loop)\n"
        "Test 2: nums=[1,3,5,7,9,11], target=11 → Expected 5, Got IndexError: list index out of range\n"
        "Test 3: nums=[1,3,5,7,9,11], target=-5 → Expected -1, Got -1 ✓\n"
        "[USER MESSAGE]\n"
        "My binary search loops forever on some inputs and crashes on others. What's the bug?"
    )
    _BS_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 5: `mid = left + right // 2` — operator precedence: `//` binds tighter than `+`. Computes `left + (right // 2)`, not `(left + right) // 2`.\n"
        "3. Line 9: `left = mid` — when `nums[mid] < target`, we know `mid` is not the answer. Setting `left = mid` (not `mid + 1`) traps `left` when `left == mid`.\n"
        "4. TLE trace for target=3 in [1,3,5,7,9,11]: left=0,right=5,mid=0+2=2,nums[2]=5>3,right=1. left=0,right=1,mid=0+0=0,nums[0]=1<3,left=mid=0. Left never advances. Infinite loop — Bug 2.\n"
        "5. IndexError trace for target=11: left=4,right=5,mid=4+(5//2)=4+2=6. Index 6 out of bounds for array of length 6 — Bug 1.\n"
        "6. Bug 2 (left=mid) causes TLE on Test 1. Bug 1 (wrong mid) causes IndexError on Test 2.\n"
        "7. I'll explain Bug 2 first (TLE is directly shown), then Bug 1.\n"
        "</think>\n\n"
        "I found **2 issues** in your code.\n\n"
        "**Issue 1 — Line 5**\n"
        "```python\n"
        "mid = left + right // 2\n"
        "```\n"
        "Python evaluates `//` before `+` (higher precedence), so this computes "
        "`left + (right // 2)` instead of `(left + right) // 2`. "
        "For `left=4, right=5`: correct mid is `4`, but your formula gives `4 + (5//2) = 4 + 2 = 6` — "
        "an index out of bounds for a 6-element array.\n\n"
        "The fix: add parentheses: `mid = (left + right) // 2`\n\n"
        "**Issue 2 — Line 9**\n"
        "```python\n"
        "left = mid\n"
        "```\n"
        "When `nums[mid] < target`, we know `mid` is NOT the answer — so `left` should jump PAST "
        "`mid` to `mid + 1`. Setting `left = mid` causes an infinite loop when `left == mid`.\n\n"
        "Trace for `target=3` in `[1,3,5,7,9,11]`:\n"
        "- `left=0, right=1, mid=0+(1//2)=0`. `nums[0]=1 < 3`. `left = mid = 0`.\n"
        "- Next iteration: identical state. Infinite loop.\n\n"
        "---\n"
        "Let's fix Issue 2 first — it's directly causing the TLE. "
        "When `nums[mid] < target`, what should `left` be set to?"
    )
    examples.append(build_example(
        "debug_v53_cat1_think_binary_search_01", "binary_search", "easy",
        [
            {"role": "user",      "content": _BS_USER},
            {"role": "assistant", "content": _BS_AI},
        ],
    ))

    # ── 5. Valid Parentheses — pop from empty stack + inverted return value ────
    _VP2_USER = (
        "[MODE: DEBUG]\n"
        "[SOURCE CODE]\n"
        "```python\n"
        "class Solution(object):\n"
        "    def isValid(self, s):\n"
        "        stack = []\n"
        "        mapping = {')': '(', '}': '{', ']': '['}\n"
        "        for char in s:\n"
        "            if char in mapping:\n"
        "                top = stack.pop()\n"
        "                if top != mapping[char]:\n"
        "                    return True\n"
        "            else:\n"
        "                stack.append(char)\n"
        "        return len(stack) == 0\n"
        "```\n"
        "[TEST CASE DETAILS]\n"
        "1/4 tests passed\n"
        "Test 1: s='()' → Expected True, Got True ✓\n"
        "Test 2: s=')(' → Expected False, Got IndexError: pop from empty list\n"
        "Test 3: s='(]' → Expected False, Got True\n"
        "Test 4: s='([)]' → Expected False, Got True\n"
        "[USER MESSAGE]\n"
        "It crashes on some inputs and gives wrong answers on others. What's wrong?"
    )
    _VP2_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 7: `top = stack.pop()` — called unconditionally. If `stack` is empty when a closing bracket appears, Python raises IndexError.\n"
        "3. Line 9: `return True` — fires when `top != mapping[char]`, i.e., brackets DO NOT match. Should return False (invalid string).\n"
        "4. Test 2: s=')(' → IndexError (confirms Bug 1: stack is empty when first ')' is processed).\n"
        "5. Test 3: s='(]' → Returns True instead of False (confirms Bug 2: '(' != '[', so line 9 fires with wrong value).\n"
        "6. Bug 1 causes crash on inputs starting with a closing bracket. Bug 2 inverts the mismatch return value.\n"
        "7. I'll explain Bug 1 first (crash), then Bug 2 (wrong return value).\n"
        "</think>\n\n"
        "Your mapping logic and stack structure are correct — I found **2 issues**.\n\n"
        "**Issue 1 — Line 7**\n"
        "```python\n"
        "top = stack.pop()\n"
        "```\n"
        "`stack.pop()` is called without checking if the stack is empty first. "
        "For input `')('`, the first character is `')'` — a closing bracket — "
        "and the stack is still empty, so Python raises `IndexError: pop from empty list`.\n\n"
        "What value could you assign to `top` when the stack is empty, "
        "so that the comparison on line 8 safely evaluates to a mismatch "
        "and the function returns `False`?\n\n"
        "**Issue 2 — Line 9**\n"
        "```python\n"
        "return True\n"
        "```\n"
        "This line fires when `top != mapping[char]` — meaning the brackets "
        "**don't** match. A mismatch means the string is NOT valid. "
        "The return value should be `False`, not `True`.\n\n"
        "---\n"
        "Let's fix Issue 1 first — it causes a crash on certain inputs. "
        "How would you safely handle `stack.pop()` when the stack might be empty?"
    )
    examples.append(build_example(
        "debug_v53_cat1_think_valid_parentheses_01", "valid_parentheses", "easy",
        [
            {"role": "user",      "content": _VP2_USER},
            {"role": "assistant", "content": _VP2_AI},
        ],
    ))

    return examples  # 5 examples


def generate_cat1():
    examples = []
    for idx, sc in enumerate(CAT1):
        for v, user_fn in enumerate(_U):
            eid = f"debug_v53_cat1_{sc['problem']}_{idx+1:02d}{chr(ord('a')+v)}"
            examples.append(build_example(
                eid, sc["problem"], sc["difficulty"],
                [
                    {"role": "user",      "content": user_fn(sc["code"], sc["error"])},
                    {"role": "assistant", "content": sc["response"]},
                ],
            ))
    examples += _cat1_think_examples()
    return examples  # 15 × 4 + 5 = 65


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY 2: HIDDEN-BUG SOURCE-CODE ANALYSIS  (10 scenarios × 3 variants = 30)
# BugA = crash (visible to test runner). BugB = logic bug in unreachable code.
# ─────────────────────────────────────────────────────────────────────────────

_U2 = [
    lambda code, err: f"Here's my code — it crashes before I can see if the logic is right:\n```python\n{code}\n```\nError: {err}",
    lambda code, err: f"I can't get past this error. What am I missing?\n```python\n{code}\n```\nTest output: {err}",
    lambda code, err: f"My submission throws an exception:\n```python\n{code}\n```\n{err}",
]

CAT2 = [
    # ── C2-1. Two Sum: NameError hides wrong dict key ────────────────────────
    {
        "problem": "two_sum", "difficulty": "easy",
        "code": (
            "def twoSum(self, nums, target):\n"
            "    seen = {}\n"
            "    for i, num in enumerate(num):\n"
            "        complement = target - num\n"
            "        if complement in seen:\n"
            "            return [seen[complement], i]\n"
            "        seen[nums] = i\n"
            "    return []"
        ),
        "error": "NameError: name 'num' is not defined (line 3)",
        "response": (
            "I found **2 issues** in your code. The test runner only saw the first one.\n\n"
            "**Issue 1 — Line 3**\n"
            "```python\n"
            "for i, num in enumerate(num):\n"
            "```\n"
            "`num` inside `enumerate(...)` doesn't exist yet — it's the loop variable *being created* "
            "by this line. You want to iterate over `nums`. Python raises `NameError` before "
            "the loop body runs.\n\n"
            "What is the list parameter in the function signature?\n\n"
            "**Issue 2 — Line 7**\n"
            "```python\n"
            "seen[nums] = i\n"
            "```\n"
            "The tests never reached this line because line 3 crashed first. "
            "But once you fix Issue 1, you'll see: you're using `nums` (the entire list) as a dict key "
            "instead of `num` (the current element). The map should store `seen[num] = i`.\n\n"
            "---\n"
            "Let's fix Issue 1 first since the code won't run at all without it. "
            "What should `enumerate(num)` be?"
        ),
    },
    # ── C2-2. Binary Search: IndexError hides infinite loop ──────────────────
    {
        "problem": "binary_search", "difficulty": "easy",
        "code": (
            "def search(self, nums, target):\n"
            "    left, right = 0, len(nums)\n"
            "    while left <= right:\n"
            "        mid = (left + right) // 2\n"
            "        if nums[mid] == target:\n"
            "            return mid\n"
            "        elif nums[mid] < target:\n"
            "            left = mid\n"
            "        else:\n"
            "            right = mid - 1\n"
            "    return -1"
        ),
        "error": "IndexError: list index out of range (line 5)",
        "response": (
            "I found **2 issues** in your code. The crash is hiding a second problem.\n\n"
            "**Issue 1 — Line 2**\n"
            "```python\n"
            "left, right = 0, len(nums)\n"
            "```\n"
            "`right` starts at `len(nums)` — one past the last valid index. "
            "`nums[mid]` raises `IndexError` when `mid` reaches that value. "
            "Set `right = len(nums) - 1`.\n\n"
            "**Issue 2 — Line 8**\n"
            "```python\n"
            "left = mid\n"
            "```\n"
            "The tests never reached this line, but once you fix Issue 1 "
            "you'll hit an infinite loop here. "
            "When `nums[mid] < target`, the target is to the *right* of `mid`. "
            "Setting `left = mid` keeps the window the same size forever. "
            "It must be `left = mid + 1` to actually narrow the search.\n\n"
            "Both bugs need fixing before the code is correct. "
            "Let's start with Issue 1: what should `right` be initialised to?"
        ),
    },
    # ── C2-3. Valid Parentheses: AttributeError hides inverted return ─────────
    {
        "problem": "valid_parentheses", "difficulty": "easy",
        "code": (
            "def isValid(self, s):\n"
            "    stack = []\n"
            "    for char in s:\n"
            "        if char in '([{':\n"
            "            stack.push(char)\n"
            "        else:\n"
            "            if not stack:\n"
            "                return False\n"
            "            top = stack.pop()\n"
            "            if (top == '(' and char != ')') or \\\n"
            "               (top == '[' and char != ']') or \\\n"
            "               (top == '{' and char != '}'):\n"
            "                return False\n"
            "    return len(stack) != 0"
        ),
        "error": "AttributeError: 'list' object has no attribute 'push'",
        "response": (
            "I found **2 issues** — the second is invisible until you fix the first.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "stack.push(char)\n"
            "```\n"
            "Python lists have no `.push()` method. Use `.append()` instead. "
            "This crashes the moment any opening bracket is seen.\n\n"
            "**Issue 2 — Line 14**\n"
            "```python\n"
            "return len(stack) != 0\n"
            "```\n"
            "Once Issue 1 is fixed, the matching logic is correct — "
            "but the final check is inverted. "
            "An empty stack means all brackets matched → valid → return `True`. "
            "But `!= 0` returns `True` when the stack is *not* empty. "
            "Change to `== 0` (or `return not stack`).\n\n"
            "Let's start with Issue 1. What's the correct Python list append method?"
        ),
    },
    # ── C2-4. Max Subarray: NameError hides wrong return value ───────────────
    {
        "problem": "max_subarray", "difficulty": "medium",
        "code": (
            "def maxSubArray(self, nums):\n"
            "    max_sum = nums[0]\n"
            "    current_sum = num[0]\n"
            "    for i in range(1, len(nums)):\n"
            "        current_sum = max(nums[i], current_sum + nums[i])\n"
            "        max_sum = max(max_sum, current_sum)\n"
            "    return max_sum - 1"
        ),
        "error": "NameError: name 'num' is not defined (line 3)",
        "response": (
            "I found **2 issues** in your code. The crash is masking a second bug.\n\n"
            "**Issue 1 — Line 3**\n"
            "```python\n"
            "current_sum = num[0]\n"
            "```\n"
            "`num` is undefined — you probably meant `nums` (the parameter). "
            "This immediately raises `NameError` before the loop runs.\n\n"
            "**Issue 2 — Line 7**\n"
            "```python\n"
            "return max_sum - 1\n"
            "```\n"
            "The tests couldn't reach this line because of the crash, "
            "but once you fix Issue 1 it will return an answer one less than correct every time. "
            "There's no reason to subtract 1 — the maximum subarray sum is just `max_sum`.\n\n"
            "Let's fix Issue 1 first. What should `num[0]` be?"
        ),
    },
    # ── C2-5. Climbing Stairs: IndexError hides incomplete recurrence ─────────
    {
        "problem": "climbing_stairs", "difficulty": "easy",
        "code": (
            "def climbStairs(self, n):\n"
            "    if n <= 1:\n"
            "        return n\n"
            "    dp = [0] * n\n"
            "    dp[1] = 1\n"
            "    dp[2] = 2\n"
            "    for i in range(3, n + 1):\n"
            "        dp[i] = dp[i-1] + dp[i-2]\n"
            "    return dp[n]"
        ),
        "error": "IndexError: list index out of range (line 6 or 9)",
        "response": (
            "I found **2 issues** in your code.\n\n"
            "**Issue 1 — Line 4**\n"
            "```python\n"
            "dp = [0] * n\n"
            "```\n"
            "This creates an array of length `n` with indices 0 to `n-1`. "
            "But line 6 writes `dp[2]` (fails when `n = 1`) and line 9 reads `dp[n]` — "
            "both are out of bounds. You need `[0] * (n + 1)` to include index `n`.\n\n"
            "What should `[0] * n` be changed to so that indices up to `n` are valid?\n\n"
            "**Issue 2 — Lines 5–6 (edge case)**\n"
            "```python\n"
            "dp[1] = 1\n"
            "dp[2] = 2\n"
            "```\n"
            "For `n = 1` the early return on line 2 fires first, so `dp[2]` is never reached. "
            "But for `n = 2` after fixing Issue 1, these base cases are correct. "
            "The recurrence on line 8 is right too. So Issue 1 is the only real fix needed.\n\n"
            "Fix Issue 1 first. What's the correct array size?"
        ),
    },
    # ── C2-6. Contains Duplicate: AttributeError hides inverted returns ───────
    {
        "problem": "contains_duplicate", "difficulty": "easy",
        "code": (
            "def containsDuplicate(self, nums):\n"
            "    seen = {}\n"
            "    for num in nums:\n"
            "        if num in seen:\n"
            "            return False\n"
            "        seen.add(num)\n"
            "    return True"
        ),
        "error": "AttributeError: 'dict' object has no attribute 'add'",
        "response": (
            "I found **2 issues** in your code. The crash hides a logic bug.\n\n"
            "**Issue 1 — Lines 2 & 6**\n"
            "```python\n"
            "seen = {}      # Line 2\n"
            "seen.add(num)  # Line 6\n"
            "```\n"
            "`seen` is a `dict` (`{}`), but `.add()` is a `set` method. "
            "Change `seen = {}` to `seen = set()` so `.add()` works correctly.\n\n"
            "**Issue 2 — Lines 5 & 7**\n"
            "```python\n"
            "return False   # fires when duplicate found\n"
            "return True    # fires when no duplicate found\n"
            "```\n"
            "Both return values are swapped. "
            "When `num in seen` (duplicate found) → return `True`. "
            "When the loop ends without finding a duplicate → return `False`.\n\n"
            "Let's fix Issue 1 first. Should `seen` be a `set` or a `dict`?"
        ),
    },
    # ── C2-7. Palindrome: IndexError hides wrong return on mismatch ───────────
    {
        "problem": "palindrome_number", "difficulty": "easy",
        "code": (
            "def isPalindrome(self, x):\n"
            "    if x < 0:\n"
            "        return False\n"
            "    s = str(x)\n"
            "    left, right = 0, len(s)\n"
            "    while left < right:\n"
            "        if s[left] != s[right]:\n"
            "            return True\n"
            "        left += 1\n"
            "        right -= 1\n"
            "    return True"
        ),
        "error": "IndexError: string index out of range (line 7)",
        "response": (
            "I found **2 issues** in your code.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "left, right = 0, len(s)\n"
            "```\n"
            "`right = len(s)` is one past the last valid index. "
            "`s[right]` on line 7 immediately raises `IndexError`. "
            "Set `right = len(s) - 1`.\n\n"
            "**Issue 2 — Line 8**\n"
            "```python\n"
            "return True\n"
            "```\n"
            "Once Issue 1 is fixed, this fires when `s[left] != s[right]` — "
            "meaning the characters *don't* match, so the number is NOT a palindrome. "
            "But you return `True`. It should be `return False`.\n\n"
            "Let's fix Issue 1. What should `right` be set to?"
        ),
    },
    # ── C2-8. Reverse Linked List: typo hides pointer order problem ───────────
    {
        "problem": "reverse_linked_list", "difficulty": "easy",
        "code": (
            "def reverseList(self, head):\n"
            "    prev = None\n"
            "    curr = head\n"
            "    while curr:\n"
            "        nxt = curr.nxt\n"
            "        curr.next = prev\n"
            "        prev = curr\n"
            "        curr = nxt\n"
            "    return prev"
        ),
        "error": "AttributeError: 'ListNode' object has no attribute 'nxt'",
        "response": (
            "I found **1 issue** in your code — a typo that prevents it from running.\n\n"
            "**Issue 1 — Line 5**\n"
            "```python\n"
            "nxt = curr.nxt\n"
            "```\n"
            "`ListNode` stores the next pointer as `.next`, not `.nxt`. "
            "This typo raises `AttributeError` immediately. Change `curr.nxt` to `curr.next`.\n\n"
            "Once you fix the typo, check the pointer order on lines 5–8: "
            "you save `nxt` first (line 5), reverse the pointer (line 6), advance `prev` (line 7), "
            "and advance `curr` via the saved `nxt` (line 8). "
            "That's the correct order — well structured!\n\n"
            "What is the correct attribute name for the next node in a `ListNode`?"
        ),
    },
    # ── C2-9. Coin Change: overwrite hides wrong impossible sentinel ──────────
    {
        "problem": "coin_change", "difficulty": "medium",
        "code": (
            "def coinChange(self, coins, amount):\n"
            "    dp = [float('inf')] * (amount + 1)\n"
            "    dp[0] = 0\n"
            "    for i in range(1, amount + 1):\n"
            "        for coin in coins:\n"
            "            if coin <= i:\n"
            "                dp[i] = dp[i - coin] + 1\n"
            "    return dp[amount] if dp[amount] != float('inf') else 1"
        ),
        "error": "Wrong answer: expected 3, got 1 (coins=[1,5,10], amount=11)",
        "response": (
            "I found **2 issues** in your code. Neither crashes, but both corrupt the result.\n\n"
            "**Issue 1 — Line 7**\n"
            "```python\n"
            "dp[i] = dp[i - coin] + 1\n"
            "```\n"
            "This overwrites `dp[i]` with whatever the current coin gives, "
            "discarding better answers from previous coins. "
            "You need `dp[i] = min(dp[i], dp[i - coin] + 1)` to keep the minimum coin count.\n\n"
            "If a previous coin found `dp[11] = 2`, and the current coin calculates 4, "
            "which value should `dp[11]` store?\n\n"
            "**Issue 2 — Line 8**\n"
            "```python\n"
            "return dp[amount] if dp[amount] != float('inf') else 1\n"
            "```\n"
            "The problem requires returning `-1` when the amount is unreachable, not `1`. "
            "Change `else 1` to `else -1`.\n\n"
            "---\n"
            "Let's fix Issue 1 first. How do you update `dp[i]` to always take the minimum?"
        ),
    },
    # ── C2-10. Merge Intervals: TypeError hides wrong overlap condition ────────
    {
        "problem": "merge_intervals", "difficulty": "medium",
        "code": (
            "def merge(self, intervals):\n"
            "    intervals.sort()\n"
            "    merged = [intervals[0]]\n"
            "    for start, end in intervals[1:]:\n"
            "        if start <= merged[-1][1]:\n"
            "            merged[-1][1] = max(end, merged[-1][1])\n"
            "        else:\n"
            "            merged.append([start, end])\n"
            "    return merged"
        ),
        "error": "TypeError: 'list' object does not support item assignment (line 6)",
        "response": (
            "I found **1 issue** that causes the crash, plus a defensive improvement.\n\n"
            "**Issue 1 — Line 3**\n"
            "```python\n"
            "merged = [intervals[0]]\n"
            "```\n"
            "`intervals[0]` is a reference to the original input element. "
            "When the input comes as tuples (immutable), `merged[-1][1] = ...` on line 6 "
            "raises `TypeError`. Even with lists, you're mutating the original input. "
            "The safe fix is to copy the first interval: `merged = [list(intervals[0])]`.\n\n"
            "With that fix, `merged[-1]` is always a mutable list and line 6 works correctly. "
            "The overlap check `start <= merged[-1][1]` and the `max(end, ...)` merge logic "
            "are both correct — nice work on those!\n\n"
            "What does `list(intervals[0])` do that `intervals[0]` alone doesn't?"
        ),
    },
]


def generate_cat2():
    examples = []
    for idx, sc in enumerate(CAT2):
        for v, user_fn in enumerate(_U2):
            eid = f"debug_v53_cat2_{sc['problem']}_{idx+1:02d}{chr(ord('a')+v)}"
            examples.append(build_example(
                eid, sc["problem"], sc["difficulty"],
                [
                    {"role": "user",      "content": user_fn(sc["code"], sc["error"])},
                    {"role": "assistant", "content": sc["response"]},
                ],
            ))
    return examples  # 10 × 3 = 30


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY 3: MULTI-TURN CONVERSATIONAL DEBUGGING  (10 groups × 4 paths = 40)
# Each example shows progressive simplification across 2-4 turns.
# ─────────────────────────────────────────────────────────────────────────────

_BS_CODE = (
    "def search(self, nums, target):\n"
    "    left, right = 0, len(nums)\n"
    "    while left <= right:\n"
    "        mid = (left + right) // 2\n"
    "        if nums[mid] == target:\n"
    "            return mid\n"
    "        elif nums[mid] < target:\n"
    "            left = mid + 1\n"
    "        else:\n"
    "            right = mid - 1\n"
    "    return -1"
)
_BS_T1_Q = (
    "I found **1 issue** in your code.\n\n"
    "**Issue 1 — Line 2**\n"
    "```python\n"
    "left, right = 0, len(nums)\n"
    "```\n"
    "`right = len(nums)` is one past the last valid index. "
    "When `mid` reaches that value, `nums[mid]` crashes with `IndexError`. "
    "The last valid index is always one less than the length.\n\n"
    "If a list has 5 elements, what is the index of the last one?"
)

CAT3 = [
    # ─── Group 1: Binary Search — 4 paths ────────────────────────────────────
    mt("debug_v53_cat3_binary_search_01a", "binary_search", "easy",
       (f"My binary search crashes:\n```python\n{_BS_CODE}\n```\nIndexError on line 5.", _BS_T1_Q),
       ("idk",
        "No worries! Let's make it concrete. "
        "If your list is `[10, 20, 30, 40, 50]`, the indices are 0, 1, 2, 3, 4. "
        "There are 5 elements, so the last index is `5 - 1 = 4`, which is `len(nums) - 1`. "
        "What should `right` be set to?"),
       ("oh so len(nums) - 1?",
        "Exactly right! `right = len(nums) - 1` keeps the pointer inside the valid range. "
        "The fixed line is:\n```python\nleft, right = 0, len(nums) - 1\n```\n"
        "Your search logic looks correct otherwise — give it a try!"),
    ),
    mt("debug_v53_cat3_binary_search_01b", "binary_search", "easy",
       (f"Getting IndexError on binary search:\n```python\n{_BS_CODE}\n```", _BS_T1_Q),
       ("is it n - 1?",
        "Yes! `n - 1` is the last valid index. So `right = len(nums) - 1`:\n"
        "```python\nleft, right = 0, len(nums) - 1\n```\n"
        "That's the only change needed — binary search logic is otherwise correct. Go!"),
    ),
    mt("debug_v53_cat3_binary_search_01c", "binary_search", "easy",
       (f"Binary search IndexError:\n```python\n{_BS_CODE}\n```", _BS_T1_Q),
       ("why does mid ever reach len(nums)?",
        "Great question! Think about when `left` and `right` converge near the boundary. "
        "If `left = len(nums) - 1` and `right = len(nums)`, then "
        "`mid = (len(nums) - 1 + len(nums)) // 2`. For a 5-element list: `(4 + 5) // 2 = 4` — OK. "
        "But if both converge at `len(nums)`, `mid = len(nums)` — out of bounds!\n\n"
        "Setting `right = len(nums) - 1` prevents `right` from ever being invalid. "
        "Does that click?"),
       ("yes, so right = len(nums) - 1?",
        "Exactly! `left, right = 0, len(nums) - 1` — just subtract 1. "
        "Your whole search logic is correct. That one character is all that's needed!"),
    ),
    mt("debug_v53_cat3_binary_search_01d", "binary_search", "easy",
       (f"What's wrong?\n```python\n{_BS_CODE}\n```\nIndexError.", _BS_T1_Q),
       ("len(nums) - 1?",
        "Spot on! `right = len(nums) - 1` stays within the array. "
        "That's the only bug — your mid calculation and pointer updates are correct. "
        "Make that change and it should pass!"),
    ),
]

# We can't assign inside a list literal — build groups explicitly
def _cat3_group2():
    _CD_CODE = (
        "def containsDuplicate(self, nums):\n"
        "    seen = set()\n"
        "    for num in nums:\n"
        "        if num in seen:\n"
        "            return False\n"
        "        seen.add(num)\n"
        "    return True"
    )
    _CD_T1_Q = (
        "I found **2 issues** in your code — both return values are swapped.\n\n"
        "**Issue 1 — Line 5**\n"
        "```python\n"
        "return False\n"
        "```\n"
        "This fires when `num in seen` — meaning we *found* a duplicate. "
        "But the function should return `True` when a duplicate exists. "
        "You're returning the opposite.\n\n"
        "When `num` is already in `seen`, does the array have duplicates?"
    )
    return [
        mt("debug_v53_cat3_contains_duplicate_01a", "contains_duplicate", "easy",
           (f"Wrong answer on contains duplicate:\n```python\n{_CD_CODE}\n```\nExpected True for [1,2,3,1], got False.", _CD_T1_Q),
           ("idk, i'm confused",
            "Let's slow down — don't worry, this is a tricky logic flip! "
            "Think about what `num in seen` means: this number appeared *before* in the list. "
            "You've found a duplicate! If the question is 'does the list have duplicates?' "
            "and you just found one, the answer is **yes** → `True`. "
            "So when you find a duplicate, return `True`, not `False`. Does that click?"),
           ("oh yeah that makes sense",
            "Great! And once you swap line 5 to `return True`, look at line 7 (`return True` at the end). "
            "If the loop finishes without finding a duplicate, there are *no* duplicates → return `False`. "
            "Make both swaps and you're done!"),
        ),
        mt("debug_v53_cat3_contains_duplicate_01b", "contains_duplicate", "easy",
           (f"Wrong answer on contains duplicate:\n```python\n{_CD_CODE}\n```", _CD_T1_Q),
           ("return False?",
            "Almost — but that's line 7 I was asking about after line 5. "
            "When the loop finishes *without* finding a duplicate, there are no duplicates → return `False`. "
            "So line 7 should indeed be `return False` (swapped from `True`). "
            "And line 5 should be `return True` (swapped from `False`). "
            "Both return values are the opposite of what they should be!"),
        ),
        mt("debug_v53_cat3_contains_duplicate_01c", "contains_duplicate", "easy",
           (f"Contains duplicate wrong answer:\n```python\n{_CD_CODE}\n```\nExpected True, got False.", _CD_T1_Q),
           ("why would we add it to seen before checking?",
            "Good observation — but look at the order: "
            "you check `if num in seen` (line 4) *before* `seen.add(num)` (line 6). "
            "So when checking, `num` was only added by a *previous* loop iteration — "
            "meaning it appeared earlier in the list. That's a duplicate!\n\n"
            "So line 5 fires exactly when you've found a number that appeared before. "
            "What should you return when you find a duplicate?"),
           ("True!",
            "Exactly! And if the loop finishes without `num in seen` ever being true, "
            "there are no duplicates → `return False` at the end. Make those two swaps and you're done!"),
        ),
        mt("debug_v53_cat3_contains_duplicate_01d", "contains_duplicate", "easy",
           (f"Bug in my contains duplicate:\n```python\n{_CD_CODE}\n```", _CD_T1_Q),
           ("there is a duplicate so return True",
            "Exactly! Swap both values:\n"
            "- Line 5: `return True` (found duplicate → yes)\n"
            "- Line 7: `return False` (no duplicate found → no)\n\n"
            "Your set-based algorithm is spot on. Just the return values needed inverting!"),
        ),
    ]


def _cat3_group3():
    """Climbing Stairs — 4 paths"""
    _CS_CODE = (
        "def climbStairs(self, n):\n"
        "    if n <= 1:\n"
        "        return n\n"
        "    dp = [0] * (n + 1)\n"
        "    dp[1] = 1\n"
        "    dp[2] = 2\n"
        "    for i in range(3, n + 1):\n"
        "        dp[i] = dp[i-1]\n"
        "    return dp[n]"
    )
    _CS_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 8**\n"
        "```python\n"
        "dp[i] = dp[i-1]\n"
        "```\n"
        "This only counts ways to arrive via a 1-step — it forgets the 2-step option. "
        "The recurrence for climbing stairs adds *both* options together.\n\n"
        "To reach step `i` you can come from `i-1` (1-step) OR from `i-2` (2-step). "
        "What would you add to `dp[i-1]` to count both paths?"
    )
    return [
        mt("debug_v53_cat3_climbing_stairs_01a", "climbing_stairs", "easy",
           (f"Wrong answer on climbing stairs:\n```python\n{_CS_CODE}\n```\nExpected 3 for n=3, got 2.", _CS_T1_Q),
           ("idk",
            "That's okay! Let's trace it. To reach step 3:\n"
            "- From step 2 → step 3 (1-step): `dp[2] = 2` ways\n"
            "- From step 1 → step 3 (2-step): `dp[1] = 1` way\n\n"
            "Total = 2 + 1 = 3. So `dp[3] = dp[2] + dp[1]`. "
            "In general: `dp[i] = dp[i-1] + ___`. What goes in the blank?"),
           ("dp[i-2]?",
            "Exactly right! `dp[i] = dp[i-1] + dp[i-2]` — "
            "ways from one step below plus ways from two steps below. "
            "Make that change on line 8 and your solution is correct!"),
        ),
        mt("debug_v53_cat3_climbing_stairs_01b", "climbing_stairs", "easy",
           (f"Climbing stairs wrong answer:\n```python\n{_CS_CODE}\n```", _CS_T1_Q),
           ("dp[i-2]?",
            "Yes! The full recurrence is `dp[i] = dp[i-1] + dp[i-2]`. "
            "At each step, you can arrive from one step back OR two steps back — sum both. "
            "That one addition fixes the algorithm. Nice work!"),
        ),
        mt("debug_v53_cat3_climbing_stairs_01c", "climbing_stairs", "easy",
           (f"Climbing stairs:\n```python\n{_CS_CODE}\n```\nGetting wrong answer.", _CS_T1_Q),
           ("why is dp[2] = 2?",
            "Great question! To reach step 2 you have exactly 2 ways: "
            "take two 1-steps (1,1) or one 2-step (2). So `dp[2] = 2`.\n\n"
            "For `dp[3]`: from step 2 (1-step, `dp[2]=2` ways) OR from step 1 (2-step, `dp[1]=1` way). "
            "Total = 3. The recurrence is `dp[i] = dp[i-1] + dp[i-2]`. "
            "What's missing from your line 8?"),
           ("+ dp[i-2]",
            "Exactly! `dp[i] = dp[i-1] + dp[i-2]`. "
            "This is the Fibonacci pattern — each step's count is the sum of the previous two. "
            "Your code is correct everywhere else!"),
        ),
        mt("debug_v53_cat3_climbing_stairs_01d", "climbing_stairs", "easy",
           (f"Climbing stairs bug:\n```python\n{_CS_CODE}\n```", _CS_T1_Q),
           ("dp[i-2]",
            "Perfect! `dp[i] = dp[i-1] + dp[i-2]` — complete recurrence. "
            "Base cases and array setup are correct. Just add `+ dp[i-2]` and you're done!"),
        ),
    ]


def _cat3_group4():
    """Valid Parentheses — 4 paths (inverted final return)"""
    _VP_CODE = (
        "def isValid(self, s):\n"
        "    stack = []\n"
        "    for char in s:\n"
        "        if char in '([{':\n"
        "            stack.append(char)\n"
        "        else:\n"
        "            if not stack:\n"
        "                return False\n"
        "            top = stack.pop()\n"
        "            if (top == '(' and char != ')') or \\\n"
        "               (top == '[' and char != ']') or \\\n"
        "               (top == '{' and char != '}'):\n"
        "                return False\n"
        "    return len(stack) != 0"
    )
    _VP_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 14**\n"
        "```python\n"
        "return len(stack) != 0\n"
        "```\n"
        "After scanning all of `s`, an *empty* stack means every bracket was matched. "
        "Your logic returns `True` when the stack is **not** empty — but non-empty means "
        "unmatched brackets (invalid!). The comparison should be `== 0`, not `!= 0`.\n\n"
        "When the stack is empty after processing all characters, is the string valid or invalid?"
    )
    return [
        mt("debug_v53_cat3_valid_parentheses_01a", "valid_parentheses", "easy",
           (f"Wrong answer on isValid:\n```python\n{_VP_CODE}\n```\nExpected True for '()[]{{}}', got False.", _VP_T1_Q),
           ("idk",
            "Let's trace `'()'`:\n"
            "1. `(` → push. Stack: `['(']`\n"
            "2. `)` → pop `(`, match ✓. Stack: `[]`\n"
            "3. End of string — stack is empty.\n\n"
            "Empty stack = all brackets matched = **valid** = should return `True`. "
            "But `len(stack) != 0` is `False` when empty. "
            "Does that show why we need `== 0`?"),
           ("oh i see, len(stack) == 0",
            "Exactly! Or equivalently `return not stack`. "
            "Either way you return `True` when empty (all matched) and `False` when not (unmatched brackets). "
            "Great reasoning — just that one operator change and your solution is complete!"),
        ),
        mt("debug_v53_cat3_valid_parentheses_01b", "valid_parentheses", "easy",
           (f"Valid parentheses wrong answer:\n```python\n{_VP_CODE}\n```", _VP_T1_Q),
           ("== 0?",
            "Yes! `len(stack) == 0` returns `True` when the stack is empty (all matched → valid) "
            "and `False` when brackets remain unmatched. "
            "Or `return not stack` is more Pythonic. Either works — one small fix!"),
        ),
        mt("debug_v53_cat3_valid_parentheses_01c", "valid_parentheses", "easy",
           (f"isValid bug:\n```python\n{_VP_CODE}\n```", _VP_T1_Q),
           ("it means all brackets were matched right?",
            "Exactly right! Empty stack = all opened brackets properly closed = valid = `True`. "
            "But `len(stack) != 0` evaluates to `False` when empty. "
            "You need `len(stack) == 0` (or `return not stack`). "
            "Your understanding of the invariant is perfect — just flip the operator!"),
        ),
        mt("debug_v53_cat3_valid_parentheses_01d", "valid_parentheses", "easy",
           (f"isValid returns wrong answer:\n```python\n{_VP_CODE}\n```", _VP_T1_Q),
           ("==",
            "Correct! `return len(stack) == 0` — empty stack → all matched → valid → `True`. "
            "That single character change is the entire fix. Nice work!"),
        ),
    ]


def _cat3_group5():
    """Coin Change — 4 paths (missing min())"""
    _CC_CODE = (
        "def coinChange(self, coins, amount):\n"
        "    dp = [float('inf')] * (amount + 1)\n"
        "    dp[0] = 0\n"
        "    for coin in coins:\n"
        "        for i in range(coin, amount + 1):\n"
        "            dp[i] = dp[i - coin] + 1\n"
        "    return dp[amount] if dp[amount] != float('inf') else -1"
    )
    _CC_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 6**\n"
        "```python\n"
        "dp[i] = dp[i - coin] + 1\n"
        "```\n"
        "This unconditionally *overwrites* `dp[i]` with the current coin's cost, "
        "losing any better answer found by a previous coin. "
        "You need to wrap this in `min(dp[i], ...)` to only update when the new path is cheaper.\n\n"
        "If a previous coin already found `dp[11] = 2`, and a new coin calculates `dp[i-coin]+1 = 5`, "
        "what should `dp[11]` become?"
    )
    return [
        mt("debug_v53_cat3_coin_change_01a", "coin_change", "medium",
           (f"Coin change wrong answer:\n```python\n{_CC_CODE}\n```\nExpected 3, got 1 for amount=11.", _CC_T1_Q),
           ("idk",
            "Let's think about it with a simple example. "
            "Suppose we've already found that `dp[6] = 2` (two 3-coins). "
            "Now we're checking a 5-coin: `dp[6 - 5 + 1] = dp[1] + 1 = 2`. "
            "Both give `dp[6] = 2`. Now suppose `dp[6] = 2` is stored, "
            "and a worse coin gives `dp[i-coin]+1 = 4`. "
            "Should we overwrite 2 with 4, or keep 2?\n\n"
            "We keep the minimum — `min(2, 4) = 2`. "
            "How do you express that with `min()` on line 6?"),
           ("min(dp[i], dp[i-coin]+1)?",
            "Exactly! `dp[i] = min(dp[i], dp[i - coin] + 1)`. "
            "This keeps the smallest coin count found so far for each amount. "
            "Your return logic is already correct. Just add `min()` and you're done!"),
        ),
        mt("debug_v53_cat3_coin_change_01b", "coin_change", "medium",
           (f"Coin change:\n```python\n{_CC_CODE}\n```\nWrong answer.", _CC_T1_Q),
           ("min(dp[i], dp[i-coin]+1)?",
            "Yes! `dp[i] = min(dp[i], dp[i - coin] + 1)`. "
            "Always keep the smaller coin count. "
            "Your return value and loop structure are correct — just that one change!"),
        ),
        mt("debug_v53_cat3_coin_change_01c", "coin_change", "medium",
           (f"Coin change wrong answer:\n```python\n{_CC_CODE}\n```", _CC_T1_Q),
           ("why does overwriting matter?",
            "Great question! In dynamic programming, you process each coin in turn. "
            "When you process coin=1, you might set `dp[6] = 6` (six 1-coins). "
            "Then when you process coin=3, you want `dp[6] = 2` (two 3-coins). "
            "If you just *overwrite*, you replace 6 with 2 — OK so far. "
            "But what if a later coin gives 4? Without `min()`, you'd overwrite 2 with 4, "
            "losing the better answer. `min()` ensures you always keep the best.\n\n"
            "How would you write line 6 using `min()`?"),
           ("dp[i] = min(dp[i], dp[i-coin]+1)",
            "Exactly right! That keeps the minimum across all coins. "
            "Your structure and return logic are correct — just add `min()` to line 6!"),
        ),
        mt("debug_v53_cat3_coin_change_01d", "coin_change", "medium",
           (f"Coin change:\n```python\n{_CC_CODE}\n```", _CC_T1_Q),
           ("2 — keep the smaller one",
            "Exactly! Keep `dp[11] = 2`, not 5. In code: `dp[i] = min(dp[i], dp[i - coin] + 1)`. "
            "That one wrapping in `min()` is the entire fix. Your return value is already correct!"),
        ),
    ]


def _cat3_group6():
    """Max Subarray — 4 paths (wrong initialization to 0)"""
    _MS_CODE = (
        "def maxSubArray(self, nums):\n"
        "    max_sum = 0\n"
        "    current_sum = 0\n"
        "    for num in nums:\n"
        "        current_sum = max(num, current_sum + num)\n"
        "        max_sum = max(max_sum, current_sum)\n"
        "    return max_sum"
    )
    _MS_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 2**\n"
        "```python\n"
        "max_sum = 0\n"
        "```\n"
        "Starting `max_sum` at `0` fails for all-negative arrays. "
        "If every number is negative, the correct answer is the least-negative element — never `0`. "
        "The right starting value is `nums[0]`, and the loop should begin from index 1.\n\n"
        "If the input is `[-5, -1, -3]`, what is the correct answer — and why doesn't `0` capture it?"
    )
    return [
        mt("debug_v53_cat3_max_subarray_01a", "max_subarray", "medium",
           (f"Max subarray fails on all-negative input:\n```python\n{_MS_CODE}\n```\nExpected -1, got 0.", _MS_T1_Q),
           ("idk",
            "Let's think about it. The subarray must be non-empty — "
            "you have to pick at least one element. For `[-5, -1, -3]`, "
            "your only choices are -5, -1, -3, or combinations. The best is -1.\n\n"
            "But `max_sum = 0` means the 'default' answer is 0, which represents an empty subarray. "
            "Since the problem requires non-empty, 0 is wrong. "
            "What's a better starting value — one that actually comes from the array?"),
           ("nums[0]?",
            "Exactly! Start with `max_sum = nums[0]` (the first element) and loop from index 1. "
            "This seeds the answer with a real value from the array. "
            "Your Kadane's logic on line 5 is correct — just fix the initialization!"),
        ),
        mt("debug_v53_cat3_max_subarray_01b", "max_subarray", "medium",
           (f"Max subarray wrong answer:\n```python\n{_MS_CODE}\n```", _MS_T1_Q),
           ("nums[0]?",
            "Yes! `max_sum = nums[0]`, and then loop `for num in nums[1:]`. "
            "Starting with the first real element ensures all-negative arrays work. "
            "Your Kadane's logic is correct — just fix line 2!"),
        ),
        mt("debug_v53_cat3_max_subarray_01c", "max_subarray", "medium",
           (f"Max subarray fails:\n```python\n{_MS_CODE}\n```", _MS_T1_Q),
           ("why can't we use 0 as a sentinel?",
            "Good question! `0` would work if an empty subarray were valid — "
            "but the problem says the subarray must be non-empty. "
            "For all-negative input, the best answer is always negative, "
            "so `0` is always larger and gets returned incorrectly.\n\n"
            "The fix: use `nums[0]` as the starting `max_sum` (a real array element) "
            "and iterate from index 1. What should line 2 become?"),
           ("max_sum = nums[0]",
            "Exactly! And change the loop to `for num in nums[1:]` so you don't count nums[0] twice. "
            "Your Kadane's update on line 5 is correct. That's the only change needed!"),
        ),
        mt("debug_v53_cat3_max_subarray_01d", "max_subarray", "medium",
           (f"Max subarray all-negative fails:\n```python\n{_MS_CODE}\n```", _MS_T1_Q),
           ("nums[0] and loop from nums[1:]",
            "Spot on! `max_sum = nums[0]` + `for num in nums[1:]`. "
            "Seeds the answer with a real value, handles all-negative arrays correctly. "
            "Your update logic is perfect — just the initialization needed fixing!"),
        ),
    ]


def _cat3_group7():
    """Two Sum variable name — 4 paths"""
    _TS_CODE = (
        "def twoSum(self, nums, target):\n"
        "    seen = {}\n"
        "    for i, num in enumerate(num):\n"
        "        complement = target - num\n"
        "        if complement in seen:\n"
        "            return [seen[complement], i]\n"
        "        seen[num] = i\n"
        "    return []"
    )
    _TS_T1_Q = (
        "I found **1 issue** causing the crash.\n\n"
        "**Issue 1 — Line 3**\n"
        "```python\n"
        "for i, num in enumerate(num):\n"
        "```\n"
        "`num` inside `enumerate(...)` doesn't exist yet — "
        "it's the loop variable *being created* by this line. "
        "You want to iterate over the input list. "
        "What is the parameter name for the list in the function signature?"
    )
    return [
        mt("debug_v53_cat3_two_sum_01a", "two_sum", "easy",
           (f"Two sum NameError:\n```python\n{_TS_CODE}\n```\nNameError: name 'num' is not defined.", _TS_T1_Q),
           ("idk",
            "Let's look at the function signature on line 1: "
            "`def twoSum(self, nums, target)`. "
            "The list parameter is called `nums`. "
            "So `enumerate(num)` should be `enumerate(nums)`. "
            "The `num` without the 's' doesn't exist until it's created by the loop itself!"),
           ("oh enumerate(nums)?",
            "Exactly! `for i, num in enumerate(nums):` — iterate over `nums` (the parameter), "
            "which gives you index `i` and value `num` each iteration. "
            "Your complement logic and hash map update look correct otherwise!"),
        ),
        mt("debug_v53_cat3_two_sum_01b", "two_sum", "easy",
           (f"Two sum crash:\n```python\n{_TS_CODE}\n```", _TS_T1_Q),
           ("nums?",
            "Yes! `enumerate(nums)` — the parameter from the function signature. "
            "`num` (without 's') doesn't exist outside the loop body. "
            "Change `enumerate(num)` to `enumerate(nums)` and your code should run!"),
        ),
        mt("debug_v53_cat3_two_sum_01c", "two_sum", "easy",
           (f"Two sum NameError:\n```python\n{_TS_CODE}\n```", _TS_T1_Q),
           ("why does num not exist?",
            "Because `num` is the *loop variable* — it's created and assigned by the `for` statement itself. "
            "When Python evaluates `enumerate(num)`, it's looking for `num` as an existing variable "
            "before the loop has a chance to create it. "
            "It's like trying to use a variable before declaring it.\n\n"
            "The list you want to enumerate is `nums` — the parameter that was passed in. "
            "What should `enumerate(num)` be changed to?"),
           ("enumerate(nums)",
            "Exactly right! `enumerate(nums)` gives you pairs of `(index, value)` from the input list. "
            "Your hash map logic is correct — just this one word change!"),
        ),
        mt("debug_v53_cat3_two_sum_01d", "two_sum", "easy",
           (f"Two sum bug:\n```python\n{_TS_CODE}\n```\nNameError.", _TS_T1_Q),
           ("enumerate(nums)",
            "Perfect! `for i, num in enumerate(nums)` — iterate over the input list. "
            "Your complement calculation and seen-map update are both correct. "
            "Just that one character ('s') and you're done!"),
        ),
    ]


def _cat3_group8():
    """Palindrome pointer direction — 4 paths"""
    _PD_CODE = (
        "def isPalindrome(self, x):\n"
        "    if x < 0:\n"
        "        return False\n"
        "    s = str(x)\n"
        "    left, right = 0, len(s) - 1\n"
        "    while left < right:\n"
        "        if s[left] != s[right]:\n"
        "            return False\n"
        "        left += 1\n"
        "        right += 1\n"
        "    return True"
    )
    _PD_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 10**\n"
        "```python\n"
        "right += 1\n"
        "```\n"
        "`right` should move *inward* (toward the center) each step, not outward. "
        "Incrementing `right` moves it toward the end of the string and eventually out of bounds. "
        "The two pointers never converge to check the middle.\n\n"
        "To move `right` toward the center, should it increment or decrement?"
    )
    return [
        mt("debug_v53_cat3_palindrome_01a", "palindrome_number", "easy",
           (f"Palindrome wrong answer:\n```python\n{_PD_CODE}\n```\nFails on x=121.", _PD_T1_Q),
           ("idk",
            "Think about the two-pointer idea: you start with `left` at the beginning "
            "and `right` at the end, and move them *toward each other* to check mirrored characters. "
            "- `left` moves right (toward center): `left += 1` ✓\n"
            "- `right` should move left (toward center): `right -= 1`\n\n"
            "But your code has `right += 1`, which moves it *away* from the center. "
            "What should the operation on `right` be?"),
           ("right -= 1?",
            "Exactly! `right -= 1` moves the right pointer inward. "
            "With `left += 1` and `right -= 1`, the pointers converge and check all mirrored pairs. "
            "That one sign change is the entire fix!"),
        ),
        mt("debug_v53_cat3_palindrome_01b", "palindrome_number", "easy",
           (f"Palindrome check bug:\n```python\n{_PD_CODE}\n```", _PD_T1_Q),
           ("right -= 1?",
            "Yes! `right -= 1` moves the right pointer toward the center. "
            "Combined with `left += 1`, the pointers converge and correctly check all mirrored positions. "
            "Your base logic and return values are correct — just that one sign change!"),
        ),
        mt("debug_v53_cat3_palindrome_01c", "palindrome_number", "easy",
           (f"Palindrome number fails:\n```python\n{_PD_CODE}\n```", _PD_T1_Q),
           ("why doesn't it crash with +=?",
            "Great question! `right += 1` keeps incrementing until `right >= len(s)`. "
            "But `while left < right` — once `left` and `right` both go past the string boundary, "
            "`left < right` may still be true and `s[right]` would crash. "
            "Actually for short numbers it might terminate from `left < right` becoming false... "
            "but it compares wrong characters because both pointers move right, "
            "never checking the actual mirrored pairs.\n\n"
            "What should `right` do instead of `+= 1`?"),
           ("right -= 1",
            "Exactly! Move right inward. With `left += 1` and `right -= 1`, "
            "you properly check `s[0]` vs `s[-1]`, then `s[1]` vs `s[-2]`, etc. "
            "That's the complete palindrome check!"),
        ),
        mt("debug_v53_cat3_palindrome_01d", "palindrome_number", "easy",
           (f"isPalindrome bug:\n```python\n{_PD_CODE}\n```", _PD_T1_Q),
           ("-= 1 to move inward",
            "Exactly right! `right -= 1` and `left += 1` — both pointers move toward center. "
            "Your check on line 7 and the return values are correct. "
            "Just change `+=` to `-=` on line 10!"),
        ),
    ]


def _cat3_group9():
    """Merge Sorted Array wrong pointer start — 4 paths"""
    _MA_CODE = (
        "def merge(self, nums1, m, nums2, n):\n"
        "    p1, p2 = m, n\n"
        "    p = m + n - 1\n"
        "    while p1 >= 0 and p2 >= 0:\n"
        "        if nums1[p1] >= nums2[p2]:\n"
        "            nums1[p] = nums1[p1]\n"
        "            p1 -= 1\n"
        "        else:\n"
        "            nums1[p] = nums2[p2]\n"
        "            p2 -= 1\n"
        "        p -= 1\n"
        "    while p2 >= 0:\n"
        "        nums1[p] = nums2[p2]\n"
        "        p2 -= 1\n"
        "        p -= 1"
    )
    _MA_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 2**\n"
        "```python\n"
        "p1, p2 = m, n\n"
        "```\n"
        "`p1` and `p2` should point to the *last valid elements* of `nums1` and `nums2`. "
        "The last valid element of `nums1` (which has `m` filled values) is at index `m - 1`. "
        "Starting at `m` immediately accesses an out-of-bounds index on line 5.\n\n"
        "If `nums1` has `m` filled elements, what is the index of its last filled element?"
    )
    return [
        mt("debug_v53_cat3_merge_sorted_01a", "merge_sorted_array", "easy",
           (f"Merge sorted array IndexError:\n```python\n{_MA_CODE}\n```\nIndexError on line 5.", _MA_T1_Q),
           ("idk",
            "Let's use a concrete example. Suppose `nums1 = [1, 3, 5, 0, 0, 0]` with `m = 3`. "
            "The filled elements are at indices 0, 1, 2 — so the last filled is at index **2**, which is `m - 1 = 2`. "
            "Index 3 (`m`) is the first empty slot, not the last filled element. "
            "So `p1` should start at `m - 1`. What should `p2` start at?"),
           ("n - 1?",
            "Exactly! `p1, p2 = m - 1, n - 1` — both point to the last valid elements. "
            "That change on line 2 fixes the IndexError. "
            "Your merge logic and cleanup loop look correct!"),
        ),
        mt("debug_v53_cat3_merge_sorted_01b", "merge_sorted_array", "easy",
           (f"Merge sorted crash:\n```python\n{_MA_CODE}\n```", _MA_T1_Q),
           ("m - 1?",
            "Yes! And similarly `p2 = n - 1`. So `p1, p2 = m - 1, n - 1`. "
            "Both start at the last valid element of their respective arrays. "
            "Just that small change on line 2 and the IndexError is gone!"),
        ),
        mt("debug_v53_cat3_merge_sorted_01c", "merge_sorted_array", "easy",
           (f"Merge sorted array IndexError:\n```python\n{_MA_CODE}\n```", _MA_T1_Q),
           ("why start from the back?",
            "Great question! If we merged from the front, we'd overwrite elements of `nums1` "
            "that we haven't processed yet. Starting from the back (largest elements first) "
            "is safe because `nums1` has extra space at the end.\n\n"
            "So `p` starts at `m + n - 1` (last position), and `p1` starts at the last *filled* "
            "element of `nums1`, which is index `m - 1`. What should line 2 be?"),
           ("p1, p2 = m - 1, n - 1",
            "Exactly! Both pointers at the last valid elements. "
            "Your merge logic is correct — just that initialization change on line 2!"),
        ),
        mt("debug_v53_cat3_merge_sorted_01d", "merge_sorted_array", "easy",
           (f"Merge sorted bug:\n```python\n{_MA_CODE}\n```\nIndexError.", _MA_T1_Q),
           ("m - 1, n - 1",
            "Perfect! `p1, p2 = m - 1, n - 1` — pointers at last valid elements. "
            "Your merge loop and cleanup are correct. One line change!"),
        ),
    ]


def _cat3_group10():
    """Longest Substring window size off-by-one — 4 paths"""
    _LS_CODE = (
        "def lengthOfLongestSubstring(self, s):\n"
        "    char_set = set()\n"
        "    left = 0\n"
        "    max_len = 0\n"
        "    for right in range(len(s)):\n"
        "        while s[right] in char_set:\n"
        "            char_set.discard(s[left])\n"
        "            left += 1\n"
        "        char_set.add(s[right])\n"
        "        max_len = max(max_len, right - left)\n"
        "    return max_len"
    )
    _LS_T1_Q = (
        "I found **1 issue** in your code.\n\n"
        "**Issue 1 — Line 10**\n"
        "```python\n"
        "max_len = max(max_len, right - left)\n"
        "```\n"
        "A window spanning indices `left` to `right` inclusive has length "
        "`right - left + 1`, not `right - left`. "
        "Every window's size is undercounted by 1 — you're off by one.\n\n"
        "If `left = 0` and `right = 2`, how many characters are in the window?"
    )
    return [
        mt("debug_v53_cat3_longest_substr_01a", "longest_substring_without_repeating", "medium",
           (f"Longest substring wrong answer:\n```python\n{_LS_CODE}\n```\nExpected 3, got 2.", _LS_T1_Q),
           ("idk",
            "Let's count manually. Window from index 0 to index 2: "
            "that's characters at positions 0, 1, and 2 — **3** characters. "
            "But `right - left = 2 - 0 = 2`. Off by one!\n\n"
            "The formula for inclusive range length is `right - left + 1`. "
            "What should the expression on line 10 be?"),
           ("right - left + 1?",
            "Exactly! `max_len = max(max_len, right - left + 1)`. "
            "Your sliding window logic (shrinking when duplicate found, adding new char) is correct. "
            "Just add `+ 1` to the length calculation!"),
        ),
        mt("debug_v53_cat3_longest_substr_01b", "longest_substring_without_repeating", "medium",
           (f"Longest substring:\n```python\n{_LS_CODE}\n```\nWrong answer.", _LS_T1_Q),
           ("right - left + 1?",
            "Yes! `right - left + 1` gives the correct inclusive window length. "
            "Your shrinking logic and set management are correct. "
            "Just add `+ 1` to line 10 and you're done!"),
        ),
        mt("debug_v53_cat3_longest_substr_01c", "longest_substring_without_repeating", "medium",
           (f"Longest substring off by one:\n```python\n{_LS_CODE}\n```", _LS_T1_Q),
           ("why + 1?",
            "Because the range is *inclusive* on both ends. "
            "Think of it like counting fence posts: between post 0 and post 2, "
            "you have posts 0, 1, and 2 — that's 3 posts, not 2. "
            "`right - left` counts the *gaps*, but we want the *elements*. "
            "Adding 1 converts gaps to elements. What should line 10 become?"),
           ("right - left + 1",
            "Exactly! `max_len = max(max_len, right - left + 1)`. "
            "Your sliding window is correctly implemented otherwise. Just add `+ 1`!"),
        ),
        mt("debug_v53_cat3_longest_substr_01d", "longest_substring_without_repeating", "medium",
           (f"Longest substring wrong:\n```python\n{_LS_CODE}\n```", _LS_T1_Q),
           ("3 characters",
            "Right — 3 characters (0, 1, 2), but `right - left = 2`. "
            "You need `right - left + 1`. Add `+ 1` to line 10 and your solution is complete!"),
        ),
    ]


def _cat3_frustration_paths():
    """
    Cat 3 frustration-path examples: 3-turn conversations modelling the
    escalation pattern from MODEL_IMPROVEMENT_PROMPT.md:

      Turn 1: complete multi-bug debug response (Issue N — Line X format)
      Turn 2: student confusion ("I still don't understand") →
               AI zooms in, different angle, side-by-side code comparison
      Turn 3: student frustration ("I wanna give up", "I give up") →
               AI: emotional acknowledgment → reframe → A/B/C choice → encouragement

    5 scenarios, 1 path each = 5 examples.
    These fill the specific gap identified in MODEL_IMPROVEMENT_PROMPT.md where
    the current training data has NO examples of the confusion→frustration path.
    """
    examples = []

    # ── 1. Two Sum: syntax error on Line 6 + dead-code logic bug on Line 7 ───
    # This is the exact scenario from MODEL_IMPROVEMENT_PROMPT.md Section 3.
    _TS_CODE = (
        "class Solution(object):\n"
        "    def twoSum(self, nums, target):\n"
        "        n = len(nums)\n"
        "        for i in range(n):\n"
        "            for j in range(i + 1, n):\n"
        "                if nums[i] + nums[j] == :\n"
        "                    return []"
    )
    _TS_T1_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 6: `if nums[i] + nums[j] == :` — missing comparison value after `==`. SyntaxError.\n"
        "3. Line 7: `return []` — returns empty list, should return `[i, j]`.\n"
        "4. Test output confirms SyntaxError on line 6 — confirms Bug 1.\n"
        "5. Test output does NOT mention Bug 2 — code never reaches line 7 due to SyntaxError.\n"
        "6. I'll explain both bugs but focus on Bug 1 first (blocks execution).\n"
        "7. I'll ask a guiding question about the function parameters.\n"
        "</think>\n\n"
        "I found **2 issues** in your code. Let's start with the one that's "
        "stopping it from running at all.\n\n"
        "**Issue 1 — Line 6**\n"
        "```python\n"
        "if nums[i] + nums[j] == :\n"
        "```\n"
        "Line 6 has `==` with nothing on the right side — Python sees an incomplete "
        "comparison and raises `SyntaxError: invalid syntax`. Every test fails because "
        "the code cannot run at all.\n\n"
        "Think about it: you're checking if two numbers add up to... what? "
        "Look at your function parameters — which one represents the number "
        "you're trying to match?\n\n"
        "**Issue 2 — Line 7**\n"
        "```python\n"
        "return []\n"
        "```\n"
        "Even after you fix the line above, Line 7 will give wrong answers. "
        "The problem asks you to return the **indices** of the two numbers. "
        "Right now you're returning an empty list. "
        "What two values do you already have that represent the positions "
        "of the numbers you found?\n\n"
        "---\n"
        "Let's fix Issue 1 first since the code can't run without it. "
        "What do you think should go after `==`?"
    )
    _TS_T2_AI = (
        "That's okay — let's zoom in on just one thing.\n\n"
        "Look at this line:\n\n"
        "```python\n"
        "if nums[i] + nums[j] == :\n"
        "```\n\n"
        "Python is asking: **\"Equal to what?\"**\n\n"
        "Now look at your function header:\n\n"
        "```python\n"
        "def twoSum(self, nums, target):\n"
        "```\n\n"
        "You have 3 inputs: `self`, `nums`, and `target`.\n"
        "- `nums` is the list of numbers\n"
        "- `target` is the number you want the sum to equal\n\n"
        "Right now your code says:\n\n"
        "```\n"
        "something == nothing\n"
        "```\n\n"
        "Which of those 3 inputs should go after `==`?"
    )
    _TS_T3_AI = (
        "Hey — pause for a second. What you're feeling right now is "
        "frustration, not lack of ability.\n\n"
        "This exact mistake — leaving something blank after `==` — is something "
        "almost every programmer makes early on. It's a syntax mistake, "
        "not an intelligence problem.\n\n"
        "Look at this one more time:\n\n"
        "```python\n"
        "def twoSum(self, nums, target):\n"
        "```\n\n"
        "The problem says: *\"return indices of the two numbers such that "
        "they add up to **target**\"*\n\n"
        "Your code checks: `nums[i] + nums[j] == ___`\n\n"
        "Pick one:\n"
        "- a) `nums`\n"
        "- b) `target`\n"
        "- c) `i + j`\n\n"
        "Your brain already knows most of the code is correct — the loops are right, "
        "the structure is right. This is just filling in one missing piece. "
        "You can do this — you're already almost there."
    )
    examples.append(mt(
        "debug_v53_cat3_frustration_two_sum_01", "two_sum", "easy",
        (
            f"Can you review my code and tell me what's wrong?\n```python\n{_TS_CODE}\n```",
            _TS_T1_AI,
        ),
        ("But I still don't understand", _TS_T2_AI),
        ("I wanna give up, I'm not good in coding", _TS_T3_AI),
    ))

    # ── 2. Contains Duplicate: both return values swapped ─────────────────────
    _CD_CODE = (
        "def containsDuplicate(self, nums):\n"
        "    seen = set()\n"
        "    for num in nums:\n"
        "        if num in seen:\n"
        "            return False\n"
        "        seen.add(num)\n"
        "    return True"
    )
    _CD_T1_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 5: `return False` — fires when `num in seen` is True, meaning a duplicate was found. Should return True.\n"
        "3. Line 7: `return True` — fires when loop finishes with no duplicate found. Should return False.\n"
        "4. Test output confirms wrong answer: expected True for [1,2,3,1], got False — confirms both return values are swapped.\n"
        "5. Both bugs are visible in source code and confirmed by test output.\n"
        "6. I'll explain both bugs and focus on Issue 1 first (most counter-intuitive).\n"
        "7. I'll ask a guiding question about what to return when a duplicate is found.\n"
        "</think>\n\n"
        "I found **2 issues** in your code — both return values are swapped.\n\n"
        "**Issue 1 — Line 5**\n"
        "```python\n"
        "return False\n"
        "```\n"
        "Line 5 fires when `num in seen` — meaning you just found a number "
        "that appeared earlier in the list. That IS a duplicate. "
        "But you're returning `False` (no duplicate), which is the opposite of what you want.\n\n"
        "When `num` is already in `seen`, does the array have duplicates?\n\n"
        "**Issue 2 — Line 7**\n"
        "```python\n"
        "return True\n"
        "```\n"
        "Line 7 runs when the loop finishes without finding any duplicate. "
        "If no duplicate was found, the answer is `False` — but you're returning `True`. "
        "Both return values are the mirror image of what they should be.\n\n"
        "---\n"
        "Let's fix Issue 1 first. When `num` is already in `seen`, what should the function return?"
    )
    _CD_T2_AI = (
        "Let's use a real-world example — forget the code for a second.\n\n"
        "Imagine you're checking a shopping list for repeated items. "
        "You go through it one by one and write each item on a notepad. "
        "If you see an item that's **already on your notepad** — you found a duplicate!\n\n"
        "In your code, `seen` is the notepad and `num in seen` means "
        "\"this item was already written down.\"\n\n"
        "So when `num in seen` is `True`, you've found a duplicate. "
        "The function is called `containsDuplicate`. Pick one:\n"
        "- a) Found a duplicate → return `True` (yes, duplicates exist)\n"
        "- b) Found a duplicate → return `False` (no duplicates)\n\n"
        "Which one matches the function's name?"
    )
    _CD_T3_AI = (
        "Hey — don't give up just yet. You're not confused because you're bad at this. "
        "Logic flips are genuinely tricky to spot — they trip up experienced developers too.\n\n"
        "Let's make it as simple as possible. One question:\n\n"
        "The function is named `containsDuplicate`.\n"
        "- YES (it contains a duplicate) → return `True`\n"
        "- NO (no duplicates) → return `False`\n\n"
        "Your code finds a duplicate on Line 5 and returns `False`. "
        "That's like finding your keys and saying \"I haven't found them.\"\n\n"
        "Pick one:\n"
        "- a) Found a duplicate → return `True`\n"
        "- b) Found a duplicate → return `False`\n\n"
        "Your set logic and loop are both completely correct — "
        "this is literally one word to change. Which option makes sense?"
    )
    examples.append(mt(
        "debug_v53_cat3_frustration_contains_duplicate_01", "contains_duplicate", "easy",
        (
            f"Wrong answer on contains duplicate:\n```python\n{_CD_CODE}\n```"
            "\nExpected True for [1,2,3,1], got False.",
            _CD_T1_AI,
        ),
        ("I still don't understand why it should be True", _CD_T2_AI),
        ("I give up, this makes no sense to me", _CD_T3_AI),
    ))

    # ── 3. Valid Parentheses: stack.pop() on empty stack ──────────────────────
    _VP_CODE = (
        "def isValid(self, s):\n"
        "    stack = []\n"
        "    mapping = {')': '(', '}': '{', ']': '['}\n"
        "    for char in s:\n"
        "        if char in mapping:\n"
        "            top = stack.pop()\n"
        "            if top != mapping[char]:\n"
        "                return False\n"
        "        else:\n"
        "            stack.append(char)\n"
        "    return len(stack) == 0"
    )
    _VP_T1_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Line 6: `top = stack.pop()` — called unconditionally. If `stack` is empty, raises IndexError.\n"
        "3. All other lines look correct: mapping is right, push/pop logic is right, return checks length.\n"
        "4. Test output confirms IndexError on pop from empty list — confirms Bug 1.\n"
        "5. Only 1 bug. The crash happens on edge cases where input starts with a closing bracket.\n"
        "6. I'll explain the 1 bug and praise the overall approach (it's mostly correct).\n"
        "7. I'll ask a guiding question about what safe sentinel value to assign when the stack is empty.\n"
        "</think>\n\n"
        "Your overall approach is right — mapping, push open brackets, pop on close. "
        "I found **1 issue**.\n\n"
        "**Issue 1 — Line 6**\n"
        "```python\n"
        "top = stack.pop()\n"
        "```\n"
        "Line 6 calls `stack.pop()` without checking whether the stack is empty first. "
        "When the input starts with a closing bracket (like `')'` or `')()'`), "
        "the stack is empty at Line 6 and Python raises `IndexError: pop from empty list`.\n\n"
        "Before popping, you need a safety check. "
        "What value could you assign to `top` when the stack is empty, "
        "so that the comparison on Line 7 safely fails and returns `False`?"
    )
    _VP_T2_AI = (
        "Good question — let's trace through a concrete example.\n\n"
        "Input: `')'` (just one closing bracket)\n\n"
        "Your code runs:\n"
        "1. `stack = []` — starts empty\n"
        "2. `char = ')'` — it's in `mapping`, so we reach Line 6\n"
        "3. `top = stack.pop()` — but `stack` is `[]`! Nothing to pop → `IndexError`\n\n"
        "Line 6 assumes there's always an open bracket waiting in the stack, "
        "but if the string starts with `)`, there isn't one yet.\n\n"
        "The fix is: `top = stack.pop() if stack else '#'`\n\n"
        "If the stack is empty, `top` becomes `'#'`, which won't match any bracket "
        "in `mapping`, so Line 7 returns `False` correctly.\n\n"
        "What should `top` be set to when the stack is empty?"
    )
    _VP_T3_AI = (
        "Hey — stop for a second. The fact that you're tracing through this logic "
        "means you ARE thinking like a programmer. "
        "This specific crash only happens on edge cases that experienced engineers "
        "miss the first time around — it's not obvious.\n\n"
        "Let's reduce this to one decision.\n\n"
        "The problem: `stack.pop()` crashes when the stack is empty.\n"
        "The fix: return a safe dummy value instead of crashing.\n\n"
        "Pick one:\n"
        "- a) `top = stack.pop() if stack else '#'`\n"
        "     (returns `'#'` when empty — `'#'` matches nothing, so Line 7 returns `False`)\n"
        "- b) `top = stack[-1] if stack else '#'`\n"
        "     (peeks at the top without removing — but doesn't fix the pop crash)\n"
        "- c) Add `if not stack: return False` before Line 6\n"
        "     (also works — explicitly reject closing bracket when nothing to match)\n\n"
        "Options a and c both fix the bug. Your logic for the rest of the function "
        "is completely correct — this is one line between you and a passing solution. "
        "Which option feels clearest to you?"
    )
    examples.append(mt(
        "debug_v53_cat3_frustration_valid_parentheses_01", "valid_parentheses", "easy",
        (
            f"My parentheses checker crashes on some inputs:\n```python\n{_VP_CODE}\n```"
            "\nError: IndexError: pop from empty list",
            _VP_T1_AI,
        ),
        ("I still don't understand when the stack would be empty", _VP_T2_AI),
        ("I'm not smart enough for this, I wanna give up", _VP_T3_AI),
    ))

    # ── 4. Climbing Stairs: missing dp[2] base case ───────────────────────────
    _CS_CODE = (
        "def climbStairs(self, n):\n"
        "    if n == 1:\n"
        "        return 1\n"
        "    dp = [0] * (n + 1)\n"
        "    dp[1] = 1\n"
        "    for i in range(2, n + 1):\n"
        "        dp[i] = dp[i-1] + dp[i-2]\n"
        "    return dp[n]"
    )
    _CS_T1_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Lines 2-3: `if n == 1: return 1` — correct base case for n=1.\n"
        "3. Line 4: `dp = [0] * (n + 1)` — initialises all slots to zero.\n"
        "4. Line 5: `dp[1] = 1` — sets base case for 1 step. Missing `dp[2] = 2`.\n"
        "5. Lines 6-7: recurrence `dp[i] = dp[i-1] + dp[i-2]` is correct, but at i=2 it uses dp[0]=0 which corrupts all higher values.\n"
        "6. Test output confirms wrong answer: expected 3 for n=3, got 1 — confirms the propagation error.\n"
        "7. I'll ask a guiding question: how many ways are there to climb exactly 2 stairs?\n"
        "</think>\n\n"
        "Your DP loop and recurrence formula are correct. I found **1 issue**.\n\n"
        "**Issue 1 — Line 5**\n"
        "```python\n"
        "dp[1] = 1\n"
        "```\n"
        "Line 5 initialises `dp[1]` but not `dp[2]`. "
        "Your array starts as all zeros, so `dp[2] = 0` when the loop begins. "
        "At `i = 2`, your formula computes `dp[2] + dp[1] = 0 + 1 = 1`, "
        "but `n = 3` should return 3. The error propagates to every higher value.\n\n"
        "There are 2 distinct ways to climb 2 stairs — "
        "either take 1 step twice, or take 2 steps at once. "
        "What should `dp[2]` be set to?"
    )
    _CS_T2_AI = (
        "Let's step back from the code and think about it physically.\n\n"
        "You have a staircase with 2 steps. "
        "You can take 1 step at a time or 2 steps at a time. "
        "How many different ways can you reach the top?\n\n"
        "- Way 1: step 1, then step 2 (1 + 1)\n"
        "- Way 2: jump both steps at once (2)\n\n"
        "That's it — **2 ways**.\n\n"
        "Your formula `dp[i] = dp[i-1] + dp[i-2]` is correct for `i ≥ 3`, "
        "but at `i = 2` it needs `dp[0]` to be meaningful. "
        "Setting `dp[2] = 2` explicitly avoids that dependency.\n\n"
        "How many ways are there to climb exactly 2 stairs?"
    )
    _CS_T3_AI = (
        "I hear you — and I want to push back on that thought. "
        "Dynamic programming is genuinely one of the hardest topics in programming. "
        "Struggling here is completely normal, not a sign of inability.\n\n"
        "Let's forget the code entirely and just answer one question "
        "about climbing stairs in real life.\n\n"
        "You're at the bottom of a 2-step staircase. "
        "You can go 1 step at a time or 2 steps at a time. "
        "How many different paths can you take to reach the top?\n\n"
        "Pick one:\n"
        "- a) 1 way\n"
        "- b) 2 ways\n"
        "- c) 3 ways\n\n"
        "That number is exactly what `dp[2]` should be. "
        "Your loop logic is already right — this is just the missing starting value. "
        "You've got this."
    )
    examples.append(mt(
        "debug_v53_cat3_frustration_climbing_stairs_01", "climbing_stairs", "easy",
        (
            f"Climbing stairs gives wrong answer:\n```python\n{_CS_CODE}\n```"
            "\nExpected 3 for n=3, got 1.",
            _CS_T1_AI,
        ),
        ("I still don't get it, why does dp[2] need a special value?", _CS_T2_AI),
        ("I don't understand anything, I think coding isn't for me", _CS_T3_AI),
    ))

    # ── 5. Reverse Linked List: returns curr (None) instead of prev ───────────
    _RL_CODE = (
        "def reverseList(self, head):\n"
        "    prev = None\n"
        "    curr = head\n"
        "    while curr:\n"
        "        next_node = curr.next\n"
        "        curr.next = prev\n"
        "        prev = curr\n"
        "        curr = next_node\n"
        "    return curr"
    )
    _RL_T1_AI = (
        "<think>\n"
        "1. Let me read the source code line by line.\n"
        "2. Lines 2-3: `prev = None`, `curr = head` — correct initialisation.\n"
        "3. Lines 5-8: `next_node = curr.next`, `curr.next = prev`, `prev = curr`, `curr = next_node` — correct pointer reversal.\n"
        "4. Line 9: `return curr` — after the loop `curr` is always `None` (that's what exited the while condition). Should return `prev`.\n"
        "5. Test output confirms wrong answer: expected 3->2->1, got None — confirms Bug 1.\n"
        "6. Only 1 bug. The reversal logic is completely correct, just the wrong return value.\n"
        "7. I'll ask a guiding question about which variable holds the new head after the loop.\n"
        "</think>\n\n"
        "Your pointer-reversal logic is correct — I found **1 issue**.\n\n"
        "**Issue 1 — Line 9**\n"
        "```python\n"
        "return curr\n"
        "```\n"
        "Line 9 returns `curr`, but when the `while` loop ends, `curr` is always `None` "
        "(that's what stopped the loop). You're returning the end of a finished traversal, "
        "not the new head of the reversed list.\n\n"
        "After the loop completes, the reversed list's new head is the last node "
        "your loop processed — the one that `prev` points to. "
        "Which variable holds the new head of the reversed list?"
    )
    _RL_T2_AI = (
        "Let's trace through a tiny list: `1 → 2 → 3 → None`\n\n"
        "Start: `prev = None`, `curr = 1`\n\n"
        "Iteration 1 (`curr = node 1`):\n"
        "- `next_node = node 2`\n"
        "- `node1.next = None` (reverse the arrow)\n"
        "- `prev = node 1`, `curr = node 2`\n\n"
        "Iteration 2 (`curr = node 2`):\n"
        "- `next_node = node 3`\n"
        "- `node2.next = node 1`\n"
        "- `prev = node 2`, `curr = node 3`\n\n"
        "Iteration 3 (`curr = node 3`):\n"
        "- `next_node = None`\n"
        "- `node3.next = node 2`\n"
        "- `prev = node 3`, `curr = None`\n\n"
        "Loop ends. Now: `prev = node 3`, `curr = None`.\n"
        "The reversed list is `3 → 2 → 1 → None`. "
        "Which variable points to node 3 (the new head)?"
    )
    _RL_T3_AI = (
        "Hey — being lost on linked list reversal is completely normal. "
        "You're tracking two variables moving through a list at the same time "
        "while also reversing arrows. That's a lot to hold in your head.\n\n"
        "Let's ignore the trace and focus on just the last line.\n\n"
        "After the loop, you have two variables:\n"
        "- `curr = None` — the loop stopped here\n"
        "- `prev = [the last real node you processed]`\n\n"
        "Pick one:\n"
        "- a) `return curr` — returns `None`\n"
        "- b) `return prev` — returns the last node processed (the new head)\n\n"
        "Your entire reversal logic — the three pointer updates inside the loop — "
        "is 100% correct. This is one word: change `curr` to `prev` on the last line. "
        "Which option gives back the head of the reversed list?"
    )
    examples.append(mt(
        "debug_v53_cat3_frustration_reverse_list_01", "reverse_linked_list", "easy",
        (
            f"Reverse linked list returns None:\n```python\n{_RL_CODE}\n```"
            "\nExpected 3->2->1, got None.",
            _RL_T1_AI,
        ),
        ("I still don't understand, what does prev hold at the end?", _RL_T2_AI),
        ("I give up, I'm so lost I can't do this", _RL_T3_AI),
    ))

    return examples  # 5 examples


def generate_cat3():
    examples = list(CAT3)  # binary_search group (4) built inline above
    examples += _cat3_group2()          # contains_duplicate (4)
    examples += _cat3_group3()          # climbing_stairs (4)
    examples += _cat3_group4()          # valid_parentheses (4)
    examples += _cat3_group5()          # coin_change (4)
    examples += _cat3_group6()          # max_subarray (4)
    examples += _cat3_group7()          # two_sum variable name (4)
    examples += _cat3_group8()          # palindrome pointer (4)
    examples += _cat3_group9()          # merge sorted array (4)
    examples += _cat3_group10()         # longest substring (4)
    examples += _cat3_frustration_paths()  # confusion → frustration (5)
    return examples  # 4 × 10 + 5 = 45


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY 4: MOSTLY-CORRECT CODE — ENCOURAGEMENT FIRST  (20 unique examples)
# ─────────────────────────────────────────────────────────────────────────────

def generate_cat4():
    return [
        build_example("debug_v53_cat4_binary_search_01", "binary_search", "easy", [
            {"role": "user", "content":
             "My binary search almost works — one edge case:\n"
             "```python\n"
             "def search(self, nums, target):\n"
             "    left, right = 0, len(nums) - 1\n"
             "    while left <= right:\n"
             "        mid = left + (right - left) // 2\n"
             "        if nums[mid] == target:\n"
             "            return mid\n"
             "        elif nums[mid] < target:\n"
             "            left = mid + 1\n"
             "        else:\n"
             "            right = mid - 1\n"
             "    return -1\n"
             "```\n"
             "Failing when the array is empty."},
            {"role": "assistant", "content":
             "Your binary search is well-written — using `left + (right - left) // 2` "
             "to avoid integer overflow is a nice touch that many students miss!\n\n"
             "For an empty array: `left = 0`, `right = len([]) - 1 = -1`. "
             "The condition `left <= right` is `0 <= -1` = `False`, "
             "so the loop never runs and you correctly return `-1`.\n\n"
             "That looks correct to me. Could you share the exact error or test case? "
             "For `nums = []` and any `target`, your code should return `-1` without crashing. "
             "Are you seeing a wrong answer or an exception?"},
        ]),
        build_example("debug_v53_cat4_two_sum_01", "two_sum", "easy", [
            {"role": "user", "content":
             "My two sum is almost right but one test fails:\n"
             "```python\n"
             "def twoSum(self, nums, target):\n"
             "    seen = {}\n"
             "    for i, num in enumerate(nums):\n"
             "        complement = target - num\n"
             "        if complement in seen:\n"
             "            return [seen[complement], i]\n"
             "        seen[num] = i\n"
             "    return []\n"
             "```\n"
             "Fails on nums=[3,3], target=6. Expected [0,1], got []."},
            {"role": "assistant", "content":
             "Your hash map approach and overall structure are excellent — "
             "this is exactly the right O(n) solution!\n\n"
             "Let me trace `nums=[3,3], target=6`:\n"
             "- `i=0, num=3`: `complement = 3`. Not in `seen` (empty). `seen = {3: 0}`.\n"
             "- `i=1, num=3`: `complement = 3`. IS in `seen`! Return `[seen[3], 1] = [0, 1]` ✓\n\n"
             "That should return `[0, 1]` correctly. "
             "Could you double-check the exact test input and output you're seeing? "
             "This looks correct to me for `[3,3], target=6`."},
        ]),
        build_example("debug_v53_cat4_valid_parentheses_01", "valid_parentheses", "easy", [
            {"role": "user", "content":
             "isValid almost works:\n"
             "```python\n"
             "def isValid(self, s):\n"
             "    stack = []\n"
             "    mapping = {')': '(', ']': '[', '}': '{'}\n"
             "    for char in s:\n"
             "        if char in mapping:\n"
             "            top = stack.pop() if stack else '#'\n"
             "            if mapping[char] != top:\n"
             "                return False\n"
             "        else:\n"
             "            stack.append(char)\n"
             "    return not stack\n"
             "```\n"
             "All tests pass except the empty string."},
            {"role": "assistant", "content":
             "This is a beautifully clean implementation using a reverse mapping dictionary — "
             "great design choice!\n\n"
             "For the empty string: the loop doesn't execute, stack is `[]`, "
             "`return not stack` = `not []` = `True` ✓. "
             "An empty string IS a valid bracket sequence, so `True` is correct.\n\n"
             "Your code handles it properly! Could you share what output you're seeing "
             "vs. what's expected? I want to confirm the actual mismatch — "
             "this solution looks correct to me."},
        ]),
        build_example("debug_v53_cat4_reverse_linked_list_01", "reverse_linked_list", "easy", [
            {"role": "user", "content":
             "Reverse linked list mostly correct:\n"
             "```python\n"
             "def reverseList(self, head):\n"
             "    prev = None\n"
             "    curr = head\n"
             "    while curr:\n"
             "        next_node = curr.next\n"
             "        curr.next = prev\n"
             "        prev = curr\n"
             "        curr = next_node\n"
             "    return prev\n"
             "```\n"
             "One edge case failing: single element list."},
            {"role": "assistant", "content":
             "Your linked list reversal is textbook perfect — "
             "saving `next_node` before overwriting, updating pointers in the right order, "
             "advancing both pointers correctly. This is the ideal iterative implementation.\n\n"
             "For a single element `[1]`: `curr = node(1)`, `prev = None`.\n"
             "- Iteration 1: `next_node = None`, `curr.next = None`, `prev = node(1)`, `curr = None`.\n"
             "- Loop ends. Return `prev = node(1)` ✓\n\n"
             "That's correct! Reversing a single-element list gives back the same list. "
             "Could you share the exact test input and expected vs. actual output? "
             "Your code looks correct to me."},
        ]),
        build_example("debug_v53_cat4_climbing_stairs_01", "climbing_stairs", "easy", [
            {"role": "user", "content":
             "Climbing stairs solution:\n"
             "```python\n"
             "def climbStairs(self, n):\n"
             "    if n <= 2:\n"
             "        return n\n"
             "    a, b = 1, 2\n"
             "    for _ in range(2, n):\n"
             "        a, b = b, a + b\n"
             "    return b\n"
             "```\n"
             "All tests pass but I'm unsure about n=1."},
            {"role": "assistant", "content":
             "Your space-optimized iterative solution is excellent — "
             "two variables instead of an array, clean and efficient!\n\n"
             "For `n=1`: `n <= 2` is true, so you return `1` ✓. "
             "For `n=2`: return `2` ✓. "
             "For `n=3`: one iteration, `a,b = 2, 1+2 = 3`, return `3` ✓.\n\n"
             "Your code handles all cases correctly. You can trust it! "
             "The `n <= 2: return n` early exit covers both base cases, "
             "and the loop correctly computes Fibonacci numbers from there. "
             "Well done!\n\n"
             "Want to trace through any other value of `n` to build confidence?"},
        ]),
        build_example("debug_v53_cat4_coin_change_01", "coin_change", "medium", [
            {"role": "user", "content":
             "Coin change mostly right:\n"
             "```python\n"
             "def coinChange(self, coins, amount):\n"
             "    dp = [float('inf')] * (amount + 1)\n"
             "    dp[0] = 0\n"
             "    for i in range(1, amount + 1):\n"
             "        for coin in coins:\n"
             "            if coin <= i:\n"
             "                dp[i] = min(dp[i], dp[i - coin] + 1)\n"
             "    return dp[amount] if dp[amount] != float('inf') else -1\n"
             "```\n"
             "All tests pass except amount=0."},
            {"role": "assistant", "content":
             "Your bottom-up DP coin change solution is clean and correct!\n\n"
             "For `amount = 0`: `dp = [0, inf, ...]`, `dp[0] = 0`. "
             "The loop `range(1, 0 + 1) = range(1, 1)` is empty. "
             "Return `dp[0] = 0` — zero coins are needed to make amount 0. That's correct!\n\n"
             "What does the test expect for `amount = 0`? "
             "If it expects `0`, your code returns `0` ✓. "
             "Could you share the specific failure message?"},
        ]),
        build_example("debug_v53_cat4_max_subarray_01", "max_subarray", "medium", [
            {"role": "user", "content":
             "Max subarray almost works:\n"
             "```python\n"
             "def maxSubArray(self, nums):\n"
             "    max_sum = nums[0]\n"
             "    current_sum = nums[0]\n"
             "    for num in nums[1:]:\n"
             "        current_sum = max(num, current_sum + num)\n"
             "        max_sum = max(max_sum, current_sum)\n"
             "    return max_sum\n"
             "```\n"
             "Failing on all-negative input."},
            {"role": "assistant", "content":
             "Your Kadane's algorithm is correctly implemented! "
             "Starting `max_sum` at `nums[0]` and iterating from `nums[1:]` is the right approach.\n\n"
             "Let me trace `[-3, -1, -2]`:\n"
             "- Start: `max_sum = -3`, `current_sum = -3`\n"
             "- `num = -1`: `current_sum = max(-1, -3-1) = max(-1,-4) = -1`. `max_sum = -1`\n"
             "- `num = -2`: `current_sum = max(-2, -1-2) = -2`. `max_sum = -1`\n"
             "- Return `-1` ✓\n\n"
             "That's correct! Could you share the specific test case that's failing? "
             "Your code looks like it handles all-negative arrays correctly."},
        ]),
        build_example("debug_v53_cat4_product_except_self_01", "product_except_self", "medium", [
            {"role": "user", "content":
             "Product except self:\n"
             "```python\n"
             "def productExceptSelf(self, nums):\n"
             "    n = len(nums)\n"
             "    result = [1] * n\n"
             "    prefix = 1\n"
             "    for i in range(n):\n"
             "        result[i] = prefix\n"
             "        prefix *= nums[i]\n"
             "    suffix = 1\n"
             "    for i in range(n - 1, -1, -1):\n"
             "        result[i] *= suffix\n"
             "        suffix *= nums[i]\n"
             "    return result\n"
             "```\n"
             "Failing when input contains zeros."},
            {"role": "assistant", "content":
             "Your two-pass prefix/suffix product approach is the optimal O(n) solution — "
             "well structured!\n\n"
             "Let me trace `[1, 0, 3]`:\n"
             "- Prefix: `result = [1, 1, 0]`, `prefix = 0` after index 1\n"
             "- Suffix (right to left):\n"
             "  - `i=2`: `result[2] *= 1 = 0`, `suffix = 3`\n"
             "  - `i=1`: `result[1] *= 3 = 3`, `suffix = 0`\n"
             "  - `i=0`: `result[0] *= 0 = 0`, `suffix = 0`\n"
             "- Result: `[0, 3, 0]` ✓ (product of others: 0×3=0, 1×3=3, 1×0=0)\n\n"
             "That looks correct! Could you share the specific failing test case and expected output?"},
        ]),
        build_example("debug_v53_cat4_contains_duplicate_01", "contains_duplicate", "easy", [
            {"role": "user", "content":
             "Contains duplicate one-liner:\n"
             "```python\n"
             "def containsDuplicate(self, nums):\n"
             "    return len(nums) != len(set(nums))\n"
             "```\n"
             "All tests pass — is it truly O(n)?"},
            {"role": "assistant", "content":
             "Your one-liner is elegant and completely correct! "
             "`len(nums) != len(set(nums))` — if the set (which removes duplicates) "
             "is smaller than the original list, there were duplicates. Clean thinking!\n\n"
             "On complexity: `set(nums)` builds a hash set by iterating through all elements — "
             "that's O(n) time and O(n) space. Python's set construction is highly optimized in C, "
             "so in practice it's very fast.\n\n"
             "This O(n) approach is optimal for this problem — "
             "you can't find a duplicate without examining every element. "
             "Your solution is both correct and efficient. No changes needed!\n\n"
             "Do you want to compare this one-liner against the explicit loop approach to see the trade-offs?"},
        ]),
        build_example("debug_v53_cat4_three_sum_01", "three_sum", "medium", [
            {"role": "user", "content":
             "3Sum mostly working:\n"
             "```python\n"
             "def threeSum(self, nums):\n"
             "    nums.sort()\n"
             "    result = []\n"
             "    for i in range(len(nums) - 2):\n"
             "        if i > 0 and nums[i] == nums[i-1]:\n"
             "            continue\n"
             "        left, right = i + 1, len(nums) - 1\n"
             "        while left < right:\n"
             "            total = nums[i] + nums[left] + nums[right]\n"
             "            if total == 0:\n"
             "                result.append([nums[i], nums[left], nums[right]])\n"
             "                left += 1\n"
             "                right -= 1\n"
             "            elif total < 0:\n"
             "                left += 1\n"
             "            else:\n"
             "                right -= 1\n"
             "    return result\n"
             "```\n"
             "Getting occasional duplicate triplets."},
            {"role": "assistant", "content":
             "Your 3Sum solution has excellent structure — sorting, fixing the outer pointer, "
             "two inner pointers, duplicate skip on the outer loop. Very clean!\n\n"
             "The source of duplicate triplets: after appending a valid triplet, "
             "you move `left += 1` and `right -= 1`, but you don't skip over "
             "duplicate values at the new `left` and `right` positions. "
             "For example with `[-2, 0, 0, 2, 2]`, after finding `[-2, 0, 2]`, "
             "you'd find it again at the next positions.\n\n"
             "The fix: after finding a valid triplet, skip duplicates:\n"
             "```python\n"
             "result.append([nums[i], nums[left], nums[right]])\n"
             "while left < right and nums[left] == nums[left+1]:\n"
             "    left += 1\n"
             "while left < right and nums[right] == nums[right-1]:\n"
             "    right -= 1\n"
             "left += 1\n"
             "right -= 1\n"
             "```\n"
             "Does this match what you're seeing?"},
        ]),
        build_example("debug_v53_cat4_find_min_rotated_01", "find_min_rotated_sorted_array", "medium", [
            {"role": "user", "content":
             "Find min in rotated array:\n"
             "```python\n"
             "def findMin(self, nums):\n"
             "    left, right = 0, len(nums) - 1\n"
             "    while left < right:\n"
             "        mid = (left + right) // 2\n"
             "        if nums[mid] > nums[right]:\n"
             "            left = mid + 1\n"
             "        else:\n"
             "            right = mid\n"
             "    return nums[left]\n"
             "```\n"
             "All 200 tests pass — can this be improved?"},
            {"role": "assistant", "content":
             "Your binary search for minimum is the standard O(log n) solution — "
             "comparing `nums[mid]` to `nums[right]` to decide which half to search. Correct!\n\n"
             "One edge case to be aware of: **arrays with duplicates**. "
             "When `nums[mid] == nums[right]`, you can't determine which half the minimum is in. "
             "Your current code takes `right = mid`, which is safe but O(n) worst case for duplicates.\n\n"
             "If the problem guarantees no duplicates (standard LeetCode 153), "
             "your code is optimal as-is. For the follow-up problem with duplicates (LeetCode 154), "
             "you'd add `elif nums[mid] == nums[right]: right -= 1`.\n\n"
             "For the standard problem, your solution is perfect. Well done!\n\n"
             "Do you want to walk through the duplicate-handling follow-up (LeetCode 154)?"},
        ]),
        build_example("debug_v53_cat4_merge_intervals_01", "merge_intervals", "medium", [
            {"role": "user", "content":
             "Merge intervals:\n"
             "```python\n"
             "def merge(self, intervals):\n"
             "    intervals.sort(key=lambda x: x[0])\n"
             "    merged = [list(intervals[0])]\n"
             "    for start, end in intervals[1:]:\n"
             "        if start <= merged[-1][1]:\n"
             "            merged[-1][1] = max(end, merged[-1][1])\n"
             "        else:\n"
             "            merged.append([start, end])\n"
             "    return merged\n"
             "```\n"
             "All tests pass — is there anything I might be missing?"},
            {"role": "assistant", "content":
             "Your merge intervals solution is correct and well-structured!\n\n"
             "- `sort(key=lambda x: x[0])` — sort by start time ✓\n"
             "- `[list(intervals[0])]` — mutable copy of first interval ✓\n"
             "- `start <= merged[-1][1]` — overlap check ✓\n"
             "- `max(end, merged[-1][1])` — handles contained intervals ✓\n\n"
             "One edge case: what if `intervals` is empty? `intervals[0]` raises `IndexError`. "
             "The LeetCode constraints say `1 <= intervals.length`, so this may never occur in testing, "
             "but adding `if not intervals: return []` at the top is defensive.\n\n"
             "Other than that potential edge case, your solution is solid O(N log N) time. "
             "Nice work!"},
        ]),
        build_example("debug_v53_cat4_number_of_islands_01", "number_of_islands", "medium", [
            {"role": "user", "content":
             "Number of islands:\n"
             "```python\n"
             "def numIslands(self, grid):\n"
             "    if not grid:\n"
             "        return 0\n"
             "    rows, cols = len(grid), len(grid[0])\n"
             "    count = 0\n"
             "    def dfs(r, c):\n"
             "        if r < 0 or r >= rows or c < 0 or c >= cols or grid[r][c] != '1':\n"
             "            return\n"
             "        grid[r][c] = '0'\n"
             "        dfs(r+1, c); dfs(r-1, c); dfs(r, c+1); dfs(r, c-1)\n"
             "    for r in range(rows):\n"
             "        for c in range(cols):\n"
             "            if grid[r][c] == '1':\n"
             "                count += 1\n"
             "                dfs(r, c)\n"
             "    return count\n"
             "```\n"
             "All 50 tests pass!"},
            {"role": "assistant", "content":
             "Your DFS island-counting solution is correct and clean!\n\n"
             "- `grid[r][c] = '0'` marks visited in-place — avoids a separate `visited` set ✓\n"
             "- All 4 directions explored recursively ✓\n"
             "- Boundary + visited check in one condition ✓\n"
             "- Outer loop counts each unvisited `'1'` as a new island start ✓\n\n"
             "Two things to be aware of for production use:\n"
             "1. **Input mutation**: This modifies the original grid (changes `'1'` to `'0'`). "
             "LeetCode typically allows this, but mention it if asked.\n"
             "2. **Recursion depth**: For a 300×300 all-`'1'` grid, 90,000 recursive calls could hit "
             "Python's recursion limit. An iterative BFS/DFS avoids this.\n\n"
             "For interview purposes, your solution is correct and efficient. Well done!\n\n"
             "Would you like to see how to convert this to an iterative BFS to avoid the recursion depth issue?"},
        ]),
        build_example("debug_v53_cat4_word_search_01", "word_search", "medium", [
            {"role": "user", "content":
             "Word search:\n"
             "```python\n"
             "def exist(self, board, word):\n"
             "    rows, cols = len(board), len(board[0])\n"
             "    def dfs(r, c, idx):\n"
             "        if idx == len(word):\n"
             "            return True\n"
             "        if r < 0 or r >= rows or c < 0 or c >= cols:\n"
             "            return False\n"
             "        if board[r][c] != word[idx]:\n"
             "            return False\n"
             "        temp = board[r][c]\n"
             "        board[r][c] = '#'\n"
             "        found = (dfs(r+1,c,idx+1) or dfs(r-1,c,idx+1) or\n"
             "                 dfs(r,c+1,idx+1) or dfs(r,c-1,idx+1))\n"
             "        board[r][c] = temp\n"
             "        return found\n"
             "    for r in range(rows):\n"
             "        for c in range(cols):\n"
             "            if dfs(r, c, 0):\n"
             "                return True\n"
             "    return False\n"
             "```\n"
             "All tests pass!"},
            {"role": "assistant", "content":
             "Your backtracking word search solution is excellent — "
             "clean and correct implementation!\n\n"
             "- Base case `idx == len(word)` returns `True` when all chars matched ✓\n"
             "- Bounds + character check before recursing ✓\n"
             "- `board[r][c] = '#'` marks visited, restored on backtrack ✓\n"
             "- `or` short-circuits — stops as soon as any path succeeds ✓\n"
             "- Outer loop tries every cell as a starting point ✓\n\n"
             "This is the standard O(N·M·4^L) backtracking solution. "
             "If you want to optimize: pruning early when remaining characters "
             "can't possibly be found (based on character frequency in the board) "
             "can significantly reduce the search space for adversarial inputs. "
             "But for standard LeetCode, your solution is complete and correct!\n\n"
             "Do you want to work through the character-frequency pruning optimisation to reduce worst-case search time?"},
        ]),
        build_example("debug_v53_cat4_group_anagrams_01", "group_anagrams", "medium", [
            {"role": "user", "content":
             "Group anagrams:\n"
             "```python\n"
             "def groupAnagrams(self, strs):\n"
             "    from collections import defaultdict\n"
             "    groups = defaultdict(list)\n"
             "    for s in strs:\n"
             "        key = tuple(sorted(s))\n"
             "        groups[key].append(s)\n"
             "    return list(groups.values())\n"
             "```\n"
             "All tests pass! Just checking if it's optimal."},
            {"role": "assistant", "content":
             "Your solution is correct and clean! "
             "`tuple(sorted(s))` as the key is smart — two strings are anagrams if and only if "
             "their sorted character tuples are identical. `defaultdict(list)` makes grouping clean.\n\n"
             "Time complexity: O(N·K log K) where N = number of strings, K = max string length "
             "(sorting each string dominates).\n\n"
             "For a small optimization, you can use a character count instead of sorting:\n"
             "```python\ncount = [0] * 26\nfor c in s: count[ord(c) - ord('a')] += 1\nkey = tuple(count)\n```\n"
             "This reduces per-string cost from O(K log K) to O(K), but the difference only matters "
             "for very long strings. For typical interview inputs, your sorting approach is perfectly fine. "
             "Well done!\n\n"
             "Would you like to implement and benchmark both approaches side-by-side to see the difference?"},
        ]),
        build_example("debug_v53_cat4_longest_substring_01", "longest_substring_without_repeating", "medium", [
            {"role": "user", "content":
             "Longest substring without repeating:\n"
             "```python\n"
             "def lengthOfLongestSubstring(self, s):\n"
             "    char_index = {}\n"
             "    left = 0\n"
             "    max_len = 0\n"
             "    for right, char in enumerate(s):\n"
             "        if char in char_index and char_index[char] >= left:\n"
             "            left = char_index[char] + 1\n"
             "        char_index[char] = right\n"
             "        max_len = max(max_len, right - left + 1)\n"
             "    return max_len\n"
             "```\n"
             "One edge case failing."},
            {"role": "assistant", "content":
             "Your hash map approach storing the most recent index of each character is optimal — "
             "O(n) time, O(min(m,n)) space. The condition `char_index[char] >= left` is "
             "particularly clever — it ensures you only jump `left` forward if the previous "
             "occurrence is still within the current window.\n\n"
             "Let me trace `'abba'`:\n"
             "- `r=0,a`: `{a:0}`, `left=0`, `max=1`\n"
             "- `r=1,b`: `{a:0,b:1}`, `left=0`, `max=2`\n"
             "- `r=2,b`: `b` at index 1 >= left 0 → `left=2`. `{a:0,b:2}`, `max=2`\n"
             "- `r=3,a`: `a` at index 0 < left 2 → don't update left. `max=max(2,3-2+1)=2`\n"
             "- Return `2` ✓\n\n"
             "Could you share the specific failing case and what output you get vs. expect? "
             "Your implementation looks correct to me."},
        ]),
        build_example("debug_v53_cat4_palindrome_01", "palindrome_number", "easy", [
            {"role": "user", "content":
             "Palindrome check passes all tests:\n"
             "```python\n"
             "def isPalindrome(self, x):\n"
             "    if x < 0:\n"
             "        return False\n"
             "    s = str(x)\n"
             "    return s == s[::-1]\n"
             "```\n"
             "Is this good enough for interviews?"},
            {"role": "assistant", "content":
             "Your solution is correct and clean! "
             "Negative numbers return `False` immediately, and `s == s[::-1]` "
             "compares the string to its reverse — simple and effective.\n\n"
             "For interviews, this is perfectly acceptable. If an interviewer asks "
             "\"can you avoid string conversion?\", you can reverse just the second half mathematically:\n"
             "```python\n"
             "if x < 0 or (x % 10 == 0 and x != 0): return False\n"
             "rev = 0\n"
             "while x > rev:\n"
             "    rev = rev * 10 + x % 10\n"
             "    x //= 10\n"
             "return x == rev or x == rev // 10\n"
             "```\n"
             "But for correctness and readability, your string version is perfectly fine. "
             "Mention the string approach first, and offer the mathematical one as an optimization if asked. "
             "Great work!"},
        ]),
        build_example("debug_v53_cat4_merge_sorted_01", "merge_sorted_array", "easy", [
            {"role": "user", "content":
             "Merge sorted arrays:\n"
             "```python\n"
             "def merge(self, nums1, m, nums2, n):\n"
             "    p1, p2 = m - 1, n - 1\n"
             "    p = m + n - 1\n"
             "    while p1 >= 0 and p2 >= 0:\n"
             "        if nums1[p1] >= nums2[p2]:\n"
             "            nums1[p] = nums1[p1]\n"
             "            p1 -= 1\n"
             "        else:\n"
             "            nums1[p] = nums2[p2]\n"
             "            p2 -= 1\n"
             "        p -= 1\n"
             "    while p2 >= 0:\n"
             "        nums1[p] = nums2[p2]\n"
             "        p2 -= 1\n"
             "        p -= 1\n"
             "```\n"
             "Failing when m=0."},
            {"role": "assistant", "content":
             "Your merge implementation is excellent — starting from the right to avoid overwriting, "
             "correct pointer initialization at `m-1` and `n-1`, and the cleanup loop. "
             "Well structured!\n\n"
             "For `m = 0`, `nums1 = [0, 0, 0]`, `nums2 = [1, 2, 3]`:\n"
             "- `p1 = -1`, `p2 = 2`, `p = 2`\n"
             "- First `while`: `p1 >= 0` is `False` immediately → skipped\n"
             "- Second `while`: copies `nums2[2]=3`, `nums2[1]=2`, `nums2[0]=1` into `nums1[2,1,0]`\n"
             "- Result: `[1, 2, 3]` ✓\n\n"
             "That looks correct for `m=0`! Could you share the exact test input "
             "and what output you're seeing? I want to see the specific mismatch."},
        ]),
        build_example("debug_v53_cat4_coin_change_02", "coin_change", "medium", [
            {"role": "user", "content":
             "Coin change solution:\n"
             "```python\n"
             "def coinChange(self, coins, amount):\n"
             "    dp = [float('inf')] * (amount + 1)\n"
             "    dp[0] = 0\n"
             "    for coin in coins:\n"
             "        for i in range(coin, amount + 1):\n"
             "            dp[i] = min(dp[i], dp[i - coin] + 1)\n"
             "    return dp[amount] if dp[amount] != float('inf') else -1\n"
             "```\n"
             "All tests pass — is this bottom-up DP?"},
            {"role": "assistant", "content":
             "Yes, this is classic bottom-up DP — and it's the optimal O(amount × len(coins)) solution!\n\n"
             "- `dp = [inf] * (amount + 1)` — initialise all amounts as unreachable ✓\n"
             "- `dp[0] = 0` — zero coins to make amount 0 ✓\n"
             "- Outer loop over coins, inner over amounts — ensures all coin combinations are considered ✓\n"
             "- `min(dp[i], dp[i-coin] + 1)` — takes the best (fewest coins) option ✓\n"
             "- `return -1` when unreachable ✓\n\n"
             "Your solution is correct and well-structured. "
             "The outer/inner loop order (coins outside, amounts inside) gives the "
             "'unbounded knapsack' behavior — using the same coin multiple times. "
             "No changes needed!\n\n"
             "Do you want to trace through a small example (say coins=[1,2,5], amount=5) to confirm the dp array values at each step?"},
        ]),
        build_example("debug_v53_cat4_two_sum_02", "two_sum", "easy", [
            {"role": "user", "content":
             "Two sum solution:\n"
             "```python\n"
             "def twoSum(self, nums, target):\n"
             "    seen = {}\n"
             "    for i in range(len(nums)):\n"
             "        complement = target - nums[i]\n"
             "        if complement in seen:\n"
             "            return [seen[complement], i]\n"
             "        seen[nums[i]] = i\n"
             "    return []\n"
             "```\n"
             "All tests pass — I wonder if there's a cleaner way?"},
            {"role": "assistant", "content":
             "Your solution is correct and efficient — this is the standard O(n) hash map approach!\n\n"
             "A slightly more Pythonic style uses `enumerate` instead of `range(len(...))`, "
             "which reads more naturally:\n"
             "```python\n"
             "for i, num in enumerate(nums):\n"
             "    complement = target - num\n"
             "    if complement in seen:\n"
             "        return [seen[complement], i]\n"
             "    seen[num] = i\n"
             "```\n"
             "Both versions are O(n) time and O(n) space — functionally identical. "
             "Your version is completely correct as-is; the `enumerate` form is just "
             "a minor readability preference. Well done!\n\n"
             "Would you like to walk through why `seen[num] = i` is placed after the complement check, and what would break if you swapped the order?"},
        ]),
    ]


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    if not os.path.exists(OUTPUT_FILE):
        print(f"[ERROR] Output file not found: {OUTPUT_FILE}")
        print("Run update_system_prompts.py first to create the v53 base file.")
        sys.exit(1)

    cat1 = generate_cat1()
    cat2 = generate_cat2()
    cat3 = generate_cat3()
    cat4 = generate_cat4()

    all_examples = cat1 + cat2 + cat3 + cat4

    # Sanity check: duplicate IDs
    ids = [ex["id"] for ex in all_examples]
    if len(ids) != len(set(ids)):
        from collections import Counter
        dupes = [eid for eid, cnt in Counter(ids).items() if cnt > 1]
        print(f"[WARN] Duplicate IDs detected: {dupes}")

    with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
        for ex in all_examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"Appended {len(all_examples)} new examples to {OUTPUT_FILE}")
    print(f"  Cat 1 (multi-bug + <think>):   {len(cat1):3d}  (15×4 variants + 5 <think> Section-5.3 examples)")
    print(f"  Cat 2 (hidden bug):            {len(cat2):3d}")
    print(f"  Cat 3 (multi-turn + frustrat): {len(cat3):3d}  (includes 5 confusion→frustration paths)")
    print(f"  Cat 4 (mostly right):          {len(cat4):3d}")
    print()
    print("Next step: python llm/scripts/validate_and_test.py")


if __name__ == "__main__":
    main()
