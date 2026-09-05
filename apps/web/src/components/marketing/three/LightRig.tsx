"use client";

import { useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";

/**
 * The camera every object in this system is lit and framed for.
 *
 * Exported from the same file as the rig on purpose. `LightRig`'s shadow
 * frustum uses `near: 3` / `far: 8`, which are not arbitrary — they bracket an
 * object of world radius ≲1.2 sitting at the origin as seen from `z = 6`. Move
 * the camera without moving them and the object falls outside the depth range:
 * shadows vanish entirely, or clamp to a single flat value. Nothing errors.
 *
 * Keeping the two in one file, plus the dev assert below, is what makes that
 * coupling discoverable instead of a trap.
 */
export const CAMERA = { position: [0, 0, 6] as [number, number, number], fov: 32 };

/**
 * The studio rig.
 *
 * A clear glass object in an empty black void is a grey blob, because
 * everything that makes glass legible is borrowed from its surroundings. In
 * monochrome all of it has to be built. Three lightformers do that work and
 * none of them is ever visible — they exist only in the reflection:
 *
 *   KEY   a narrow, tall rect at a grazing angle. This is the one that produces
 *         the long streak that reads as "studio glass".
 *   FILL  a large soft rect above and behind, giving the body its satin falloff.
 *   KICK  a small hot rect below-right, separating the lower edge from the void.
 *
 * `frames={1}` is the single most important prop here: the cubemap is rendered
 * **once**, not per frame. `frames={Infinity}` would re-render three
 * lightformers into a 256² cubemap on every tick for a rig that never moves.
 *
 * THE DIRECTIONAL LIGHT IS NOT DECORATION, but it is not always needed either.
 *
 * `<Lightformer>`s are emissive meshes inside the environment scene rather than
 * `THREE.Light`s, so they cannot cast. Image-based light alone therefore cannot
 * separate one part of an object from another that lies against it. For the
 * Möbius fan that is fatal — its blades cannot refract each other (drei renders
 * the transmission FBO with the mesh swapped to a discard material) and without
 * the shadow pass the pleats collapse into a smear.
 *
 * It is per-object because it is not free: shadows cost two extra draw calls per
 * frame. A **non-convex** object needs them — the facet sphere's valleys between
 * adjacent pyramids self-shadow, and those lines are what separate one facet
 * from the next in monochrome. A near-convex one (the chamfered cube) has almost
 * nothing to self-shadow and should pass `castShadow={false}`.
 *
 * `normalBias`, not `bias`, is the knob for acne here. It was tuned while the
 * hero object still span, which swept every surface past the light and averaged
 * artefacts away. Objects that hold a fixed angle to the light would show any
 * artefact permanently, in the same pixels.
 */
export function LightRig({
  radius,
  castShadow = true,
}: {
  radius: number;
  castShadow?: boolean;
}) {
  const extent = radius * 1.15;
  const cameraZ = useThree((state) => state.camera.position.z);

  if (process.env.NODE_ENV !== "production" && Math.abs(cameraZ - CAMERA.position[2]) > 1e-6) {
    console.error(
      `LightRig: camera is at z=${cameraZ} but the shadow frustum near/far (3/8) ` +
        `assumes z=${CAMERA.position[2]}. The object will fall outside the depth ` +
        `range and shadows will silently disappear. Move near/far with the camera.`
    );
  }

  return (
    <>
      <Environment resolution={256} frames={1}>
        <color attach="background" args={["#000000"]} />
        <Lightformer
          form="rect"
          intensity={7}
          position={[-4, 1, 2]}
          scale={[0.4, 8, 1]}
          rotation={[0, Math.PI / 2, 0]}
          color="#ffffff"
        />
        <Lightformer
          form="rect"
          intensity={2.2}
          position={[1.5, 5, -3]}
          scale={[9, 6, 1]}
          rotation={[Math.PI / 4, 0, 0]}
          color="#e8e8ea"
        />
        <Lightformer
          form="rect"
          /* Carries more weight when `castShadow` is off: with no shadow pass
             separating the lower edge from the void, this is the only thing
             doing it. */
          intensity={castShadow ? 3.4 : 4.2}
          position={[3.5, -3, 2.5]}
          scale={[2, 1.4, 1]}
          rotation={[0, -Math.PI / 3, 0]}
          color="#ffffff"
        />
      </Environment>

      <directionalLight
        castShadow={castShadow}
        position={[-3.2, 3.6, 2.4]}
        intensity={1.15}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={3}
        shadow-camera-far={8}
        shadow-bias={-0.0006}
        shadow-normalBias={0.03}
      />
    </>
  );
}
