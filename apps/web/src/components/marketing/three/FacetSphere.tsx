"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  createFacetSphereGeometry,
  FACET_SPHERE_DOWNGRADED,
  FACET_SPHERE_FULL,
  outerRadius,
} from "./facet-sphere";
import { LightRig } from "./LightRig";
import { GlassMaterial } from "./glass-material";
import { useCursorLean } from "./useCursorLean";

/**
 * How much of the visible frame the object should span.
 *
 * LOWER THAN THE FAN'S 0.93, and the difference is not arbitrary. The fan is
 * three-lobed, so it only reaches its maximum radius at three azimuths and
 * reads smaller than its bounding circle most of the time — 0.93 compensates.
 * A sphere reaches its maximum radius at *every* azimuth, so the same number
 * would have it touching the edges of its box and crowding the form beside it.
 */
const FILL = 0.86;

/**
 * The login object: a crystalline sphere of raised facets.
 *
 * WHY THE YAW IS CONSTANT HERE AND EASED ON THE FAN
 *
 * The fan's yaw oscillates because a full rotation would be a lie: rotating
 * that band is mathematically identical to advancing its twist phase, so a
 * constant spin would undo the whole point of animating the blades.
 *
 * This object has no such equivalence. Its identity *is* its rotational
 * symmetry, and the effect worth having is the key specular sweeping across a
 * field of sharp points — which needs continuous rotation to happen at all. An
 * eased yaw would stall that sweep twice per cycle and read as a stutter.
 *
 * Three incommensurate rigid periods (44.9s yaw, 33.1s nod, 15.3s float) plus
 * the cursor lean, so nothing repeats on a noticeable cycle.
 *
 * THE GEOMETRY IS STATIC AND MUST STAY THAT WAY. No per-frame vertex writes,
 * so `useFrame` runs at the default priority — the fan's `-1` exists solely
 * because it rewrites buffers the transmission pass would otherwise read stale,
 * and copying it here would be cargo-cult.
 */
export function FacetSphere({ downgraded }: { downgraded: boolean }) {
  const body = useRef<THREE.Group>(null);
  const pointer = useCursorLean();
  const { viewport } = useThree();

  const params = downgraded ? FACET_SPHERE_DOWNGRADED : FACET_SPHERE_FULL;
  const geometry = useMemo(() => createFacetSphereGeometry(params), [params]);

  // Built imperatively, so React will not reclaim the GPU buffers.
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((state) => {
    const object = body.current;
    if (!object) return;
    const t = state.clock.elapsedTime;

    object.rotation.y = t * 0.14;
    object.position.y = Math.sin(t * 0.41) * 0.05;

    // Cursor *lean*, never tracking — tracking reads as a toy. Spring-damped
    // toward the target rather than snapped, and capped at roughly ±8°.
    const targetX = 0.28 + Math.sin(t * 0.19) * 0.07 - pointer.current.y * 0.14;
    const targetZ = pointer.current.x * 0.09;
    const damp = Math.min(1, 3.2 / 60);
    object.rotation.x += (targetX - object.rotation.x) * damp;
    object.rotation.z += (targetZ - object.rotation.z) * damp;
  });

  const radius = outerRadius(params);
  const scale = (viewport.height * FILL) / (2 * radius);

  return (
    <>
      {/* Shadows ON. The sphere is non-convex: every valley between two
          adjacent pyramids has both faces sloping up away from it, so those
          valleys self-shadow — and in monochrome those shadow lines are the
          main thing separating one facet from the next. */}
      <LightRig radius={radius * scale} />
      <group ref={body} scale={scale}>
        <mesh geometry={geometry} castShadow receiveShadow>
          <GlassMaterial preset="sphere" downgraded={downgraded} />
        </mesh>
      </group>
    </>
  );
}
