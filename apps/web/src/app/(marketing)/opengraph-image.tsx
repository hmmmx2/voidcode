import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Open Graph card for `/`.
 *
 * Placed inside the `(marketing)` route group deliberately: route groups do not
 * affect URLs, so this attaches to `/` and nothing else. At `app/` it would also
 * apply to `/login`, `/homepage` and `/profile`, which is noise.
 *
 * Do NOT also set `openGraph.images` in `layout.tsx`. The file convention
 * injects the image and merges with the metadata already declared there; a
 * manual `images` value silently wins and disables this file.
 *
 * Two things this depends on that are easy to break:
 *   - `metadataBase` in `app/layout.tsx`, or the URL emitted is localhost.
 *   - the `opengraph-image` exclusion in `middleware.ts`, or every crawler
 *     (all of them sessionless) gets a 307 to /login instead of a PNG.
 *
 * FONTS. `next/font/google` hands back CSS, not font bytes, so Inter cannot be
 * reused from `layout.tsx`. Satori also does not synthesise weights — asking for
 * 300 with only a 400 loaded silently renders 400. These two files were copied
 * out of the `@fontsource/inter` package (latin subset, WOFF, which Satori
 * reads; it cannot read WOFF2). They live in the source tree rather than being
 * read from node_modules so that `process.cwd()`-relative reads keep working in
 * a standalone build. 62 KB for both.
 *
 * SATORI. Flexbox only — no grid, no float. Every element with more than one
 * child needs an explicit `display: flex` or it throws. No `backdrop-filter`,
 * so the glass nav cannot be depicted here. The mark is embedded as a data-URI
 * `<img>` rather than inline SVG because Satori's SVG support is partial and
 * version-dependent, while resvg renders a data-URI image at full fidelity.
 */

export const alt =
  "VoidCode AI — Preparation that builds understanding, not just output.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="butt"><path d="M20.384 7.012A10 10 0 1 1 11.616 7.012"/></svg>`;

/**
 * Background, as an image rather than CSS.
 *
 * A CSS `radial-gradient` here renders wrong: Satori laid it out as a
 * hard-edged rectangle with straight left and bottom borders and an inverted
 * centre — a grey box, not a glow. Its gradient support is partial in the same
 * way its SVG support is. Handing resvg an actual SVG gradient produces exactly
 * the intended falloff, and it is the same reasoning that puts the mark in a
 * data URI.
 */
const BACKDROP = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.17"/><stop offset="55%" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="#000000"/><ellipse cx="840" cy="70" rx="560" ry="420" fill="url(#g)"/></svg>`;

const svgSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

const markSrc = svgSrc(MARK);
const backdropSrc = svgSrc(BACKDROP);

const fontPath = (file: string) =>
  join(process.cwd(), "src", "app", "(marketing)", "fonts", file);

export default async function OpenGraphImage() {
  const [light, regular] = await Promise.all([
    readFile(fontPath("inter-latin-300-normal.woff")),
    readFile(fontPath("inter-latin-400-normal.woff")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          padding: "72px 80px",
          position: "relative",
        }}
      >
        {/* The one soft light. Stands in for the hero's bloom — the page's
            actual depth comes from backdrop-filter and WebGL, neither of which
            Satori can render. */}
        <img
          src={backdropSrc}
          width={size.width}
          height={size.height}
          alt=""
          style={{ position: "absolute", top: 0, left: 0 }}
        />

        <div style={{ display: "flex", alignItems: "center" }}>
          <img src={markSrc} width={40} height={40} alt="" />
          <div
            style={{
              marginLeft: 14,
              fontSize: 26,
              fontWeight: 400,
              color: "#ffffff",
              letterSpacing: "-0.01em",
            }}
          >
            VoidCode AI
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 82,
              fontWeight: 300,
              color: "#ffffff",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            Preparation that builds
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 82,
              fontWeight: 300,
              color: "#848484",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            understanding, not just output.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 24,
            fontWeight: 400,
            color: "#a3a3a3",
          }}
        >
          Guided preparation for ML and systems interviews
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: light, weight: 300, style: "normal" },
        { name: "Inter", data: regular, weight: 400, style: "normal" },
      ],
    }
  );
}
