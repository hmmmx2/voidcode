"""Closed vocabularies for interview question metadata.

Extracted from `apps/api/scripts/interview_content.py` so that module can be deleted along with
the other four content scripts. These are **validation vocabularies, not content** — they describe
the shape a question's metadata may take, and they outlive any particular set of questions.

A typo in one of these should fail at seed time rather than become a ghost filter in the UI: a
domain of `"cude"` produces a filter chip that matches nothing, on a page that otherwise looks
perfectly healthy.

COMPANIES ARE A HINT, NOT A CLAIM. `companies` records where a question, or a close variant, is
commonly reported. It is not drawn from any lab's internal material and must never be presented as
one. Carried over verbatim from the original module, because it is the sort of caveat that gets
lost in a move and then quietly becomes a claim nobody meant to make.
"""
from __future__ import annotations

#: Subject areas a question can belong to. Matches the five areas the revised plan names, plus
#: `maths` for the derivation questions that underpin all of them.
DOMAINS = ["ml", "dl", "cuda", "maths", "llm", "vlm"]

#: Where a question is commonly reported from. A hint, not a claim — see the module docstring.
COMPANIES = ["Meta", "OpenAI", "Anthropic", "Google DeepMind", "NVIDIA"]

#: What kind of answer a question wants. Distinct from `difficulty`: a derivation and a coding
#: task can be equally hard and still need different UI and different grading.
KINDS = ["derivation", "computation", "code"]
