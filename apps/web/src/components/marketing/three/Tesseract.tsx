"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  createTesseractGeometry,
  updateTesseractGeometry,
  TESSERACT_DOWNGRADED,
  TESSERACT_FULL,
  outerRadius,
} from "./tesseract-geometry";
import { LightRig } from "./LightRig";
import { GlassMaterial } from "./glass-material";
import { useCursorLean } from "./useCursorLean";

/**
 * Lower than the other objects' fill.
 *
 * `outerRadius` is the extreme the projection reaches only at the peak of the
 * 4D rotation — measured, the object's actual extent swings between 3.26 and
 * 4.15 over a cycle, so sizing to the peak leaves it looking undersized for
 * most of the time.
 *
 * 0.62 corrected for that arithmetically and was still far too small on screen,
 * because a wireframe has almost no filled area: a solid of the same bounding
 * radius reads as much larger than 32 thin beams enclosing empty space. Raised
 * again to 0.98 — higher than either sibling object, and for the same reason.
 *
 * A hypercube's projection is mostly empty space by construction: the eight
 * struts and the inner cell sit well inside the outer one, so the shape only
 * touches its bounding circle at eight corners and reads considerably smaller
 * than its radius implies. The sphere fills its circle everywhere and needs
 * 0.86; this needs to run right up to the edge of its box to carry the same
 * weight beside the form.
 */
const FILL = 0.98;

export function Tesseract({ downgraded }: { downgraded: boolean }) {
  const body = useRef<THREE.Group>(null);
  const pointer = useCursorLean();
  const { viewport } = useThree();

  const params = downgraded ? TESSERACT_DOWNGRADED : TESSERACT_FULL;
  const geometry = useMemo(() => createTesseractGeometry(params), [params]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * Priority −1, exactly as `MobiusFan` needs it and for the same reason.
   *
   * r3f runs frame subscribers in ascending priority, and
   * `MeshTransmissionMaterial` is a *child* of this component — so React
   * registers its priority-0 subscriber first, and at default priority the
   * transmission pass would sample the previous frame's vertex buffers. This
   * object rewrites every vertex each frame, so that would be visible.
   */
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    updateTesseractGeometry(geometry, t);

    const object = body.current;
    if (!object) return;

    // A SLOW 3D YAW ON TOP OF THE 4D ROTATION.
    //
    // This was originally omitted, on the reasoning that the 4D rotation is
    // already the whole event and a second motion would make it impossible to
    // tell which was which. Rendered, that was wrong: with a fixed viewpoint
    // the 4D rotation carries the projection through heavily foreshortened
    // poses where the frame collapses toward a plane and reads as a squashed
    // lattice rather than a hypercube. There is no camera angle that is good
    // for every phase, so the camera has to move.
    //
    // Much slower than the 4D rotation (0.075 against 0.20) so the two remain
    // distinguishable — the eye reads the fast inversion as the object's own
    // behaviour and the slow turn as the viewpoint, which is exactly the
    // separation the original note was worried about losing.
    object.rotation.y = t * 0.075;
    object.position.y = Math.sin(t * 0.33) * 0.045;

    const targetX = 0.16 - pointer.current.y * 0.12;
    const targetZ = pointer.current.x * 0.07;
    const damp = Math.min(1, 3.2 / 60);
    object.rotation.x += (targetX - object.rotation.x) * damp;
    object.rotation.z += (targetZ - object.rotation.z) * damp;
  }, -1);

  const radius = outerRadius(params);
  const scale = (viewport.height * FILL) / (2 * radius);

  return (
    <>
      {/* Shadows OFF. The frame is 32 thin beams with large gaps — there is
          almost no surface to receive a shadow, and the two extra draw calls
          per frame would buy nothing. The beams read against the page by their
          own speculars instead. */}
      <LightRig radius={radius * scale} castShadow={false} />
      <group ref={body} scale={scale}>
        <mesh geometry={geometry}>
          <GlassMaterial preset="frame" downgraded={downgraded} />
        </mesh>
      </group>
    </>
  );
}
