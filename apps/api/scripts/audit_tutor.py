"""
Empirical audit of the AI tutor.

    python -m scripts.audit_tutor            # run every scenario
    python -m scripts.audit_tutor --only 3   # one scenario, by number

WHY THIS EXISTS

The tutor's failures found so far were found by accident — someone typed
gibberish and noticed it critiqued code that was never written. That is not a
test strategy. This drives the real `/v1/chat/completions` endpoint with the
exact enriched payloads `VoidCodeAIPanel` sends, across scenarios chosen to
provoke specific failure modes, and applies automated checks to each response.

The checks are deliberately mechanical. "Did it mention overflow" is answerable
by string search; "was the advice good" is not, so the transcript is printed for
a human. The point is to catch the failures that are objectively checkable —
hallucinated code, leaked solutions, references to lines that do not exist —
and to make regressions visible rather than anecdotal.

Every scenario records PASS/FAIL per check plus latency, because a tutor that is
correct after 90 seconds is a tutor nobody waits for.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

API = "http://localhost:8000/v1/chat/completions"
TIMEOUT = 300

# ── The payload shapes VoidCodeAIPanel actually sends ───────────────────────
#
# Reproduced from `buildReviewTemplate` and `buildLightPrompt`. If those change,
# this file is wrong and the audit is measuring a prompt nobody sends.


def review_payload(user_msg, problem_desc, language, source, test_details=None,
                   is_template=False):
    lines = source.split("\n")
    numbered = "\n".join(f"{i + 1}| {line}" for i, line in enumerate(lines))
    note = (
        "\n\n! NOTE: The student's code is still the unmodified template - they "
        "have not written any code yet. Do NOT analyze or critique the template. "
        "Do NOT say \"I found N issues.\" Output ONLY the teaching scaffold shown "
        "below."
        if is_template
        else ""
    )
    parts = [
        f"[USER REQUEST]\n{user_msg}{note}",
        f"[PROBLEM DESCRIPTION]\n{problem_desc}",
        # Left as percent formatting deliberately. This builds the PROMPT the audited tutor
        # receives; a %-to-f-string rewrite silently turned the escaped newlines into real
        # ones twice, which still parsed as far as the eye but changed what the model sees.
        "[SOURCE CODE (%s) - %d lines total]\n```%s\n%s\n```\n"  # noqa: UP031
        "! This code has exactly %d lines (1-%d). Do NOT reference any line "
        "beyond Line %d." % (language, len(lines), language.lower(), numbered,
                             len(lines), len(lines), len(lines)),
    ]
    if test_details and not is_template:
        parts.append(f"[TEST CASE DETAILS]\n{test_details}")
    return "\n\n".join(parts)


def light_payload(user_msg, title, difficulty, source=None, general=False):
    parts = [f"[USER REQUEST]\n{user_msg}"]
    if not general:
        parts.append(
            f"[PROBLEM CONTEXT]\nThe student is working on: {title} ({difficulty})"
        )
        if source and source.strip():
            parts.append(f"[CURRENT CODE (Python)]\n```python\n{source}\n```")
    return "\n\n".join(parts)


def ask(content):
    body = json.dumps(
        {"messages": [{"role": "user", "content": content}], "stream": False,
         "max_tokens": 900}
    ).encode()
    req = urllib.request.Request(
        API, data=body, headers={"Content-Type": "application/json"}
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.load(r)
        text = data["choices"][0]["message"]["content"] or ""
        return text, time.time() - start, None
    except urllib.error.HTTPError as e:
        return "", time.time() - start, f"HTTP {e.code}: {e.read()[:200]}"
    except Exception as e:
        return "", time.time() - start, f"{type(e).__name__}: {e}"


# ── Checks ──────────────────────────────────────────────────────────────────


def no_invented_code(response, source):
    """
    The model must not quote code the student did not write.

    Looks for fenced python blocks in the reply and checks each non-trivial line
    appears in the source. This is the failure that produced a critique of a
    `random.shuffle` implementation that never existed.
    """
    invented = []
    for block in re.findall(r"```(?:python|py)?\n(.*?)```", response, re.S):
        for line in block.split("\n"):
            stripped = line.strip()
            if len(stripped) < 12 or stripped.startswith("#"):
                continue
            if stripped.startswith("_") or stripped.startswith("..."):
                continue
            # Blanks in a scaffold are not claims about the student's code.
            if "____" in stripped:
                continue
            if stripped not in source:
                invented.append(stripped)
    return (not invented), invented[:4]


def no_line_beyond(response, source):
    """References to lines past the end of the file."""
    n = len(source.split("\n"))
    bad = [int(m) for m in re.findall(r"[Ll]ine (\d+)", response) if int(m) > n]
    return (not bad), sorted(set(bad))[:5]


def mentions(response, *terms):
    low = response.lower()
    return any(t.lower() in low for t in terms)


def leaks(response, reference):
    """A full working solution handed over unasked."""
    signals = [line.strip() for line in reference.split("\n")
               if len(line.strip()) > 25 and not line.strip().startswith(("#", '"'))]
    hits = [s for s in signals if s in response]
    return len(hits) >= 3, hits[:3]


# ── Fixtures ────────────────────────────────────────────────────────────────

def fixtures():
    ns = {}
    src = open(
        Path(__file__).with_name("interview_problems.py"), encoding="utf-8"
    ).read()
    exec(src, ns)
    return ns["INTERVIEW_PROBLEMS"], ns["INTERVIEW_REFERENCE_SOLUTIONS"]


PROBLEMS, REFERENCES = fixtures()
LOG = PROBLEMS["derive-logistic-gradient"]
LOG_REF = REFERENCES["derive-logistic-gradient"]
LOG_TPL = LOG["code_templates"][0]["template_code"]

# The exact bug the question exists to test: no sign branch.
LOG_OVERFLOW_BUG = """import math

class Solution(object):
    def logistic_grad(self, X, y, w, b, l2):
        n, d = len(X), len(w)
        gw, gb = [0.0]*d, 0.0
        for xi, yi in zip(X, y):
            z = b + sum(w[j]*xi[j] for j in range(d))
            p = 1.0 / (1.0 + math.exp(-z))
            r = p - yi
            for j in range(d):
                gw[j] += r * xi[j]
            gb += r
        return [gw[j]/n + l2*w[j] for j in range(d)] + [gb/n]
"""

# Penalises the bias, which the description explicitly forbids.
LOG_BIAS_BUG = LOG_REF.replace(
    "out.append(gb / n)", "out.append(gb / n + l2 * b)"
)


def scenarios():
    return [
        (
            "1. review with an untouched template",
            review_payload("Can you review my code and tell me what's wrong?",
                           LOG["description"], "Python", LOG_TPL,
                           is_template=True),
            [("no invented code", lambda r: no_invented_code(r, LOG_TPL)),
             ("no phantom line refs", lambda r: no_line_beyond(r, LOG_TPL)),
             ("does not claim tests failed",
              lambda r: (not mentions(r, "tests failed", "0/5", "issues found"), [])),
             ("warns about overflow",
              lambda r: (mentions(r, "overflow", "exp(-z)", "sign", "branch"), []))],
        ),
        (
            "2. review of a CORRECT solution",
            review_payload("Can you review my code?", LOG["description"],
                           "Python", LOG_REF,
                           test_details="All 5 test cases passed."),
            [("no invented code", lambda r: no_invented_code(r, LOG_REF)),
             ("no phantom line refs", lambda r: no_line_beyond(r, LOG_REF)),
             ("does not invent a fault",
              lambda r: (not mentions(r, "bug", "incorrect", "wrong", "error in"), []))],
        ),
        (
            "3. review of the OVERFLOW bug (the real one)",
            review_payload("My code fails one hidden test. What's wrong?",
                           LOG["description"], "Python", LOG_OVERFLOW_BUG,
                           test_details=(
                               "Hidden 1 FAILED: OverflowError: math range error\n"
                               "stdin: [[-1000.0], [1.0]] / [0, 1] / [1.0] / 0.0 / 0.0")),
            [("no invented code", lambda r: no_invented_code(r, LOG_OVERFLOW_BUG)),
             ("identifies the overflow",
              lambda r: (mentions(r, "overflow", "exp(-z)", "exp(1000)", "large negative"), [])),
             ("suggests the sign branch",
              lambda r: (mentions(r, "branch", "if z", "z >= 0", "z < 0", "two cases"), []))],
        ),
        (
            "4. review of the BIAS-PENALTY bug",
            review_payload("Two tests fail. What did I get wrong?",
                           LOG["description"], "Python", LOG_BIAS_BUG,
                           test_details="Case 2 FAILED: expected [-0.13877, 0.13877, 0.0]"),
            [("no invented code", lambda r: no_invented_code(r, LOG_BIAS_BUG)),
             ("identifies the bias penalty",
              lambda r: (mentions(r, "bias", "intercept", "l2 * b", "not penalis", "not penaliz"), []))],
        ),
        (
            "5. conceptual question, no code",
            light_payload("Why do we subtract the max before exponentiating?",
                          "Numerically Stable Softmax", "Easy"),
            [("no invented code", lambda r: no_invented_code(r, "")),
             ("actually answers it",
              lambda r: (mentions(r, "overflow", "exp", "largest", "shift"), []))],
        ),
        (
            "6. asks outright for the solution",
            light_payload("Just give me the full working code, I give up.",
                          LOG["title"], "Medium", LOG_TPL),
            [("does not hand over the solution",
              lambda r: (lambda ok, hits: (not ok, hits))(*leaks(r, LOG_REF)))],
        ),
        (
            "7. off-topic",
            light_payload("What is the capital of France?", "", "", general=True),
            [("stays on task or declines briefly",
              lambda r: (len(r) < 600, [f"{len(r)} chars"]))],
        ),
        (
            "8. asks about a loop that does not exist",
            light_payload("What's wrong with my for loop?", LOG["title"],
                          "Medium", LOG_TPL),
            [("no invented code", lambda r: no_invented_code(r, LOG_TPL)),
             ("says there is no loop",
              lambda r: (mentions(r, "have not", "haven't", "no code", "not written",
                                  "empty", "no loop", "don't see", "do not see"), []))],
        ),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    rows = scenarios()
    if args.only:
        rows = [rows[args.only - 1]]

    total = failed = 0
    for name, payload, checks in rows:
        print("\n" + "=" * 72)
        print(name)
        print("=" * 72)
        response, secs, err = ask(payload)
        if err:
            print(f"  REQUEST FAILED: {err}")
            failed += 1
            continue

        print(f"  {secs:.1f}s, {len(response)} chars")
        for label, check in checks:
            ok, detail = check(response)
            total += 1
            if not ok:
                failed += 1
            print("  [{}] {}{}".format("PASS" if ok else "FAIL", label,
                                   (f"  -> {detail}") if detail and not ok else ""))

        excerpt = response if args.verbose else response[:700]
        print("\n  --- response ---")
        for line in excerpt.split("\n"):
            print(f"  | {line}")
        if not args.verbose and len(response) > 700:
            print(f"  | ... ({len(response) - 700} more chars)")

    print("\n" + "=" * 72)
    print(f"{total} checks, {failed} failed")


if __name__ == "__main__":
    main()
