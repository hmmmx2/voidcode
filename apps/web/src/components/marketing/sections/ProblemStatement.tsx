import {
  Container,
  Eyebrow,
  Section,
} from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

/**
 * The turn.
 *
 * TWO COLUMNS ON DESKTOP, ONE ON A PHONE. The statement holds the left column and the paragraph
 * that qualifies it holds the right, so the claim and its evidence are read side by side instead of
 * the eye travelling down a single centred stack the width of a paperback.
 *
 * It was centred and stacked, and at desktop widths that meant the headline wrapped across four
 * short lines with the supporting paragraph below it — a tall, narrow column in the middle of a
 * wide screen, with the line breaks falling wherever the measure happened to put them.
 *
 * The air is still the design: the section keeps its vertical rhythm and the columns are far apart
 * (`gap-x-16`), so this is the same amount of quiet arranged horizontally. Nothing was added.
 */
export function ProblemStatement() {
  return (
    <Section id="why">
      <Container>
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          {/*
            `items-start`, not `items-center`: the two columns are different lengths, and centring
            them against each other leaves the paragraph floating with no edge to align to. Both
            start at the same line.

            `lg:grid-cols-[1.05fr_1fr]` gives the headline the slightly wider column — it is set at
            `text-h2`, so equal columns make it wrap a word earlier than the paragraph does.
          */}
          <div className="mt-6 grid items-start gap-y-8 lg:grid-cols-[1.05fr_1fr] lg:gap-x-16">
            <p className="text-h2 text-ink">
              Code assistants accelerate delivery.
              <span className="block text-ink-3">
                They do not build understanding.
              </span>
            </p>
            <p className="max-w-[46ch] text-lg leading-relaxed text-ink-2 lg:pt-2">
              General-purpose assistants are optimised to produce working code.
              None are optimised to ensure you can reproduce it independently —
              under time pressure, without tooling, while explaining your
              reasoning to an interviewer.
            </p>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}
