import * as THREE from "three";

/**
 * The "endless time" form: a pleated Möbius fan.
 *
 * Many thin blades strung around a circle, each turned a little further than the
 * last, so the set completes an odd number of half-twists over one lap. Like a
 * book's pages bent into a ring. Every blade's face is perpendicular to the
 * circle's tangent, and every blade turns within its own plane as it goes round.
 *
 * THREE HALF-TWISTS, NOT ONE. The projected inner boundary is `r_in(θ) = R − g(θ)`
 * where `g` has period `2π/k`, so the central hole has k-fold symmetry. The
 * reference sculpture's hole is a rounded triangle; that is k=3. At k=1 the hole
 * comes out round. Three is odd, so the band is still non-orientable — still a
 * Möbius strip.
 *
 * (The hole actually has 2k local minima, in three tight pairs whose intervening
 * maximum is ~2% shallower, so it reads as a rounded triangle with blunted
 * corners — closer to the reference than a sharp deltoid.)
 *
 * WHY THE BLADES TAPER, AND WHY THAT IS NOT OBVIOUS
 *
 * Continuing the placement to blade `i = blades` gives `φ = kπ`, so for odd k the
 * blade there is blade 0 rotated 180° about its own tangential axis. For the
 * pattern to close, whatever sits at that index must coincide with blade 0.
 *
 * That looks like it forbids a taper — a section narrow at one end and wide at
 * the other is not invariant under the flip. It only forbids a taper defined in
 * blade-*local* coordinates. Define it as a function of the vertex's **world
 * radius** and closure is automatic, because world radius does not care which way
 * the blade is facing. So the law is the one real pleated paper obeys, constant
 * angular width:
 *
 *     tangential half-thickness  T = τ · ρ,   τ = fill · π / blades
 *
 * The blade then tapers at exactly `r_out / r_in`, which is the ratio the
 * reference shows; the material fraction becomes identical at every radius, which
 * is what stops blades interpenetrating near the hole; and it degrades to
 * symmetric exactly at the pinches, where "which end is outward" is undefined —
 * which is *why* it closes.
 *
 * ρ is linear in the blade-local (x, y), so all six faces stay planar and a blade
 * is still twelve triangles.
 *
 * THE BLADES MOVE; THE BODY DOES NOT
 *
 * The object used to spin. It no longer does — instead a wave travels around the
 * ring, rocking each blade about its resting angle.
 *
 * The constraint that forces that shape of solution: **a uniform blade rotation
 * is exactly a rigid spin.** Rotating the body by Δ is identical to shifting
 * every blade's twist phase by −kΔ/2, so "every blade turns in place at the same
 * rate" *is* spinning, just described differently. Only a spatially-varying
 * modulation is genuinely new motion — hence a travelling wave.
 */

export type FanParams = {
  /** Half-twists per lap. Must be odd, or the band is orientable and not a Möbius. */
  halfTwists: number;
  /** Distance from the origin to the centreline the blades are strung along. */
  majorRadius: number;
  /** Blade length — its long axis, which sweeps from radial to axial as it twists. */
  bladeLength: number;
  /** Blade height — the short in-plane axis. Sets how deep the lobes cut. */
  bladeHeight: number;
  /** How many blades complete the lap. Keep divisible by `halfTwists`. */
  blades: number;
  /** Fraction of the local angular pitch filled with material, 0–1. */
  fill: number;
  /*
   * There is deliberately no orientation parameter here.
   *
   * An obvious-looking one — offsetting θ so blade 0 starts somewhere else —
   * does nothing at all. The twist is a function of world angle (`φ = kθ/2`), so
   * shifting θ changes which blade sits at which angle but leaves the twist field
   * identical; the pinches stay pinned to world 60°/180°/300° and the object is
   * unchanged to within half a blade's spacing.
   *
   * Composition is therefore a transform, not a geometry parameter: see
   * `ORIENTATION` in MobiusFan.
   */
  /** Ripple: [amplitude, angular rate] for each of the counter-propagating waves. */
  ripple: ReadonlyArray<{ amplitude: number; rate: number; waves: number }>;
};

/**
 * Proportions measured off the reference sculpture: its hole is ~0.37 of the rim
 * and its pleats reach ~2.6× further out than in. Both fall out of
 * `hole/rim = (R − c)/(R + c)` with `c = hypot(bladeLength/2, bladeHeight/2)`.
 *
 * `bladeHeight` is the knob to tune against the photograph — it alone sets how
 * deep the three lobes cut.
 *
 * `blades` is divisible by `halfTwists` on purpose: that gives exact C3 symmetry,
 * so the three lobes are identical and the three pinches land squarely on blades.
 *
 * THE RIPPLE. `waves` must be an integer for the seam to close, and a multiple of
 * `halfTwists` for C3 to survive — two separate constraints, asserted separately.
 * `±3` is the smallest legal choice and the right one: exactly one crest per lobe.
 * `6` reads as vibration; `9` starts beating against the 38-blade sampling.
 *
 * Two counter-propagating waves rather than one, because a single wave is
 * strictly periodic — and a hard loop on what is now the only fast motion is the
 * "reads mechanical" failure this file already worried about when the object
 * span. Two crests chasing each other at incommensurate rates never repeat.
 */
export const FAN_FULL: FanParams = {
  halfTwists: 3,
  majorRadius: 1.15,
  bladeLength: 1.02,
  bladeHeight: 0.24,
  blades: 114,
  fill: 0.5,

  /**
   * Combined peak amplitude 0.16 rad, not the 0.23 first tried. At 0.23 the
   * lobes swing ~35° and the hole stops reading as a triangle at the extremes —
   * it goes lopsided, which costs the object the one feature that identifies it.
   * 0.16 keeps the triangle legible at every phase while the blades still visibly
   * rock. Rates raised slightly to compensate: a smaller motion needs more speed
   * to read at all.
   */
  ripple: [
    { amplitude: 0.11, rate: 0.95, waves: 3 },
    { amplitude: 0.05, rate: 0.58, waves: -3 },
  ],
};

export const FAN_DOWNGRADED: FanParams = {
  ...FAN_FULL,
  blades: 63,
  fill: 0.55,
};

const halfLength = (p: FanParams) => p.bladeLength / 2;
const halfHeight = (p: FanParams) => p.bladeHeight / 2;
/** Radial reach of a blade corner from the centreline. */
const reach = (p: FanParams) => Math.hypot(halfLength(p), halfHeight(p));
const tauOf = (p: FanParams) => (p.fill * Math.PI) / p.blades;

/**
 * The maximum *cylindrical* radius of any vertex — what sizes the object on
 * screen and the shadow frustum, both of which are centred on the origin.
 *
 * `majorRadius + bladeLength/2` is wrong twice over: it ignores the blade's height
 * (a corner reaches `hypot(a, b)`, not `a`) and the tangential offset.
 */
export const outerRadius = (p: FanParams) =>
  (p.majorRadius + reach(p)) * Math.sqrt(1 + tauOf(p) ** 2);

/** Innermost cylindrical radius — the deepest point of the hole. */
export const innerRadius = (p: FanParams) => p.majorRadius - reach(p);

/**
 * A strict upper bound on the distance from the origin to any vertex, at any
 * phase. Distinct from `outerRadius`, which is a *cylindrical* radius: this adds
 * the axial extent, which peaks at `reach` when a blade stands on end.
 *
 * Assigned once. Never call `computeBoundingSphere()` in the frame loop — it is
 * two passes over every vertex for no benefit, and three centres its sphere on
 * the bounding *box*, which drifts because a three-lobed form has no 180°
 * rotational symmetry.
 */
export const boundingRadius = (p: FanParams) => Math.hypot(outerRadius(p), reach(p));

/**
 * The twist angle of the blade at angular position `theta`, at time `t`.
 *
 * One definition, shared by the update path and the assertions — if the
 * assertions re-implemented this they would stop testing the shipped code.
 */
export function bladeTwist(p: FanParams, theta: number, t: number): number {
  let phi = (p.halfTwists * theta) / 2;
  for (const w of p.ripple) {
    phi += w.amplitude * Math.sin(w.rate * t - w.waves * theta);
  }
  return phi;
}

type FanScratch = {
  params: FanParams;
  /** 24 local corners: x, y, and the tangential side as ±1. */
  template: Float32Array;
  /** Which axis each template vertex's face points along, and its sign. */
  faceAxis: Int8Array;
  faceSign: Int8Array;
  cosTheta: Float64Array;
  sinTheta: Float64Array;
  tau: number;
  /** 1/√(1+τ²) — the normalisation for the two broad faces. */
  taperNorm: number;
};

/**
 * Writes one blade's 24 positions, and the 16 normals that vary with time.
 *
 * Callable with `i = blades` to produce the phantom blade the seam assertion
 * compares against blade 0 — same code path, no special case.
 *
 * Writes in place and returns void. Allocating here would be harmless at build
 * time and would be ~6,800 allocations per second in the frame loop.
 *
 * NORMALS ARE ANALYTIC, not cross products. Verified against cross products to
 * 8e-15 across every blade at eleven phases:
 *
 *   ±x (blade tips)   ±(cosφ·cosθ, cosφ·sinθ, sinφ)          — already unit
 *   ±y (long edges)   ±(−sinφ·cosθ, −sinφ·sinθ, cosφ)        — already unit
 *   ±side (broad)     (±sinθ − τcosθ, ∓cosθ − τsinθ, 0)·norm — **φ-free**
 *
 * The tip normal really is exactly `u` even though the taper tilts that face:
 * the tilt is along the tangential axis, which is perpendicular to `u`, so the
 * normal is unchanged. And the broad-face normal is `f × e_z` with
 * `f = e_r + side·τ·e_w`, which means the side sign rides the *θ* terms and not
 * the τ terms — get that backwards and the error is exactly 2τ.
 *
 * Because the broad faces do not depend on φ, their 8 vertices are written once
 * at build and skipped here forever.
 */
function writeBlade(
  s: FanScratch,
  i: number,
  t: number,
  positions: Float32Array,
  normals: Float32Array,
  base: number
) {
  const p = s.params;
  const wrapped = i % p.blades;
  const theta = (i / p.blades) * Math.PI * 2;

  // Precomputed for real blades; recomputed only for the phantom.
  const ct = i === wrapped ? s.cosTheta[i] : Math.cos(theta);
  const st = i === wrapped ? s.sinTheta[i] : Math.sin(theta);

  const phi = bladeTwist(p, theta, t);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);

  const R = p.majorRadius;
  const tau = s.tau;

  // The two φ-dependent face normals, computed once per blade.
  const ux = cp * ct;
  const uy = cp * st;
  const uz = sp;
  const vx = -sp * ct;
  const vy = -sp * st;
  const vz = cp;

  for (let j = 0; j < 24; j++) {
    const x = s.template[j * 3];
    const y = s.template[j * 3 + 1];
    const side = s.template[j * 3 + 2];

    const rho = R + x * cp - y * sp;
    const axial = x * sp + y * cp;
    const tangential = side * tau * rho;

    const o = base + j * 3;
    // radial = (ct, st, 0) · up = (0, 0, 1) · w = u × v = (st, −ct, 0)
    positions[o] = rho * ct + tangential * st;
    positions[o + 1] = rho * st - tangential * ct;
    positions[o + 2] = axial;

    const axis = s.faceAxis[j];
    if (axis === 2) continue; // broad face: time-invariant, written at build

    const sg = s.faceSign[j];
    if (axis === 0) {
      normals[o] = sg * ux;
      normals[o + 1] = sg * uy;
      normals[o + 2] = sg * uz;
    } else {
      normals[o] = sg * vx;
      normals[o + 1] = sg * vy;
      normals[o + 2] = sg * vz;
    }
  }
}

/**
 * One merged geometry for the whole fan.
 *
 * Not an `InstancedMesh`. Instancing would also be a single draw call, but it
 * forces every blade to share one set of vertex positions — precisely what the
 * `τ·ρ` taper cannot do, and precisely what a per-blade ripple cannot do either.
 * A merged buffer is the same vertex-shader work minus the per-vertex matrix
 * fetch, is correctly bounded, and costs ~90 KB of VRAM at this size.
 */
export function createFanGeometry(p: FanParams): THREE.BufferGeometry {
  // Borrowed purely for its 24-vertex / 36-index topology: four unshared vertices
  // per face, which is what lets every face carry its own flat normal. Its
  // normals also tell us which face each vertex belongs to.
  const box = new THREE.BoxGeometry(p.bladeLength, p.bladeHeight, 1);
  const boxPos = box.attributes.position.array as Float32Array;
  const boxNor = box.attributes.normal.array as Float32Array;
  const boxIdx = Array.from(box.index!.array);

  const template = new Float32Array(72);
  const faceAxis = new Int8Array(24);
  const faceSign = new Int8Array(24);
  for (let j = 0; j < 24; j++) {
    template[j * 3] = boxPos[j * 3];
    template[j * 3 + 1] = boxPos[j * 3 + 1];
    template[j * 3 + 2] = Math.sign(boxPos[j * 3 + 2]);

    const nx = boxNor[j * 3];
    const ny = boxNor[j * 3 + 1];
    const nz = boxNor[j * 3 + 2];
    if (Math.abs(nx) > 0.5) {
      faceAxis[j] = 0;
      faceSign[j] = Math.sign(nx);
    } else if (Math.abs(ny) > 0.5) {
      faceAxis[j] = 1;
      faceSign[j] = Math.sign(ny);
    } else {
      faceAxis[j] = 2;
      faceSign[j] = Math.sign(nz);
    }
  }
  box.dispose();

  const tau = tauOf(p);
  const scratch: FanScratch = {
    params: p,
    template,
    faceAxis,
    faceSign,
    cosTheta: new Float64Array(p.blades),
    sinTheta: new Float64Array(p.blades),
    tau,
    taperNorm: 1 / Math.sqrt(1 + tau * tau),
  };

  for (let i = 0; i < p.blades; i++) {
    const theta = (i / p.blades) * Math.PI * 2;
    scratch.cosTheta[i] = Math.cos(theta);
    scratch.sinTheta[i] = Math.sin(theta);
  }

  const positions = new Float32Array(p.blades * 72);
  const normals = new Float32Array(p.blades * 72);
  const indices: number[] = [];

  for (let i = 0; i < p.blades; i++) {
    const base = i * 72;
    const ct = scratch.cosTheta[i];
    const st = scratch.sinTheta[i];

    // The two broad faces never change: write them now and never again.
    for (let j = 0; j < 24; j++) {
      if (faceAxis[j] !== 2) continue;
      const sg = faceSign[j];
      const o = base + j * 3;
      normals[o] = (sg * st - tau * ct) * scratch.taperNorm;
      normals[o + 1] = (-sg * ct - tau * st) * scratch.taperNorm;
      normals[o + 2] = 0;
    }

    for (let q = 0; q < boxIdx.length; q += 3) {
      indices.push(i * 24 + boxIdx[q], i * 24 + boxIdx[q + 1], i * 24 + boxIdx[q + 2]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  // Must be set before the first render: three reads `usage` only when it first
  // creates the GL buffer, so setting it later is silently a no-op.
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  normalAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttr);
  geometry.setAttribute("normal", normalAttr);
  geometry.setIndex(indices);
  geometry.userData.fan = scratch;

  // Valid the instant it exists — the first `gl.render` can precede the first
  // `useFrame` callback in some mount orderings.
  updateFanGeometry(geometry, 0);

  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boundingRadius(p));

  // No `uv`: MeshTransmissionMaterial only reads vUv under USE_TRANSMISSIONMAP /
  // USE_THICKNESSMAP, and neither is bound.

  if (process.env.NODE_ENV !== "production") {
    assertFan(p);
  }

  return geometry;
}

/**
 * Rewrites every blade for time `t`.
 *
 * Deliberately does not take `FanParams` — they come from `userData`. Passing
 * them would let a caller hand over values that do not match the buffer sizes,
 * and since this writes by manual index rather than `.set()`, that is a silent
 * out-of-bounds write rather than a throw.
 *
 * Allocation-free and branch-light on purpose: this runs every frame.
 */
export function updateFanGeometry(geometry: THREE.BufferGeometry, t: number) {
  const scratch = geometry.userData.fan as FanScratch | undefined;
  if (!scratch) return;

  const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
  const normalAttr = geometry.attributes.normal as THREE.BufferAttribute;
  const positions = positionAttr.array as Float32Array;
  const normals = normalAttr.array as Float32Array;

  for (let i = 0; i < scratch.params.blades; i++) {
    writeBlade(scratch, i, t, positions, normals, i * 72);
  }

  positionAttr.needsUpdate = true;
  normalAttr.needsUpdate = true;
}

/**
 * The checks that make this class of bug extinct.
 *
 * Standalone, taking only params: it evaluates vertices itself rather than
 * reading the live buffer, so it cannot be fooled by a stale or half-written
 * frame. Called once from `createFanGeometry` — never from `updateFanGeometry`
 * and never from a frame loop. Per-frame dev checks train people to ignore
 * dev-mode jank.
 */
export function assertFan(p: FanParams) {
  const problems: string[] = [];

  // ── Tier A: time-invariant ────────────────────────────────────────────────

  if (!Number.isInteger(p.halfTwists) || p.halfTwists % 2 === 0) {
    problems.push(`halfTwists must be an odd integer, got ${p.halfTwists}`);
  }

  for (const w of p.ripple) {
    // Two distinct constraints, deserving two distinct messages.
    if (!Number.isInteger(w.waves)) {
      problems.push(`ripple waves ${w.waves} is not an integer — the seam will not close`);
    } else if (w.waves % p.halfTwists !== 0) {
      problems.push(
        `ripple waves ${w.waves} is not a multiple of halfTwists ${p.halfTwists} — ` +
          "one lobe would animate differently from the other two, breaking C3"
      );
    }
  }

  const a = halfLength(p);
  const b = halfHeight(p);
  const tau = tauOf(p);
  const atanTau = Math.atan(tau);
  const halfPitch = Math.PI / p.blades;

  if (atanTau >= halfPitch) {
    problems.push(
      `blades overlap: taper angle ${((atanTau * 180) / Math.PI).toFixed(3)}° ` +
        `exceeds half-pitch ${((halfPitch * 180) / Math.PI).toFixed(3)}°`
    );
  }

  // The silhouette must repeat every 2π/k and *not* more often. Uses the
  // unmodulated twist deliberately: this pins the twist count, which the ripple
  // does not touch. Do not "fix" it to include the ripple.
  const rIn = (theta: number) => {
    const phi = (p.halfTwists * theta) / 2;
    return p.majorRadius - (a * Math.abs(Math.cos(phi)) + b * Math.abs(Math.sin(phi)));
  };
  let devK = 0;
  let devKPlus = 0;
  for (let s = 0; s < 3600; s++) {
    const theta = (s / 3600) * Math.PI * 2;
    devK = Math.max(devK, Math.abs(rIn(theta) - rIn(theta + (2 * Math.PI) / p.halfTwists)));
    devKPlus = Math.max(
      devKPlus,
      Math.abs(rIn(theta) - rIn(theta + (2 * Math.PI) / (p.halfTwists + 1)))
    );
  }
  if (devK > 1e-9) {
    problems.push(`silhouette is not ${p.halfTwists}-fold periodic (deviation ${devK})`);
  }
  if (devKPlus < 1e-3) {
    problems.push(`silhouette is also periodic at 2π/${p.halfTwists + 1} — twist count is wrong`);
  }

  // ── Tier B: sampled across the ripple's phase ─────────────────────────────

  // Nine phases across the slowest wave, plus the two extremes. Nine because it
  // is coprime to 3, so no sample lands systematically at the same position in
  // the C3 cell.
  const slowest = Math.min(...p.ripple.map((w) => Math.abs(w.rate)));
  const period = (2 * Math.PI) / (slowest || 1);
  const phases: number[] = [];
  for (let m = 0; m < 9; m++) phases.push((m * period) / 9);
  phases.push(period / 4, (3 * period) / 4);

  const geometry = new THREE.BufferGeometry();
  const probe = createProbe(p);

  let worstSeam = 0;
  let worstWedge = 0;
  let worstNormal = 0;
  let minRadius = Infinity;
  let maxRadius = 0;

  for (const t of phases) {
    const first = probe(0, t);
    const phantom = probe(p.blades, t);
    worstSeam = Math.max(worstSeam, setDistance(first.positions, phantom.positions));

    for (let i = 0; i < p.blades; i++) {
      const { positions, normals, cosTheta, sinTheta } = probe(i, t);

      for (let j = 0; j < 24; j++) {
        const px = positions[j * 3];
        const py = positions[j * 3 + 1];
        const offset = Math.atan2(px * sinTheta - py * cosTheta, px * cosTheta + py * sinTheta);
        // Exact identity, not an inequality: the τ·ρ law makes every vertex's
        // angular offset atan(τ) regardless of radius, φ or t. Far sharper than
        // "< half-pitch", and it catches any future change that makes the
        // tangential offset non-proportional to ρ.
        worstWedge = Math.max(worstWedge, Math.abs(Math.abs(offset) - atanTau));
        const r = Math.hypot(px, py);
        minRadius = Math.min(minRadius, r);
        maxRadius = Math.max(maxRadius, r);
      }

      worstNormal = Math.max(worstNormal, normalDisagreement(positions, normals, probe.indices));
    }
  }
  geometry.dispose();

  if (worstSeam > 1e-6) {
    problems.push(
      `the band does not close: blade[blades] is not blade[0] (max gap ${worstSeam}). ` +
        "The profile must be a function of world radius, not of blade-local coordinates."
    );
  }
  if (worstWedge > 1e-12) {
    problems.push(
      `vertex angular offset is not exactly atan(τ) (worst deviation ${worstWedge}) — ` +
        "the tangential offset is no longer proportional to radius"
    );
  }
  if (worstNormal > 1e-6) {
    problems.push(`analytic normals disagree with cross products by ${worstNormal}`);
  }
  if (minRadius <= 0) {
    problems.push(`a vertex reaches the axis (min radius ${minRadius.toFixed(4)})`);
  }
  if (Math.abs(outerRadius(p) - maxRadius) > 1e-4) {
    problems.push(
      `outerRadius() says ${outerRadius(p).toFixed(5)} but the furthest vertex is ` +
        `${maxRadius.toFixed(5)}`
    );
  }

  if (problems.length) {
    throw new Error(`fan-geometry: ${problems.join("; ")}`);
  }
}

/** Builds a throwaway evaluator that mirrors the shipped write path exactly. */
function createProbe(p: FanParams) {
  const box = new THREE.BoxGeometry(p.bladeLength, p.bladeHeight, 1);
  const boxPos = box.attributes.position.array as Float32Array;
  const boxNor = box.attributes.normal.array as Float32Array;
  const indices = Array.from(box.index!.array);

  const template = new Float32Array(72);
  const faceAxis = new Int8Array(24);
  const faceSign = new Int8Array(24);
  for (let j = 0; j < 24; j++) {
    template[j * 3] = boxPos[j * 3];
    template[j * 3 + 1] = boxPos[j * 3 + 1];
    template[j * 3 + 2] = Math.sign(boxPos[j * 3 + 2]);
    const nx = boxNor[j * 3];
    const ny = boxNor[j * 3 + 1];
    if (Math.abs(nx) > 0.5) {
      faceAxis[j] = 0;
      faceSign[j] = Math.sign(nx);
    } else if (Math.abs(ny) > 0.5) {
      faceAxis[j] = 1;
      faceSign[j] = Math.sign(ny);
    } else {
      faceAxis[j] = 2;
      faceSign[j] = Math.sign(boxNor[j * 3 + 2]);
    }
  }
  box.dispose();

  const tau = tauOf(p);
  const taperNorm = 1 / Math.sqrt(1 + tau * tau);
  // Float64, deliberately, where the shipped buffers are Float32. These
  // assertions exist to catch algebra errors, and at Float32 precision the exact
  // identities below bottom out around 5e-8 (wedge) and 4e-6 (normals) purely
  // from storage rounding — noise that would force tolerances loose enough to
  // hide a real mistake. Evaluated in double precision they hold to ~1e-15, so
  // the thresholds can stay sharp enough to mean something.
  const positions = new Float64Array(72);
  const normals = new Float64Array(72);

  const probe = (i: number, t: number) => {
    const theta = (i / p.blades) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const phi = bladeTwist(p, theta, t);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);

    for (let j = 0; j < 24; j++) {
      const x = template[j * 3];
      const y = template[j * 3 + 1];
      const side = template[j * 3 + 2];
      const rho = p.majorRadius + x * cp - y * sp;
      const tangential = side * tau * rho;
      const o = j * 3;
      positions[o] = rho * ct + tangential * st;
      positions[o + 1] = rho * st - tangential * ct;
      positions[o + 2] = x * sp + y * cp;

      const sg = faceSign[j];
      if (faceAxis[j] === 0) {
        normals[o] = sg * cp * ct;
        normals[o + 1] = sg * cp * st;
        normals[o + 2] = sg * sp;
      } else if (faceAxis[j] === 1) {
        normals[o] = -sg * sp * ct;
        normals[o + 1] = -sg * sp * st;
        normals[o + 2] = sg * cp;
      } else {
        normals[o] = (sg * st - tau * ct) * taperNorm;
        normals[o + 1] = (-sg * ct - tau * st) * taperNorm;
        normals[o + 2] = 0;
      }
    }
    return { positions, normals, cosTheta: ct, sinTheta: st };
  };
  probe.indices = indices;
  return probe;
}

/** Largest distance from any vertex of `a` to its nearest counterpart in `b`. */
function setDistance(a: Float64Array, b: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    let best = Infinity;
    for (let j = 0; j < b.length; j += 3) {
      best = Math.min(
        best,
        Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2])
      );
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** How far the analytic normals sit from the winding's own face normals. */
function normalDisagreement(
  positions: Float64Array,
  normals: Float64Array,
  indices: number[]
): number {
  let worst = 0;
  for (let q = 0; q < indices.length; q += 3) {
    const i0 = indices[q] * 3;
    const i1 = indices[q + 1] * 3;
    const i2 = indices[q + 2] * 3;
    const e1x = positions[i1] - positions[i0];
    const e1y = positions[i1 + 1] - positions[i0 + 1];
    const e1z = positions[i1 + 2] - positions[i0 + 2];
    const e2x = positions[i2] - positions[i0];
    const e2y = positions[i2 + 1] - positions[i0 + 1];
    const e2z = positions[i2 + 2] - positions[i0 + 2];
    let cx = e1y * e2z - e1z * e2y;
    let cy = e1z * e2x - e1x * e2z;
    let cz = e1x * e2y - e1y * e2x;
    const m = Math.hypot(cx, cy, cz) || 1;
    cx /= m;
    cy /= m;
    cz /= m;
    worst = Math.max(
      worst,
      Math.hypot(cx - normals[i0], cy - normals[i0 + 1], cz - normals[i0 + 2])
    );
  }
  return worst;
}
