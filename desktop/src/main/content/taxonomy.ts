/**
 * The concept graph, checked rather than trusted.
 *
 * `concepts.ts` is hand-authored, and every invariant below has a failure mode that is silent
 * without it: a prerequisite naming a concept that was renamed, a cycle introduced by adding one
 * edge, a `teaches` pointing at a problem that no longer exists. None of those throw on their own
 * — they produce a graph that walks wrong, and a "what next" that skips something.
 *
 * **The invariants are ported from the web repo's `features/taxonomy.py`**, which had already
 * worked out which ones matter: a count floor that catches a truncated file, unknown-prerequisite
 * rejection, unknown-category rejection, and an acyclicity check that **reports the cycle it
 * found** rather than merely asserting one exists. That last detail is the difference between a
 * fixable failure and a hunt.
 *
 * Two invariants are new here, because the desktop maps concepts onto real content and the web
 * did not: every `teaches` entry must name a real item, and every item should be taught by
 * something. The second is reported rather than thrown — see `coverage`.
 */
import { CONCEPTS, CONCEPT_CATEGORIES, type Concept, type ConceptCategory } from "./concepts.js";
import { listProblems } from "./problems.js";
import { QUESTIONS } from "./interview-bank.js";

/**
 * The count bounds, and what they are actually for.
 *
 * Not a quality bar — a truncated or half-written file is the thing they catch. The floor is
 * below the current count so authoring can remove a concept without tripping it; the ceiling is
 * far above any plausible hand-authored taxonomy, so passing it means something went wrong
 * upstream rather than that someone wrote 300 concepts.
 */
export const MIN_CONCEPTS = 30;
export const MAX_CONCEPTS = 300;

export class TaxonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxonomyError";
  }
}

/**
 * Every content id a learner can actually do: the curriculum problems and the interview questions.
 *
 * Deliberately no counts here. They were "14 and 38" and the second one had been 44 for a while —
 * prose restating a number the catalogue owns is how that happens. `tests/content-census.test.ts`
 * is the one place counts live, and it fails when they change.
 *
 * `listProblems()` rather than the raw array, which is not exported — and the distinction is
 * deliberate upstream: `problems.ts` keeps the interview workspaces out of the curriculum list so a
 * short syllabus does not present as one several times its length. Both are things a learner does,
 * so both are taxonomy items; only the *listing* is separate.
 */
function contentIds(): Set<string> {
  return new Set([...listProblems().map((p) => p.id), ...QUESTIONS.map((q) => q.slug)]);
}

/**
 * Validate the graph, or throw naming what is wrong.
 *
 * Called by `taxonomy()` on first use, so nothing can read an invalid graph — and by the test
 * suite directly, which is what makes an authoring mistake fail in CI rather than at runtime.
 */
export function validate(concepts: readonly Concept[] = CONCEPTS): void {
  if (concepts.length < MIN_CONCEPTS || concepts.length > MAX_CONCEPTS) {
    throw new TaxonomyError(
      `expected ${String(MIN_CONCEPTS)}-${String(MAX_CONCEPTS)} concepts, found ${String(concepts.length)}`
    );
  }

  const byId = new Map<string, Concept>();
  for (const concept of concepts) {
    // Duplicates are why this is a Map built by hand rather than `new Map(concepts.map(...))`,
    // which would silently keep the last of a pair and leave the graph a concept short.
    if (byId.has(concept.id)) throw new TaxonomyError(`duplicate concept ${concept.id}`);
    byId.set(concept.id, concept);
  }

  const items = contentIds();

  for (const concept of concepts) {
    if (!(concept.category in CONCEPT_CATEGORIES)) {
      throw new TaxonomyError(`concept ${concept.id} has unknown category ${concept.category}`);
    }
    for (const prerequisite of concept.prerequisites) {
      if (!byId.has(prerequisite)) {
        throw new TaxonomyError(`concept ${concept.id} lists unknown prerequisite ${prerequisite}`);
      }
      if (prerequisite === concept.id) {
        throw new TaxonomyError(`concept ${concept.id} is its own prerequisite`);
      }
    }
    for (const item of concept.teaches) {
      // The check the web taxonomy had no need for: it mapped onto Codeforces tags, this maps
      // onto content that can be renamed or removed in the same commit.
      if (!items.has(item)) {
        throw new TaxonomyError(`concept ${concept.id} teaches unknown item ${item}`);
      }
    }
  }

  assertAcyclic(byId);
}

/**
 * Iterative three-colour DFS, reporting the actual cycle.
 *
 * Iterative rather than recursive because the report needs the path, and the path is easier to
 * keep honest as an explicit stack than as call frames. Grey means "on the current path" — meeting
 * a grey node is the cycle, and slicing the path from that node gives the loop to print.
 *
 * Ported from `features/taxonomy.py`, including the choice to name the cycle: "the graph is
 * cyclic" sends you looking through every edge, and `a -> b -> c -> a` does not.
 */
function assertAcyclic(byId: ReadonlyMap<string, Concept>): void {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>([...byId.keys()].map((id) => [id, WHITE]));

  for (const root of byId.keys()) {
    if (colour.get(root) !== WHITE) continue;

    const stack: Array<{ id: string; remaining: string[] }> = [
      { id: root, remaining: [...(byId.get(root)?.prerequisites ?? [])] },
    ];
    const path = [root];
    colour.set(root, GREY);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;

      const next = top.remaining.shift();
      if (next === undefined) {
        colour.set(top.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      if (colour.get(next) === GREY) {
        const cycle = [...path.slice(path.indexOf(next)), next];
        throw new TaxonomyError(`prerequisite graph is cyclic: ${cycle.join(" -> ")}`);
      }
      if (colour.get(next) === WHITE) {
        colour.set(next, GREY);
        path.push(next);
        stack.push({ id: next, remaining: [...(byId.get(next)?.prerequisites ?? [])] });
      }
    }
  }
}

export interface Taxonomy {
  concepts: ReadonlyMap<string, Concept>;
  /** Every concept that teaches this item. Empty for an item nothing covers. */
  conceptsFor(itemId: string): Concept[];
  /** Transitive prerequisites, nearest first is NOT guaranteed — it is a set, ordered by walk. */
  ancestors(conceptId: string): Set<string>;
  /** Prerequisites before dependents. Throws on a cycle, which `validate` has already refused. */
  topological(): Concept[];
}

let cached: Taxonomy | undefined;

/** The validated graph. Validated once, on first use. */
export function taxonomy(): Taxonomy {
  if (cached !== undefined) return cached;
  validate();

  const concepts = new Map(CONCEPTS.map((c) => [c.id, c]));

  const byItem = new Map<string, Concept[]>();
  for (const concept of CONCEPTS) {
    for (const item of concept.teaches) {
      const list = byItem.get(item);
      if (list === undefined) byItem.set(item, [concept]);
      else list.push(concept);
    }
  }

  cached = {
    concepts,
    conceptsFor: (itemId) => byItem.get(itemId) ?? [],
    ancestors(conceptId) {
      const seen = new Set<string>();
      const queue = [...(concepts.get(conceptId)?.prerequisites ?? [])];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined || seen.has(next)) continue;
        seen.add(next);
        queue.push(...(concepts.get(next)?.prerequisites ?? []));
      }
      return seen;
    },
    topological() {
      // Kahn's, over a graph `validate` has already proved acyclic — so a leftover node here
      // would mean the two disagree, and that is worth saying rather than returning a short list.
      const indegree = new Map([...concepts.keys()].map((id) => [id, 0]));
      const dependents = new Map<string, string[]>();
      for (const concept of CONCEPTS) {
        indegree.set(concept.id, concept.prerequisites.length);
        for (const prerequisite of concept.prerequisites) {
          dependents.set(prerequisite, [...(dependents.get(prerequisite) ?? []), concept.id]);
        }
      }

      const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
      const ordered: Concept[] = [];
      while (ready.length > 0) {
        const id = ready.shift();
        if (id === undefined) continue;
        const concept = concepts.get(id);
        if (concept !== undefined) ordered.push(concept);
        for (const dependent of dependents.get(id) ?? []) {
          const left = (indegree.get(dependent) ?? 1) - 1;
          indegree.set(dependent, left);
          if (left === 0) ready.push(dependent);
        }
      }

      /**
       * Unreachable, and kept anyway.
       *
       * `topological()` is only reachable through `taxonomy()`, which runs `validate()` first —
       * so a cyclic graph never gets here, and mutation testing confirms nothing can observe this
       * branch. It stays because it asserts the one thing the two algorithms have to agree on,
       * and a future caller that skipped validation would otherwise get a silently short list
       * rather than an error.
       */
      if (ordered.length !== concepts.size) {
        throw new TaxonomyError("topological order is short; the graph is cyclic after all");
      }
      return ordered;
    },
  };

  return cached;
}

export interface Coverage {
  /** Concepts with no content behind them — the taxonomy claims these and cannot teach them. */
  conceptsWithoutContent: string[];
  /** Items no concept claims — reachable in the app, invisible to any concept-aware ordering. */
  itemsWithoutConcept: string[];
}

/**
 * What the taxonomy does not cover, reported rather than thrown.
 *
 * Both halves are real gaps and neither is a reason to refuse to start: a concept with no content
 * is the argument for the next authoring batch, and an item with no concept still works, it just
 * cannot be ordered. Throwing would mean the app refuses to launch over a curriculum gap, which
 * is the wrong severity by a wide margin.
 *
 * The test suite asserts on this so a gap cannot grow unnoticed, which is where the pressure to
 * close it belongs.
 */
export function coverage(): Coverage {
  const items = contentIds();
  const taught = new Set(CONCEPTS.flatMap((c) => c.teaches));

  return {
    conceptsWithoutContent: CONCEPTS.filter((c) => c.teaches.length === 0).map((c) => c.id),
    itemsWithoutConcept: [...items].filter((id) => !taught.has(id)).sort(),
  };
}

export type { Concept, ConceptCategory };
