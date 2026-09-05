"use client";

import dynamic from "next/dynamic";
import { FacetSphereStill } from "./FacetSphereStill";
import { TieredObject } from "./TieredObject";

/** The login page's object — a binding. All machinery is in `TieredObject`. */
const LoginCanvas = dynamic(
  () => import("./LoginCanvasEntry").then((mod) => mod.LoginCanvasEntry),
  { ssr: false }
);

export function LoginObject() {
  return (
    <TieredObject
      still={<FacetSphereStill />}
      renderLive={(downgraded, onReady) => (
        <LoginCanvas downgraded={downgraded} onReady={onReady} />
      )}
    />
  );
}
