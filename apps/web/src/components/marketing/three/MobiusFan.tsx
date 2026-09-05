"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  createFanGeometry,
  updateFanGeometry,
  FAN_DOWNGRADED,
  FAN_FULL,
  outerRadius,
} from "./fan-geometry";
import { LightRig } from "./LightRig";
import { GlassMaterial } from "./glass-material";
import { useCursorLean } from "./useCursorLean";

/**
 * How much of the visible frame the object should span.
 *
 * Sized against the *maximum* radius, which the three-lobed rim only reaches at
 * three azimuths — so the object reads a little smaller than this number most of
 * the time, and 0.93 is deliberately higher than it looks like it should be.
 */
const FILL = 0.93;

/**
 * Where the three-fold form points, radians about the view axis.
 *
 * This became a real decision the moment the body stopped spinning: the object
 * now presents one aspect forever instead of showing every azimuth over a
 * rotation, so the orientation is permanent rather than something the animation
 * averages away.
 *
 * It lives here rather than in `FanParams` because it cannot live there. The
 * twist is a function of *world* angle (`φ = kθ/2`), so offsetting θ in the
 * geometry shifts which blade sits where without moving the twist field at all —
 * the pinches stay pinned to 60°/180°/300° and the object is unchanged. Only a
 * transform actually rotates it.
 *
 * −30° puts a pinch at the bottom and a lobe straight up, so the form reads as a
 * stable tripod and the two upper lobes open toward the headline. C3 means only
 * 120° of distinct choices exist; this is the one that looked most settled.
 *
 * A separate static group from the animated one on purpose — `rotation.z` on
 * `body` belongs to the cursor lean.
 */
const ORIENTATION = -Math.PI / 6;

/**
 * The pleated Möbius fan.
 *
 * WHY THE BODY NO LONGER SPINS
 *
 * It used to, on an inner group, and the argument for that was a real one:
 * rotating the band about its own normal by Δ is *identical* to advancing every
 * blade's twist phase by −kΔ/2, so a rigid spin bought a travelling twist for
 * free, with no per-frame geometry work at all.
 *
 * That equivalence is exactly why the spin had to go. It cuts both ways: if a
 * uniform phase advance is a rigid rotation, then "make the blades rotate in
 * place instead of spinning the object" is not a different animation — it is the
 * same animation described differently. The only way to get motion that is
 * genuinely *in* the blades rather than *of* the body is a modulation that varies
 * around the ring. So the twist law carries two counter-propagating waves (see
 * `bladeTwist`), each blade rocks about its resting angle, and the wave travels.
 *
 * The cost of that is real: the geometry is now rewritten every frame rather than
 * built once. It is ~64 KB of attribute upload and a few tens of thousands of
 * flops, against a frame that already renders the whole scene twice. Measured, it
 * does not move the p95.
 *
 * What is left on the body is deliberately slow: a long yaw, a slower vertical
 * float, a slight nod, and the cursor lean. Three rigid periods with no common
 * multiple, none of them fast enough to read as rotation — the contrast between
 * those and the quick ripple is what makes it read as a living object rather
 * than a turntable.
 *
 * DO NOT reduce the 0.34 base tilt. At the three pinches every blade is axial,
 * and that tilt is the only thing keeping them a foreshortened band rather than
 * a row of edge-on lines.
 */
export function MobiusFan({ downgraded }: { downgraded: boolean }) {
  const body = useRef<THREE.Group>(null);
  const pointer = useCursorLean();
  const { viewport } = useThree();

  const params = downgraded ? FAN_DOWNGRADED : FAN_FULL;
  const geometry = useMemo(() => createFanGeometry(params), [params]);

  // Built imperatively, so React will not reclaim the GPU buffers.
  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * Priority −1, and that is not cosmetic.
   *
   * r3f runs frame subscribers in ascending priority. `MeshTransmissionMaterial`
   * is a *child* of this component, so React runs its layout effect first and its
   * priority-0 subscriber is inserted ahead of ours — at default priority the
   * transmission pass would read the previous frame's vertex buffers. A negative
   * priority sorts first without flipping r3f into manual-render mode.
   */
  useFrame((state) => {
    updateFanGeometry(geometry, state.clock.elapsedTime);

    const object = body.current;
    if (!object) return;

    // Long, unhurried yaw. Slower and wider than it was when the object span:
    // raising the amplitude alone would just read as head-shaking, and it is the
    // contrast between one slow turn and one quick ripple that reads as alive.
    object.rotation.y = Math.sin(state.clock.elapsedTime * 0.16) * 0.3;
    object.position.y = Math.sin(state.clock.elapsedTime * 0.37) * 0.06;

    // Cursor *lean*, never cursor tracking — tracking reads as a toy. Capped at
    // roughly ±9° and spring-damped toward the target rather than snapped. The
    // nod on x is what stops the three pinches from tracing the same path
    // forever now that nothing else rotates.
    const nod = Math.sin(state.clock.elapsedTime * 0.11) * 0.05;
    const targetX = -pointer.current.y * 0.16 + 0.34 + nod;
    const targetZ = pointer.current.x * 0.1;
    const damp = Math.min(1, 3.2 / 60);
    object.rotation.x += (targetX - object.rotation.x) * damp;
    object.rotation.z += (targetZ - object.rotation.z) * damp;
  }, -1);

  const radius = outerRadius(params);
  // `viewport.height`, not width: the canvas is square, and the fan's widest
  // silhouette lies in its own plane, so height binds once the tilt is applied.
  const scale = (viewport.height * FILL) / (2 * radius);

  return (
    <>
      <LightRig radius={radius * scale} />
      <group ref={body} scale={scale}>
        <group rotation-z={ORIENTATION}>
          <mesh geometry={geometry} castShadow receiveShadow>
            <GlassMaterial preset="fan" downgraded={downgraded} />
          </mesh>
        </group>
      </group>
    </>
  );
}
