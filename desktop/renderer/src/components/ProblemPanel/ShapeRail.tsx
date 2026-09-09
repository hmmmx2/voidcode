import type { Problem } from "@/lib/mock-data";

/**
 * What goes in, what comes out.
 *
 * Shape errors are most of what actually goes wrong writing ML code, and the statement above
 * this rail describes the *maths* — it does not say that `x` arrives as a flat list of three
 * floats and must leave as one. That gap is where the first ten minutes of every attempt go.
 *
 * Every value here is derived in main from the cases' own arguments and the reference's real
 * output (`content/shapes.ts`). Nothing is authored, so the rail cannot drift out of step with
 * the exercise the way a hand-written note would. Where a shape could not be derived it is
 * simply absent — a confidently wrong shape on an exercise about shapes is worse than none.
 */
export default function ShapeRail({ shapes }: { shapes: NonNullable<Problem["shapes"]> }) {
  return (
    <section aria-label="Input and output shapes" className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Shapes</h3>

      <div className="flex flex-wrap items-center gap-1.5">
        {shapes.inputs.map((input, index) => (
          <span key={`${input.name}-${index}`} className="flex items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden className="text-[11px] text-ink-3">
                ,
              </span>
            )}
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-line px-2 py-0.5">
              <span className="font-mono text-[11px] text-ink-3">{input.name}</span>
              <span className="font-mono text-[11px] text-ink">{input.shape}</span>
            </span>
          </span>
        ))}

        {shapes.output !== undefined && (
          <>
            <span aria-hidden className="px-0.5 text-[11px] text-ink-3">
              →
            </span>
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-line px-2 py-0.5">
              <span className="font-mono text-[11px] text-ink-3">returns</span>
              <span className="font-mono text-[11px] text-ink">{shapes.output}</span>
            </span>
          </>
        )}
      </div>

      {/* Said once, quietly. Without it a reader could reasonably assume these were written
          alongside the prose and might be stale — which is exactly the doubt that makes a
          reference rail useless. */}
      <p className="text-[11px] text-ink-3">From the first example, and what the reference returns for it.</p>
    </section>
  );
}
