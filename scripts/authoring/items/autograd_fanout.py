"""Reverse-mode autodiff where one node feeds two consumers.

The interview point: a value used more than once accumulates gradient from every consumer. Getting
this wrong does not crash and does not look wrong — it silently halves a gradient, the model still
trains, just worse. It is the most common hand-rolled-backprop bug there is.
"""

SLUG = "autograd-fanout-accumulation"
TITLE = "Backpropagate through a node used twice"
DIFFICULTY = "medium"
CATEGORIES = ["DL"]
CONCEPTS = ["autograd", "backpropagation"]

DESCRIPTION = (
    "You are given a small computation graph as a list of nodes in topological order. Each node is "
    "either an input or an operation over earlier nodes. Return the gradient of the final node "
    "with respect to every input, in node order, each rounded to 4 decimal places.\n\n"
    "Supported ops: add(a, b), mul(a, b), square(a).\n\n"
    "The whole problem is what happens when a node feeds more than one consumer. Its gradient is "
    "the SUM of the contributions from every consumer — not the last one written, and not the "
    "first. A graph where nothing branches passes with the bug present, which is exactly why this "
    "survives in real code: it does not crash, it silently halves a gradient and the model trains "
    "slightly worse."
)

TEMPLATE = '''class Solution(object):
    def grads(self, nodes, values):
        """
        :type nodes: List[List]      e.g. ["input"] or ["mul", 0, 2]
        :type values: List[float]    value of each input node, 0.0 for non-inputs
        :rtype: List[float]          d(last node)/d(input), per input node, in node order
        """
'''

DRIVER = '''import sys
_tok = sys.stdin.read().split()
_i = 0
_n = int(_tok[_i]); _i += 1
_nodes = []
for _ in range(_n):
    _op = _tok[_i]; _i += 1
    if _op == "input":
        _nodes.append(["input"])
    elif _op == "square":
        _nodes.append(["square", int(_tok[_i])]); _i += 1
    else:
        _nodes.append([_op, int(_tok[_i]), int(_tok[_i + 1])]); _i += 2
_values = [float(_tok[_i + _k]) for _k in range(_n)]
print(" ".join(str(_g) for _g in Solution().grads(_nodes, _values)))
'''

_FORWARD = '''class Solution(object):
    def grads(self, nodes, values):
        n = len(nodes)
        out = list(values)
        for i, node in enumerate(nodes):
            op = node[0]
            if op == "add":
                out[i] = out[node[1]] + out[node[2]]
            elif op == "mul":
                out[i] = out[node[1]] * out[node[2]]
            elif op == "square":
                out[i] = out[node[1]] ** 2
        grad = [0.0] * n
        grad[n - 1] = 1.0
'''

_RETURN = '''
        return [round(grad[i], 4) for i, node in enumerate(nodes) if node[0] == "input"]
'''

REFERENCE = _FORWARD + '''        # Reverse topological order. Every consumer ADDS into its inputs, so a node feeding two
        # consumers ends up with the sum — the whole point of the problem.
        for i in range(n - 1, -1, -1):
            g = grad[i]
            if g == 0.0:
                continue
            op = nodes[i][0]
            if op == "add":
                grad[nodes[i][1]] += g
                grad[nodes[i][2]] += g
            elif op == "mul":
                a, b = nodes[i][1], nodes[i][2]
                grad[a] += g * out[b]
                grad[b] += g * out[a]
            elif op == "square":
                grad[nodes[i][1]] += g * 2.0 * out[nodes[i][1]]
''' + _RETURN

# Format: n, then n node descriptors, then n values (0 for non-inputs).
CASES = [
    # y = x0 * x1. Nothing branches: dy/dx0 = x1 = 4, dy/dx1 = x0 = 3.
    ("Case 1", "3 input input mul 0 1 3.0 4.0 0.0\n", False),
    # y = x0 + x0 — node 0 feeds BOTH operands of the add. dy/dx0 = 2, not 1.
    ("Case 2", "2 input add 0 0 5.0 0.0\n", False),
    # Node 2 consumed twice by the add.
    ("Hidden 1", "4 input input mul 0 1 add 2 2 2.0 3.0 0.0 0.0\n", True),
    # y = square(x0) * x0 = x0^3, so x0 reaches y by two different routes.
    ("Hidden 2", "3 input square 0 mul 1 0 3.0 0.0 0.0\n", True),
]

# Derived from calculus, not from the reference. Without these a self-consistently wrong
# implementation would pass everything else in the harness.
CHECKS = [
    ("Case 1", "4.0 3.0"),      # d(x0*x1) = (x1, x0)
    ("Case 2", "2.0"),          # d(x0 + x0)/dx0 = 2
    ("Hidden 2", "27.0"),       # d(x0^3)/dx0 = 3*x0^2 = 27 at x0 = 3
]

MUTANTS = {
    # The bug the problem exists for: assignment where accumulation is required.
    "overwrites instead of accumulating": _FORWARD + '''        for i in range(n - 1, -1, -1):
            g = grad[i]
            if g == 0.0:
                continue
            op = nodes[i][0]
            if op == "add":
                grad[nodes[i][1]] = g
                grad[nodes[i][2]] = g
            elif op == "mul":
                a, b = nodes[i][1], nodes[i][2]
                grad[a] = g * out[b]
                grad[b] = g * out[a]
            elif op == "square":
                grad[nodes[i][1]] = g * 2.0 * out[nodes[i][1]]
''' + _RETURN,
    # Product rule against its own value rather than the other operand.
    "product rule uses the wrong operand": _FORWARD + '''        for i in range(n - 1, -1, -1):
            g = grad[i]
            if g == 0.0:
                continue
            op = nodes[i][0]
            if op == "add":
                grad[nodes[i][1]] += g
                grad[nodes[i][2]] += g
            elif op == "mul":
                a, b = nodes[i][1], nodes[i][2]
                grad[a] += g * out[a]
                grad[b] += g * out[b]
            elif op == "square":
                grad[nodes[i][1]] += g * 2.0 * out[nodes[i][1]]
''' + _RETURN,
    # Drops the chain-rule factor on square.
    "square forgets the factor of 2x": _FORWARD + '''        for i in range(n - 1, -1, -1):
            g = grad[i]
            if g == 0.0:
                continue
            op = nodes[i][0]
            if op == "add":
                grad[nodes[i][1]] += g
                grad[nodes[i][2]] += g
            elif op == "mul":
                a, b = nodes[i][1], nodes[i][2]
                grad[a] += g * out[b]
                grad[b] += g * out[a]
            elif op == "square":
                grad[nodes[i][1]] += g
''' + _RETURN,
    # Walks the graph forwards, so nothing reaches the inputs.
    "traverses in forward order": _FORWARD + '''        for i in range(n):
            g = grad[i]
            if g == 0.0:
                continue
            op = nodes[i][0]
            if op == "add":
                grad[nodes[i][1]] += g
                grad[nodes[i][2]] += g
            elif op == "mul":
                a, b = nodes[i][1], nodes[i][2]
                grad[a] += g * out[b]
                grad[b] += g * out[a]
            elif op == "square":
                grad[nodes[i][1]] += g * 2.0 * out[nodes[i][1]]
''' + _RETURN,
}

HINTS = [
    "Run the graph forwards first and keep every intermediate value — the product rule needs the "
    "other operand's value, which only exists after the forward pass.",
    "Seed the last node's gradient to 1.0 and walk backwards. Every operation ADDS into its "
    "inputs' gradients; it never assigns.",
    "Check yourself on y = x + x. If you get 1 rather than 2 you are overwriting where you should "
    "accumulate, and no graph without branching will ever show it.",
]
