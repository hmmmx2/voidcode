import {
  Container,
  Eyebrow,
  Lead,
  MonoLabel,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

/**
 * The prerequisite graph.
 *
 * This section is about the *mechanism* — a directed acyclic graph of concepts
 * with a mastery estimate per node — because that is what genuinely exists in
 * `data/concepts.yaml` and `features/taxonomy.py`, acyclicity assertion and all.
 *
 * It does not enumerate the concepts, and that is deliberate rather than coy:
 * the shipped taxonomy is classical DSA, so listing its contents on a page
 * positioned for ML interviews would be a claim the repository does not support.
 * The graph is real. Its ML contents are not built yet — tracked in
 * `docs/OPEN_QUESTIONS.md`.
 *
 * THE NODE COUNT IS 80, NOT 88. Verified by parsing `data/concepts.yaml`:
 * techniques 16, graphs 14, data_structures 12, recursion_dp 11, math 11,
 * foundations 7, strings 6, geometry 3. The page claimed 88 for some time — a
 * figure that also appeared in `docs/OPEN_QUESTIONS.md` and `MEMORY.md` and was
 * wrong in all three. `features/taxonomy.py` caps the taxonomy at exactly this
 * number, so it is also the one figure here that a reader could check.
 *
 * THE ANIMATIONS ARE APPLIED WITH `motion-safe:animate-*`, NOT PLAIN CSS.
 *
 * Two reasons, and the first is not stylistic. Tailwind v4 strips any
 * `@keyframes` block that no `--animate-*` theme variable references, so the
 * first version of this — hand-written rules inside a
 * `prefers-reduced-motion: no-preference` media query — was removed from the
 * build entirely and silently. The elements rendered, the neighbouring CSS
 * still applied, and `animationName` read `none`. Registering them in `@theme`
 * and applying them as utilities is what survives.
 *
 * Second, `motion-safe:` IS the reduced-motion gate, and it gates the right
 * way round: the un-animated state is the finished graph, so a visitor who
 * suppresses motion gets the complete diagram immediately rather than a blank
 * panel waiting for an animation that will never run.
 *
 * WHY THIS SECTION ANIMATES WHEN ALMOST NOTHING ELSE DOES
 *
 * See the block comment above the keyframes in `globals.css`. Short version: a
 * directed graph traversed *backwards* is the one claim on this page that a
 * still image cannot carry, because direction and reversal are both temporal.
 * The motion is the diagram explaining itself, not decoration, and it is the
 * only reason to break the page's one-signature-motion rule.
 */

type Node = {
  x: number;
  y: number;
  r: number;
  filled: boolean;
  label?: string;
  /** Layer index. Drives the build stagger so the graph assembles left to right. */
  depth: number;
};

const NODES: Node[] = [
  { x: 60, y: 150, r: 5, filled: true, label: "foundations", depth: 0 },
  { x: 170, y: 90, r: 4, filled: true, depth: 1 },
  { x: 170, y: 210, r: 4, filled: true, depth: 1 },
  { x: 290, y: 60, r: 4, filled: true, depth: 2 },
  { x: 290, y: 150, r: 6, filled: true, label: "you are here", depth: 2 },
  { x: 290, y: 240, r: 4, filled: false, depth: 2 },
  { x: 410, y: 100, r: 4, filled: false, depth: 3 },
  { x: 410, y: 195, r: 5, filled: false, label: "next", depth: 3 },
  { x: 530, y: 60, r: 4, filled: false, depth: 4 },
  { x: 530, y: 150, r: 4, filled: false, depth: 4 },
  { x: 530, y: 245, r: 4, filled: false, depth: 4 },
  { x: 645, y: 150, r: 5, filled: false, label: "the interview", depth: 5 },
];

const EDGES: [number, number][] = [
  [0, 1], [0, 2], [1, 3], [1, 4], [2, 4], [2, 5],
  [3, 6], [4, 6], [4, 7], [5, 7], [6, 8], [6, 9],
  [7, 9], [7, 10], [8, 11], [9, 11], [10, 11],
];

/**
 * The route the backwards trace follows: the problem just failed (`next`), back
 * through the concept the learner is on, to the prerequisite that was actually
 * missing. Reversed here so the animation reads right to left, against the
 * graph's own direction — which is the entire point being illustrated.
 */
const TRACE_ROUTE = [7, 4, 1, 0];

/** Where the trace lands. Highlighted as it arrives. */
const FOUND_INDEX = TRACE_ROUTE[TRACE_ROUTE.length - 1];

const distance = (a: Node, b: Node) => Math.hypot(b.x - a.x, b.y - a.y);

/** `M x y L x y …` through the route, plus its total length for the dash. */
function traceGeometry() {
  const points = TRACE_ROUTE.map((i) => NODES[i]);
  const d = points
    .map((n, i) => `${i === 0 ? "M" : "L"} ${n.x} ${n.y}`)
    .join(" ");
  const length = points
    .slice(1)
    .reduce((sum, n, i) => sum + distance(points[i], n), 0);
  return { d, length };
}

const BUILD_STEP = 0.11; // seconds between depth layers

export function ConceptGraph() {
  const trace = traceGeometry();

  return (
    <Section>
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-24">
          <Reveal>
            <Eyebrow>Prerequisites</Eyebrow>
            <SectionHeading>Prerequisite-aware progression.</SectionHeading>
            <Lead>
              Concepts form a directed graph rather than a list. When you fail a
              problem, the tutor traverses backwards to identify which prerequisite
              was actually missing, and addresses that instead.
            </Lead>
            <p className="mt-6 max-w-[46ch] text-[0.9375rem] leading-relaxed text-ink-2">
              This is why the second question is usually more approachable than the
              first, and why the same gap is rarely tested twice.
            </p>
          </Reveal>

          <Reveal
            delay={0.12}
            className="min-w-0 overflow-hidden rounded-panel border border-line bg-void-2 p-4 lg:p-8"
          >
            <svg
              viewBox="0 0 700 300"
              className="h-auto w-full"
              role="img"
              /* The description names the mechanism rather than the picture. A
                 caption reading "twelve circles joined by lines" would be
                 technically accurate and tell a non-sighted visitor nothing
                 about why the graph is on the page. */
              aria-label="A directed graph of concepts running left to right. Earlier nodes are filled to show mastery, later ones outlined. When a problem is failed, the tutor traces backwards through the graph to the prerequisite that was missing."
            >
              <defs>
                {/* A soft bloom behind mastered nodes. Keeps them reading as lit
                    rather than merely white, which matters on a panel this dark. */}
                <radialGradient id="graph-node-glow">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </radialGradient>
              </defs>

              {EDGES.map(([from, to]) => {
                const length = distance(NODES[from], NODES[to]);
                return (
                  <line
                    key={`${from}-${to}`}
                    className="motion-safe:animate-graph-edge"
                    x1={NODES[from].x}
                    y1={NODES[from].y}
                    x2={NODES[to].x}
                    y2={NODES[to].y}
                    stroke="#262626"
                    strokeWidth="1"
                    strokeDasharray={length}
                    style={
                      {
                        "--edge-length": length,
                        animationDelay: `${NODES[from].depth * BUILD_STEP}s`,
                      } as React.CSSProperties
                    }
                  />
                );
              })}

              {/* The backwards trace, above the edges and below the nodes. Two
                  dash segments: one bright travelling pulse, then a gap long
                  enough that nothing else of the path is ever visible. */}
              <path
                className="motion-safe:animate-graph-trace"
                d={trace.d}
                fill="none"
                stroke="#ffffff"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={`${Math.round(trace.length * 0.16)} ${Math.round(trace.length)}`}
                style={{ "--trace-length": trace.length } as React.CSSProperties}
              />

              {NODES.map((node, i) => (
                <g key={i}>
                  {node.filled && (
                    <circle
                      className="graph-shape motion-safe:animate-graph-node"
                      cx={node.x}
                      cy={node.y}
                      r={node.r * 3.2}
                      fill="url(#graph-node-glow)"
                      style={{ animationDelay: `${node.depth * BUILD_STEP + 0.14}s` }}
                    />
                  )}

                  {i === FOUND_INDEX && (
                    /* The ring that fires when the trace lands. Drawn as its own
                       element rather than by animating the node, so the node's
                       own build animation is never interrupted mid-cycle. */
                    <circle
                      className="graph-shape motion-safe:animate-graph-found"
                      cx={node.x}
                      cy={node.y}
                      r={node.r + 6}
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth="1"
                      opacity="0"
                    />
                  )}

                  <circle
                    className="graph-shape motion-safe:animate-graph-node"
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={node.filled ? "#ffffff" : "#0d0d0f"}
                    stroke={node.filled ? "#ffffff" : "#3a3a3a"}
                    strokeWidth="1"
                    style={{ animationDelay: `${node.depth * BUILD_STEP + 0.14}s` }}
                  />

                  {node.label && (
                    <text
                      className="graph-shape fill-[#848484] font-mono motion-safe:animate-graph-node"
                      x={node.x}
                      y={node.y - node.r - 10}
                      textAnchor="middle"
                      fontSize="11"
                      style={{ animationDelay: `${node.depth * BUILD_STEP + 0.22}s` }}
                    >
                      {node.label}
                    </text>
                  )}
                </g>
              ))}
            </svg>

            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4">
              <span className="flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 rounded-full bg-ink" />
                <MonoLabel>mastered</MonoLabel>
              </span>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full border border-[#3a3a3a] bg-void-2"
                />
                <MonoLabel>not yet</MonoLabel>
              </span>
              <MonoLabel className="ml-auto">80 nodes · acyclic · asserted at load</MonoLabel>
            </div>
          </Reveal>
        </div>
      </Container>
    </Section>
  );
}
