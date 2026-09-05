import { Container, Eyebrow, MonoLabel } from "@/components/marketing/primitives/SectionShell";
import { Reveal } from "@/components/motion/Reveal";

/**
 * Credibility row.
 *
 * Every claim here is something that exists in this repository and can be
 * pointed at — the fine-tune config, the quantization script, the SGLang
 * compose file, the concept taxonomy. Nothing on this strip describes a
 * curriculum, because there isn't one yet (see `docs/OPEN_QUESTIONS.md`).
 *
 * That constraint turns out to be an advantage: "we run our own weights" is a
 * sharper claim for this audience than any problem count would be.
 */
/**
 * Labels are terser than they were when this was a five-column grid — a single
 * horizontal band has roughly 1160px for all of it, and the long forms overflowed
 * by ~30%. Nothing was dropped that changed a claim: "self-hosted" is now carried
 * by the eyebrow, and the rest is the same fact in fewer words.
 */
const STACK = [
  { value: "Qwen2.5-7B", label: "QLoRA fine-tuned" },
  { value: "SGLang / vLLM", label: "streaming" },
  { value: "AWQ 4-bit", label: "quantized" },
  { value: "8,192", label: "reasoning tokens" },
  { value: "80", label: "concept graph" },
];

export function StackStrip() {
  return (
    /*
      Bounded top and bottom so it reads as a band *between* sections rather than
      a section of its own — the slot a customer logo wall would occupy on a site
      that had customers. It stays text, because inventing logos is not an option
      and the stack is the more specific claim anyway.
    */
    <section className="border-y border-line py-10 lg:py-12">
      <Container>
        <Reveal>
          <div
            className={[
              "flex items-center gap-8 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              // Edge fades are the strongest logo-wall cue there is, and on
              // mobile they double as the affordance that the row scrolls.
              "[mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]",
              // `justify-between` degrades to flex-start when the row overflows,
              // so keeping the scroller and the mask at every width is safe and
              // means a slightly-too-narrow desktop scrolls instead of clipping.
              "lg:justify-between",
            ].join(" ")}
          >
            <Eyebrow className="shrink-0 whitespace-nowrap border-r border-line pr-8">
              Self-hosted infrastructure
            </Eyebrow>

            <dl className="flex shrink-0 items-center gap-8 lg:gap-6">
              {STACK.map((item) => (
                <div
                  key={item.value}
                  className="flex shrink-0 items-baseline gap-2 whitespace-nowrap"
                >
                  <dt className="text-sm font-light tracking-tight text-ink">
                    {item.value}
                  </dt>
                  <dd>
                    <MonoLabel>{item.label}</MonoLabel>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
