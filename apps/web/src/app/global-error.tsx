"use client";

/**
 * The last resort: a throw in the ROOT LAYOUT itself.
 *
 * `error.tsx` cannot catch those — it renders *inside* the layout, so if the
 * layout is what failed there is nowhere for it to mount. Only `global-error.tsx`
 * replaces the whole document, which is why it must supply its own `<html>` and
 * `<body>`.
 *
 * It therefore cannot use anything the layout provides: no fonts, no CSS
 * variables, no providers, no `Mark` component. Every colour here is a literal
 * hex value for that reason — reaching for `bg-void` would depend on the
 * stylesheet the failing layout was responsible for loading, and a fallback that
 * needs the thing it is falling back from is not a fallback.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#050507",
          color: "#e7e7ea",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "0.75rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#8a8a93",
          }}
        >
          VoidCode AI
        </p>
        <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 300 }}>
          The app failed to start.
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: "46ch",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            color: "#b4b4bb",
          }}
        >
          Something went wrong before the page could render. Reloading may fix it.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "0.75rem",
            borderRadius: "999px",
            border: "1px solid #3a3a42",
            background: "#16161a",
            color: "#e7e7ea",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        {error.digest && (
          <p
            style={{
              marginTop: "1.5rem",
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.75rem",
              color: "#8a8a93",
            }}
          >
            Reference {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
