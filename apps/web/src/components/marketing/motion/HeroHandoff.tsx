"use client";

import { useEffect, useRef } from "react";
import { useShouldReduceMotion } from "@/lib/hooks/useShouldReduceMotion";

/**
 * The page's signature motion: the headline collapses and the demo takes the
 * centre of the viewport.
 *
 * This is what reconciles two things that sound contradictory — a demo "in the
 * middle of the page" and a demo in the hero. It starts under the CTAs, where
 * everyone sees it, and *becomes* the centre as you scroll. Nothing is pinned:
 * pinning plus Monaco plus a WebGL context is precisely where pages like this
 * fall over, so the hero simply scrolls away once the handoff has played.
 *
 * WHY THIS IS HAND-ROLLED
 *
 * It was written against `motion`'s `useScroll` + `useSpring` first. Measured,
 * that put 48 KB gz into the initial payload — 21% of the whole page — for one
 * tween. What it buys is a spring and a scroll subscription, both of which are
 * about thirty lines here.
 *
 * The loop also never touches React state: it writes transforms straight to the
 * three refs inside a rAF, so scrolling costs no reconciliation at all. And it
 * self-terminates once the eased value converges, so a stationary page schedules
 * no frames.
 *
 * The three slots are props rather than children so the headline stays
 * server-rendered markup in the initial HTML — it is the intended LCP element
 * and must not wait on this client boundary.
 */

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Linear map from an input sub-range onto an output range, clamped at both ends. */
function map(p: number, inEnd: number, from: number, to: number) {
  return from + (to - from) * clamp01(p / inEnd);
}

/**
 * How far through the hero each part of the handoff finishes, as a fraction of
 * the root's scrolled height.
 *
 * These are only meaningful against a measured root, because `p` is
 * `-rect.top / rect.height`. When the object moved into the grid at `lg` it
 * stopped being `absolute` and started contributing its 511px to that height:
 * measured at 1280, the root went 1112px → 1157px. Every threshold is therefore
 * the original value scaled by 1112/1157 ≈ 0.961, which keeps the handoff
 * finishing after the same number of *pixels* of scrolling rather than the same
 * fraction of a now-taller element.
 *
 * If the hero's composition changes again, re-measure — do not nudge by eye.
 */
const HEADLINE_FADE = 0.25;
const DEMO_RISE = 0.21;
const DEMO_FADE_IN = 0.135;
const OBJECT_RECEDE = 0.29;

export function HeroHandoff({
  object,
  scrim,
  headline,
  demo,
}: {
  object: React.ReactNode;
  /**
   * Full-bleed layer painted between the object and the text. Separate from
   * `object` because below `lg` the object sits behind the headline and needs a
   * scrim spanning the whole hero, while the object's own box is only the ring.
   */
  scrim: React.ReactNode;
  headline: React.ReactNode;
  demo: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const objectRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLDivElement>(null);
  const demoRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useShouldReduceMotion();

  useEffect(() => {
    const root = rootRef.current;
    const objectEl = objectRef.current;
    const headlineEl = headlineRef.current;
    const demoEl = demoRef.current;
    if (!root || !objectEl || !headlineEl || !demoEl) return;

    // Reduced motion: strip anything a previous run left behind and stop. Both
    // elements stay plainly visible — not a slower version of the same thing.
    //
    // Clearing the four properties this loop actually writes, rather than
    // `cssText = ""`. The blunt version also destroys inline custom properties
    // and anything else the markup put there — so the moment a layout needs an
    // inline `--var` on one of these three elements, reduced-motion users get a
    // silently broken page. Narrow it now, while it is free.
    if (shouldReduceMotion) {
      for (const el of [objectEl, headlineEl, demoEl]) {
        el.style.opacity = "";
        el.style.transform = "";
        el.style.filter = "";
        el.style.willChange = "";
      }
      return;
    }

    let frame = 0;
    let eased = 0;
    let target = 0;

    /**
     * Writes straight to the three elements' inline styles.
     *
     * CONSEQUENCE, and it is the easiest bug to introduce here: inline style
     * beats classes, so `transform` on any of these three refs is *owned by this
     * function*. Never put a transform utility — `-translate-x-1/2`, `rotate-*`,
     * `scale-*` — on the elements passed as `object`, `headline` or `demo`. It
     * will be deleted on the first frame and the element will jump. Put it on an
     * inner wrapper instead.
     */
    const apply = (p: number) => {
      headlineEl.style.opacity = String(map(p, HEADLINE_FADE, 1, 0));
      headlineEl.style.transform = `translateY(${map(p, HEADLINE_FADE, 0, -48)}px) scale(${map(p, HEADLINE_FADE, 1, 0.82)})`;

      demoEl.style.opacity = String(map(p, DEMO_FADE_IN, 0.8, 1));
      demoEl.style.transform = `translateY(${map(p, DEMO_RISE, 36, 0)}px) scale(${map(p, DEMO_RISE, 0.92, 1)})`;

      objectEl.style.opacity = String(map(p, OBJECT_RECEDE, 1, 0.12));
      objectEl.style.transform = `scale(${map(p, OBJECT_RECEDE, 1, 0.72)})`;
      objectEl.style.filter = `blur(${map(p, OBJECT_RECEDE, 0, 3)}px)`;
    };

    const measure = () => {
      const rect = root.getBoundingClientRect();
      return clamp01(-rect.top / Math.max(1, rect.height));
    };

    const tick = () => {
      // Approach rather than snap. 0.18 lands close to the stiff, heavily damped
      // spring this replaced: the demo should feel *placed*, not thrown, and a
      // looser value reads as lag on a trackpad.
      eased += (target - eased) * 0.18;
      if (Math.abs(target - eased) < 0.0005) eased = target;
      apply(eased);
      frame = eased === target ? 0 : requestAnimationFrame(tick);
    };

    const schedule = () => {
      target = measure();
      if (!frame) frame = requestAnimationFrame(tick);
    };

    for (const el of [objectEl, headlineEl, demoEl]) {
      el.style.willChange = "transform, opacity";
    }

    eased = target = measure();
    apply(eased);

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [shouldReduceMotion]);

  return (
    /*
      The root stays a plain block, not the grid. Two reasons: `measure()` reads
      its height, so it must span headline *and* demo; and it keeps the demo from
      becoming a grid item needing a column span.
    */
    <div ref={rootRef} className="relative">
      <div className="grid items-center gap-y-12 lg:grid-cols-[1fr_0.95fr] lg:gap-x-12">
        <div ref={headlineRef} className="origin-top">
          {headline}
        </div>

        {/*
          Two layouts in one element. Below `lg` the object is taken out of flow
          and floated behind the centred headline — keeping it out of the reading
          order, which a collapsed grid column would not do. At `lg` it becomes a
          real grid cell in the right column.

          Centring uses `left-[calc(...)]` rather than `left-1/2 -translate-x-1/2`
          on purpose: `apply()` owns `transform` on this element and would delete
          the translate on the first frame. See the note on `apply`.

          `--ring` is safe to set inline here now that the reduced-motion path
          clears four named properties instead of the whole cssText.
        */}
        <div
          ref={objectRef}
          style={{ "--ring": "clamp(300px, 38vw, 540px)" } as React.CSSProperties}
          className={[
            "pointer-events-none absolute -z-10 h-[var(--ring)] w-[var(--ring)]",
            "left-[calc(50%-var(--ring)/2)] top-[calc(var(--ring)*-0.44)]",
            "lg:relative lg:left-auto lg:top-auto lg:z-auto",
            "lg:aspect-square lg:h-auto lg:w-full lg:max-w-[620px] lg:justify-self-end",
          ].join(" ")}
        >
          {object}
        </div>
      </div>

      {/*
        Painted between the object and the text. Both this and the object sit at
        `-z-10` inside the root, so DOM order decides: object first, scrim second.
        It has to live inside this subtree because the parent Container carries
        `z-10`, and a sibling outside that stacking context could never paint
        between them.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        {scrim}
      </div>

      <div ref={demoRef} className="mt-16 origin-top lg:mt-24">
        {demo}
      </div>
    </div>
  );
}
