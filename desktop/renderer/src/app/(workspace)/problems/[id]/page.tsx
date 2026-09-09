/**
 * Static export cannot prerender a dynamic segment without `generateStaticParams`, and
 * these slugs are open-ended — problems and questions come from the database, and
 * Phase 6 lets a user ingest an arXiv paper no build could have known about. A fixed list
 * would be wrong, not merely incomplete.
 *
 * So this is a shell: `generateStaticParams` returns one placeholder because Next needs
 * the function to exist, and the real slug is read from the URL by the client component
 * below. Direct navigation to a real id is served by the `app://` handler, which falls back
 * to *this* shell — `/problems/placeholder/index.html` — for any unmatched sibling path
 * (`main/protocol.ts`).
 *
 * **The name `placeholder` is load-bearing.** The handler resolves the fallback by looking for
 * a directory called exactly that beside the requested path. This file returned `{ id: "1" }`,
 * so the only problem that ever opened was `/problems/1/`; every other one missed the sibling
 * lookup, fell through to the root `index.html`, and was redirected to `/build` by the root
 * route before this shell could read the id. Clicking any problem in the catalogue landed the
 * user in the IDE.
 *
 * It looked like navigation rather than a 404 — a real page, rendered successfully, just the
 * wrong one — which is the same failure mode the handler's own comment describes for the
 * interviews shell. That one was written correctly and this one was not, and nothing compared
 * them.
 *
 * The split exists because `generateStaticParams` is server-only and `usePathname` is
 * client-only; they cannot share a file.
 */
import Client from "./Client";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function ProblemPage() {
  return <Client />;
}
