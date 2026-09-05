/**
 * Whether this device should be running a transmission material at all.
 *
 * THIS FILE MUST IMPORT NOTHING. Not React, not `three`, not a util.
 *
 * That is not tidiness, it is the whole point of the module existing. The probe
 * used to live inside `HeroCanvas.tsx`, which *is* the lazily-imported chunk —
 * so a device with no WebGL2 or a software rasteriser downloaded **256 KB gz of
 * three and drei and then rendered `null`**. Every byte of that was wasted on
 * exactly the devices least able to afford it.
 *
 * Hoisting the probe above the `import()` boundary means the decision is made
 * before the chunk is requested. It is free because this file has no
 * dependencies: it can sit in the initial graph without dragging anything in.
 *
 * The corollary is a rule with teeth — see `TieredObject.tsx`: **no module on
 * the initial graph may import from `three`, `@react-three/fiber` or
 * `@react-three/drei`, directly or transitively.** Add an import here and the
 * lazy chunk silently becomes an eager one, the page still works, and the only
 * symptom is the payload budget moving.
 */

export type Capability = "full" | "downgraded" | "none";

/**
 * Two failure modes are worth catching before they cost anyone a frame: no
 * WebGL2 context, where the canvas would simply never paint, and a software
 * rasteriser, where `MeshTransmissionMaterial`'s per-frame render target turns a
 * decorative background element into a stalled main thread.
 *
 * Deliberately NOT checked: `navigator.deviceMemory` (absent on Safari and
 * Firefox, so it would misfire on the platforms it would matter most for) and
 * anything user-agent shaped. Mobile is handled by layout, never by tier —
 * a phone with a real GPU should get real glass.
 */
export function probeCapability(): Capability {
  if (typeof window === "undefined") return "none";

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) return "none";

  let renderer = "";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");

  // Release immediately. Browsers cap simultaneous WebGL contexts (~16 in
  // Chrome) and evict the oldest when the cap is hit — a probe context left
  // alive would count against the budget of the canvas we are about to create.
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  // `hardwareConcurrency` is the proxy for a weak device. Absent means old
  // Safari, which is treated as capable — the fallback tier is a visual
  // downgrade and guessing wrong toward "capable" is the cheaper error.
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4;

  if (software) return "none";
  return weak ? "downgraded" : "full";
}
