import {
  Container,
  Eyebrow,
  Lead,
  MonoLabel,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

const TRACKS = [
  {
    id: "01",
    name: "Implementation",
    summary:
      "Implement core primitives from first principles, without library abstractions.",
    items: [
      "Attention, multi-head and causal",
      "KV cache: append, evict, page",
      "Samplers — top-k, nucleus, temperature",
      "Tokenizers and the off-by-one that ruins them",
      "Backprop by hand through a small graph",
    ],
  },
  {
    id: "02",
    name: "Systems",
    summary:
      "Design the systems that serve them, then defend the trade-offs under questioning.",
    items: [
      "Continuous batching and the latency it costs",
      "Quantization: what you lose, and where",
      "Retrieval that survives a stale index",
      "Evaluation nobody can game",
      "Capacity planning on a fixed GPU budget",
    ],
  },
];

const FLOW = ["Attempt", "Ask", "Get questioned", "Resolve it yourself"];

/**
 * Two tracks plus the interaction loop.
 *
 * The chevron flow is Scale's device rendered in hairlines rather than filled
 * gradient shapes — the shape is what reads, and on a monochrome page the fill
 * would be the only thing on screen with a background of its own.
 */
export function TwoTracks() {
  return (
    <Section id="tracks">
      <Container>
        <Reveal className="max-w-[42rem]">
          <Eyebrow>Coverage</Eyebrow>
          <SectionHeading>Both halves of the interview loop.</SectionHeading>
          <Lead>
            Coding rounds and design rounds test different capabilities and fail
            for different reasons. Each is practised independently, against the
            same tutor.
          </Lead>
        </Reveal>

        <div className="mt-16 grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-2">
          {TRACKS.map((track, i) => (
            <Reveal key={track.id} delay={0.08 * i} className="bg-void-0 p-8 lg:p-10">
              <div className="flex items-baseline gap-3">
                <MonoLabel>{track.id}</MonoLabel>
                <h3 className="text-2xl font-light tracking-tight text-ink">{track.name}</h3>
              </div>
              <p className="mt-4 max-w-[38ch] text-[0.9375rem] leading-relaxed text-ink-2">
                {track.summary}
              </p>
              <ul className="mt-8 space-y-3 border-t border-line pt-6">
                {track.items.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 text-[0.9375rem] leading-relaxed text-ink-2"
                  >
                    <span aria-hidden className="mt-[0.7em] h-px w-3 shrink-0 bg-line-strong" />
                    {item}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>

        {/* Anchor offset now lives once on `html` as `scroll-padding-top` in
            globals.css, so every target gets it — not just this one. */}
        <div id="how" className="mt-20">
          <Reveal>
            <Eyebrow className="text-center">How it works</Eyebrow>
          </Reveal>
          <ol className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-4">
            {FLOW.map((step, i) => (
              <Reveal as="li" key={step} delay={0.07 * i} className="flex items-center gap-3">
                <span className="rounded-full border border-line-strong px-5 py-2.5 text-sm text-ink-2">
                  {step}
                </span>
                {i < FLOW.length - 1 && (
                  <span aria-hidden className="text-ink-3">
                    &rsaquo;
                  </span>
                )}
              </Reveal>
            ))}
          </ol>
        </div>
      </Container>
    </Section>
  );
}
