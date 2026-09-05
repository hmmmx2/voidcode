"""Per-learner, per-concept mastery from real submissions.

The join this needs — `submissions -> problems -> problem_concepts` — only became possible once the
taxonomy join was populated. Before that, `features/irt.py` and the Spark pipeline computed mastery
over scraped Codeforces data with hashed handles that joined to no platform user, which is the
audit's central criticism of that work.

WHY CREDIT IS DIVIDED ACROSS AN ITEM'S CONCEPTS
-------------------------------------------------
A problem tagged with three concepts is not three pieces of evidence. Counting it once per concept
would let a heavily-tagged problem dominate a learner's profile, and would make tagging decisions
silently change mastery estimates. Dividing keeps a submission worth exactly one observation
regardless of how it was tagged.

This is also why a wrong tag is expensive rather than merely untidy: it does not add noise, it
moves weight from one concept to another.

WHY FIRST-ATTEMPT PASS RATE IS TRACKED SEPARATELY
----------------------------------------------------
Overall pass rate rewards persistence, which is a different thing from knowing the material — a
learner who fails six times and then passes has demonstrated something, but not mastery. Spec §4.3
names first-attempt pass rate as the strongest weakness signal, and this keeps both so a ranker can
use the one it wants rather than a blend nobody chose.

WHY ESTIMATES CARRY THEIR SAMPLE SIZE
----------------------------------------
A mastery of 0.0 from one attempt and 0.0 from thirty are not the same claim. Returning the count
alongside the estimate lets a ranker refuse to act on thin evidence; returning only the score
invites confident recommendations built on a single submission, which is the failure mode the risk
register names for this platform.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

#: A submission counts as solved only on this status. Anything else — wrong answer, runtime error,
#: timeout, compile failure — is an attempt that did not succeed.
ACCEPTED = "accepted"

#: Recency weighting. Spec §4.3 asks for exponential decay with a 30-day half-life: material
#: practised six months ago is weaker evidence of present ability than material practised
#: yesterday, and a profile that never forgets will keep recommending against weaknesses the
#: learner has since fixed.
#:
#: MEASURED, AND 30 DAYS IS THE WORST OF THE VALUES TESTED. Fitted against 49,745 held-out attempts
#: on the research corpus — predict whether a learner's next attempt on a concept passed, from a
#: recency-weighted history of their earlier attempts on it, scored by log loss:
#:
#:     7 days   0.96870
#:    30 days   0.95252   <- this default
#:    90 days   0.94946
#:   365 days   0.94902   <- best
#:   no decay   0.94923   <- still better than 30 days
#:
#: Two things follow. Recency weighting barely matters here at all: the spread across every value is
#: 0.37%, and the curve is flat past 90 days. And 30 days is measurably too aggressive — it discards
#: information, which is why NO decay outperforms it.
#:
#: THE DEFAULT IS LEFT AT 30 ANYWAY, deliberately. That measurement is World A: Codeforces, years of
#: competitive-programming history. This constant serves World B, where learners return weekly to an
#: ML-interview catalogue and where forgetting plausibly is faster. Changing a product default on
#: evidence from a different corpus would be substituting one unfitted number for another with a
#: measurement attached to make it look principled.
#:
#: What this does establish is that the value is not principled and should be fitted per corpus.
#: `mastery_for_learner` already takes `half_life_days`, so fitting it is a caller decision, not a
#: rewrite. The product cannot fit it yet: 2 submissions.
HALF_LIFE_DAYS = 30.0


@dataclass(frozen=True)
class Attempt:
    """One submission, already joined to the concepts its problem teaches."""

    user_id: str
    problem_id: str
    concepts: tuple[str, ...]
    status: str
    created_at: datetime

    @property
    def solved(self) -> bool:
        return self.status == ACCEPTED


@dataclass(frozen=True)
class Mastery:
    concept_id: str
    #: Recency-weighted share of attempts that were accepted, in [0, 1].
    score: float
    #: Unweighted counts. Present so a caller can judge how much to trust `score` — an estimate
    #: without its sample size invites confident action on a single observation.
    attempts: int
    solved: int
    #: Accepted on the learner's *first* attempt at a problem, over problems attempted. The
    #: strongest weakness signal per spec §4.3, kept separate because overall pass rate rewards
    #: persistence and persistence is not knowledge.
    first_attempt_rate: float | None


def _weight(when: datetime, now: datetime, half_life_days: float) -> float:
    age_days = max((now - when).total_seconds() / 86400.0, 0.0)
    return 0.5 ** (age_days / half_life_days)


def mastery_for_learner(attempts: Iterable[Attempt], *, now: datetime | None = None,
                        half_life_days: float = HALF_LIFE_DAYS) -> dict[str, Mastery]:
    """Concept id -> `Mastery`, for one learner's attempts.

    Untagged problems contribute nothing. That is deliberate and worth stating: a submission
    against a problem with no concepts is not evidence about any concept, and quietly attributing
    it somewhere would be inventing data. It is also why an unpopulated `problem_concepts` produces
    an empty profile rather than a wrong one.
    """
    now = now or datetime.utcnow()

    weighted_solved: dict[str, float] = defaultdict(float)
    weighted_total: dict[str, float] = defaultdict(float)
    raw_attempts: dict[str, int] = defaultdict(int)
    raw_solved: dict[str, int] = defaultdict(int)

    # First attempt per (learner, problem), by time. Ordering matters: "first attempt" is a
    # property of the sequence, and reading it off an unsorted list silently picks an arbitrary one.
    ordered = sorted(attempts, key=lambda a: a.created_at)
    seen_problem: set[str] = set()
    first_by_concept: dict[str, list[bool]] = defaultdict(list)

    for a in ordered:
        if not a.concepts:
            continue
        # One submission is one observation however many concepts it carries, so a heavily-tagged
        # problem cannot outweigh a narrowly-tagged one.
        share = 1.0 / len(a.concepts)
        w = _weight(a.created_at, now, half_life_days) * share

        is_first = a.problem_id not in seen_problem
        seen_problem.add(a.problem_id)

        for c in a.concepts:
            weighted_total[c] += w
            raw_attempts[c] += 1
            if a.solved:
                weighted_solved[c] += w
                raw_solved[c] += 1
            if is_first:
                first_by_concept[c].append(a.solved)

    out: dict[str, Mastery] = {}
    for c, total in weighted_total.items():
        firsts = first_by_concept.get(c, [])
        out[c] = Mastery(
            concept_id=c,
            score=(weighted_solved[c] / total) if total > 0 else 0.0,
            attempts=raw_attempts[c],
            solved=raw_solved[c],
            first_attempt_rate=(sum(firsts) / len(firsts)) if firsts else None,
        )
    return out


def weakest_concepts(profile: dict[str, Mastery], *, limit: int = 5,
                     min_attempts: int = 2) -> list[Mastery]:
    """The concepts a ranker should target, weakest first.

    `min_attempts` exists because the weakest-looking concept is almost always the one with a
    single failed attempt, and recommending heavily against one bad submission is the
    sparse-history failure the risk register names. Raising the floor trades coverage for
    confidence, and that is the right direction when the recommendation is what the learner sees.

    Ties break on concept id so the same profile always produces the same list — a recommendation
    that reshuffles between page loads reads as broken even when both orderings are defensible.
    """
    eligible = [m for m in profile.values() if m.attempts >= min_attempts]
    eligible.sort(key=lambda m: (m.score, m.concept_id))
    return eligible[:limit]


def coverage_gaps(profile: dict[str, Mastery], all_concepts: Sequence[str]) -> list[str]:
    """Concepts with no attempts at all.

    Distinct from a low score, and the distinction matters to a ranker: never-attempted is not
    evidence of weakness, it is absence of evidence. Treating the two alike would bury genuinely
    weak concepts under every topic the learner has simply not reached yet.
    """
    return sorted(set(all_concepts) - set(profile))
