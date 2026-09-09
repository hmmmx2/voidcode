/**
 * Static export cannot prerender a dynamic segment without `generateStaticParams`, and
 * these slugs are open-ended — problems, questions and papers come from the database, and
 * Phase 6 lets a user ingest an arXiv paper no build could have known about. A fixed list
 * would be wrong, not merely incomplete.
 *
 * So this is a shell: `generateStaticParams` returns one placeholder because Next needs
 * the function to exist, and the real slug is read from the URL by the client component
 * below. Direct navigation to a real slug is served by the `app://` handler, which falls
 * back to *this* shell — `/interviews/placeholder/index.html` — for any unmatched sibling
 * (`main/protocol.ts`).
 *
 * That last part was wrong until the interviews router was migrated. The handler fell back
 * to the root `index.html`, which is the redirect to `/homepage`, so a cold load of a real
 * question rendered the dashboard instead — successfully, with no error. The name
 * `placeholder` is therefore load-bearing: the fallback looks for it by name.
 *
 * The split exists because `generateStaticParams` is server-only and `usePathname` is
 * client-only; they cannot share a file.
 */
import Client from "./Client";

export function generateStaticParams() {
  return [{ slug: "placeholder" }];
}

export default function InterviewQuestionPage() {
  return <Client />;
}
