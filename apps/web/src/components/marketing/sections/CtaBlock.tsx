import { Container, Section } from "@/components/marketing/primitives/SectionShell";
import { Pill } from "@/components/ui/Pill";
import { Reveal } from "@/components/motion/Reveal";

export function CtaBlock() {
  return (
    <Section divider={false} className="pb-12 lg:pb-16">
      <Container>
        <Reveal className="relative overflow-hidden rounded-cta border border-line bg-void-1 px-8 py-20 text-center lg:px-16 lg:py-28">
          {/* One soft bloom. The page's only decorative light outside the hero,
              which is what keeps it feeling like an ending rather than another
              section. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]"
          />

          <div className="relative">
            <h2 className="mx-auto max-w-[18ch] text-h2 text-ink">
              Start preparing properly.
            </h2>
            <p className="mx-auto mt-6 max-w-[44ch] text-lg leading-relaxed text-ink-2">
              Install it and work through your first problem today. No account needed.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Pill href="#download" variant="solid" size="lg">
                Download
              </Pill>
              <Pill href="#how" variant="ghost" size="lg">
                See how it works
              </Pill>
            </div>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}
