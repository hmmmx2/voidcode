/**
 * Shell for the Interview Prep surfaces that live in the workbench.
 *
 * Bare: the workbench supplies the menu bar, activity bar and section sidebar. This exists
 * because a route group without its own layout inherits the nearest one above it, and
 * `(homepage)`'s carries a backdrop, a footer and a page-level scroll container — none of
 * which belong on a surface inside a fixed frame.
 */
export default function PrepLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-full">{children}</div>;
}
