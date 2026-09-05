import { DEMO_PROBLEM } from "./demo-content";
import { MonoLabel } from "@/components/marketing/primitives/SectionShell";

/**
 * Left column. Purely presentational and identical in every demo state — it is
 * the part of the workspace that does not move, which is what makes the parts
 * that do move legible.
 *
 * Hidden below `lg`: at that width the three-column workspace collapses to
 * editor + tutor, and the problem statement is the least load-bearing of the
 * three for a visitor who is skimming.
 */
export function DemoProblemPanel() {
  return (
    <aside className="hidden min-w-0 flex-col border-r border-line bg-void-1 lg:flex">
      <div className="flex h-9 shrink-0 items-center border-b border-line-strong bg-[#262626] px-3">
        <span className="text-xs font-medium text-ink">Problem</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-ink-3">
            {DEMO_PROBLEM.difficulty}
          </span>
          <MonoLabel>{DEMO_PROBLEM.track}</MonoLabel>
        </div>

        <h3 className="mt-3 text-[0.9375rem] font-medium leading-snug text-ink">
          {DEMO_PROBLEM.title}
        </h3>

        <p className="mt-3 text-xs leading-relaxed text-ink-2">{DEMO_PROBLEM.description}</p>

        <p className="mt-4 break-all font-mono text-[11px] leading-relaxed text-ink-3">
          {DEMO_PROBLEM.signature}
        </p>

        <p className="mt-5 text-[10px] uppercase tracking-[0.18em] text-ink-3">Constraints</p>
        <ul className="mt-2 space-y-1.5">
          {DEMO_PROBLEM.constraints.map((constraint) => (
            <li key={constraint} className="flex gap-2 text-xs leading-relaxed text-ink-2">
              <span aria-hidden className="mt-[7px] h-px w-2 shrink-0 bg-line-strong" />
              {constraint}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
