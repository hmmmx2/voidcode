"use client";

import { GlassCanvas } from "./GlassCanvas";
import { Tesseract } from "./Tesseract";

/** The `dynamic()` target for `/register`. See `HeroCanvasEntry` for why each route needs one. */
export function RegisterCanvasEntry({
  downgraded,
  onReady,
}: {
  downgraded: boolean;
  onReady: () => void;
}) {
  return (
    <GlassCanvas onReady={onReady} shadows={false}>
      <Tesseract downgraded={downgraded} />
    </GlassCanvas>
  );
}
