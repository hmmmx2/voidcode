/**
 * Shell for `/build`.
 *
 * Bare, because the workbench now supplies the chrome: the menu bar, the activity bar and
 * the panel toggles all live in the root layout. This route used to carry `TopNavigation`
 * itself; keeping it would draw a second navigation inside the first.
 *
 * No scroll container either — the IDE is a fixed three-column surface that manages overflow
 * per column, and a page-level scroller would let the whole editor scroll out of view.
 */
export default function BuildLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-full">{children}</div>;
}
