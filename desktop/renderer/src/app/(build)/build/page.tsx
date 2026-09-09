import BuildWorkspace from "@/components/Build/BuildWorkspace";

/**
 * `/build` — the standalone IDE.
 *
 * Its own route group, not `(workspace)`: no problem tabs, no Submit, no tutor. A Build
 * window opens here directly (`windows.ts` routes it), and a Study window that navigates
 * here finds `host.fs` absent and says so.
 */
export default function BuildPage() {
  return <BuildWorkspace />;
}
