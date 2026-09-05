# VoidCode AI — landing page design brief

The durable design reference for the public page at `/`. Written before the build; kept in sync with it.

---

## 1. What this page is

VoidCode AI is a Socratic tutor for engineers preparing for DL/ML/LLM/VLM system-design and coding interviews. It refuses to hand over solutions. That refusal is the product, and it is the thing the page has to sell.

Before this page existed there was no public surface at all — `middleware.ts` bounced every unauthenticated request to `/login`. So `/` is net-new, and everything on it is a first impression.

**The one-line thesis:** *It won't give you the answer. That's the point.*

---

## 2. References, and how they differ

Two sources, opposite production models. They must be synthesised deliberately, not blended.

| | Scale AI | Cleve AI |
|---|---|---|
| Canvas | Pure black | `#0a0a0a`, stock shadcn neutral |
| 3D | Iridescent rendered objects throughout | **None.** Zero WebGL, zero `<canvas>` |
| Depth from | Real refraction + colour | 2D CSS: `perspective`, `blur`, `mix-blend-mode`, hairlines |
| Type | Enormous light-weight grotesque | Rubik headings / Inter body |
| Demo | None | Real ProseMirror editor + scripted regex "AI" |
| Signature motion | Section-scrubbed objects | Scroll-linked hero→demo handoff |

**Take from Scale:** the scale. Huge light type, brutal whitespace, one hero object, uppercase letterspaced eyebrows.
**Take from Cleve:** the discipline. Hairlines instead of fills, 6–8px reveals, one signature motion, a demo that is a real editor.

What we do **not** take from Scale is an iridescent object per section. That is what turns a premium page into a 2019 Dribbble shot, and it is unaffordable next to Monaco.

---

## 3. The three rules

1. **Surfaces are separated by border, not fill.** Cleve's card background is identical to its page background; the card is a 1px line. This is the single reason it reads as calm and expensive. On a monochrome page it matters double — fill variation is the only remaining axis and it must be conserved.
2. **Every section is `#000`–`#0d0d0f`. Nothing is lighter.** Contrast comes from type weight, hairlines, and the object.
3. **One signature motion, one quiet primitive.** `HeroHandoff` is the signature; `Reveal` is the primitive. Everything beyond those two makes the page feel cheaper, not richer.

---

## 4. Colour

Monochrome: black, space grey, matte black, white. One approved exception, in §5.

### Additive tokens

These are **new**. No existing token in `globals.css` may be modified — the authed app consumes all of them, and `--color-primary` / `--color-accent` / `--color-ring` all resolve to green `#2e7d32`.

| Token | Value | Role |
|---|---|---|
| `--color-void-0` | `#000000` | Page canvas |
| `--color-void-1` | `#050506` | Raised |
| `--color-void-2` | `#0d0d0f` | Panel / card |
| `--color-void-3` | `#141416` | Hover |
| `--color-ink` | `#ffffff` | Headlines, primary CTA only |
| `--color-ink-2` | `#a3a3a3` | Body |
| `--color-ink-3` | `#848484` | Tertiary, eyebrows |
| `--color-line` | `#141416` | Hairline |
| `--color-line-strong` | `#262626` | Emphasised hairline |

**White is scarce.** Reserved for headlines and the single primary CTA. That scarcity is what makes it read as emphasis. Body copy is `ink-2`, never white.

### The green trap

`@theme inline` substitutes a token's **value** into the utility, so `bg-primary` compiles to a literal `#2e7d32` and a scoped CSS-variable override cannot reach it. The landing page therefore must never use:

- `Button` at `variant="default"` (`bg-primary`)
- `Button` at `variant="outline"` or `variant="ghost"` (`hover:bg-accent/10`)
- `ring-ring` — which `button.tsx` puts on *every* variant via `focus-visible:ring-ring`

Use the landing-local `Pill` primitive instead. Enforced by a grep in the verification checklist.

---

## 5. Monochrome glass — the central problem

A clear glass object in an empty black void is a grey blob. Everything that makes glass legible is borrowed from its environment: Scale's objects get refraction structure, specular streaks and dispersion for free from a colourful HDRI. Strip the colour and every one of those has to be manufactured.

Seven moves, in order of leverage:

**1. Build an invisible environment.** 2–3 drei `<Lightformer>` rects inside `<Environment resolution={256}>` — a large soft rect above and behind at ~45°, a narrow tall rect at grazing angle on the left, a small hot rect below-right. The grazing rect produces the long specular streak that reads as "studio glass". The lightformers are never visible; they exist only in the reflection. **This is the highest-leverage decision on the page.** Without it, no material settings will save the object.

**2. Value range replaces colour range.** Hard target: the silhouette must contain a true `#000000` *and* a clipped `#ffffff` specular. Body sits `#1a1a1a`–`#3a3a3a`, rim/Fresnel around `#a3a3a3`. If the brightest pixel is `#cccccc`, it reads as plastic and the shot has failed.

**3. Micro-dispersion — the one approved colour exception.** `chromaticAberration: 0.02–0.04`. A barely-perceptible prismatic shimmer confined to high-curvature edges. It never appears as an accent, and it is the difference between "glass" and "grey resin". This is how real glass behaves.

**4. Two roughness zones.** A satin body at `0.15–0.25` that catches broad soft light and reads as volume, and polished bevels at `~0.02` that catch the sharp streaks. Uniform polish in a dark scene is invisible.

**5. Give it something to refract — in the DOM, not the scene.** Behind the canvas: a vertical `#000 → #111114` gradient plus one very wide, very soft radial bloom at ~4% white. The glass then refracts a gradient instead of flat black, which is what makes the interior read as volume. Cleve does exactly this with 2D blurred blobs, at zero cost.

**6. The silhouette carries the read.** Internal contrast is low, so the outline does the work — which rules out stock primitives. The object is a **fanned Möbius**: 114 thin blades swept around a circle, each turned a little further so the set completes **three** half-twists over one lap. Like a book's pages bent into a ring.

It still reads as a circular void — the brand is VoidCode — but the pleats give it a form worth looking at for longer than a second, and supply the depth cue the two-column layout removed along with the headline occlusion. The three twists are what produce the reference's signature: a **rounded-triangle hole**, and a rim that pinches and swells three times per lap rather than staying circular. See §15.

It went through two earlier forms — a beveled annulus, then a solid Möbius band — and the fan is the first that holds attention on its own.

*One substitution from the original brief:* it called for internal ribbing revealed by refraction as the object turns. The fan is that idea taken literally, in geometry rather than in the material.

**7. Grain.** Monochrome glass gradients band on 8-bit displays. One tiled noise layer at 3% opacity, `mix-blend-mode: overlay`, `pointer-events: none`, hero only. `overlay` rather than `normal` because `normal` lifts blacks to dark grey and undoes the point of a true-black canvas.

*Implemented as a 140×140 `feTurbulence` tile encoded once as a data URI*, rather than the PNG this brief first specified. The objection to `feTurbulence` is to running it as a live filter over live content; as a `background-image` the browser rasterises it a single time and repeats it, so it costs one small decode and no per-frame work — and it avoids adding a binary asset.

---

## 6. Typography

No new font. Inter at weight 200–300 at display sizes gives Scale's light grotesque. `Playfair_Display` is loaded on `<body>` with zero consumers anywhere in `src/` and gets deleted.

| Role | Size | Weight | Tracking | Leading |
|---|---|---|---|---|
| Hero H1 | `clamp(2.75rem, 7vw, 6.5rem)` | 300 | `-0.03em` | `0.95` |
| Section H2 | `clamp(2rem, 4vw, 3.5rem)` | 300 | `-0.02em` | `1.05` |
| Feature H3 | `1.5rem` | 400 | `-0.01em` | `1.2` |
| Lead | `1.125rem` | 400 | `0` | `1.6` |
| Body | `0.9375rem` | 400 | `0` | `1.65` |
| Eyebrow | `0.75rem` | 500 | `0.22em` upper | `1` |
| Mono label | `0.75rem` JetBrains | 400 | `0.02em` | `1` |
| Footer wordmark | `clamp(6rem, 22vw, 20rem)` | 200 | `-0.04em` | `0.8` |

---

## 7. Spacing and shape

- Container `mx-auto max-w-[1240px] px-6 lg:px-10`
- Section `py-24 lg:py-40`
- Inside a section: eyebrow → H2 = 20px · H2 → lead = 24px · lead → content = 56px
- Feature rows `lg:grid-cols-[0.75fr_1.25fr] gap-12 lg:gap-24`, alternating via `order`
- Sections separated by a `border-t` hairline — **never** by a background change
- Radii: pills `9999px` (most used) · panels `2rem` · CTA block `2.5rem` · small chrome `0.5rem`
- Shadows always soft, wide, negative-spread: `0 24px 70px -30px rgb(0 0 0 / 0.8)`. On pure black these are nearly invisible, which is correct — they exist so the demo window and feature panels lift off the void.

---

## 8. Page structure

| # | Section | Notes |
|---|---|---|
| 1 | Nav | Transparent full-width over the hero, contracting into a floating glass pill on scroll — see §8a |
| 2 | Hero | Two columns at `lg`: eyebrow / H1 / sub / two CTAs on the left, the Möbius on the right, demo full-width beneath. Below `lg` it collapses to the original centred treatment with the object floated behind the headline — see §8b |
| 3 | Stack strip | The honest ML credibility row (§10) |
| 4 | The problem | One full-width statement at H2 size with enormous air. Secondary object mark, scroll-scrubbed |
| 5 | Two tracks | Coding and Systems. Hairline chevron flow — Scale's device rendered in lines |
| 6 | Feature rows ×3 | Five tutor modes · Visible reasoning · Real execution |
| 7 | Concept graph | The 88-concept prerequisite DAG as a hairline visual |
| 8 | Objection FAQ | 4–5 hairline accordion items |
| 9 | CTA | `rounded-cta` panel, one soft bloom, white pill |
| 10 | Footer | Giant `VOIDCODE` wordmark on a native view-timeline |

---

## 8b. The two-column hero

Follows a Scale AI reference: text left, object right, gradient headline, proof band beneath. Three things about it are non-obvious.

**Mobile does not collapse into a column.** A collapsed grid would put a 320px decorative 3D blob between the headline and the demo — inserting a decorative element into the reading order and pushing the demo below the fold on exactly the devices where the transmission material costs most. Below `lg` the object stays `position: absolute`, floated behind the headline, out of flow. Verified: at 375px the grid has **one** in-flow child.

**The handoff thresholds were re-measured, not adjusted by eye.** Progress is `-rect.top / rect.height` of the root, and moving the object into the grid at `lg` made it contribute its height for the first time: the root went **1112px → 1157px**. Scaling all four thresholds by 1112/1157 keeps the handoff completing after the same *pixel* distance — measured at 289 / 243 / 336px against the old 289 / 245 / 334px, within 2px on every stage.

**`apply()` owns `transform` on the three refs.** It writes inline styles, which beat classes, so a transform utility on the `object`, `headline` or `demo` element is deleted on the first frame. Centring the object below `lg` therefore uses `left-[calc(50%-var(--ring)/2)]` rather than `left-1/2 -translate-x-1/2`. The regression test is that the object's `x` never changes while scrolling.

**No desktop vignette**, and that is a measured decision rather than an omission. Sinking the object's surround with a radial vignette looked worse: `closest-side` reaches full opacity at the box's half-width, so everything beyond that — the whole corner region — sits at a flat 60% black and stops dead at the element's edge, drawing a hard grey square behind the object. Side by side, nothing at all reads better.

The headline uses its own `--text-hero` token (`clamp(2.5rem, 4.4vw, 4rem)`) rather than `--text-display`. In a ~600px column, `--text-display`'s 104px wraps to four lines.

---

## 8a. The mark, and the navbar

### The mark

An **open aperture ring** — `components/brand/Mark.tsx`, inline SVG, `currentColor`, one component for all six call sites.

Its 0.600 hole/outer ratio was inherited from the hero object's first form, a beveled annulus at 0.594. **That echo is now approximate** — the fanned Möbius sits at 0.415 and does not hold one ratio at all. The mark is deliberately not chased: it ships in six call sites, the favicon and the generated OG image, and it still reads as the same family, a circular aperture held open. Reconciling the two should be a brand decision, not a side effect of tuning a 3D model.

**The gap is at top dead centre, and that was a correction.** The first version put it on the upper-left diagonal to match the hero's key specular. Rendered at 16–48px it read unmistakably as a **loading spinner** — an arbitrary diagonal gap is the defining cue of one, because spinners rotate. Seven alternatives were rendered and compared: a centred bar reads as a power button, concentric rings as a bullseye, a small gap vanishes to a plain ring at 16px, and variable stroke weight is not achievable with `stroke` at all (concentric arcs of differing widths step visibly at the joins). Moving the gap to a cardinal axis kills the spinner read at no cost.

Drawn as an explicit arc, never `stroke-dasharray`: a dashed `<circle>` starts at 3 o'clock and runs clockwise per SVG2, so the gap lands somewhere unintended and needs an unexplained `rotate()`. Satori's dasharray support is also patchy, which matters for the OG image. `butt` caps, because round caps eat `stroke-width/2` at each end and nearly close the notch at 16px.

`app/icon.svg` carries the same ring at viewBox 27 instead of 32 — a favicon is drawn into a 16px box where padding costs legibility. It uses **explicit colours plus a `prefers-color-scheme` block, never `currentColor`**: a favicon renders as its own document with nothing to inherit from, so `currentColor` resolves to black and vanishes against dark browser chrome.

### The navbar

Transparent and full-width over the hero; on scroll it contracts into a floating glass pill.

**The structure is the point.** The glass is a childless absolutely-positioned sibling, not a background on the bar. That separation is what keeps it cheap:

| | At rest | Scrolled |
|---|---|---|
| Bar width | 1240px | 920px |
| Bar height | **64px** | **64px** |
| Bar offset | 0 | 12px |
| Glass height | **56px** | **56px** |
| Glass opacity | 0 | 1 |

Height never animates, and neither does the glass's geometry — only its opacity crosses the compositor. The apparent shrink is entirely the bar's `max-width`, which is the single layout-animating property on the component, scoped by `contain: layout`. The naive version animates header height and background together, running ~18 layout passes over a subtree full of text during exactly the frames when `HeroHandoff`'s rAF loop is writing transforms.

Scroll state is a `data-scrolled` attribute written straight to the node from a rAF-throttled passive listener — no React state, no re-render per scroll event. **Hysteresis at 32/8**: oscillation is impossible (a fixed element cannot change document height) but flicker is not, since momentum and rubber-band settling cross a single threshold several times within a few frames.

The `@supports` order is load-bearing: near-opaque black is the *default* and the translucent white film is the enhancement. Reversed, a browser without `backdrop-filter` gets an unreadable white haze over scrolling content.

`will-change` is deliberately absent — `max-width` is not compositable, and `will-change: transform` would stack a layer on top of the one `backdrop-filter` already forces, which is the classic cause of blurry text under glass on Windows fractional DPI.

### The mobile menu

Net-new: below `md` the links were previously just `hidden` with no replacement, and "Sign in" was `hidden sm:inline-flex`, so on a phone it appeared nowhere at all. Both actions now live in the sheet.

Built on `<dialog>` + `showModal()` for the focus trap, Escape, `inert` and top-layer stacking. Two hard-won details:

- **Cleanup is synchronous, never left to the `close` event.** Measured in this project, a `dialog.close()` flipped `.open` to false while no `close` event was ever delivered. Hanging the release of a body scroll lock on a queued task means a dropped event leaves the page permanently unscrollable with no user recovery. Escape is intercepted via `onCancel` + `preventDefault` and routed through the same synchronous path; `onClose` remains only as a net.
- **Hash links must close *and* scroll, in that order.** Releasing the lock in an effect runs after paint, so the browser's jump happens first against a locked body and silently does nothing.

`lock()` and `unlock()` are both guarded by a ref. Without that, a second `lock()` captures the already-locked values as "previous" and every later unlock restores `overflow: hidden`.

---

## 9. The demo

**Placement: in the hero, directly beneath the CTAs.** Not mid-page — that means ~40% of visitors never reach the strongest asset on the site. The scroll handoff resolves this: as the headline collapses, the demo scales up and *becomes* the centre of the viewport. Same end state, better first impression.

**Chrome mirrors the real workspace**, not macOS traffic lights: `h-9 bg-[#262626] border-b border-[#333333]`, a `Code` label, and the real `ic-run-code.svg` / `ic-submit-code.svg` assets. The demo should be a screenshot of the product, not a mock of it.

**Below `md`, Monaco never loads.** A static highlighted `<pre>` with an animated caret stands in, and the scripted tutor is unchanged. Monaco on touch is a poor experience anyway, and this removes ~2 MB of CDN traffic from most mobile visits.

**Subject: scaled dot-product attention** — the canonical ML implementation interview question, with two classic planted bugs:

```python
scores = Q @ K.transpose(-2, -1)        # missing / sqrt(d_k)
attn   = torch.softmax(scores, dim=-2)  # wrong axis, should be -1
```

The axis bug is ideal for a Socratic demo: it runs without error, produces plausible output, and fails a subtle test.

**Three beats.** (1) The visitor asks for the answer and is refused, well — this is the money moment, the whole product in ten seconds. (2) A hint that moves the code by inserting a *comment scaffold, not code*, mutating the real editor buffer. (3) Debug mode on a real failing test, still without writing the fix.

**Three prompt chips are the primary interaction; free typing is secondary.** A regex miss in the hero is expensive. The fallback converts rather than apologises.

**Nothing executes.** `judge0` is a remote code execution service and putting it behind an unauthenticated public page is an unmetered cost line and an abuse surface. Run plays a 700ms canned animation and derives its result from structural markers in the buffer, so a visitor who genuinely fixes the code still gets an honest `3 / 3 passed` with zero backend.

**Reuse `ChatMessage` and `ThinkingBlock` unforked** so the demo renders pixel-identically to the real product. That identity is the entire point of having a demo.

---

## 10. What the page may and may not claim

The repo contains **no ML, LLM, VLM or system-design learner content**. The problem bank is five easy DSA problems; all 80 concepts in `data/concepts.yaml` are classical DSA.

**Honest and available:** self-hosted Qwen inference (SGLang / vLLM), QLoRA fine-tuning on Qwen2.5-7B-Instruct, AWQ quantization, an 8192-token reasoning budget with visible thinking traces, and an 88-concept prerequisite DAG mapped onto Codeforces' 38 tags with rating-band gating. That is a real "we built the stack ourselves" story and it is what the stack strip says.

**Not available:** any claim that ML system-design practice problems exist. The demo authors its own content, which is normal for a demo, but the gap between demo subject matter and shipped curriculum is a launch blocker tracked in `docs/OPEN_QUESTIONS.md`.

---

## 11. Motion

**No motion library.** This section originally specified `motion` (the Framer Motion successor) via `LazyMotion` + `m`, estimated at 18–20 KB gz. Measured after building, it was **48 KB gz landing in the initial payload — 21% of the whole page**, because `useScroll`/`useSpring`/`useTransform` pull in far more than the `domAnimation` feature bundle.

The page needs exactly two behaviours, and neither justifies that:

| Primitive | Implementation |
|---|---|
| `Reveal` | `.reveal` / `.reveal-shown` in `globals.css`; an IntersectionObserver toggles the class. `{opacity:0, y:8, blur(6px)}` → `{opacity:1, y:0, blur(0)}`, 0.5s, stagger 0/.06/.12/.18, once. **8px, not 40** |
| `HeroHandoff` | Hand-rolled: passive scroll listener → rAF → transforms written straight to three refs. Eased by `eased += (target − eased) × 0.18`, which lands close to the stiff, heavily damped spring it replaced. Never touches React state, so scrolling costs no reconciliation, and the loop self-terminates on convergence |
| Footer wordmark | Native CSS `animation-timeline: view()`. No JS |

Removing the dependency took the initial payload from **231 KB gz to 193 KB gz**. Reduced motion is now handled in CSS for `Reveal`, which also removes the possibility of the JS and the stylesheet disagreeing.

`.reveal` starts at `opacity: 0`, so the marketing layout carries a `<noscript>` override. Do not remove one without the other.

Still no GSAP, and still no Lenis — smooth-scroll hijacking is a hostile default and desyncs scroll-linked timing on trackpads.

**The object's motion:** slow idle rotation on a tilted axis plus a bob at an *incommensurate* frequency so the loop never visibly repeats; **light-rig parallax** counter-moving against the object (moving highlights sell glass far more than a moving object does, and it is nearly free); a cursor *lean* of max ±8–10°, spring-damped, desktop only — never tracking, because tracking reads as a toy; and scroll recede during the handoff.

**Reduced motion:** `Reveal` becomes opacity-only at 150ms · `HeroHandoff` is disabled entirely and both elements are statically visible · the 3D canvas never mounts and the Tier-0 still is the final state · **the demo does not autoplay** and shows a Play button instead. That last one is the most commonly missed case, and it is exactly what the preference exists to prevent.

---

## 12. Performance contract

Measured on the production build (`pnpm --filter @voidcode/web build`), gzipped, by summing the chunks referenced in the prerendered `/` HTML. Reproduce with the commands in §13.

| Budget | Target | Measured |
|---|---|---|
| LCP element | The hero H1, server-rendered, no JS. **Never** the demo or canvas | ✅ `H1` at **244 ms** (dev, localhost). Re-checked after the two-column change, which made the canvas fully in-viewport while shrinking the headline — the canvas never became a candidate at all |
| Initial `/` payload | ≤ 200 KB gz | **194 KB gz** — up 1 KB after the nav rebuild. Two `next/image` nodes were removed, but the net-new mobile menu costs slightly more than they saved |
| — of which React + React DOM | — | 76 KB gz (framework floor, not route code) |
| — of which route + Next runtime | ≤ 120 KB gz | **117 KB gz** |
| Three stack | Separate lazy chunk, after LCP on idle | **256 KB gz**, confirmed absent from the initial HTML |
| Frame rate, canvas in view | 60 fps | **60 fps** |

The three/drei chunk is over the 200 KB figure originally written here. It is left as measured rather than trimmed, because it never blocks anything: it is fetched after `requestIdleCallback`, behind a WebGL2 capability probe, and the page is complete and correct without it.

Monaco loads from `cdn.jsdelivr.net` (~2 MB) because there is no `loader.config({ monaco })` call. Invisible on the authed app; on a public page it is a critical-path third-party dependency, a CSP entry and a privacy disclosure. Mitigated with `preconnect`, viewport-intersection deferral, and `md`+ only.

The compounding risk is Monaco, three, and scroll-linked motion all wanting the main thread at once. **Sequencing is the mitigation: LCP text → idle → three → intersection → Monaco.** Nothing starts before the paint it would block.

Exactly one WebGL context on the page, ever. Secondary object marks are pre-rendered frame sequences, which also look *better* than live glass because they are not sample-limited.

---

## 13. Reproducing the measurements

```bash
pnpm --filter @voidcode/web build

cd apps/web/.next
grep -o 'chunks/[a-z0-9]*\.js' server/app/index.html | sort -u | sed 's|chunks/||' > /tmp/initial.txt
tot=0; for c in $(cat /tmp/initial.txt); do tot=$((tot + $(gzip -c "static/chunks/$c" | wc -c))); done
echo "initial: $((tot/1024)) KB gz"

# largest chunk overall — three/drei; confirm it is NOT in /tmp/initial.txt
ls -S static/chunks/*.js | head -1 | xargs -I{} sh -c 'echo "$(($(gzip -c {} | wc -c)/1024)) KB gz  {}"'
```

LCP and frame rate were read in the browser via `PerformanceObserver` on
`largest-contentful-paint` and a `requestAnimationFrame` counter, against the dev
server on localhost. Both are localhost figures and are **not** a substitute for a
field measurement on real network conditions.

## 14. Verification checklist

Route behaviour, logged out — all confirmed:

| Path | Expected | Actual |
|---|---|---|
| `/` `/terms` `/privacy` `/login` | 200 | 200 |
| `/homepage` `/courses` `/profile` `/problems/1` | redirect to `/login` | redirect |

Logged in, `/` redirects to `/homepage`, preserving what the deleted `app/page.tsx`
used to do.

Also checked: no horizontal overflow at 375 px or 1280 px; `grep` over
`components/marketing/` finds zero uses of `bg-primary`, `ring-ring`,
`hover:bg-accent`, the shared `Button`, or the literal `#2e7d32`; the demo plays
all three beats, mutates the real Monaco buffer, falls back gracefully on
unmatched input, and reports an honest `3 / 3` when both planted bugs are
actually fixed.

**Not verified by emulation:** `prefers-reduced-motion` was checked by reading the
code paths, not by toggling the OS setting — the browser tooling available here
cannot emulate the media query. The branches exist in `Reveal` (CSS `@media`),
`HeroHandoff` (early return that strips inline styles), `HeroObject` (canvas never
mounts) and `DemoWindow` (autoplay never starts, Play button shown instead), but
they should be exercised manually before launch.

**Also not verified: the mobile menu's close-on-resize-past-`md`.** The browser
pane used for testing dispatches neither `resize` nor `matchMedia` `change` events
when its viewport is changed — measured directly: `innerWidth` went 1024 → 420 and
`matchMedia("(min-width: 768px)").matches` flipped, while both event counters
stayed at 0. Every real browser fires `resize` on a viewport change, so this is a
harness limitation rather than a defect, but the behaviour is genuinely untested.
The handler listens for both `change` and `resize` and re-checks on open. **Rotate
a real phone to landscape with the menu open before launch** — the failure mode is
an invisible modal holding focus with the trigger `display: none`.

**Nav scroll behaviour was verified by driving the state directly, not by
scrolling.** `requestAnimationFrame` is suspended while that pane is not
compositing, so the rAF-throttled listener could not run and CSS transitions could
not advance. The state machine's *output* was verified by toggling `data-scrolled`
with transitions disabled (the table in §8a is those measurements), and the pill
was confirmed visually once the pane resumed compositing. The 32/8 hysteresis
itself has not been exercised against real scroll input.

---

## 15. The fanned Möbius, verified

`components/marketing/three/fan-geometry.ts` builds the whole object as one
merged `BufferGeometry`; `MobiusFan.tsx` renders it as a single mesh. Shipped
parameters: `halfTwists 3, majorRadius 1.15, bladeLength 1.02, bladeHeight 0.24,
blades 114, fill 0.50`.

### Three half-twists, not one

This is the correction that made it match the reference. For a Möbius band of
`k` half-twists the projected inner boundary has period `2π/k`, so the central
hole has k-fold symmetry. The reference sculpture's hole is unmistakably a
**rounded triangle** — k=3. The first build used `phi = theta / 2`, i.e. k=1,
which renders a round hole, and that is exactly what it rendered. Three is odd,
so the band is still non-orientable and still genuinely a Möbius strip.

The hole actually has **2k = 6** local minima, not 3: the half-extent
`a|cos(kθ/2)| + b|sin(kθ/2)|` peaks twice per half-turn of the section. They fall
in three tight pairs whose intervening maximum is ~2% shallower, so it reads as a
rounded triangle with blunted corners — closer to the reference than the sharp
deltoid the naive formula predicts.

### The taper, and why it is not obvious

Continuing the placement to blade `i = B` gives `φ = kπ`, so for odd k the blade
there is blade 0 rotated 180°. For the pattern to close, whatever sits at that
index must coincide with blade 0 — which looks like it forbids a taper, since a
narrow-inner/wide-outer section is not invariant under that flip.

It only forbids a taper defined in blade-**local** coordinates. Define it as a
function of the vertex's **world radius** and closure is automatic, because world
radius does not care which way the blade faces. The law is the one real pleated
paper obeys — constant angular width, `T = τ·ρ` with `τ = fill·π/B`.

Three things fall out of it: the blade tapers at exactly `r_out/r_in`, which is
the ratio the reference shows; the material fraction becomes identical at every
radius, which is what fixes the interpenetration below; and it degrades to
symmetric exactly at the pinches, where "which end is outward" is undefined —
which is *why* it closes.

### A bug the previous version was shipping

The old `bladeThickness < 2πR/blades` check measured pitch at the **centreline**.
But every blade plane contains the z-axis, so pitch shrinks linearly with radius
and blades are closest at their **inner tips**. Measured on the shipped values:
pitch there was 0.0456 against a thickness of 0.055 — a **negative gap of
−0.0094**. Every blade overlapped both neighbours across the inner 40% of its
length, fusing the pleats into a solid collar around the hole.

The replacement check is per-vertex and radius-independent: every vertex's
angular offset from its own half-plane must stay under `π/B`. That is sufficient
for no self-intersection anywhere, for any R, a, b.

### Construction

Not an `InstancedMesh`. Instancing is also one draw call, but it forces every
blade to share one set of vertex positions — precisely what `τ·ρ` cannot do. A
merged buffer is the same vertex-shader work minus the per-vertex matrix fetch,
is correctly bounded (so `frustumCulled={false}` and the manual
`computeBoundingSphere()` both went away), and costs ~90 KB of VRAM. Measured
side effect: worst frame improved from 26.9ms to 17.5ms.

Normals are computed per triangle rather than by `computeVertexNormals()`, which
would give the same answer only while the unshared-vertex layout holds — an
invariant nobody would notice breaking.

### Measured

| Check | Result |
|---|---|
| Seam closure (phantom blade B ≡ blade 0) | ✓ — and a blade-local wedge control correctly **fails**, so the test has teeth |
| Disjoint wedges | 0.789° vs 1.579° half-pitch — **50% of budget** |
| Min vertex radius | 0.626 > 0 |
| hole/rim · rim/hole | **0.374** · **2.674** (reference measured ~2.6) |
| Silhouette periodicity | **1.1e-15** at 2π/3; **0.326** at 2π/4 |
| Inner lobes | 6 (three tight pairs) |
| Blade taper, inner→outer tip | 0.0172 → 0.0462, ratio **2.674** |
| Frame rate | **60fps**, median 16.7ms, p95 17.0ms, worst 17.5ms |
| LCP | still the `<h1>`, sole candidate |
| `/` payload | 194 KB gz, unchanged |

**`outerRadius` needed two corrections.** `R + bladeLength/2` ignores both the
blade's height (a corner reaches `hypot(a,b)`, not `a`) and the tangential
offset. It is now `(R + hypot(a,b))·√(1+τ²)`, which matches the furthest vertex
to 7.5e-5. This figure sizes the object on screen *and* the shadow frustum, so
under-reporting it clipped the outermost blade tips out of the depth pass.

**The fan is not centrally symmetric**, and that surfaced as a false assertion
failure worth recording: C3 symmetry contains no 180° rotation, so the bounding
*box* centre sits ~0.12 off the origin and three's `computeBoundingSphere` —
which centres on that box — returns 1.758 where the radius about the origin is
1.674. Both are correct; they are different quantities. Never compare them.

### Motion — the blades move, the body does not

The object used to spin about its own normal, and the argument for that was
sound: rotating the band by Δ is *identical* to advancing every blade's twist
phase by −kΔ/2, so a rigid spin bought a travelling twist for free with no
per-frame geometry work.

**That same equivalence is why the spin had to go.** It cuts both ways — if a
uniform phase advance is a rigid rotation, then "rotate each blade in place
instead of spinning the object" is not a different animation, it is the same
animation described differently. Genuinely new motion requires a modulation that
varies *around* the ring:

```
φ(θ, t) = k·θ/2  +  Σ Aⱼ·sin(ωⱼ·t − pⱼ·θ)
          A = 0.11 @ ω 0.95, p = +3      A = 0.05 @ ω 0.58, p = −3
```

**`p` faces two separate constraints**, asserted separately: an integer closes the
seam, and a multiple of `halfTwists` preserves C3. At p = 1, 2, 4 or 5 one lobe
would animate differently from the other two. `±3` is the smallest legal choice
and gives exactly one crest per lobe.

**Two counter-propagating waves, not one.** A single wave is strictly periodic,
and a hard loop on what is now the only fast motion is the "reads mechanical"
failure this file already worried about when the object span. Two crests chasing
each other at incommensurate rates never repeat.

Combined peak amplitude is **0.16 rad, reduced from 0.23 after looking at it**: at
0.23 the lobes swing ~35° and the hole goes lopsided at the extremes, costing the
object the one feature that identifies it.

What survives on the body is deliberately slow — a 39s yaw, a 17s float, a 57s
nod and the cursor lean. None is fast enough to read as rotation; the contrast
between those and the quick ripple is what reads as a living object rather than a
turntable.

**The 0.34 base tilt must not be reduced.** At the three pinches every blade is
axial, and that tilt is the only thing keeping them a foreshortened band rather
than a row of edge-on lines.

### What the animation cost, measured

| | measured |
|---|---|
| Frame p50 / p95 / worst | **16.7 / 17.0 / 17.2 ms** — worst *improved* from 17.5 |
| `bufferSubData` per frame | **2** — position and normal, no range fragmentation |
| Upload per frame | **64.1 KB**, exactly as predicted |
| GL draw calls per frame | **4** |
| `/` payload | 194 KB gz, unchanged |
| LCP | still the `<h1>`, sole candidate |

Three things kept it that cheap.

**Normals are analytic, not cross products.** Verified against cross products to
8e-15 across every blade at eleven phases. The tip normal is exactly `u` even
though the taper tilts that face — the tilt is along the tangential axis, which
is perpendicular to `u`. And the broad-face normal is `f × e_z` with
`f = e_r + side·τ·e_w`, so **the side sign rides the θ terms, not the τ terms**;
getting that backwards produces an error of exactly 2τ, which is how the first
attempt was caught. Because that normal has no φ in it at all, the 8 broad-face
vertices per blade are written once at build and never touched again.

**The update writes in place.** The original `bladeVertices` allocated a
`Float32Array` per blade — harmless 114 times at build, ~6,800 allocations per
second in a frame loop.

**The frame callback runs at priority −1.** r3f runs subscribers in ascending
priority, and `MeshTransmissionMaterial` is a *child*, so React registers its
priority-0 subscriber first; at default priority the transmission pass would read
the previous frame's buffers.

The bounding sphere is assigned analytically once — `computeBoundingSphere()` is
two passes over every vertex for no benefit, and three centres its sphere on the
bounding *box*, which drifts because a three-lobed form has no 180° rotational
symmetry.

### Two things found while doing this

**The cursor lean had never worked.** It read `state.pointer`, but `HeroObject`'s
wrapper is `pointer-events-none` and the `<Canvas>` carries
`pointerEvents: "none"`, so r3f never receives a pointer event and `state.pointer`
stays at (0, 0) forever. It only became noticeable once the spin stopped covering
for it. Now fed by a `window` `pointermove` listener, which sidesteps r3f's event
system rather than making the object hit-testable.

**There is no orientation parameter, and there cannot be one.** The obvious
version — offsetting θ so blade 0 starts elsewhere — does nothing: the twist is a
function of world angle, so shifting θ moves which blade sits where without
moving the twist field, and the pinches stay pinned to 60°/180°/300°. Composition
is a transform (`ORIENTATION` in `MobiusFan`), set to −30° so a pinch sits at the
bottom and the form reads as a stable tripod.

**Still outstanding:** the fan is drawn **4 times per frame** — main pass,
transmission FBO, and *two* shadow passes, because three re-renders the shadow map
on every `gl.render` and drei's transmission material forces an extra one.
`gl.shadowMap.autoUpdate = false` with an explicit per-frame `needsUpdate` would
halve that, and it is a bigger lever than anything in the vertex loop. Sequencing
is delicate — the frame's first render is drei's, with the discard material bound
— so it deserves its own measured change.
