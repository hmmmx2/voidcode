import * as THREE from "three";

/**
 * A tesseract — the 4-dimensional analogue of a cube — projected into 3D and
 * rendered as a frame of solid beams.
 *
 * WHAT YOU ARE ACTUALLY LOOKING AT
 *
 * A cube is bounded by 6 squares; a tesseract is bounded by 8 cubes. You cannot
 * see one, but you can see its shadow, and the standard perspective shadow is
 * the familiar "cube inside a cube": both are genuine cubical cells of the
 * solid, and the 8 struts joining their corners are 6 more cells seen edge-on.
 * The inner cube only looks smaller for the same reason a distant object does —
 * it is further away along the fourth axis.
 *
 * WHY IT MUST ROTATE IN 4D AND NOT MERELY IN 3D
 *
 * This is the whole design. A static cube-inside-a-cube is a *drawing* of a
 * tesseract; spin it in 3D and it stays a drawing, because the inner cube stays
 * inner. Rotate it in a plane that includes the w axis and the projection does
 * something no 3D object can: cells sweep through each other and the inner cube
 * turns inside out, becoming the outer one, continuously and without any face
 * ever passing through another in 4D.
 *
 * That inversion is the only visual evidence that a fourth dimension is
 * involved. Remove it — animate `rotation.y` on the group instead — and the
 * object silently reverts to two nested boxes.
 *
 * WHY BEAMS RATHER THAN LINES
 *
 * `LineSegments` would be one draw call and far less code, and it is wrong
 * here. Lines are rasterised at a fixed pixel width, so they do not thin with
 * distance, take no lighting, and cannot carry the transmission material every
 * other object on this site uses — the tesseract would read as a diagram pasted
 * onto the page rather than an object sitting in it. Solid beams get real
 * perspective, real speculars along their length, and refraction at the joints.
 *
 * PER-FRAME GEOMETRY, deliberately, unlike `facet-sphere.ts` and
ancurrent changes every projected vertex on every
 * frame, so positions and normals are rewritten in place — `DynamicDrawUsage`,
 * a scratch buffer, and no allocation in the hot path. This is the same
 * arrangement `fan-geometry.ts` uses and for the same reason.
 */

export type TesseractParams = {
  /** Half-extent of the 4D hypercube, before projection. */
  size: number;
  /**
   * Distance of the viewer along the w axis, in units of `size`.
   *
   * This sets how much smaller the far cell looks — it is the 4D analogue of
   * focal length. Must exceed 1 or a vertex reaches the viewer's own w and the
   * projection divides by zero.
   *
   * Near 1 the perspective is violent and the inner cube shrinks to a dot; by 4
   * the projection is nearly parallel and the two cubes are almost the same
   * size, which reads as a flat lattice rather than a nested solid. 2.15 keeps
   * a clear inner cube with the outer still comfortably containing it.
   */
  viewerW: number;
  /**
   * Beam half-thickness, in projected units.
   *
   * Raised twice, 0.034 → 0.048 → 0.070, both times after looking at it.
   *
   * Thin beams present very little surface to the light rig, so below roughly
   * 0.04 the specular has nowhere to land and the frame dims out into a
   * hairline wireframe rather than reading as glass. Thickness is doing double
   * duty here: it sets the visual weight AND it is most of what makes the
   * object legible at all, because a beam only picks up the key streak across
   * the width it presents.
   *
   * The ceiling is where adjacent beams merge at the vertices — around 0.09 at
   * this projection scale, past which the eight corner joints fuse into blobs
   * and the frame stops reading as separate edges. 0.070 sits comfortably under
   * that with the beams clearly solid.
   */
  thickness: number;
  /** Radians per second in the x–w plane. This is the one that inverts it. */
  rateXW: number;
  /** Radians per second in the y–z plane, so the inversion is seen from a turning angle. */
  rateYZ: number;
};

export const TESSERACT_FULL: TesseractParams = {
  size: 1,
  viewerW: 2.6,
  thickness: 0.070,
  // Slow. The inversion is the payoff and it needs to be legible rather than
  // impressive — at much above this it reads as flicker, and the moment the two
  // cubes pass through each other becomes a smear instead of an event.
  rateXW: 0.20,
  // Deliberately incommensurate with rateXW (ratio ~1.86, not a simple
  // fraction), so the pair never returns to the same combined pose and the
  // motion has no visible loop.
  rateYZ: 0.107,
};

/** Thicker beams so the coarser material still reads; same motion. */
export const TESSERACT_DOWNGRADED: TesseractParams = {
  ...TESSERACT_FULL,
  thickness: 0.082,
};

/** 16 vertices, 32 edges, 6 faces per beam, 2 triangles per face. */
export const EDGE_COUNT = 32;
const VERTS_PER_BEAM = 36; // 6 faces x 2 triangles x 3 vertices, non-indexed

type Vec4 = [number, number, number, number];

/** The 16 corners of a 4D hypercube: every combination of ±size. */
function hypercubeVertices(size: number): Vec4[] {
  const out: Vec4[] = [];
  for (let i = 0; i < 16; i++) {
    out.push([
      i & 1 ? size : -size,
      i & 2 ? size : -size,
      i & 4 ? size : -size,
      i & 8 ? size : -size,
    ]);
  }
  return out;
}

/**
 * Two corners share an edge exactly when they differ in one coordinate — i.e.
 * their indices differ by a single bit. 16 vertices x 4 bits / 2 = 32 edges.
 */
function hypercubeEdges(): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    for (let bit = 0; bit < 4; bit++) {
      const j = i ^ (1 << bit);
      if (j > i) out.push([i, j]);
    }
  }
  return out;
}

/**
 * The maximum distance any projected vertex reaches from the origin, over the
 * whole rotation. Used for on-screen scaling and for the shadow frustum, so
 * under-reporting it clips geometry out of the depth pass.
 *
 * THE OBVIOUS ANSWER IS WRONG, by a factor of three.
 *
 * The intuition "the nearest corner is at w = −size, so the radius is
 * `size·√3 · viewerW/(viewerW+1)`" ignores that the x–w rotation moves w. The
 * assertion below caught it: that formula gives 1.2133 where the true maximum
 * is 4.1324.
 *
 * Done properly. The x–w rotation preserves `x² + w² = 2·size²`, and the y–z
 * rotation preserves `y² + z² = 2·size²`, so a vertex whose rotated w-coordinate
 * is `w` sits at projected radius
 *
 *     r(w) = W·√(4·size² − w²) / (W − w),        W = viewerW · size
 *
 * over `w ∈ [−size√2, size√2]`. Setting `dr/dw = 0` gives
 * `−w(W − w) + (4size² − w²) = 0`, i.e. a single stationary point at
 *
 *     w* = 4·size² / W
 *
 * which lies outside the reachable range whenever `viewerW < 2√2 ≈ 2.828` — so
 * for any usefully perspective value the maximum is at the boundary
 * `w = size√2` instead. `Math.min` picks the correct branch either way, and the
 * assertion re-derives the answer numerically across 64 phases as an
 * independent check.
 *
 * The final term is the beam's own corner, which sits `thickness√2` outside the
 * vertex it joins.
 */
export const outerRadius = (p: TesseractParams) => {
  const W = p.viewerW * p.size;
  const w = Math.min((4 * p.size * p.size) / W, p.size * Math.SQRT2);
  return (
    (W * Math.sqrt(4 * p.size * p.size - w * w)) / (W - w) + p.thickness * Math.SQRT2
  );
};

type Scratch = {
  params: TesseractParams;
  vertices4d: Vec4[];
  edges: [number, number][];
  projected: Float64Array; // 16 x 3
  positions: Float32Array;
  normals: Float32Array;
};

export function createTesseractGeometry(p: TesseractParams): THREE.BufferGeometry {
  if (process.env.NODE_ENV !== "production") assertTesseract(p);

  const total = EDGE_COUNT * VERTS_PER_BEAM;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const normalAttr = new THREE.BufferAttribute(normals, 3);

  // Must be set BEFORE the first render: three reads `usage` only when it first
  // creates the GL buffer, so setting it afterwards is silently a no-op.
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  normalAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute("position", positionAttr);
  geometry.setAttribute("normal", normalAttr);

  const scratch: Scratch = {
    params: p,
    vertices4d: hypercubeVertices(p.size),
    edges: hypercubeEdges(),
    projected: new Float64Array(16 * 3),
    positions,
    normals,
  };
  geometry.userData.tesseract = scratch;

  // Fill it before returning: the first `gl.render` can precede the first
  // `useFrame` callback in some mount orderings, and an unwritten buffer is a
  // cluster of degenerate triangles at the origin.
  updateTesseractGeometry(geometry, 0);

  // Assigned once, never computed. The bound is exact and constant, so
  // `computeBoundingSphere()` every frame would be two passes over 1,152
  // vertices to arrive at a number already known.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius(p));

  return geometry;
}

// Module-scope scratch vectors. Allocating these inside the frame callback
// would be ~200 Vector3s per frame at 60fps, which shows as a GC sawtooth.
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * Rewrite every vertex for time `t`. Allocation-free.
 *
 * Takes no params — they live on `geometry.userData`. Passing them separately
 * would let a caller hand over values that do not match the buffer sizes, and
 * because this writes by manual index rather than `.set()`, that is a silent
 * out-of-bounds write rather than a throw.
 */
export function updateTesseractGeometry(geometry: THREE.BufferGeometry, t: number): void {
  const s = geometry.userData.tesseract as Scratch | undefined;
  if (!s) return;

  const { params: p, vertices4d, edges, projected, positions, normals } = s;

  const cxw = Math.cos(t * p.rateXW);
  const sxw = Math.sin(t * p.rateXW);
  const cyz = Math.cos(t * p.rateYZ);
  const syz = Math.sin(t * p.rateYZ);

  // ── Rotate in 4D, then project 4D → 3D ────────────────────────
  for (let i = 0; i < 16; i++) {
    const [x0, y0, z0, w0] = vertices4d[i];

    // x–w plane. This is the rotation that carries a vertex from the far cell
    // to the near one, and so the one that turns the solid inside out.
    const x1 = x0 * cxw - w0 * sxw;
    const w1 = x0 * sxw + w0 * cxw;

    // y–z plane, an ordinary 3D rotation, so the inversion is watched from a
    // slowly changing angle rather than head-on.
    const y1 = y0 * cyz - z0 * syz;
    const z1 = y0 * syz + z0 * cyz;

    // Perspective divide along w — identical in form to a 3D→2D projection,
    // one dimension up. `viewerW > 1` guarantees a positive denominator, which
    // is what the assertion protects.
    const k = (p.viewerW * p.size) / (p.viewerW * p.size - w1);
    projected[i * 3] = x1 * k;
    projected[i * 3 + 1] = y1 * k;
    projected[i * 3 + 2] = z1 * k;
  }

  // ── Rebuild one beam per edge ─────────────────────────────────
  let w = 0;

  const writeTri = (c0: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3) => {
    _e1.subVectors(c1, c0);
    _e2.subVectors(c2, c0);
    _n.crossVectors(_e1, _e2).normalize();
    for (const c of [c0, c1, c2]) {
      positions[w] = c.x;
      positions[w + 1] = c.y;
      positions[w + 2] = c.z;
      normals[w] = _n.x;
      normals[w + 1] = _n.y;
      normals[w + 2] = _n.z;
      w += 3;
    }
  };

  for (let e = 0; e < edges.length; e++) {
    const [ia, ib] = edges[e];
    _a.set(projected[ia * 3], projected[ia * 3 + 1], projected[ia * 3 + 2]);
    _b.set(projected[ib * 3], projected[ib * 3 + 1], projected[ib * 3 + 2]);

    _dir.subVectors(_b, _a);
    const len = _dir.length();
    if (len < 1e-9) {
      // Two projected vertices coincide — possible at the exact instant the
      // solid passes through its degenerate pose. Emit a zero-area beam rather
      // than dividing by zero; it is invisible for the one frame it occurs.
      for (let i = 0; i < VERTS_PER_BEAM * 3; i++) {
        positions[w + i] = 0;
        normals[w + i] = 0;
      }
      w += VERTS_PER_BEAM * 3;
      continue;
    }
    _dir.divideScalar(len);

    // Any vector not parallel to `dir` works as a seed for the cross section.
    // Choosing by smallest component keeps it well away from parallel, which a
    // fixed up-vector would not — every beam here points in a different
    // direction and several are vertical.
    const ax = Math.abs(_dir.x);
    const ay = Math.abs(_dir.y);
    const az = Math.abs(_dir.z);
    if (ax <= ay && ax <= az) _up.set(1, 0, 0);
    else if (ay <= az) _up.set(0, 1, 0);
    else _up.set(0, 0, 1);

    _u.crossVectors(_dir, _up).normalize().multiplyScalar(p.thickness);
    _v.crossVectors(_dir, _u).normalize().multiplyScalar(p.thickness);

    // 8 corners: the 4 cross-section points at each end.
    for (let i = 0; i < 4; i++) {
      const su = i === 0 || i === 3 ? 1 : -1;
      const sv = i < 2 ? 1 : -1;
      _corners[i]
        .copy(_a)
        .addScaledVector(_u, su)
        .addScaledVector(_v, sv);
      _corners[i + 4]
        .copy(_b)
        .addScaledVector(_u, su)
        .addScaledVector(_v, sv);
    }

    // 4 sides, wound so their normals face outward from the beam axis.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      writeTri(_corners[i], _corners[j], _corners[j + 4]);
      writeTri(_corners[i], _corners[j + 4], _corners[i + 4]);
    }
    // 2 end caps, so the joints at each vertex are solid rather than open tubes.
    writeTri(_corners[0], _corners[2], _corners[1]);
    writeTri(_corners[0], _corners[3], _corners[2]);
    writeTri(_corners[4], _corners[5], _corners[6]);
    writeTri(_corners[4], _corners[6], _corners[7]);
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
}

/**
 * Dev-only. Called once from create, never from the frame loop — per-frame dev
 * checks train people to ignore dev-mode jank.
 */
export function assertTesseract(p: TesseractParams): void {
  const problems: string[] = [];

  if (!(p.size > 0)) problems.push(`size must be positive, got ${p.size}`);
  if (!(p.viewerW > 1)) {
    problems.push(
      `viewerW must exceed 1, got ${p.viewerW}. At exactly 1 a vertex reaches ` +
        `the viewer's own w and the perspective divide is by zero; below 1 the ` +
        `projection turns inside out and the solid renders as garbage.`
    );
  }
  if (!(p.thickness > 0)) {
    problems.push(`thickness must be positive, got ${p.thickness}`);
  }
  if (problems.length > 0) throw new Error(`tesseract: ${problems.join("; ")}`);

  // Topology: 16 vertices, 32 edges, and every vertex of degree 4 — a vertex
  // with the wrong degree means the bit-flip adjacency is wrong, which produces
  // a shape that still looks like a lattice while not being a hypercube.
  const edges = hypercubeEdges();
  if (edges.length !== EDGE_COUNT) {
    problems.push(`expected ${EDGE_COUNT} edges, generated ${edges.length}`);
  }
  const degree = new Array(16).fill(0);
  for (const [i, j] of edges) {
    degree[i]++;
    degree[j]++;
  }
  if (degree.some((d) => d !== 4)) {
    problems.push(
      `every vertex of a tesseract has degree 4; got ${JSON.stringify(degree)}`
    );
  }

  // The exported radius must bound every projected vertex, at every phase of
  // the rotation — it sizes both the object on screen and the shadow frustum,
  // so under-reporting it clips geometry out of the depth pass.
  const verts = hypercubeVertices(p.size);
  let worst = 0;
  for (let step = 0; step < 64; step++) {
    const a = (step / 64) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const [x0, y0, z0, w0] of verts) {
      const x1 = x0 * c - w0 * s;
      const w1 = x0 * s + w0 * c;
      const k = (p.viewerW * p.size) / (p.viewerW * p.size - w1);
      worst = Math.max(worst, Math.hypot(x1 * k, y0 * k, z0 * k));
    }
  }
  const bound = outerRadius(p);
  if (worst > bound + 1e-9) {
    problems.push(
      `outerRadius() reports ${bound.toFixed(4)} but a projected vertex reaches ` +
        `${worst.toFixed(4)} during the rotation — the bound is not conservative ` +
        `and geometry will be clipped from the shadow pass`
    );
  }

  if (problems.length > 0) throw new Error(`tesseract: ${problems.join("; ")}`);
}
