/**
 * Types for `collect-licences.mjs`, so `tests/packaging.test.ts` can import its manifest.
 *
 * The build scripts are plain `.mjs` — they run under bare Node with no build step, which is the
 * point of them — so a declaration file is how the one that is *asserted against* crosses into the
 * typechecked world. Without this, `npm test` passes and `npm run typecheck` fails with TS7016,
 * which is the documented hazard in this repository and has now caught me twice.
 *
 * Kept deliberately small: only what the test reads. Widening it to describe the whole module would
 * be a second place to maintain for no gain.
 */

/** One licence file, its source, and whether a missing source fails the build. */
export interface LicenceArtefact {
  /** Path inside `build/licenses/`, and so inside `resources/licenses/` in the installed app. */
  to: string;
  /** Absolute path on the build machine. */
  from: string;
  required: boolean;
}

export const ARTEFACTS: readonly LicenceArtefact[];

export const TREES: readonly { to: string; cwd: string }[];

/** Gather everything into `build/licenses/`. Throws on a missing required artefact. */
export function collect(): void;
