"""Loss scaling under gradient accumulation, with unequal microbatches.

The interview point: accumulating k microbatches and dividing by k reproduces a large-batch step
ONLY when the microbatches are the same size. With a ragged last microbatch — which is every real
dataloader — dividing by k weights the short batch's examples more heavily than the others.

This is the failure that makes accumulated training subtly disagree with large-batch training while
every loss curve looks normal.
"""

SLUG = "grad-accum-ragged-batch"
TITLE = "Make accumulation match the large batch when the last microbatch is short"
DIFFICULTY = "medium"
CATEGORIES = ["DL"]
CONCEPTS = ["gradient_accumulation", "loss_functions"]

DESCRIPTION = (
    "You are accumulating gradients over k microbatches to simulate one large batch. Each "
    "microbatch reports its MEAN per-example gradient and how many examples it held.\n\n"
    "Return the accumulated gradient that exactly equals what a single batch over all the examples "
    "would have produced, rounded to 6 decimal places.\n\n"
    "The trap: summing the microbatch means and dividing by k is correct only when every "
    "microbatch is the same size. Real dataloaders produce a short final microbatch, and dividing "
    "by k then over-weights the examples in it — a 2-example tail counts as much as a 32-example "
    "microbatch. Nothing crashes; accumulated training just quietly stops matching the large-batch "
    "run it is supposed to reproduce."
)

TEMPLATE = '''class Solution(object):
    def accumulate(self, means, counts):
        """
        :type means: List[float]   per-microbatch MEAN gradient
        :type counts: List[int]    examples in each microbatch
        :rtype: float              gradient equal to a single batch over every example
        """
'''

DRIVER = '''import sys
_tok = sys.stdin.read().split()
_k = int(_tok[0])
_means = [float(x) for x in _tok[1:1 + _k]]
_counts = [int(x) for x in _tok[1 + _k:1 + 2 * _k]]
print(Solution().accumulate(_means, _counts))
'''

REFERENCE = '''class Solution(object):
    def accumulate(self, means, counts):
        # Weight each microbatch by the examples it actually held. Summing means and dividing by k
        # is the same thing ONLY when every count is equal, which is the case that hides the bug.
        total = 0.0
        for mean, count in zip(means, counts):
            total += mean * count
        return round(total / sum(counts), 6)
'''

CASES = [
    # Equal microbatches: the naive average is right here, so this case alone proves nothing.
    ("Case 1", "2\n0.4 0.6\n8 8\n", False),
    # Ragged tail. Weighted: (0.4*8 + 1.0*2)/10 = 0.52. Naive mean of means: 0.7.
    ("Case 2", "2\n0.4 1.0\n8 2\n", False),
    # Single microbatch — accumulation must be a no-op, not a division by k.
    ("Hidden 1", "1\n0.35\n16\n", True),
    # Three microbatches, one of them tiny and extreme.
    ("Hidden 2", "3\n0.1 0.2 3.0\n32 32 1\n", True),
]

# Computed from the definition of a mean over all examples, not from the reference.
CHECKS = [
    ("Case 1", "0.5"),          # (0.4*8 + 0.6*8) / 16
    ("Case 2", "0.52"),         # (0.4*8 + 1.0*2) / 10   — the naive answer would be 0.7
    ("Hidden 1", "0.35"),       # one microbatch changes nothing
]

MUTANTS = {
    "divides by the microbatch count": '''class Solution(object):
    def accumulate(self, means, counts):
        return round(sum(means) / len(means), 6)
''',
    "sums the means without normalising": '''class Solution(object):
    def accumulate(self, means, counts):
        return round(sum(means), 6)
''',
    # Weights correctly but normalises by k instead of the example total.
    "weights but divides by k": '''class Solution(object):
    def accumulate(self, means, counts):
        total = 0.0
        for mean, count in zip(means, counts):
            total += mean * count
        return round(total / len(counts), 6)
''',
    # Uses the first microbatch's size for every microbatch — right until the tail is short.
    "assumes every microbatch is the first one's size": '''class Solution(object):
    def accumulate(self, means, counts):
        size = counts[0]
        total = 0.0
        for mean in means:
            total += mean * size
        return round(total / (size * len(means)), 6)
''',
}

HINTS = [
    "Write down what a single batch over all the examples computes: the sum of every per-example "
    "gradient, divided by the number of examples.",
    "A microbatch's mean times its count recovers its SUM. That is the quantity that is safe to "
    "add across microbatches; means are not.",
    "Test yourself with counts [8, 2]. If dividing by 2 gives you the same answer as dividing by "
    "10 examples, your microbatches were equal-sized and the case was not testing anything.",
]
