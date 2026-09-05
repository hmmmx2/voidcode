import {
  Container,
  Eyebrow,
  Section,
} from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

/**
 * The turn.
 *
 * One statement, enormous air, nothing else in the viewport. This is the only
 * section on the page with no supporting content — the whitespace is the design,
 * and adding a feature grid under it would defuse the line.
 */
export function ProblemStatement() {
  return (
    <Section id="why">
      <Container>
        <Reveal className="mx-auto max-w-[46rem] text-center">
          <Eyebrow>The problem</Eyebrow>
          <p className="mt-6 text-h2 text-ink">
            Code assistants accelerate delivery.
            <span className="block text-ink-3">
              They do not build understanding.
            </span>
          </p>
          <p className="mx-auto mt-8 max-w-[46ch] text-lg leading-relaxed text-ink-2">
            General-purpose assistants are optimised to produce working code.
            None are optimised to ensure you can reproduce it independently —
            under time pressure, without tooling, while explaining your
            reasoning to an interviewer.
          </p>
        </Reveal>
      </Container>
    </Section>
  );
}
