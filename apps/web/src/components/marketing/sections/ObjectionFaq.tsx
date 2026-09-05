import {
  Container,
  Eyebrow,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

/**
 * Objection handling, not feature listing.
 *
 * A product whose entire premise is "it refuses to help you the way you want to
 * be helped" generates four predictable objections. Answering them in the
 * visitor's own words is worth more than a fifth feature row.
 *
 * Native `<details>` — no JS, no accordion library, keyboard-accessible and
 * findable by in-page search by default.
 */
const FAQ = [
  {
    q: "Isn't this slower than having a model write the code?",
    a: "Yes, considerably — and that is the trade being made. Time spent deriving something is time you do not spend re-deriving it under pressure. If you need working code shipped today, use a general-purpose assistant; this is not competing on throughput.",
  },
  {
    q: "What happens if I get genuinely stuck?",
    a: "Say so directly. Frustration is detected and routes to a different mode, where questions become smaller and more concrete until one is answerable. You will not be left without a path forward — the tutor simply will not skip you to the end.",
  },
  {
    q: "Does the tutor ever provide code?",
    a: "It provides structure and questions — a scaffold with blanks, a comment naming the sub-goal — but it does not complete them. Once a submission passes, it reviews what you wrote and gives the feedback a code reviewer would.",
  },
  {
    q: "Which model powers this?",
    a: "Our own, running on our own GPUs — a fine-tuned Qwen2.5-7B served through SGLang and quantized to 4-bit AWQ. Your code is not forwarded to a third-party API.",
  },
  {
    q: "How is my code handled?",
    a: "It is stored against your account so the tutor can read your previous submissions and history — that context is most of what makes it useful. It is not used as training data for any third party.",
  },
];

export function ObjectionFaq() {
  return (
    <Section id="faq">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-24">
          <Reveal>
            <Eyebrow>FAQ</Eyebrow>
            <SectionHeading>Questions worth asking.</SectionHeading>
          </Reveal>

          <div className="border-t border-line">
            {FAQ.map((item, i) => (
              <Reveal key={item.q} delay={0.05 * i}>
                <details className="group border-b border-line">
                  <summary className="flex cursor-pointer list-none items-center gap-6 py-6 text-[1.0625rem] font-light text-ink marker:hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink">
                    {item.q}
                    <span
                      aria-hidden
                      className="ml-auto shrink-0 text-xl font-light text-ink-3 transition-transform duration-300 ease-void group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="max-w-[62ch] pb-7 text-[0.9375rem] leading-relaxed text-ink-2">
                    {item.a}
                  </p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  );
}
