import { Eyebrow, MonoLabel } from "@/components/marketing/primitives/SectionShell";
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

/**
 * One pass of the strip's contents.
 *
 * Rendered twice inside the track. A component rather than `[...STACK, ...STACK]` so the eyebrow
 * repeats with the items — it is part of the phrase ("self-hosted infrastructure: Qwen2.5-7B…"),
 * and a track that repeated only the values would read as a list with one stray label in it.
 */
function StripRun({ "aria-hidden": ariaHidden }: { "aria-hidden"?: boolean }) {
  return (
    <div aria-hidden={ariaHidden} className="flex shrink-0 items-center gap-8 pr-8 lg:gap-10 lg:pr-10">
      <Eyebrow className="shrink-0 whitespace-nowrap border-r border-line pr-8 lg:pr-10">
        Self-hosted infrastructure
      </Eyebrow>

      <dl className="flex shrink-0 items-center gap-8 lg:gap-10">
        {STACK.map((item) => (
          <div key={item.value} className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
            <dt className="text-sm font-light tracking-tight text-ink">{item.value}</dt>
            <dd>
              <MonoLabel>{item.label}</MonoLabel>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}


export function StackStrip() {
  return (
    /*
      Bounded top and bottom so it reads as a band *between* sections rather than
      a section of its own — the slot a customer logo wall would occupy on a site
      that had customers. It stays text, because inventing logos is not an option
      and the stack is the more specific claim anyway.
    */
    <section className="border-y border-line py-10 lg:py-12">
      <Reveal>
        {/*
          A MOVING STRIP, AND THEREFORE NOT IN `Container`.

          A marquee has to run edge to edge: bounded to the page gutter it would visibly appear and
          disappear a centimetre inside the screen, which reads as clipping rather than as motion.
          The mask below fades both ends instead, so items arrive and leave rather than popping.

          It used to be a horizontal scroller that clipped its last item at anything under ~1160px.
          Moving it solves that at every width — nothing is ever permanently cut off, because
          everything comes around.
        */}
        <div
          className={[
            "overflow-hidden",
            "[mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]",
          ].join(" ")}
        >
          {/*
            `w-max` so the track is as wide as its contents rather than the viewport, and the
            percentage in the keyframes is a percentage of the track. Two copies of the list, the
            second `aria-hidden` — a screen reader should hear the claims once, and a duplicate is
            what makes the loop seamless rather than a jump back to the start.
          */}
          <div className="marquee-track flex w-max animate-marquee items-center">
            <StripRun />
            <StripRun aria-hidden />
          </div>
        </div>
      </Reveal>
    </section>
  );
}
