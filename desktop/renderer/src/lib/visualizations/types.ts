/**
 * Step data for the Visualize tab.
 *
 * WHY THIS IS DATA AND NOT EIGHT HAND-BUILT ANIMATIONS
 *
 * Twelve bespoke animations is twelve things to maintain and thirteen the moment
 * a problem is added. Four renderers cover the whole curriculum because the
 * shapes repeat: almost everything is a row of numbers or a grid of them, and
 * the two that are not — a token sequence and a set of boxes — are each worth
 * one renderer on their own. A new problem gets a visualization by authoring
 * steps, not by writing a component.
 *
 * WHY IT LIVES IN THE FRONTEND RATHER THAN THE DATABASE
 *
 * It is presentation, not content. Putting it in `problems` would mean a
 * column, a migration, a seed change and an API field for something no other
 * consumer of that API would ever read. Keyed by slug here, a problem with no
 * entry renders an honest empty state.
 *
 * EVERY VALUE SHOWN IS PRE-COMPUTED, DELIBERATELY.
 *
 * The renderers do no arithmetic. If the visualization computed softmax itself
 * it would be a second implementation of the thing being taught, free to drift
 * from the reference solution and from the test cases. Authoring the numbers
 * means what the learner sees is what was checked.
 */

/** A cell's role, which is the only thing that drives its styling. */
export type CellState =
  | "idle"
  /** Being read or compared this step. */
  | "active"
  /** Written this step — the thing that changed. */
  | "changed"
  /** Excluded: masked by causality, suppressed by NMS, outside the nucleus. */
  | "muted";

export type Cell = {
  /** Rendered as-is. Pre-formatted strings, never raw floats — see above. */
  value: string;
  state?: CellState;
  /** Small label under the cell: an index, a token id, a dimension name. */
  label?: string;
};

type BaseStep = {
  /** One line, present tense: "Subtract the maximum from every logit." */
  caption: string;
  /** Optional second line — the formula, or why this step exists at all. */
  detail?: string;
};

export type VectorStep = BaseStep & {
  /** Stacked rows, so a step can show input above output without a grid. */
  rows: { title?: string; cells: Cell[] }[];
};

export type MatrixStep = BaseStep & {
  grid: Cell[][];
  rowLabels?: string[];
  colLabels?: string[];
};

export type TokenStep = BaseStep & {
  tokens: Cell[];
  /** Inclusive index pair to bracket as a merge candidate. */
  bracket?: [number, number];
};

export type BoxStep = BaseStep & {
  /** Coordinates in the problem's own space; the renderer scales to fit. */
  boxes: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    label: string;
    state?: CellState;
  }[];
  extent: { width: number; height: number };
};

export type Visualization =
  | { kind: "vector"; title: string; steps: VectorStep[] }
  | { kind: "matrix"; title: string; steps: MatrixStep[] }
  | { kind: "tokens"; title: string; steps: TokenStep[] }
  | { kind: "boxes"; title: string; steps: BoxStep[] };
