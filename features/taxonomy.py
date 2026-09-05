"""Concept taxonomy loader, validator and tag projection.

Single source of truth is `data/concepts.yaml`. Everything downstream — the Spark
feature pipeline, candidate generation, course assembly — reads the taxonomy through
this module so the DAG invariants are enforced in exactly one place.

Run directly to validate:
    python -m features.taxonomy
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache

import yaml

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "concepts.yaml",
)

# Spec §4.2 set this range at 40–80 when the taxonomy was classical DSA only.
#
# THE CEILING WAS RAISED, AND THE OLD ONE WAS A LATENT BLOCKER. `concepts.yaml`
# holds exactly 80, so validation passed with zero headroom: adding a single ML
# concept — attention, quantization, kernel fusion, any of them — raised
# `TaxonomyError` and took the whole feature pipeline with it. An upper bound
# that a planned, necessary edit trips is not a guard, and it would have fired
# during content authoring with a message about a spec section rather than
# about what actually went wrong.
#
# The bound is kept rather than removed. Its real job is catching a malformed or
# truncated file, and a floor of 40 with a generous ceiling still does that. 300
# is well above any plausible hand-authored taxonomy — beyond that, something
# has gone wrong upstream rather than someone having written 300 concepts.
MIN_CONCEPTS, MAX_CONCEPTS = 40, 300


class TaxonomyError(ValueError):
    """Raised when the taxonomy violates an invariant. Never caught in pipelines."""


@dataclass(frozen=True)
class Concept:
    id: str
    name: str
    category: str
    prerequisites: tuple[str, ...]


@dataclass
class Taxonomy:
    concepts: dict[str, Concept]
    tag_mappings: dict[str, list[dict]]
    max_concepts_per_problem: int
    untagged_concepts: tuple[str, ...]
    unrated_concepts: tuple[str, ...]
    categories: dict[str, str] = field(default_factory=dict)

    # ── invariants ──────────────────────────────────────────────────────────
    def validate(self) -> None:
        n = len(self.concepts)
        if not MIN_CONCEPTS <= n <= MAX_CONCEPTS:
            raise TaxonomyError(
                f"spec §4.2 requires {MIN_CONCEPTS}-{MAX_CONCEPTS} concepts, found {n}")

        for c in self.concepts.values():
            for p in c.prerequisites:
                if p not in self.concepts:
                    raise TaxonomyError(
                        f"concept {c.id!r} lists unknown prerequisite {p!r}")
            if c.category not in self.categories:
                raise TaxonomyError(
                    f"concept {c.id!r} has unknown category {c.category!r}")

        self._assert_acyclic()

        for tag, rules in self.tag_mappings.items():
            if not rules:
                raise TaxonomyError(f"tag {tag!r} has no rules")
            for rule in rules:
                if "max_rating" not in rule:
                    raise TaxonomyError(f"tag {tag!r} has a rule with no max_rating")
                for cid in rule.get("concepts") or []:
                    if cid not in self.concepts:
                        raise TaxonomyError(
                            f"tag {tag!r} maps to unknown concept {cid!r}")
            ratings = [r["max_rating"] for r in rules]
            if ratings != sorted(ratings):
                raise TaxonomyError(
                    f"tag {tag!r} rules must be ordered by ascending max_rating")

        for cid in (*self.untagged_concepts, *self.unrated_concepts):
            if cid not in self.concepts:
                raise TaxonomyError(f"fallback references unknown concept {cid!r}")

    def _assert_acyclic(self) -> None:
        """Iterative three-colour DFS. Reports the actual cycle, not just its existence."""
        WHITE, GREY, BLACK = 0, 1, 2
        colour = dict.fromkeys(self.concepts, WHITE)
        for root in self.concepts:
            if colour[root] != WHITE:
                continue
            stack = [(root, iter(self.concepts[root].prerequisites))]
            path = [root]
            colour[root] = GREY
            while stack:
                node, it = stack[-1]
                advanced = False
                for nxt in it:
                    if colour[nxt] == GREY:
                        cycle = [*path[path.index(nxt):], nxt]
                        raise TaxonomyError(
                            "prerequisite graph is cyclic: " + " -> ".join(cycle))
                    if colour[nxt] == WHITE:
                        colour[nxt] = GREY
                        path.append(nxt)
                        stack.append((nxt, iter(self.concepts[nxt].prerequisites)))
                        advanced = True
                        break
                if not advanced:
                    colour[node] = BLACK
                    stack.pop()
                    path.pop()

    # ── graph queries ───────────────────────────────────────────────────────
    def ancestors(self, concept_id: str) -> set[str]:
        """Transitive prerequisites. Used by the Phase 3 prerequisite-graph walk."""
        seen: set[str] = set()
        stack = list(self.concepts[concept_id].prerequisites)
        while stack:
            c = stack.pop()
            if c in seen:
                continue
            seen.add(c)
            stack.extend(self.concepts[c].prerequisites)
        return seen

    def topological_order(self) -> list[str]:
        """Kahn's algorithm. Course modules are emitted in this order (spec §5.3)."""
        indeg = {c: len(self.concepts[c].prerequisites) for c in self.concepts}
        dependents: dict[str, list[str]] = {c: [] for c in self.concepts}
        for c in self.concepts.values():
            for p in c.prerequisites:
                dependents[p].append(c.id)
        ready = sorted(c for c, d in indeg.items() if d == 0)
        out: list[str] = []
        while ready:
            c = ready.pop(0)
            out.append(c)
            for d in sorted(dependents[c]):
                indeg[d] -= 1
                if indeg[d] == 0:
                    ready.append(d)
            ready.sort()
        if len(out) != len(self.concepts):
            raise TaxonomyError("topological sort incomplete; graph is cyclic")
        return out

    # ── tag projection ──────────────────────────────────────────────────────
    def concepts_for(self, tags, rating) -> list[str]:
        """Project a problem's Codeforces tags + rating onto concept ids.

        Order is preserved and deterministic: tags are applied in the order given,
        de-duplicated, then truncated to max_concepts_per_problem. Truncation keeps
        the earliest-listed concepts, so put the defining tag first if it matters.
        """
        if rating is None:
            return list(self.unrated_concepts)[: self.max_concepts_per_problem]

        out: list[str] = []
        for tag in tags or []:
            rules = self.tag_mappings.get(tag)
            if not rules:
                continue
            for rule in rules:  # ascending max_rating, first match wins
                if rating <= rule["max_rating"]:
                    for cid in rule.get("concepts") or []:
                        if cid not in out:
                            out.append(cid)
                    break
        if not out:
            out = list(self.untagged_concepts)
        return out[: self.max_concepts_per_problem]


def load_taxonomy(path: str = DEFAULT_PATH, *, validate: bool = True) -> Taxonomy:
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    concepts = {}
    for c in raw["concepts"]:
        if c["id"] in concepts:
            raise TaxonomyError(f"duplicate concept id {c['id']!r}")
        concepts[c["id"]] = Concept(
            id=c["id"], name=c["name"], category=c["category"],
            prerequisites=tuple(c.get("prerequisites") or []),
        )

    tax = Taxonomy(
        concepts=concepts,
        tag_mappings={str(k): v for k, v in (raw.get("tag_mappings") or {}).items()},
        max_concepts_per_problem=int(raw.get("max_concepts_per_problem", 4)),
        untagged_concepts=tuple(raw.get("untagged_concepts") or []),
        unrated_concepts=tuple(raw.get("unrated_concepts") or []),
        categories={c["id"]: c["name"] for c in raw.get("categories") or []},
    )
    if validate:
        tax.validate()
    return tax


@lru_cache(maxsize=1)
def get_taxonomy() -> Taxonomy:
    return load_taxonomy()


if __name__ == "__main__":
    t = load_taxonomy()
    order = t.topological_order()
    print(f"concepts            {len(t.concepts)}")
    print(f"categories          {len(t.categories)}")
    print(f"codeforces tags     {len(t.tag_mappings)}")
    print(f"prerequisite edges  {sum(len(c.prerequisites) for c in t.concepts.values())}")
    print(f"roots (no prereqs)  {[c for c in order if not t.concepts[c].prerequisites]}")
    depth = max(len(t.ancestors(c)) for c in t.concepts)
    deepest = max(t.concepts, key=lambda c: len(t.ancestors(c)))
    print(f"deepest concept     {deepest} ({depth} transitive prerequisites)")
    print("VALIDATION PASSED")
