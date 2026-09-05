import * as THREE from "three";

/**
 * The login object: a crystalline sphere built from raised triangular facets.
 *
 * Take a subdivided icosahedron and replace every triangular face with a
 * shallow three-sided **frustum** — a pyramid pushed outward and then sliced
 * off flat. The result is a field of raised triangular plates covering a
 * sphere: sloped shoulders catching the light, a flat cap on top of each.
 *
 * THE CAPS ARE THE POINT, AND THE FIRST VERSION GOT THEM WRONG.
 *
 * This was originally built with sharp apexes — true pyramids converging to a
 * point. That is subtly but decisively the wrong solid. A point has no area, so
 * it carries no value of its own; the facet reads as two shoulders meeting at a
 * highlight, which looks like a spiked ball rather than a cut stone. The flat
 * cap gives every facet a third, larger surface at a distinctly different angle
 * from both shoulders — and that third value is what makes the object read as
 * *faceted* rather than *spiky*.
 *
 * It is also what the reference actually shows: each cell is a plate with a
 * visible flat top, not a spike.
 *
 * WHY FACETS AT ALL, AND NOT A SPHERE
 *
 * The same reason the hero is a fan of blades and not a torus. A smooth sphere
 * in monochrome glass over a black page is a grey circle: one continuous
 * surface, one continuous gradient, nothing for the light rig to catch. Every
 * facet here sits at a different angle, so the key lightformer's streak breaks
 * across hundreds of independent surfaces and the object reads as *cut* rather
 * than moulded. The facets are the legibility.
 *
 * THE APEX SITS ON A SPHERE, NOT AT A FIXED HEIGHT
 *
 * The obvious construction — push each face out along its normal by a height
 * `h` — makes the outer radius `max|centroid| + h`, and `max|centroid|` has no
 * closed form at arbitrary subdivision. It would have to be measured
 * numerically, and any "analytic radius" claim would be a lie.
 *
 * Placing the apex *at* radius `radius · spike` instead makes both radii exact
 * by construction: every base vertex is at exactly `radius`, every apex at
 * exactly `radius · spike`. The bounding sphere is then exact, assigned once,
 * and `outerRadius` is a one-line multiplication rather than a scan.
 *
 * The cost is that facet slope now varies with subdivision (see `spike` below),
 * which is a parameter to tune rather than a property to derive. That is the
 * better trade: a tuned constant with an assertion beats a derived quantity
 * nobody can check.
 *
 * THE BASE TRIANGLE IS NOT EMITTED, AND THE SOLID IS STILL CLOSED
 *
 * Only the three side quads and the cap of each frustum are written — seven
 * triangles. That looks like it should leave a hole where every original
 * triangle was, and it does not: every original edge is shared by exactly two
 * original triangles, and each of those contributes one side quad containing
 * that edge. The union is a closed manifold with no boundary.
 *
 * `assertFacetSphere` checks this two independent ways — edge pairing and Euler
 * characteristic — because it is the one structural claim here that is not
 * obvious by inspection. Verified before building: with V = V0 + 3F0,
 * E = E0 + 9F0 (base + vertical + quad diagonals + cap edges) and F = 7F0,
 * V − E + F collapses to V0 − E0 + F0 = 2 at every subdivision level.
 *
 * THIS GEOMETRY IS STATIC. DO NOT ANIMATE ITS VERTICES.
 *
 * Unlike `fan-geometry.ts`, nothing here is rewritten per frame. The object
 * moves by rigid transform only, so:
 *
 *   - buffers stay at the default `StaticDrawUsage` — do NOT call `setUsage`
 *   - there is deliberately no `updateFacetSphereGeometry`
 *   - **zero `bufferSubData` calls per frame**, against the fan's 64 KB
 *
 * That is a strict improvement in the frame budget and it is easy to throw away
 * by "improving" the object with a vertex wobble. Don't.
 */

export type FacetSphereParams = {
  /**
   * Icosahedron subdivision level, passed straight to `IcosahedronGeometry`.
   *
   * Face count is **20·(detail+1)²** — NOT `20·4^detail`. three's
   * `PolyhedronGeometry` splits each edge into `detail+1` segments rather than
   * recursively quartering, so the sequence is 20, 80, 180, 320, not
   * 20, 80, 320, 1280. Measured against three 0.185.1; an assertion written
   * against the recursive formula fails at detail 2 by a factor of 16/9.
   */
  detail: number;
  /** Base sphere radius. Every original vertex sits exactly here. */
  radius: number;
  /**
   * Apex radius, as a multiple of `radius`.
   *
   * Must exceed the largest face-centroid radius or the pyramid inverts and
   * points *inward* — the one real footgun of this parameterisation, and the
   * first thing `assertFacetSphere` checks. Centroid radii are 0.944 at
   * detail 1, 0.977 at detail 2 and 0.988 at detail 3, so any value above 1 is
   * safe; values below it are the failure case.
   */
  spike: number;
  /**
   * Flat-cap size, as a fraction of the base triangle. 0 < cap < 1.
   *
   * Each cap vertex is the base vertex pulled `1 − cap` of the way toward the
   * face centroid, then projected out to the apex radius. So `cap = 0.55` means
   * the flat top is 55% the angular size of the base.
   *
   * At `cap → 0` this degenerates to the sharp pyramid this geometry started
   * as, which reads as a spiked ball rather than a cut stone — the shoulders
   * meet at a point that carries no value of its own.
   * At `cap → 1` the shoulders vanish and the surface becomes a faceted sphere
   * with no relief at all.
   */
  cap: number;
};

/**
 * `detail: 2` gives 180 facets — about 90 of them camera-facing, each
 * subtending roughly 40px on a 540px object. That is the level where the
 * surface reads as crystalline rather than either faceted-by-accident or
 * uniformly grey.
 *
 * `spike` DIFFERS BETWEEN THE PRESETS ON PURPOSE, and it is not a typo.
 * Facet slope is `atan((spike − |centroid|) / (chord/√3))`, and the edge chord
 * shrinks with subdivision — 0.618 at detail 1, 0.412 at detail 2. Holding
 * `spike` constant across the two would give the downgraded tier a visibly
 * *sharper* surface than the full one, which is backwards. Both values below
 * target the same ≈24° slope.
 */
export const FACET_SPHERE_FULL: FacetSphereParams = {
  detail: 2,
  radius: 1,
  spike: 1.105,
  cap: 0.55,
};

/** 80 facets. Coarser, and paired with the non-transmissive material. */
export const FACET_SPHERE_DOWNGRADED: FacetSphereParams = {
  detail: 1,
  radius: 1,
  spike: 1.135,
  cap: 0.55,
};

/** Base faces before pyramidisation. See `detail` for why this is not 4^n. */
export const baseFaceCount = (p: FacetSphereParams) => 20 * (p.detail + 1) ** 2;

/**
 * Emitted triangles per facet: 6 for the three side quads, 1 for the flat cap.
 * The original base triangle is never emitted — see the header.
 */
export const TRIANGLES_PER_FACET = 7;
export const faceCount = (p: FacetSphereParams) => TRIANGLES_PER_FACET * baseFaceCount(p);

/**
 * Exact. Every apex is placed at this radius by construction, and no vertex
 * lies beyond one. Used both for on-screen scaling and for the shadow frustum,
 * so under-reporting it would clip the outermost points out of the depth pass.
 *
 * There is deliberately no separate `boundingRadius`. The fan needs one because
 * its `outerRadius` is *cylindrical* and the bounding sphere additionally needs
 * the axial extent; here the object is radially symmetric and the two are the
 * same number. Two names for one quantity is worse than one.
 */
export const outerRadius = (p: FacetSphereParams) => p.radius * p.spike;

/** The valleys between pyramids — exact, every base vertex sits here. */
export const innerRadius = (p: FacetSphereParams) => p.radius;

export function createFacetSphereGeometry(p: FacetSphereParams): THREE.BufferGeometry {
  if (process.env.NODE_ENV !== "production") assertFacetSphere(p);

  const source = new THREE.IcosahedronGeometry(1, p.detail);
  const src = source.attributes.position.array as ArrayLike<number>;
  const baseFaces = src.length / 9;

  const positions = new Float32Array(baseFaces * TRIANGLES_PER_FACET * 9);
  const normals = new Float32Array(baseFaces * TRIANGLES_PER_FACET * 9);

  let w = 0;

  // Scratch, hoisted out of the loop. At detail 2 this runs 180 times at build
  // and never again, so it is not hot — but allocating six vectors per face is
  // noise in a heap profile taken during mount, and hiding real signal behind
  // build-time garbage is its own cost.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const m = new THREE.Vector3();
  const aTop = new THREE.Vector3();
  const bTop = new THREE.Vector3();
  const cTop = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();

  /** One side face: three positions, then its flat normal three times. */
  const writeFace = (v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3) => {
    // The exact normal of a triangle IS the normalised cross product of two of
    // its edges. This is not the fan's analytic-normal argument — that exists
    // because the fan re-derives a closed form every frame and cross products
    // would cost thousands of normalisations per second. Here the build runs
    // once, and `computeVertexNormals()` would produce an identical result on
    // a non-indexed geometry (it has nothing to average). Inlining is worth it
    // for one pass instead of two, and because it makes the winding assertion
    // below possible without a second traversal.
    e1.subVectors(v1, v0);
    e2.subVectors(v2, v0);
    n.crossVectors(e1, e2).normalize();

    for (const v of [v0, v1, v2]) {
      positions[w] = v.x;
      positions[w + 1] = v.y;
      positions[w + 2] = v.z;
      normals[w] = n.x;
      normals[w + 1] = n.y;
      normals[w + 2] = n.z;
      w += 3;
    }
  };

  for (let f = 0; f < baseFaces; f++) {
    const o = f * 9;
    // RENORMALISE, do not just scale.
    //
    // three stores `IcosahedronGeometry`'s positions in a Float32Array, so its
    // "unit" vectors are only unit to about 3e-8. Scaling those by `radius`
    // inherits that error, and the claim this whole construction rests on —
    // "every base vertex is at exactly `radius`, every apex at exactly
    // `radius · spike`" — would be true only to float32 precision.
    //
    // The assertion caught this: it measured base vertices off by 3.12e-8
    // against a 1e-12 threshold. The wrong fix is to loosen the threshold to
    // 1e-6, which would then be too coarse to catch a genuine algebra error.
    // The right one is to make the input exact, in double precision, once at
    // build. It also improves the shipped geometry very slightly.
    a.set(src[o], src[o + 1], src[o + 2]).normalize().multiplyScalar(p.radius);
    b.set(src[o + 3], src[o + 4], src[o + 5]).normalize().multiplyScalar(p.radius);
    c.set(src[o + 6], src[o + 7], src[o + 8]).normalize().multiplyScalar(p.radius);

    m.copy(a).add(b).add(c).divideScalar(3);

    // Each cap vertex: shrink the base corner toward the centroid by `cap`,
    // then project it out to the apex radius.
    //
    // Projecting rather than offsetting is what keeps `outerRadius` exact — all
    // three cap vertices land on the sphere of radius `radius · spike`, so the
    // bounding sphere is known without measuring anything. The cap is still
    // perfectly planar: any three points define a plane.
    for (const [corner, out] of [
      [a, aTop],
      [b, bTop],
      [c, cTop],
    ] as const) {
      out
        .copy(m)
        .addScaledVector(corner.clone().sub(m), p.cap)
        .normalize()
        .multiplyScalar(p.radius * p.spike);
    }

    // Three side quads, each split into two triangles, then the flat cap.
    //
    // Winding follows the source triangle, which is CCW seen from outside; the
    // quads are wound base-edge-first so their normals face outward too. That
    // is asserted rather than assumed — a flipped face is invisible until it
    // renders as a hole.
    writeFace(a, b, bTop);
    writeFace(a, bTop, aTop);
    writeFace(b, c, cTop);
    writeFace(b, cTop, bTop);
    writeFace(c, a, aTop);
    writeFace(c, aTop, cTop);
    writeFace(aTop, bTop, cTop);
  }

  source.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

  // No `uv`. `MeshTransmissionMaterial` only reads vUv under USE_TRANSMISSIONMAP
  // or USE_THICKNESSMAP, and neither is bound.

  // Assigned, never computed. `computeBoundingSphere()` is a full pass over
  // every vertex to arrive at a number we already know exactly — and it centres
  // its result on the bounding *box*, which for a radially symmetric object is
  // the origin only by luck of the subdivision.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius(p));

  return geometry;
}

/**
 * Dev-only structural checks. Called once from `createFacetSphereGeometry`,
 * never from a frame loop — per-frame dev checks train people to ignore
 * dev-mode jank.
 *
 * Standalone: it takes only params and rebuilds the vertices itself in
 * **Float64**, rather than reading the shipped `Float32Array`. At float32
 * precision the exact radius identities below bottom out around 5e-8 purely
 * from storage rounding, which would force the tolerances loose enough to hide
 * a real algebra error. In double precision they hold to ~1e-15, so 1e-12 is a
 * threshold that means something.
 */
export function assertFacetSphere(p: FacetSphereParams): void {
  const problems: string[] = [];

  // ── Parameter sanity ──────────────────────────────────────────
  if (!Number.isInteger(p.detail) || p.detail < 0 || p.detail > 4) {
    problems.push(
      `detail must be an integer in [0, 4], got ${p.detail}. ` +
        `Face count is 20·(detail+1)², so 5 would be 720 facets — past the point ` +
        `the 256² transmission buffer can resolve them.`
    );
  }
  if (!(p.radius > 0)) problems.push(`radius must be positive, got ${p.radius}`);
  if (!Number.isFinite(p.spike)) problems.push(`spike must be finite, got ${p.spike}`);
  if (!(p.cap > 0) || !(p.cap < 1)) {
    problems.push(
      `cap must be strictly between 0 and 1, got ${p.cap}. At 0 the facet ` +
        `collapses to a sharp point (a spiked ball, not a cut stone); at 1 the ` +
        `sloped shoulders vanish and there is no relief at all.`
    );
  }

  // Throw NOW, before touching geometry.
  //
  // These used to accumulate into `problems` alongside the structural checks
  // and throw at the end, like `assertFan` does. That is wrong here, because
  // the structural checks *consume* the parameters: at `detail: 1.5`,
  // `IcosahedronGeometry` returns a vertex count that is not a multiple of 9
  // and the rebuild loop below read past the end of the array, so the caller
  // got `TypeError: Cannot read properties of undefined` instead of the
  // message written three lines above. A bad parameter must produce the
  // sentence explaining it, not a crash inside the checker.
  if (problems.length > 0) {
    throw new Error(`facet-sphere: ${problems.join("; ")}`);
  }

  const source = new THREE.IcosahedronGeometry(1, p.detail);

  if (source.index !== null) {
    problems.push(
      `IcosahedronGeometry returned an INDEXED geometry. This build reads ` +
        `positions as 9 floats per face and would silently produce garbage. ` +
        `three changed PolyhedronGeometry — call .toNonIndexed() before reading.`
    );
  }

  const src = Array.from(source.attributes.position.array as ArrayLike<number>);
  source.dispose();
  const baseFaces = src.length / 9;

  if (baseFaces !== baseFaceCount(p)) {
    problems.push(
      `expected ${baseFaceCount(p)} base faces from 20·(detail+1)² at detail ` +
        `${p.detail}, got ${baseFaces}. If this is 20·4^detail, the formula in ` +
        `this file is wrong, not three.`
    );
  }

  // ── Rebuild in double precision ───────────────────────────────
  type V = [number, number, number];
  const faces: [V, V, V][] = [];
  let maxCentroid = 0;

  // Mirrors the build's renormalisation exactly — see the comment there. If the
  // probe scaled the raw float32 values instead, it would report a 3e-8 error
  // that the shipped geometry does not have.
  const unit = (x: number, y: number, z: number): V => {
    const l = Math.hypot(x, y, z);
    return [(x / l) * p.radius, (y / l) * p.radius, (z / l) * p.radius];
  };

  for (let f = 0; f < baseFaces; f++) {
    const o = f * 9;
    const tri: V[] = [
      unit(src[o], src[o + 1], src[o + 2]),
      unit(src[o + 3], src[o + 4], src[o + 5]),
      unit(src[o + 6], src[o + 7], src[o + 8]),
    ];
    const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const my = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    const mz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
    const ml = Math.hypot(mx, my, mz);
    maxCentroid = Math.max(maxCentroid, ml / p.radius);

    const capOf = (corner: V): V => {
      const x = mx + (corner[0] - mx) * p.cap;
      const y = my + (corner[1] - my) * p.cap;
      const z = mz + (corner[2] - mz) * p.cap;
      const l = Math.hypot(x, y, z);
      const k = (p.radius * p.spike) / l;
      return [x * k, y * k, z * k];
    };
    const at = capOf(tri[0]);
    const bt = capOf(tri[1]);
    const ct = capOf(tri[2]);

    faces.push(
      [tri[0], tri[1], bt],
      [tri[0], bt, at],
      [tri[1], tri[2], ct],
      [tri[1], ct, bt],
      [tri[2], tri[0], at],
      [tri[2], at, ct],
      [at, bt, ct]
    );
  }

  // 1 — the inverted-pyramid footgun.
  if (!(p.spike > maxCentroid)) {
    problems.push(
      `spike ${p.spike} does not exceed the largest face-centroid radius ` +
        `${maxCentroid.toFixed(6)} — the facet points INWARD and the solid turns ` +
        `itself inside out. spike must be > ${maxCentroid.toFixed(4)} at detail ${p.detail}.`
    );
  }

  // 2/3 — exact radii, which is the whole justification for placing apexes on a sphere.
  const rIn = innerRadius(p);
  const rOut = outerRadius(p);
  let worstBase = 0;
  let worstApex = 0;
  let maxLen = 0;
  let minArea = Infinity;
  let minDot = Infinity;

  for (const [v0, v1, v2] of faces) {
    // Every vertex must sit on ONE OF exactly two spheres: the base at `rIn` or
    // the cap at `rOut`. Nothing in between.
    //
    // The check is per-vertex rather than per-slot because a frustum's faces
    // mix the two — a side quad has two base corners and one cap corner, the
    // other has one and two, and the cap triangle has three cap corners. The
    // sharp-pyramid version could assume "v0/v1 base, v2 apex" and this cannot.
    // Asserting membership of the pair is both simpler and stronger: it catches
    // a vertex that drifted off *either* sphere, wherever it appears.
    for (const v of [v0, v1, v2]) {
      const len = Math.hypot(...v);
      maxLen = Math.max(maxLen, len);
      const dIn = Math.abs(len - rIn);
      const dOut = Math.abs(len - rOut);
      if (dIn <= dOut) worstBase = Math.max(worstBase, dIn);
      else worstApex = Math.max(worstApex, dOut);
    }

    const e1: V = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2: V = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(cx, cy, cz);
    minArea = Math.min(minArea, len / 2);

    // 9 — outward winding. The face normal must point the same way as the face
    // centroid, or the triangle renders back-to-front and reads as a black hole.
    const gx = (v0[0] + v1[0] + v2[0]) / 3;
    const gy = (v0[1] + v1[1] + v2[1]) / 3;
    const gz = (v0[2] + v1[2] + v2[2]) / 3;
    const gl = Math.hypot(gx, gy, gz);
    if (len > 0 && gl > 0) {
      minDot = Math.min(minDot, (cx * gx + cy * gy + cz * gz) / (len * gl));
    }
  }

  if (worstBase > 1e-12) {
    problems.push(`base vertices off ${rIn} by up to ${worstBase.toExponential(2)}`);
  }
  if (worstApex > 1e-12) {
    problems.push(
      `cap vertices off ${rOut} by up to ${worstApex.toExponential(2)} — the apex is ` +
        `probably not being normalised before scaling`
    );
  }
  // 4 — the exported formula must agree with what the build actually produces.
  if (Math.abs(maxLen - rOut) > 1e-12) {
    problems.push(
      `outerRadius() reports ${rOut} but the furthest vertex is at ${maxLen} — ` +
        `the exported formula has drifted from the construction`
    );
  }
  // Outward winding. The correct test is `> 0`, not some comfortable margin.
  //
  // This was written as `> 0.5` for the sharp-pyramid version and it fired on
  // the truncated one at 0.3480 — a false positive. A frustum's side walls
  // slope steeply, so their normals sit ~70° off radial while still pointing
  // firmly outward; only the flat caps are near-radial. The 0.5 was encoding an
  // assumption about face slope, not about correctness.
  //
  // A genuinely flipped face gives a *negative* dot, so zero is the real
  // boundary. The observed minimum is reported either way, because a value
  // creeping toward zero means facets are becoming near-tangential — the
  // configuration where a shallow depth bias starts producing shadow acne.
  if (minDot <= 0) {
    problems.push(
      `a face normal points inward (min dot with its centroid ` +
        `${minDot.toFixed(4)}) — winding is flipped or a facet is degenerate`
    );
  }
  if (minArea < 1e-9) {
    problems.push(`degenerate triangle, area ${minArea.toExponential(2)}`);
  }

  // 5 — no missing or duplicated side faces.
  if (faces.length !== faceCount(p)) {
    problems.push(`expected ${faceCount(p)} emitted faces, built ${faces.length}`);
  }

  // ── 7 and 8: closed manifold, checked two independent ways ────
  //
  // Both are here on purpose. Edge pairing catches a hole; Euler catches a
  // mis-stitch that happens to leave every edge paired. They are cheap and
  // dev-only, and this is the one claim in the file that is not self-evident.
  const key = (v: V) => v.map((x) => Math.round(x * 1e9)).join(",");
  const ids = new Map<string, number>();
  const id = (v: V) => {
    const k = key(v);
    let i = ids.get(k);
    if (i === undefined) ids.set(k, (i = ids.size));
    return i;
  };

  const directed = new Set<string>();
  let unpaired = 0;
  const edges = new Set<string>();

  for (const [v0, v1, v2] of faces) {
    const t = [id(v0), id(v1), id(v2)];
    for (let i = 0; i < 3; i++) {
      const from = t[i];
      const to = t[(i + 1) % 3];
      directed.add(`${from}>${to}`);
      edges.add(from < to ? `${from}-${to}` : `${to}-${from}`);
    }
  }
  for (const e of directed) {
    const [from, to] = e.split(">");
    if (!directed.has(`${to}>${from}`)) unpaired++;
  }

  if (unpaired > 0) {
    problems.push(
      `${unpaired} directed edges have no opposite twin — the surface is not ` +
        `closed. Every base edge must be shared by two adjacent pyramids and ` +
        `every interior edge by two side faces of the same pyramid.`
    );
  }

  const V = ids.size;
  const E = edges.size;
  const F = faces.length;
  if (V - E + F !== 2) {
    problems.push(
      `Euler characteristic is ${V - E + F}, expected 2 (V=${V} E=${E} F=${F}). ` +
        `The solid is not a topological sphere.`
    );
  }

  if (problems.length > 0) {
    throw new Error(`facet-sphere: ${problems.join("; ")}`);
  }
}
