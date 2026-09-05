# Model Improvement Prompt — Debug Mode Quality & Pedagogical Depth

> Professional assessment of the VoidCode AI's current DEBUG mode behaviour and
> a high-level prompt for model improvement. Written from a senior LLM engineer
> perspective with focus on prompt engineering, training data quality, and
> pedagogical effectiveness.

---

## 1. Problem Statement

### What's Going Wrong

The VoidCode AI's DEBUG mode responses have several quality issues observed in
production:

| Issue | Current Behaviour | Expected Behaviour |
|-------|------------------|-------------------|
| **Only reads execution output** | Model fixates on the `SyntaxError` from test runner and repeats it verbatim | Model should **independently analyse source code** line by line, using execution results only as supporting evidence |
| **Misses multiple bugs** | Identifies 1 bug but ignores a second one (`return []` should be `return [i, j]`) | Must find **ALL bugs** in the code and enumerate them |
| **Duplicates the same error** | Repeats the same 🔴/🟢 block twice for the same line 11 error | Each unique bug should appear exactly once |
| **Too format-fixated** | Response is a rigid `🔴 Problem / 🟢 Think` template that feels robotic | Response should be conversational, warm, and Socratic while still being structured |
| **No conversational flow** | Doesn't adapt tone across multi-turn interactions ("I still don't understand" → "I want to give up") | Should progressively simplify, use analogies, and provide emotional support |
| **Shallow analysis** | Points at syntax error without explaining WHY or teaching debugging methodology | Should teach the student HOW to debug on their own next time |

### Root Cause Analysis

```
Problem 1: System prompt treats execution results as PRIMARY input
──────────────────────────────────────────────────────────────────
  The model receives embedded context blocks like:
    [SOURCE CODE]...[TEST CASE DETAILS]...[EXECUTION OUTPUT]...
  
  The model latches onto [EXECUTION OUTPUT] because it's the most
  explicit signal. It essentially echo-parses stderr rather than
  reading the actual source code.

Problem 2: Training data over-indexes on format compliance
──────────────────────────────────────────────────────────────────
  The 🔴/🟢 format was trained to be followed rigidly.
  The model treats format compliance as more important than
  content quality. It produces "correct format, weak analysis."

Problem 3: No instruction to count and enumerate ALL bugs
──────────────────────────────────────────────────────────────────
  The system prompt says "Point to each issue" but doesn't
  explicitly instruct: "First, read the entire source code and
  identify ALL issues before responding."

Problem 4: No multi-turn warmth guidance in DEBUG mode
──────────────────────────────────────────────────────────────────
  EMPATHY mode exists but only triggers on strong signals
  ("I give up", "I'm dumb"). The gap between robotic DEBUG
  and warm EMPATHY is too wide. There's no middle ground
  for normal confused students.
```

---

## 2. Bug Identification Methodology — What the Model SHOULD Do

### Current (Bad) Flow

```
1. Receive source code + execution results
2. Read stderr → find error message
3. Format error into 🔴/🟢 template
4. Respond

Problem: Step 2 shortcuts the analysis. The model never reads the code.
```

### Desired (Good) Flow

```
1. Receive source code + execution results + problem description
2. READ the source code line by line (primary analysis)
   ├── For each line, ask: "Does this line do what the problem requires?"
   ├── Check: variable names, operators, return values, edge cases
   └── Build a list of ALL issues found
3. Cross-reference with execution results (secondary validation)
   ├── Do the errors confirm what I found in step 2?
   ├── Are there issues the test runner DIDN'T catch? (logic bugs that
   │   produce wrong output but no error)
   └── Which test cases pass and which fail? What does that tell me?
4. Prioritise issues (most critical first)
5. Present issues conversationally, one at a time
6. End with a guiding question for the MOST impactful bug
```

### Concrete Example — Two Sum Bug Analysis

The model should identify **2 distinct bugs**:

```python
class Solution(object):
    def twoSum(self, nums, target):
        n = len(nums)
        for i in range(n):
            for j in range(i + 1, n):
                if nums[i] + nums[j] == :      # BUG 1: missing 'target'
                    return []                    # BUG 2: returns [] not [i, j]
```

**Bug 1 (Line 11):** `== :` — missing comparison value (`target`)
- Severity: SyntaxError — code won't run at all
- Execution result confirms: `SyntaxError: invalid syntax`
- This is the PRIMARY bug to address first

**Bug 2 (Line 12):** `return []` — returns empty list instead of `[i, j]`
- Severity: Logic error — code runs but produces wrong output
- Execution result DOES NOT catch this (code never reaches line 12
  due to Bug 1)
- The model must find this through SOURCE CODE ANALYSIS, not test output
- This is why reading the source code is essential — test results alone
  would miss this

---

## 3. Ideal Response Behaviour — Multi-Turn Example

### Turn 1: Initial Bug Report (Conversational, Complete)

**User:** "Can you review my code and tell me what's wrong?"

**Expected VoidCode AI response:**

> I found **2 issues** in your code. Let's start with the one that's
> stopping it from running at all.
>
> ### Issue 1 — Line 11
>
> ```python
> if nums[i] + nums[j] == :
> ```
>
> Python sees `==` and expects a value on the right side, but there's
> nothing there. That's why you're getting `SyntaxError: invalid syntax`.
>
> Think about it: you're checking if two numbers add up to... what?
> Look at your function parameters — which one represents the number
> you're trying to match?
>
> ### Issue 2 — Line 12
>
> ```python
> return []
> ```
>
> Even after you fix the line above, this line will give you wrong
> answers. The problem asks you to return the **indices** of the two
> numbers. Right now you're returning an empty list.
>
> What two values do you already have that represent the positions
> of the numbers you found?
>
> ---
>
> Let's fix Issue 1 first since the code can't run without it.
> What do you think should go after `==`?

**Why this is better:**
- Found BOTH bugs (not just the one from stderr)
- Conversational, not robotic
- Asks guiding questions (Socratic)
- Doesn't give the answer directly
- Prioritises the most impactful bug
- Teaches debugging thinking ("look at your function parameters")

---

### Turn 2: Student Confusion ("I still don't understand")

**User:** "But I still don't understand"

**Expected response:**

> That's okay — let's zoom in on just one thing.
>
> Look at this line:
>
> ```python
> if nums[i] + nums[j] == :
> ```
>
> Python is asking: **"Equal to what?"**
>
> Now look at your function header:
>
> ```python
> def twoSum(self, nums, target):
> ```
>
> You have 3 inputs: `self`, `nums`, and `target`.
>
> - `nums` is the list of numbers
> - `target` is the number you want the sum to equal
>
> Right now your code says:
>
> ```
> something == nothing
> ```
>
> Which of those 3 inputs should go after `==`?

**Why this is better:**
- Doesn't repeat the 🔴/🟢 format verbatim
- Narrows focus to ONE problem
- Gives a concrete, answerable question
- Uses the student's own code as the teaching tool
- Multiple choice makes it less intimidating

---

### Turn 3: Student Frustration ("I wanna give up, I'm not good in coding")

**User:** "I wanna give up, I'm not good in coding"

**Expected response:**

> Hey — pause for a second. What you're feeling right now is
> frustration, not lack of ability.
>
> This exact mistake — leaving something blank after `==` — is
> something almost every programmer makes early on. It's a syntax
> mistake, not an intelligence problem.
>
> Look at this one more time:
>
> ```python
> def twoSum(self, nums, target):
> ```
>
> The problem says: *"return indices of the two numbers such that
> they add up to **target**"*
>
> Your code checks: `nums[i] + nums[j] == ___`
>
> Pick one:
> - a) `nums`
> - b) `target`
> - c) `i + j`
>
> Your brain already knows most of the code is correct. This is
> just filling in one missing piece. You can do this — you're
> already almost there.

**Why this is better:**
- Emotional acknowledgment first
- Reframes struggle as normal
- Gives a multiple-choice question (lowest possible barrier)
- Encourages without being patronising
- Still doesn't give the answer

---

## 4. System Prompt Improvements

### 4.1 DEBUG Mode — Proposed System Prompt Changes

The current DEBUG section in `FINETUNED_SYSTEM_PROMPT` is:

```
### DEBUG MODE: Line-by-Line Identification
- Point to each issue with line number and code
- 🔴 **Problem:** What is wrong
- 🟢 **Think:** Guiding question WITHOUT giving answer
- End with: "Which one would you like to tackle first?"
```

**Proposed replacement:**

```
### DEBUG MODE: Source Code Analysis

**Step 1 — Read the source code FIRST (before looking at test results)**
Read every line of the student's code. For each line, ask yourself:
"Does this line correctly implement what the problem requires?"
Identify ALL issues — syntax errors, logic errors, wrong return values,
missing edge cases.

**Step 2 — Cross-reference with test results**
Test case results and execution output are SUPPORTING EVIDENCE only.
They confirm bugs you found in Step 1, but they can also MISS bugs
(e.g., unreachable code after a syntax error). NEVER rely solely on
test output — always read the source code independently.

**Step 3 — Count and enumerate**
State how many issues you found: "I found N issues in your code."
Present each issue with:
- The line number and the exact code
- A plain-English explanation of what's wrong (no jargon)
- A guiding question that helps the student figure out the fix

**Step 4 — Prioritise and focus**
Start with the most impactful bug (the one preventing the code from
running). End with: "Let's fix [most critical issue] first. [Guiding
question]?"

**Rules for DEBUG mode:**
- NEVER just echo the stderr/test output — add your own analysis
- NEVER show the same bug twice
- If there are multiple bugs, list them ALL but focus discussion on ONE
- Use natural, conversational language — not robotic markers
- Teach debugging METHODOLOGY: "Here's how you can spot this yourself…"
- If the student's code is mostly correct, acknowledge what they did RIGHT
  before pointing out what's wrong
```

---

### 4.2 Conversational Warmth in DEBUG Mode

Add a warmth instruction that applies even before EMPATHY mode triggers:

```
## Tone across all modes

Even in DEBUG and TEACHING modes, maintain a warm and approachable tone:
- Start with something positive when possible ("Your overall approach
  is solid — just a couple of things to fix")
- Use "we" and "let's" instead of "you must" and "you should"
- If the student seems lost, simplify and narrow focus BEFORE they
  explicitly say they're frustrated
- Never make the student feel they should have known something
- Treat every question as a legitimate learning moment
```

---

### 4.3 Multi-Turn Awareness in DEBUG Mode

```
## Multi-turn debugging sessions

When a student responds to a DEBUG message:
- DO NOT repeat the full list of bugs
- Focus on the ONE bug you asked about
- If they're confused, rephrase from a completely different angle
- If they gave a partial answer, acknowledge what's right, then refine
- If they seem overwhelmed, offer a concrete choice (A/B/C options)
- Progressive simplification: each turn should be SIMPLER than the last
```

---

## 5. Training Data Improvements

### 5.1 Current Training Data Gap

The training data likely contains DEBUG examples that look like:

```
User: "My code doesn't work"
Assistant: "I found 1 issue in your code:\n\n**Line 3**\n```python\n...\n```\n🔴 **Problem:** ...\n🟢 **Think:** ..."
```

**What's missing:**
- Examples with MULTIPLE bugs (2–4 per code snippet)
- Examples where test output DOESN'T catch a bug (logic errors after
  syntax errors)
- Multi-turn sequences showing progressive simplification
- Examples with warm, conversational tone (not just 🔴/🟢 robotic format)
- Examples where the model acknowledges what's CORRECT before pointing
  out bugs

### 5.2 New Training Examples Needed

**Category 1: Multi-bug identification**
- Code with 2–3 bugs of different types (syntax + logic + edge case)
- Model response identifies ALL of them, focuses on most critical first

**Category 2: Source code analysis vs test output divergence**
- Code where Bug A causes SyntaxError (masking Bug B)
- Model finds Bug B through code reading, not test output
- Model explains: "The tests only caught Bug A because Bug B is after
  the syntax error. But once you fix line X, you'll hit Bug B on line Y."

**Category 3: Conversational multi-turn debugging**
- Turn 1: List all bugs, focus on one
- Turn 2: Student confused → rephrase differently, narrow focus
- Turn 3: Student partially gets it → confirm, guide to completion
- Turn 4: Student still stuck → offer multiple choice / analogy

**Category 4: Mostly-correct code encouragement**
- Code that's 90% correct with 1 small bug
- Model response: "Your approach is solid! The brute force logic is
  correct, the loop structure is right. Just one small thing on line X…"

### 5.3 Training Data Format — DEBUG Examples

```json
{
  "messages": [
    {
      "role": "system",
      "content": "<VERBATIM system prompt>"
    },
    {
      "role": "user",
      "content": "[MODE: DEBUG]\n[SOURCE CODE]\n```python\nclass Solution(object):\n    def twoSum(self, nums, target):\n        n = len(nums)\n        for i in range(n):\n            for j in range(i + 1, n):\n                if nums[i] + nums[j] == :\n                    return []\n```\n[TEST CASE DETAILS]\n0/3 tests passed\n...\n[USER MESSAGE]\nCan you review my code and tell me what's wrong?"
    },
    {
      "role": "assistant",
      "content": "I found **2 issues** in your code. Let's start with the one that's stopping it from running.\n\n### Issue 1 — Line 6\n\n```python\nif nums[i] + nums[j] == :\n```\n\nPython sees `==` and expects a value on the right side, but there's nothing there. That's why every test case is failing with `SyntaxError`.\n\nThink about it: you're checking if two numbers add up to... what? Look at your function parameters — which one represents the target value?\n\n### Issue 2 — Line 7\n\n```python\nreturn []\n```\n\nEven after you fix the line above, this will return an empty list instead of the answer. The problem asks you to return the **indices** of the matching numbers. What two variables already hold those positions inside your loops?\n\n---\n\nLet's fix Issue 1 first since the code can't run without it. What do you think should go after `==`?"
    }
  ]
}
```

---

## 6. Evaluation Criteria for Improved Model

### 6.1 Automated Checks

| Check | Pass Criteria |
|-------|-------------|
| Bug count accuracy | Model identifies ALL bugs in the code (verified against ground truth) |
| No duplicate bugs | Each unique bug appears exactly once in the response |
| Source code citation | Response references specific line numbers from the source code |
| No answer leaking | Response does NOT contain the complete fixed code |
| Guiding question present | Response ends with a question or prompt for student input |
| Positive framing | At least one positive/encouraging statement per response |

### 6.2 Quality Rubric (LLM-as-Judge)

Score each response 1–5 on:

| Dimension | 1 (Poor) | 3 (Acceptable) | 5 (Excellent) |
|-----------|----------|----------------|---------------|
| **Completeness** | Misses bugs | Finds most bugs | Finds ALL bugs with correct severity |
| **Analysis depth** | Just echoes stderr | Explains what's wrong | Teaches debugging methodology |
| **Pedagogical quality** | Gives the answer directly | Asks a question | Asks a targeted, answerable question at the right difficulty level |
| **Tone** | Robotic, cold | Neutral | Warm, encouraging, conversational |
| **Multi-turn awareness** | Repeats previous response | Acknowledges follow-up | Adapts approach based on student's confusion level |
| **Conciseness** | Too brief (misses info) | Appropriate length | Focused, no redundant content |

### 6.3 Regression Test Set

Create a gold set of 20+ DEBUG scenarios covering:

- Single bug (syntax error)
- Single bug (logic error)
- Multiple bugs (syntax + logic)
- Multiple bugs (one masked by another)
- Mostly-correct code (1 minor issue)
- Code with correct logic but wrong variable names
- Code that passes some tests but fails others (partial correctness)
- Infinite loop / recursion errors
- Off-by-one errors
- Empty/null edge case failures

---

## 7. Implementation Priorities

| Priority | Task | Impact | Effort |
|:---:|------|:---:|:---:|
| 🔴 1 | Update DEBUG section in system prompt (Section 4.1) | High | Low |
| 🔴 2 | Add warmth and multi-turn instructions (Section 4.2 + 4.3) | High | Low |
| 🟡 3 | Generate 50+ multi-bug DEBUG training examples | High | Medium |
| 🟡 4 | Generate 30+ multi-turn debug conversation sequences | High | Medium |
| 🟢 5 | Build automated eval suite with bug-count accuracy | Medium | Medium |
| 🟢 6 | Create LLM-as-Judge rubric evaluation pipeline | Medium | High |
| 🟢 7 | Create regression test set (20+ gold scenarios) | Medium | Medium |

### Phase 1: Prompt Engineering (Immediate — No Retraining)

Update `FINETUNED_SYSTEM_PROMPT` in `prompts.py` with the improved DEBUG
instructions from Section 4. This is a **zero-cost improvement** that takes
effect immediately without retraining the model.

> ⚠️ **Warning:** Modifying the system prompt on a fine-tuned model carries
> distribution shift risk. The model was trained on the old prompt format.
> Test thoroughly before deploying. If quality degrades, the model needs
> retraining with the new prompt.

### Phase 2: Training Data Enhancement

Generate new DEBUG training examples following Section 5.2 categories.
Each example should:
- Contain the updated system prompt (verbatim match)
- Demonstrate multi-bug identification
- Show source-code-first analysis methodology
- Use conversational tone, not 🔴/🟢 markers
- Include multi-turn sequences with progressive simplification

### Phase 3: Evaluation & Iteration

Build the automated eval suite (Section 6) and the regression test set.
Use LLM-as-Judge (GPT-4o or Claude) to score model outputs against the
rubric. Iterate on training data and prompt until quality metrics stabilise.

---

## 8. Key Engineering Insights

### Why This Problem Is Hard

The core tension in this system is between **format compliance** and
**pedagogical quality**:

- Fine-tuning teaches the model to follow a rigid format (which it does well)
- But rigid format compliance suppresses natural conversational ability
- The model becomes a "format machine" rather than a "teaching machine"
- The 🔴/🟢 markers make the model think structure IS the answer

### The Solution: Teach Analysis, Not Just Format

The model needs training examples that demonstrate **thinking before
formatting**. The internal reasoning should be:

```
<think>
1. Let me read the source code line by line
2. Line 6: `if nums[i] + nums[j] == :` — missing comparison value after ==
3. Line 7: `return []` — returns empty list, should return [i, j]
4. Test output shows SyntaxError on line 6 — confirms Bug 1
5. Test output does NOT mention Bug 2 — because code never reaches line 7
6. I'll explain both bugs but focus on Bug 1 first (blocks execution)
7. I'll ask a guiding question about the function parameters
</think>
```

This thinking process should be visible in the `<think>` tags during
generation, teaching the model to analyse before responding.

### Format vs Content Trade-Off

| Approach | Format Compliance | Pedagogical Quality | Recommendation |
|----------|:-:|:-:|---|
| Current (rigid 🔴/🟢) | ★★★★★ | ★★☆☆☆ | Too rigid |
| Proposed (conversational + structured) | ★★★★☆ | ★★★★★ | Better trade-off |
| Pure conversational (no structure) | ★★☆☆☆ | ★★★★☆ | Too loose for consistency |

The goal is structured-but-warm: clear issue identification with line numbers,
but wrapped in natural language that adapts to the student's emotional state.
