/**
 * The logged-in app's design primitives.
 *
 * These exist because there were none: seven routes and roughly twenty
 * components had each drawn their own card, chip, progress bar and toolbar,
 * which is how the app accumulated ~404 hardcoded hex literals and three
 * mutually incompatible surface systems.
 *
 * Import from `@/components/app`, not from the individual files.
 *
 * WHAT LIVES ELSEWHERE, AND WHY
 *   `Pill`   — `@/components/ui/Pill`. The product's only button, shared with
 *              the landing page.
 *   `Field`  — `@/components/ui/Field`. Text inputs, shared with auth.
 *   `Reveal` — `@/components/motion/Reveal`. Scroll reveal, shared with the
 *              landing page. Never place it in a `display: none` subtree.
 */
export { AppBackdrop } from "./AppBackdrop";
export { Surface, GlassSurface } from "./Surface";
export { Menu, Modal } from "./Overlay";
export { Badge } from "./Badge";
export { ProgressBar, ProgressRing } from "./Progress";
export { Verdict, VerdictIcon } from "./Verdict";
export { IdePanel, IdeBar, IdeIconButton } from "./IdeFrame";
