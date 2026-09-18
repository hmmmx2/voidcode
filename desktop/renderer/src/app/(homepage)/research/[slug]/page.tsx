/**
 * The shell for every paper, named `placeholder` because the `app://` handler looks it up by that
 * exact word.
 *
 * Static export cannot prerender a dynamic segment without `generateStaticParams`, and these slugs
 * come from the database — a fixed list would be wrong rather than merely incomplete. So this
 * exports one placeholder route, and `Client` reads the real slug from the URL. A cold load of
 * `/research/attention-is-all-you-need` is served by `resolveRoute`, which falls back to this
 * sibling shell; without the name it would fall through to the root `index.html`, which redirects,
 * and the paper would silently open the dashboard instead. That has already happened twice in this
 * application — see `src/main/protocol.ts`.
 *
 * `generateStaticParams` is server-only and `usePathname` is client-only, so they cannot share a
 * file. Hence the split.
 */
import Client from "./Client";

export function generateStaticParams() {
  return [{ slug: "placeholder" }];
}

export default function PaperPage() {
  return <Client />;
}
