"""Build llm/data/eval_debug_gold_extended.jsonl. Run from the repo root.

WHY AN EXTENDED FILE RATHER THAN EDITING THE 33
--------------------------------------------------
`eval_baseline_before_v53.json` records 11/33 against the EXISTING scenarios. Adding medium and hard
cases to that file changes the denominator, and every future comparison against 11/33 would be
comparing two different populations while looking like a like-for-like improvement. That is this
project's signature failure. So the 33 are frozen and the new scenarios live beside them, tagged
`baseline_set: false`, and `run_evals.py` reports the frozen subset as its own bucket.

LINE NUMBERS ARE COMPUTED, NEVER TYPED
-----------------------------------------
Every ground-truth line is located by searching the source for a unique anchor string. A hand-typed
line number is exactly the plausible-wrong value this repo keeps producing, and a gold set with a
wrong line silently marks a CORRECT tutor answer as a miss -- the metric would then get worse as the
tutor got better.
"""
import json
import pathlib


def at(src: str, anchor: str) -> int:
    """1-indexed line containing `anchor`. Raises if absent or ambiguous."""
    lines = src.split("\n")
    hits = [i + 1 for i, line in enumerate(lines) if anchor in line]
    if len(hits) != 1:
        raise ValueError(f"anchor {anchor!r} matched {len(hits)} lines, need exactly 1")
    return hits[0]


SCENARIOS: list[dict] = []


def add(id_, difficulty, problem, scenario_type, source, bugs, user_message, notes,
        positive_framing=False):
    """`bugs` is [(anchor, type, description)] -- the line is resolved from the anchor."""
    ground = [{"line": at(source, anchor), "type": t, "description": d}
              for anchor, t, d in bugs]
    lines = sorted(b["line"] for b in ground)
    assert len(set(lines)) == len(lines), f"{id_}: two bugs resolved to the same line"
    SCENARIOS.append({
        "id": id_, "scenario_type": scenario_type, "problem": problem,
        "difficulty": difficulty, "user_message": user_message, "source_code": source,
        "ground_truth_bugs": ground, "expected_bug_count": len(ground),
        "positive_framing_expected": positive_framing, "notes": notes,
        "baseline_set": False,
    })


# ─────────────────────────── MEDIUM ───────────────────────────

add("eval_ext_mutable_default_001", "medium", "accumulate", "single_logic",
    '''def collect(item, bucket=[]):
    bucket.append(item)
    return bucket


def group_all(items):
    out = []
    for item in items:
        out.append(collect(item))
    return out''',
    [("def collect(item, bucket=[]):", "logic",
      "Mutable default argument: the list is created once at definition time and shared across "
      "every call, so results accumulate between calls")],
    "This works the first time I call it but the output keeps growing on later calls. Why?",
    "Classic mutable-default. The bug is on the def line, not at the append.")

add("eval_ext_integer_division_002", "medium", "binary_search", "single_logic",
    '''def search(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = (lo + hi) / 2
        if nums[mid] == target:
            return mid
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1''',
    [("mid = (lo + hi) / 2", "type",
      "True division produces a float, so nums[mid] raises TypeError; needs // for an index")],
    "TypeError: list indices must be integers or slices, not float. I don't see where a float comes from.",
    "Single-line type bug with an explicit traceback in the message.")

add("eval_ext_mutate_while_iterating_003", "medium", "filter_evens", "single_logic",
    '''def drop_evens(nums):
    for n in nums:
        if n % 2 == 0:
            nums.remove(n)
    return nums''',
    [("for n in nums:", "logic",
      "Mutating the list being iterated causes the iterator to skip elements; iterate over a copy "
      "or build a new list")],
    "What's wrong here? drop_evens([2, 4, 6]) gives me [4] instead of []. Some of them "
    "survive and I can't work out which.",
    "The visible symptom points at remove(), but the defect is the iteration target.")

add("eval_ext_shallow_grid_004", "medium", "build_grid", "single_logic",
    '''def make_grid(rows, cols):
    grid = [[0] * cols] * rows
    return grid


def set_cell(grid, r, c, value):
    grid[r][c] = value
    return grid''',
    [("grid = [[0] * cols] * rows", "logic",
      "List multiplication copies the reference, so every row is the same object and writing one "
      "cell writes the whole column")],
    "Setting one cell changes a value in every row. I only assigned to grid[r][c] once.",
    "Aliasing, not an indexing error. A tutor citing set_cell has the wrong line.")

add("eval_ext_float_equality_005", "medium", "converged", "single_logic",
    '''def has_converged(previous, current):
    return previous == current


def train(steps):
    loss = 1.0
    for _ in range(steps):
        new_loss = loss * 0.9
        if has_converged(loss, new_loss):
            break
        loss = new_loss
    return loss''',
    [("return previous == current", "logic",
      "Exact float equality almost never holds after arithmetic; needs a tolerance such as "
      "abs(a - b) < eps")],
    "Can you help me debug this? My training loop never breaks early, even when the loss "
    "stops moving in the printout.",
    "The reported symptom is in train(), the defect is in the helper.")

add("eval_ext_skips_first_006", "medium", "running_max", "single_logic",
    '''def running_max(nums):
    best = nums[0]
    out = []
    for i in range(1, len(nums)):
        best = max(best, nums[i])
        out.append(best)
    return out''',
    [("for i in range(1, len(nums)):", "logic",
      "Starting at index 1 emits one fewer element than the input; the first position is never "
      "appended, so len(out) == len(nums) - 1")],
    "My function returns the wrong length -- the output list is always one shorter than the "
    "input and I can't see where an element goes missing.",
    "Off-by-one in the range start, not in the append.")

add("eval_ext_is_vs_equals_007", "medium", "count_target", "single_logic",
    '''def count_matches(values, target):
    total = 0
    for v in values:
        if v is target:
            total += 1
    return total''',
    [("if v is target:", "logic",
      "Identity comparison rather than equality; works for small cached ints and fails for larger "
      "values or freshly constructed objects")],
    "This is doing something wrong: it counts correctly for small numbers but returns 0 "
    "when the values get bigger. Same code.",
    "The intermittent behaviour is the tell. A tutor that says 'works fine' has missed it.")

add("eval_ext_early_return_008", "medium", "all_positive", "single_logic",
    '''def all_positive(nums):
    for n in nums:
        if n > 0:
            return True
        else:
            return False''',
    [("return True", "logic",
      "Returning inside the loop on the first element decides the answer from nums[0] alone; the "
      "True return must move after the loop and the condition inverted")],
    "Please help me fix this bug: all_positive([1, -5, 3]) returns True, and it's clearly "
    "not all positive.",
    "Two returns, but only the early True is the defect -- the False is correctly placed logic that "
    "belongs in the loop. A tutor flagging both lines over-reports.")

add("eval_ext_dict_mutation_009", "medium", "dedupe_counts", "single_logic",
    '''def prune(counts, threshold):
    for key in counts:
        if counts[key] < threshold:
            del counts[key]
    return counts''',
    [("for key in counts:", "logic",
      "Deleting from a dict during iteration raises RuntimeError: dictionary changed size during "
      "iteration; iterate over list(counts) instead")],
    "RuntimeError: dictionary changed size during iteration. But I'm only deleting one key at a time.",
    "Same family as the list case but a hard error rather than silent skipping.")

add("eval_ext_swapped_bounds_010", "medium", "clamp", "single_logic",
    '''def clamp(value, low, high):
    if value < high:
        return high
    if value > low:
        return low
    return value''',
    [("if value < high:", "logic",
      "Bound comparisons are swapped: values below the range should be raised to `low`, not `high`"),
     ("if value > low:", "logic",
      "Bound comparisons are swapped: values above the range should be lowered to `high`, not `low`")],
    "What's wrong with my code? clamp(5, 0, 10) gives me 10 and clamp(-3, 0, 10) gives me "
    "10 as well -- everything comes out 10.",
    "Two coupled bugs. Fixing only one leaves the function wrong, so a tutor reporting one line "
    "has not solved it.")

# ─────────────────────────── HARD ───────────────────────────

add("eval_ext_infinite_binary_search_011", "hard", "binary_search", "single_logic",
    '''def search(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if nums[mid] == target:
            return mid
        if nums[mid] < target:
            lo = mid
        else:
            hi = mid - 1
    return -1''',
    [("lo = mid", "logic",
      "Assigning lo = mid without +1 means lo never advances when hi == lo + 1, so the loop spins "
      "forever on a two-element window"),
     ("while lo < hi:", "logic",
      "Strict < skips the final single-element window, so a target at the last remaining index is "
      "reported missing even after the loop is fixed")],
    "There is a bug somewhere: it hangs on some inputs and returns -1 on others where the "
    "value is definitely in the list.",
    "Two independent defects producing two different symptoms. The hang is the loud one; the "
    "boundary miss survives fixing it and is the one most answers drop.")

add("eval_ext_visited_after_recursion_012", "hard", "graph_dfs", "single_logic",
    '''def count_component(graph, start):
    visited = set()

    def walk(node):
        for neighbour in graph[node]:
            if neighbour not in visited:
                walk(neighbour)
        visited.add(node)

    walk(start)
    return len(visited)''',
    [("visited.add(node)", "logic",
      "The node is marked visited only after its neighbours are explored, so a cycle re-enters it "
      "and recurses until RecursionError; the mark must happen on entry")],
    "RecursionError on any graph with a cycle. Trees are fine.",
    "The mark is present, just in the wrong place -- so 'you forgot to track visited' is a wrong "
    "diagnosis that sounds right.")

add("eval_ext_sliding_window_013", "hard", "min_subarray", "multi_logic",
    '''def shortest_at_least(nums, target):
    left = 0
    total = 0
    best = len(nums) + 1
    for right in range(len(nums)):
        total += nums[right]
        while total >= target:
            best = min(best, right - left)
            left += 1
    return best if best <= len(nums) else 0''',
    [("best = min(best, right - left)", "logic",
      "Window length is right - left + 1; this reports every window one element too short"),
     ("left += 1", "logic",
      "The left element is never subtracted from `total` when the window shrinks, so the running "
      "sum no longer matches the window and the while loop cannot terminate correctly")],
    "My function doesn't work properly -- it returns lengths that are one too small, and on "
    "some inputs it just hangs.",
    "Two bugs in adjacent lines with different symptoms. The off-by-one is visible in output; the "
    "missing subtraction is the cause of the hang.")

add("eval_ext_closure_capture_014", "hard", "build_callbacks", "single_logic",
    '''def make_multipliers(factors):
    out = []
    for f in factors:
        out.append(lambda x: x * f)
    return out


def apply_all(fns, value):
    return [fn(value) for fn in fns]''',
    [("out.append(lambda x: x * f)", "logic",
      "The lambda closes over the variable `f`, not its value, so every function uses the final "
      "loop value; bind with a default argument such as lambda x, f=f: x * f")],
    "Can you help me fix this? All the functions in the list behave identically -- they all "
    "use the last factor, even though I appended them inside the loop.",
    "The append line is right and the loop is right; the capture semantics are the defect.")

add("eval_ext_dp_init_and_order_015", "hard", "coin_change", "multi_logic",
    '''def min_coins(coins, amount):
    dp = [0] * (amount + 1)
    for value in range(1, amount + 1):
        for coin in coins:
            if coin <= value:
                dp[value] = min(dp[value], dp[value - coin] + 1)
    return dp[amount]''',
    [("dp = [0] * (amount + 1)", "logic",
      "Every cell initialised to 0 means min() always selects 0, so the table never fills; all "
      "cells except dp[0] must start at infinity"),
     ("return dp[amount]", "logic",
      "No unreachable-amount case: once initialised to infinity this must return -1 when dp[amount] "
      "is still unreachable rather than returning the sentinel")],
    "Always returns 0 no matter what coins I pass.",
    "The second bug is INVISIBLE until the first is fixed, which is the point of the scenario: an "
    "answer that stops at the initialisation is incomplete but looks complete.")

add("eval_ext_sort_key_and_reverse_016", "hard", "top_k", "multi_logic",
    '''def top_k(records, k):
    def rank(record):
        return record["name"]

    ordered = sorted(records, key=rank, reverse=False)
    return ordered[:k]''',
    [('return record["name"]', "logic",
      "The sort key reads the name field rather than the score, so the result is alphabetical "
      "rather than top-k by value"),
     ("reverse=False", "logic",
      "Ascending order returns the lowest-scoring entries; top-k needs reverse=True")],
    "top_k returns the wrong records. They're sorted, just not the ones I want.",
    "Two independent defects on separate lines. Fixing only the key still returns the bottom k, "
    "so a partial answer produces output that is still wrong in a different way.")

add("eval_ext_empty_input_only_017", "hard", "average", "single_logic",
    '''def average(nums):
    total = 0
    for n in nums:
        total += n
    return total / len(nums)''',
    [("return total / len(nums)", "logic",
      "ZeroDivisionError on an empty list; the only failing case, so 19 of 20 tests pass")],
    "19 of my 20 tests pass. The last one fails and I can't reproduce it by hand.",
    "Deliberately a single easy-to-state bug presented as a hard scenario: the difficulty is that "
    "almost everything passes, so the tutor must reason about the untested edge rather than read "
    "an error. Tests whether high pass rates suppress the diagnosis.")

add("eval_ext_accumulator_reset_018", "hard", "group_runs", "multi_logic",
    '''def run_lengths(items):
    runs = []
    current = []
    for item in items:
        if current and item != current[0]:
            runs.append(current)
        current.append(item)
    return runs''',
    [("runs.append(current)", "logic",
      "`current` is appended by reference and never reset, so every stored run is the same list and "
      "keeps growing; append a copy and start a fresh list"),
     ("return runs", "logic",
      "The final run is never appended because the flush only happens on a boundary; the trailing "
      "group is silently dropped")],
    "What's wrong with this? The groups all look the same in the output, and the last group "
    "is missing entirely.",
    "Aliasing plus a missing flush. Two symptoms in one message, and the missing-final-group bug "
    "is the one that survives a partial fix.")


def main() -> int:
    out = pathlib.Path("llm/data/eval_debug_gold_extended.jsonl")
    existing = {json.loads(line)["id"]
                for line in pathlib.Path("llm/data/eval_debug_gold.jsonl")
                .read_text(encoding="utf-8").splitlines() if line.strip()}
    ids = [s["id"] for s in SCENARIOS]
    assert len(set(ids)) == len(ids), "duplicate id within the extended set"
    clash = set(ids) & existing
    assert not clash, f"id collides with the frozen set: {clash}"

    out.write_text("\n".join(json.dumps(s, ensure_ascii=False) for s in SCENARIOS) + "\n",
                   encoding="utf-8")
    by_diff: dict[str, int] = {}
    for s in SCENARIOS:
        by_diff[s["difficulty"]] = by_diff.get(s["difficulty"], 0) + 1
    print(f"wrote {len(SCENARIOS)} scenarios to {out}: {by_diff}")
    print(f"multi-bug scenarios: {sum(1 for s in SCENARIOS if s['expected_bug_count'] > 1)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
