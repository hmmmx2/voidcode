/**
 * Tensor shapes for a problem, **derived rather than written down**.
 *
 * Shape errors are most of what actually goes wrong in ML code, and nothing in the app
 * currently states what goes in or comes out. The obvious fix is a `shapes` field on
 * `Problem` — and it would be the same mistake as an `expectedOutput` field: a value typed by
 * hand that can silently disagree with what the reference does. `problems.ts` has no
 * `expectedOutput` for exactly this reason, and shapes get the same treatment.
 *
 * So: input shapes come from the cases' own arguments, and the output shape from the repr the
 * reference actually produced. Both are already computed for grading; neither is authored.
 *
 * Where a shape cannot be derived, it is **absent** rather than guessed. A wrong shape on an
 * exercise about shapes would be worse than none.
 */
import type { Problem } from "./problems.js";

export interface ShapeInfo {
  inputs: Array<{ name: string; shape: string }>;
  /** Absent when the reference's output could not be read structurally. */
  output?: string;
}

/**
 * Describe a JSON-ish value's shape the way NumPy would.
 *
 * `(3,)` with the trailing comma is deliberate — it is Python's own notation for a 1-tuple,
 * and it is what the learner sees when they print `arr.shape`. Writing `(3)` would be a
 * different thing in Python and would teach the wrong notation.
 */
export function shapeOf(value: unknown): string {
  if (!Array.isArray(value)) {
    if (typeof value === "string") return "str";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "number") return "scalar";
    // Objects, null, undefined: no honest shape.
    return "—";
  }

  const dimensions: number[] = [];
  let level: unknown = value;

  while (Array.isArray(level)) {
    dimensions.push(level.length);

    const first = level[0];
    // Ragged stops the walk: `[[1,2],[3]]` has no rectangular shape, and reporting `(2, 2)`
    // from the first row would be a confident lie.
    if (
      !Array.isArray(first) ||
      !level.every((row) => Array.isArray(row) && row.length === first.length)
    ) {
      break;
    }
    level = first;
  }

  return `(${dimensions.join(", ")}${dimensions.length === 1 ? "," : ""})`;
}

/**
 * Read a Python repr well enough to see its structure.
 *
 * The sandbox normalises results with Python's `repr`, so `['ab', 'x']` and `True` arrive in
 * Python's spelling rather than JSON's. Only the *shape* is wanted here, so a small literal
 * translation is enough — and anything that does not survive it yields no shape at all rather
 * than a parse that half worked.
 */
function parseRepr(repr: string): unknown {
  const json = repr
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    // Single- to double-quoted. Our content has no apostrophes inside string literals; if
    // that ever changes, this fails to parse and the shape is simply omitted.
    .replace(/'/g, '"');

  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * A plottable pair, for the dashboard's function plot.
 *
 * The design thesis is that **the mathematics is the imagery** — this product has no honest
 * stock photograph, but it does have the curve the exercise is about. So the plot is drawn
 * from the reference's real output for a real case, exactly like the shape rail, and never
 * from a hand-drawn illustration that could quietly stop matching the maths.
 */
export interface PlotSeries {
  /** Present only when the input is itself a plottable series of the same length. */
  input?: number[];
  output: number[];
}

/** Below two points there is no shape to see; above this it is a smear at card size. */
const MIN_POINTS = 2;
const MAX_POINTS = 64;

/**
 * A flat numeric series, or nothing.
 *
 * Deliberately strict. A list of ints that happens to be a *shape* (`[256, 256, 3]`) is
 * numerically plottable and completely meaningless as a curve, so this is only half the
 * decision — `derivePlot` below requires the output to look like a computed quantity.
 */
function numericSeries(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length < MIN_POINTS || value.length > MAX_POINTS) return undefined;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  return value as number[];
}

/**
 * The curve for a problem, when there is one worth drawing.
 *
 * Absent far more often than present, and that is correct. Cross-entropy returns a scalar,
 * BPE returns strings, broadcast-shapes returns a shape tuple — none of those is a function
 * anyone would plot, and drawing them anyway would be decoration pretending to be data.
 *
 * The test for "is this a computed quantity" is that the values are not all integers. Every
 * problem here that returns a genuine curve — softmax, sigmoid, layer-norm, attention —
 * returns floats; every one that returns a shape, an index list or a count returns integers.
 * That is a heuristic rather than a proof, and it is deliberately biased towards showing
 * nothing.
 */
export function derivePlot(
  /**
   * Structurally minimal on purpose: the cases, and nothing else.
   *
   * `PublicProblem` — what the dashboard has — omits `reference` entirely, and requiring the
   * full `Problem` here would have forced a cast that quietly handed the answer key to a
   * surface that must never see it. Narrow parameters keep the firewall structural.
   */
  problem: { cases: ReadonlyArray<{ visible: boolean; args?: readonly unknown[] }> },
  outputRepr?: string
): PlotSeries | undefined {
  if (outputRepr === undefined) return undefined;

  const output = numericSeries(parseRepr(outputRepr));
  if (output === undefined) return undefined;
  if (output.every((n) => Number.isInteger(n))) return undefined;

  const sample = problem.cases.find((c) => c.visible) ?? problem.cases[0];
  // `args` is absent on a hidden case in the public projection — the arguments are redacted
  // along with the expected output — so this cannot assume it is there.
  const input = numericSeries(sample?.args?.[0]);

  // Only when it lines up point-for-point. A five-element input against a three-element
  // output is two different things on one axis.
  return input !== undefined && input.length === output.length ? { input, output } : { output };
}

/**
 * Parameter names from the starter template.
 *
 * The template is the signature the learner is handed, so its parameter names are the ones
 * they will use — which makes them the right labels. Positional `arg 1`, `arg 2` would be
 * accurate and useless.
 */
export function parameterNames(problem: Problem): string[] {
  // `[\s\S]` rather than `.` so a signature wrapped across lines still matches.
  const signature = new RegExp(`def\\s+${problem.entry}\\s*\\(([\\s\\S]*?)\\)`).exec(
    problem.template
  );
  if (signature?.[1] === undefined) return [];

  return signature[1]
    .split(",")
    .map((part) =>
      part
        // Drop a default value and a type annotation, keeping the name.
        .split("=")[0]!
        .split(":")[0]!
        .trim()
    )
    .filter((name) => name !== "" && name !== "self");
}

/**
 * Shapes for a problem, from one representative case.
 *
 * The first *visible* case, because that is the one the learner is looking at while they read
 * the rail. A hidden case may be deliberately degenerate — a single element, an empty list —
 * and would describe the exercise misleadingly.
 */
export function deriveShapes(problem: Problem, outputRepr?: string): ShapeInfo | undefined {
  const sample = problem.cases.find((c) => c.visible) ?? problem.cases[0];
  if (sample === undefined) return undefined;

  const names = parameterNames(problem);

  const inputs = sample.args.map((arg, index) => ({
    // Fall back to a position when the template could not be parsed — a shape with a weak
    // label still beats no shape.
    name: names[index] ?? `arg ${index + 1}`,
    shape: shapeOf(arg),
  }));

  if (inputs.length === 0) return undefined;

  const parsed = outputRepr === undefined ? undefined : parseRepr(outputRepr);
  const output = parsed === undefined ? undefined : shapeOf(parsed);

  return { inputs, ...(output !== undefined && output !== "—" ? { output } : {}) };
}
