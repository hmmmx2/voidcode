"use client";

import { MeshTransmissionMaterial } from "@react-three/drei";
import * as THREE from "three";

/**
 * Hoisted to a module constant, deliberately.
 *
 * `background={new THREE.Color("#000000")}` inline allocates a Color on every
 * render. Harmless in the hero, which re-renders essentially never — but these
 * materials now live on the auth pages, inside trees that re-render on every
 * keystroke of a form. One allocation per keypress is not a leak, but it is
 * garbage generated for a value that is constant.
 */
const BLACK = new THREE.Color("#000000");

/**
 * Per-object glass tuning.
 *
 * `transmission` is the value to understand before changing anything here. It is
 * NOT 1, and that is the central tuning decision for every object on this site:
 * a fully transmissive surface over a black page shows **black**. At 1 the hero
 * fan's pleats vanished everywhere except where an edge happened to catch a
 * specular, and it read as a few bright hairs around a dark mass. Holding some
 * of the surface back gives every face a base to pick the light rig up on. It is
 * still glass; it is just not a window.
 *
 * `roughness` is higher than a real polished solid for the same reason — a
 * mirror-smooth face only shows a highlight where the geometry happens to align,
 * and a little scatter lights the whole face.
 *
 * The three presets differ only where the *shape* forces them to:
 *
 * FAN — thin blades. Low thickness, and it can afford full dispersion because
 * 114 curved blades spread it thinly.
 *
 * SPHERE — a solid, so real thickness. Lower roughness than the fan: its facets
 * are flat, and a flat facet needs less scatter than a curved blade to show a
 * gradient across it.
 *
 * CUBE — a thick solid, and the one that needs dispersion pulled back. The fan
 * spreads chromatic aberration across many curved edges; a cube concentrates it
 * on twelve straight ones, where colour fringing along a perfectly straight line
 * is far more visible. At the fan's 0.026 it stops being "barely perceptible,
 * confined to high-curvature edges" and starts reading as an accent colour,
 * which breaks the monochrome rule outright. Transmission also drops: at 0.7
 * with the fan's thin `thickness` a cube reads as a hollow grey box.
 */
/**
 * `envMapIntensity` IS PER-PRESET, and the sphere's is far lower than the fan's.
 *
 * This was measured, not guessed. At the fan's 2.2 the facet sphere rendered
 * with its body sitting around #5a–#9a — well above the #1a1a1a–#3a3a3a the
 * design brief specifies, with no facet falling to true black and no clipped
 * specular anywhere. That is the brief's own definition of the failure: "if the
 * brightest pixel is #cccccc, it reads as plastic and the shot has failed." It
 * looked like matte concrete.
 *
 * The cause is geometric, not a bad number. The fan is 114 *thin* blades that
 * sit mostly edge-on to the broad FILL lightformer, so they only ever graze it.
 * 180 flat facets covering a sphere catch that same rect square-on, and every
 * one of them lifts off black. The environment contribution therefore has to be
 * roughly halved to buy back the same value range.
 *
 * The key lightformer is untouched — the specular that reads as glass comes
 * from that, and lowering the environment is precisely what lets it clip
 * against a darker body instead of washing into it.
 */
export const GLASS_PRESETS = {
  fan: {
    transmission: 0.7, thickness: 0.3, ior: 1.6,
    roughness: 0.24, chromaticAberration: 0.026, envMapIntensity: 2.2,
  },
  sphere: {
    transmission: 0.7, thickness: 0.45, ior: 1.6,
    roughness: 0.2, chromaticAberration: 0.026, envMapIntensity: 1.1,
  },
  // The cube needs the LOWEST environment contribution of the three, which is
  // the opposite of what its low `transmission` suggests.
  //
  // Measured: at envMapIntensity 1.6 it rendered as a near-white solid box —
  // body around #c0, no true black anywhere, no clipped specular. The two
  // settings compound rather than trade off. Low transmission means most of
  // what you see is *reflected* rather than transmitted, and six large flat
  // faces each reflect the broad FILL rect at full strength across their whole
  // area. The sphere at least breaks that up across 180 facets at 180 angles;
  // a cube has six.
  //
  // 0.62 is where the shadowed faces finally reach the near-black the design
  // brief asks for while the top face still clips against the key light. Below
  // ~0.5 the whole object disappears into the page.
  cube: {
    transmission: 0.55, thickness: 0.9, ior: 1.55,
    roughness: 0.16, chromaticAberration: 0.014, envMapIntensity: 0.62,
  },
  /**
   * The tesseract frame: 32 thin beams, and the exact OPPOSITE problem to the
   * cube.
   *
   * Reusing the cube preset was the obvious move and it was wrong — the frame
   * rendered as a barely-visible grey wireframe. The cube's `envMapIntensity`
   * is low because six large flat faces each catch the broad fill across their
   * whole area; a beam 0.03 units across presents almost no area to any light
   * and is usually near edge-on, so it needs the *most* environment
   * contribution of the four presets, not the least.
   *
   * This is structurally the fan's situation — thin elements against black — so
   * the values follow the fan's, with one exception. Dispersion stays at the
   * cube's low figure: a tesseract's beams are perfectly straight lines, and
   * colour fringing along a straight edge is far more conspicuous than along
   * the fan's curved blades. At 0.026 it would read as an accent colour and
   * break the monochrome rule.
   */
  frame: {
    transmission: 0.72, thickness: 0.22, ior: 1.6,
    roughness: 0.2, chromaticAberration: 0.013, envMapIntensity: 2.6,
  },
} as const;

export type GlassPreset = keyof typeof GLASS_PRESETS;

/**
 * The downgraded tier: no transmission, so no per-frame render target at all.
 *
 * This is what a 4-core device gets. It is a dark polished solid rather than
 * glass — the clearcoat and a high `envMapIntensity` are doing all the work,
 * picking the light rig up off the surface instead of through it.
 */
export function GlassMaterial({
  preset,
  downgraded,
}: {
  preset: GlassPreset;
  downgraded: boolean;
}) {
  if (downgraded) {
    return (
      <meshPhysicalMaterial
        color="#0a0a0a"
        roughness={0.18}
        metalness={0.1}
        clearcoat={1}
        clearcoatRoughness={0.06}
        reflectivity={1}
        envMapIntensity={2.4}
      />
    );
  }

  const p = GLASS_PRESETS[preset];

  return (
    <MeshTransmissionMaterial
      /* One full-scene render into a 256² FBO per frame, paid once for the whole
         mesh however many faces it holds. */
      samples={4}
      resolution={256}
      transmission={p.transmission}
      thickness={p.thickness}
      ior={p.ior}
      roughness={p.roughness}
      envMapIntensity={p.envMapIntensity}
      /* The one approved colour on this site — a barely-perceptible prismatic
         shimmer confined to high-curvature edges. */
      chromaticAberration={p.chromaticAberration}
      anisotropicBlur={0.25}
      distortion={0.18}
      distortionScale={0.3}
      temporalDistortion={0.06}
      clearcoat={1}
      clearcoatRoughness={0.06}
      attenuationDistance={1.2}
      attenuationColor="#9a9aa2"
      color="#ffffff"
      background={BLACK}
    />
  );
}
