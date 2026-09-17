import { Container, Eyebrow } from "@/components/marketing/primitives/SectionShell";
import { Pill } from "@/components/ui/Pill";
import { HeroObject } from "@/components/marketing/three/HeroObject";
import { HeroHandoff } from "@/components/marketing/motion/HeroHandoff";
import { DemoWindow } from "@/components/marketing/demo/DemoWindow";

/**
 * Hero.
 *
 * Two placement decisions carry this section.
 *
 * The object sits behind and above the headline and is deliberately occluded by
 * it. Occlusion is the cheapest depth cue there is — far cheaper than trying to
 * make a monochrome glass object read as three-dimensional on its own.
 *
 * The demo sits directly under the CTAs rather than in the middle of the page. A
 * mid-page demo means a large share of visitors never reach the strongest asset
 * on the site; `HeroHandoff` resolves that by making it *become* the centre of
 * the viewport as the headline collapses.
 *
 * The <h1> is plain server-rendered text and stays that way. It is passed to
 * `HeroHandoff` as a prop precisely so it lands in the initial HTML rather than
 * behind a client boundary — it is the intended LCP element.
 */
export function Hero() {
  return (
    // `isolate` is load-bearing, not decoration. The backdrop below sits at
    // negative z so the headline can occlude it. Without a stacking context here
    // it paints behind the *layout's* black background — neither this section
    // (position:relative, z-index:auto) nor the layout wrapper creates one, so
    // the whole backdrop silently disappears.
    /*
      Bottom padding, not just top. The demo window is the last thing in this section and it sat
      flush against `StackStrip`'s top border — two bordered surfaces touching, which reads as one
      broken panel rather than as two sections.
    */
    <section className="relative isolate overflow-hidden pb-24 pt-32 lg:pb-32 lg:pt-40">
      {/* Something for the glass to refract. Flat black gives the object no
          interior; a soft vertical gradient plus one very wide bloom gives it
          volume, at the cost of two gradients. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[900px] bg-[linear-gradient(to_bottom,#111114_0%,#050506_45%,#000000_100%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-10%] -z-20 h-[720px] w-[1100px] -translate-x-1/2 animate-drift rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.045),transparent)]"
      />

      {/* Monochrome glass gradients band on 8-bit displays. One tiled noise
          layer at 3% removes it. Hero only — no other section has a gradient
          large enough to band. */}
      <div aria-hidden className="grain pointer-events-none absolute inset-0 z-0" />

      <Container className="relative z-10">
        <HeroHandoff
          /*
            No desktop vignette here, and that is a measured decision rather than
            an omission. The worry was that with the object alone in its own
            column, against the lightest part of the backdrop, its glass edges
            would wash out. A radial vignette to sink the surround turned out to
            be visibly worse: `closest-side` reaches full opacity at the box's
            half-width, so the whole corner region beyond that sits at a flat 60%
            black and stops dead at the element's edge — a hard grey square
            behind the object. Compared side by side, the object reads better
            with nothing at all.
          */
          object={<HeroObject />}
          scrim={
            /* Mobile only. Below `lg` the object floats behind the centred
               headline, and a specular streak crossing a light-weight glyph
               destroys it. This sinks the object's midtones exactly where type
               lands without touching the silhouette's edges — cheaper and more
               controllable than dimming the object, which would flatten it
               everywhere. */
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_58%_30%_at_50%_18%,rgba(0,0,0,0.8),rgba(0,0,0,0.4)_60%,transparent_82%)] lg:hidden" />
          }
          headline={
            <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
              <Eyebrow>ML &amp; systems interview preparation</Eyebrow>

              {/* `19ch`, widened from 15ch when the headline copy changed.
                  The measure and the words are coupled: at 15ch the current
                  first line broke as "Preparation that / builds /
                  understanding," — four lines with a dangling verb. Any future
                  headline edit needs this number checked with it. */}
              <h1 className="mt-6 max-w-[19ch] text-hero text-ink">
                {/* The gradient goes on this span, never the <h1>, so the
                    heading keeps a solid computed colour of its own. See
                    `.headline-gradient` in globals.css for why that matters. */}
                <span className="headline-gradient">
                  Preparation that builds understanding,
                </span>
                <span className="block text-ink-3">not just output.</span>
              </h1>

              <p className="mt-7 max-w-[44ch] text-lg leading-relaxed text-ink-2">
                A guided tutor for machine learning and systems interviews. It
                identifies where your understanding breaks down, then works
                through it with you.
              </p>

              <div className="mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
                <Pill href="#download" variant="solid" size="lg">
                  Download
                </Pill>
                <Pill href="#how" variant="outline" size="lg">
                  See how it works
                </Pill>
              </div>
            </div>
          }
          demo={<DemoWindow />}
        />
      </Container>
    </section>
  );
}
