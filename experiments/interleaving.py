"""Team-draft interleaving: compare two rankers without live traffic. Spec §7.1.

WHY INTERLEAVING RATHER THAN AN A/B TEST
------------------------------------------
An A/B test splits LEARNERS, so the comparison is between two populations and every difference
between those populations is noise you must average away. Interleaving splits WITHIN a list: one
learner sees a blend of both rankers' suggestions, and the credit goes to whichever ranker put the
item they engaged with there.

That removes between-learner variance entirely, which is the dominant term. Published comparisons
find interleaving detects the same difference with one to two orders of magnitude less traffic —
decisive for a platform with 9 users, where an A/B test needs traffic that does not exist.

TEAM DRAFT, AND WHY THE COIN FLIP MATTERS
-------------------------------------------
Radlinski et al.'s scheme: the two rankers take turns picking their highest-ranked item not already
placed, like captains picking a team. Who picks first is decided by a fair coin at each round.

Without that coin the first ranker always fills position 1, which collects the most engagement
regardless of quality — position bias would be attributed to whichever ranker was arbitrarily
listed first, and the measurement would be of the argument order.

WHAT THIS MEASURES, AND WHAT IT DOES NOT
------------------------------------------
It gives a RELATIVE preference: which ranker's placements got engaged with more often. It cannot
say whether either is any good in absolute terms, and it says nothing about learning outcomes —
engagement is a proxy, and on a tutoring platform it is a weaker proxy than on a search engine,
because the item a learner clicks is not necessarily the item that taught them most.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field


@dataclass
class Interleaved:
    """One interleaved list and the provenance needed to attribute engagement."""

    items: list[str]
    #: item -> which ranker placed it. The whole point of the structure.
    credit: dict[str, str] = field(default_factory=dict)

    def attribute(self, engaged: set[str]) -> dict[str, int]:
        """Wins per ranker, from the set of items the learner engaged with.

        Items in `engaged` that are not in the list are ignored rather than raising: a learner can
        reach a problem by search or a direct link, and that engagement belongs to neither ranker.
        """
        wins: dict[str, int] = {}
        for item in engaged:
            owner = self.credit.get(item)
            if owner is not None:
                wins[owner] = wins.get(owner, 0) + 1
        return wins


def team_draft(ranking_a: list[str], ranking_b: list[str], *,
               length: int = 10, rng: random.Random | None = None,
               name_a: str = "A", name_b: str = "B") -> Interleaved:
    """Interleave two rankings, recording which ranker placed each item.

    `rng` is injected rather than taken from the global module state so a comparison is
    reproducible. An interleaving experiment whose assignment cannot be replayed cannot be audited,
    and the coin flips are the part most worth auditing.
    """
    rng = rng or random.Random()
    a_rest = [x for x in ranking_a]
    b_rest = [x for x in ranking_b]
    placed: set[str] = set()
    out = Interleaved(items=[])

    while len(out.items) < length and (a_rest or b_rest):
        # Fair coin per round; see the module docstring on why this is not optional.
        a_first = rng.random() < 0.5
        order = [(name_a, a_rest), (name_b, b_rest)] if a_first else [(name_b, b_rest), (name_a, a_rest)]
        for owner, pool in order:
            if len(out.items) >= length:
                break
            while pool:
                candidate = pool.pop(0)
                if candidate in placed:
                    continue
                placed.add(candidate)
                out.items.append(candidate)
                out.credit[candidate] = owner
                break
    return out


def compare(sessions: list[tuple[list[str], list[str], set[str]]], *,
            length: int = 10, seed: int = 0,
            name_a: str = "A", name_b: str = "B") -> dict:
    """Run interleaving across historical sessions and total the wins.

    Each session is (ranking_a, ranking_b, engaged_items). A session where both rankers score
    equally is a TIE and is excluded from the win rate, following the standard treatment: ties carry
    no preference information, and counting them as half a win for each shrinks the estimate toward
    0.5 in a way that depends on how often the two lists happen to agree.
    """
    rng = random.Random(seed)
    wins_a = wins_b = ties = 0
    for ranking_a, ranking_b, engaged in sessions:
        il = team_draft(ranking_a, ranking_b, length=length, rng=rng,
                        name_a=name_a, name_b=name_b)
        w = il.attribute(engaged)
        a, b = w.get(name_a, 0), w.get(name_b, 0)
        if a > b:
            wins_a += 1
        elif b > a:
            wins_b += 1
        else:
            ties += 1

    decisive = wins_a + wins_b
    return {
        "sessions": len(sessions),
        f"wins_{name_a}": wins_a,
        f"wins_{name_b}": wins_b,
        "ties": ties,
        "decisive_sessions": decisive,
        # None rather than 0.5 when nothing was decisive: "no preference measured" and "measured a
        # dead heat" are different claims and only one of them is supported by zero observations.
        "win_rate_a": (wins_a / decisive) if decisive else None,
    }
