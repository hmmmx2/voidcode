"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { CAMERA } from "./LightRig";

/**
 * The `<Canvas>` host shared by every 3D object on this site.
 *
 * This was `HeroCanvas`. Two things changed when it became shared:
 *
 * 1. **It no longer probes.** The capability decision moved up to
 *    `TieredObject`, above the `import()` boundary, so an incapable device does
 *    not download this chunk to be told it cannot use it. `downgraded` arrives
 *    as a prop already decided.
 * 2. **`shadows` is per-route.** Shadows cost two extra draw calls per frame and
 *    only earn them on a non-convex object — see the note in `LightRig`.
 *
 * `frameloop` drops to "never" whenever the object leaves the viewport or the
 * tab is hidden. There is no point rendering refraction for someone reading the
 * FAQ, and on a laptop the fan is audible proof of it.
 *
 * Two independent effects write the same `active` flag, so a tab-hide followed
 * by a scroll resolves to whichever fired last. That is simple rather than
 * correct, and deliberately so: the failure mode is at worst one wasted frame
 * on a hidden tab, and the alternative is two pieces of state to keep in sync.
 */
export function GlassCanvas({
  children,
  shadows = true,
  onReady,
}: {
  children: ReactNode;
  shadows?: boolean;
  onReady?: () => void;
}) {
  const [active, setActive] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
      rootMargin: "120px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <div ref={hostRef} className="absolute inset-0">
      <Canvas
        // Transparent so the DOM gradient and bloom underneath show through and
        // give the glass something to refract.
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 1.75]}
        frameloop={active ? "always" : "never"}
        camera={CAMERA}
        // PCF-soft when enabled. Only the object is in the scene, so this
        // shadows nothing else and stays cheap.
        shadows={shadows ? "soft" : false}
        onCreated={onReady}
        style={{ pointerEvents: "none" }}
      >
        {children}
      </Canvas>
    </div>
  );
}
