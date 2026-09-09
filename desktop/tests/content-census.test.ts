/**
 * The gaps the curriculum knows it has, in one place.
 *
 * Three separate test files pinned a hole each: `taxonomy.test.ts` held the exact list of concepts
 * with no content, `selection.test.ts` held the exact list of concepts that read as available and
 * are not, and `interviews.test.ts` held a bare problem count. Every one of them is *supposed* to
 * fail when content is authored — that is what a pin is for — but they were in three files a
 * newcomer had no reason to connect, and D8 is about to close several holes at once.
 *
 * So the pins live together now, and an authoring batch updates one reviewable place. **The pressure
 * is unchanged**: shortening a list still requires editing this file, and that edit is the record
 * that a hole was closed. What is removed is the hunt.
 *
 * ## Why these are pinned at all
 *
 * A hole must not be closeable by deleting the thing that reports it. `concepts.ts` keeps four
 * concepts with an empty `teaches` deliberately — the hole is the argument for the next authoring
 * batch, and deleting one would make the curriculum look complete by forgetting what is missing.
 * The same reasoning covers the other two lists.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/voidcode-test" } }));

const { coverage } = await import("../src/main/content/taxonomy.js");
const { gatedConcepts } = await import("../src/main/content/selection.js");
const { listProblems } = await import("../src/main/content/problems.js");
const { QUESTIONS } = await import("../src/main/content/interview-bank.js");
const { CONCEPTS } = await import("../src/main/content/concepts.js");

const EMPTY = { problems: new Map(), questions: new Map() };

describe("concepts the app claims and cannot teach", () => {
  it("is empty", () => {
    /**
     * Was `["backpropagation", "kernel-fusion", "linear-algebra", "quantization"]` — four concepts
     * that were real vocabulary in this domain and taught by nothing. D5 named them as the argument
     * for the next authoring batch, and D8 was that batch:
     *
     *   linear-algebra   -> matmul-chain-order        (which bracketing of Q K^T V is cheaper)
     *   backpropagation  -> reverse-mode-fan-out      (gradients add where a value is reused)
     *   quantization     -> int8-scale-and-zero-point (what the zero point buys)
     *   kernel-fusion    -> fusion-memory-traffic     (unfused intensity does not move)
     *
     * Empty is now the assertion. If a concept is added without content this fails, which is what
     * the pin is for — and it must not be "fixed" by deleting the concept, because that would make
     * the curriculum look complete by forgetting what is missing.
     */
    expect(coverage().conceptsWithoutContent).toEqual([]);
  });

  it("leaves no item untaught", () => {
    /**
     * The other direction, and it is a hard requirement rather than a pinned gap: an item no concept
     * claims is reachable in the app and invisible to every concept-aware ordering, so the
     * recommender cannot place it at all.
     *
     * This is the assertion that makes `concepts.ts` a mandatory edit for each new item.
     */
    expect(coverage().itemsWithoutConcept).toEqual([]);
  });
});

describe("concepts that read as available and are not", () => {
  it("is empty", () => {
    /**
     * A second kind of hole, which `coverage()` cannot see: the concept has content and its own
     * prerequisites are met, but **every item teaching it is co-taught with something not yet
     * open**. A single-item root in that position cannot be demonstrated until unrelated work is
     * done. The remedy is a standalone item, which is authoring.
     *
     * Was `["floating-point", "probability-basics"]`. Both were single-item roots whose only item
     * was co-taught with an advanced concept, so the root could not be demonstrated until unrelated
     * work was done. D8 gave each a standalone item — `ulp-and-absorption` and
     * `weighted-distribution-moments` — and both teach only their own root.
     */
    expect(gatedConcepts(EMPTY)).toEqual([]);
  });
});

describe("what the catalogue currently holds", () => {
  /**
   * Counts, and the honest reason they are here: a number in a test is a weak assertion, because it
   * says a total changed without saying what. `curriculum-parity.test.ts` already derives the
   * problem count from `listProblems()` and checks the renderer mirror against it, so the *only*
   * thing a hardcoded 14 added was a second place to edit.
   *
   * These record the totals so an authoring batch is visible in the diff of one file, and are
   * deliberately the least interesting assertions in the suite.
   */
  it("counts 16 curriculum problems and 44 interview questions", () => {
    // 44: D8 added six interview items — two standalone roots and one for each of the four holes.
    // 16: the two hard problems appended last.
    expect(listProblems()).toHaveLength(16);
    expect(QUESTIONS).toHaveLength(44);
  });

  it("has two hard curriculum problems", () => {
    /**
     * This used to assert a **gap**: `hard: 0`, written down because a number nothing checks is how
     * every other count in this repository went stale. The gap is closed, so the line now records a
     * real distribution instead of an absence — which is what a declared state is for. It cost one
     * edit to flip, and nobody had to remember it was owed.
     *
     * `layer-norm-backward` and `online-softmax`. Both hard for composition or a numerical trap
     * rather than for length: the first because the mean and variance couple every element, so the
     * term coming from `std`'s own dependence on `x` is easy to drop and invisible whenever
     * `dy * gamma` is constant; the second because a running maximum has to rescale the denominator
     * and the accumulator by exactly the same factor, and correcting one gives a finite, plausible,
     * wrong answer.
     */
    const problems = listProblems();
    const count = (difficulty: string) => problems.filter((p) => p.difficulty === difficulty).length;

    expect({ easy: count("easy"), medium: count("medium"), hard: count("hard") }).toEqual({
      easy: 6,
      medium: 8,
      hard: 2,
    });

    // Nothing is a difficulty this test does not know about, or the three counts above could sum
    // to less than the catalogue and still look right.
    expect(count("easy") + count("medium") + count("hard")).toBe(problems.length);
  });

  it("counts 52 concepts across the six categories", () => {
    // Unchanged by D8 so far: the new item closes a *gated* concept by giving an existing one a
    // second, standalone item. Closing a `teaches`-empty hole would not change this either — the
    // concept already exists, which is the point of keeping it.
    expect(CONCEPTS).toHaveLength(52);
  });

  it("teaches every item in both catalogues", () => {
    // Derived rather than typed. The interesting property is that the two agree, which
    // `itemsWithoutConcept` above already enforces — this names the number for the diff.
    const taught = new Set(CONCEPTS.flatMap((c) => c.teaches));
    expect(taught.size).toBe(listProblems().length + QUESTIONS.length);
  });
});
