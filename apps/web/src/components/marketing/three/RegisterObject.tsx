"use client";

import dynamic from "next/dynamic";
import { TesseractStill } from "./TesseractStill";
import { TieredObject } from "./TieredObject";

const RegisterCanvas = dynamic(
  () => import("./RegisterCanvasEntry").then((mod) => mod.RegisterCanvasEntry),
  { ssr: false }
);

export function RegisterObject() {
  return (
    <TieredObject
      still={<TesseractStill />}
      renderLive={(downgraded, onReady) => (
        <RegisterCanvas downgraded={downgraded} onReady={onReady} />
      )}
    />
  );
}
