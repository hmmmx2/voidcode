/**
 * Intentionally empty.
 *
 * This file exists to stop PostCSS config discovery at the desktop workspace.
 * Without it, Vite walks up to the repo root and finds the Expo scaffold's
 * `postcss.config.mjs`, which requires `@tailwindcss/postcss` — a dependency of
 * that app, not of this one — and every build fails before it starts.
 *
 * Phase 5 adds the real plugins here when the design system lands (spec §1.0
 * point 6). Until then there is no CSS pipeline to configure.
 */
module.exports = { plugins: {} };
