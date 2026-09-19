"use client";

import { UserProfileProvider } from "@/lib/context/UserProfileContext";
// Imported for its side effect: `client.ts` installs the IPC transport interceptor at
// module load. Every api module imports it too, so this is belt and braces — but it makes
// the dependency visible at the root rather than implicit three imports down.
import "@/lib/api/client";
import { configureMonacoLoader } from "@/lib/monaco-local";

/**
 * Point Monaco's loader at the bundled `vs/` before anything can ask for Monaco.
 *
 * AT MODULE SCOPE, WHICH IS THE FIX RATHER THAN THE STYLE. `@monaco-editor/loader`'s `init()`
 * is one-shot — it sets `isInitialized` before doing anything — so whoever asks first decides
 * where Monaco is loaded from for the life of the page. `markdown/CodeBlock.tsx` asks, from an
 * effect, on every route with a fenced code block; until this call existed, any route without a
 * Monaco editor mounted asked with the package's default CDN path, the CSP blocked it silently,
 * and code blocks fell back to plain text permanently. Module evaluation of the root client
 * component is strictly before any component effect, so this cannot lose that race.
 *
 * `tests/monaco-loader.test.ts` asserts both halves: the path, and that the call is here.
 */
configureMonacoLoader();

/**
 * Root providers.
 *
 * `SessionProvider` is gone: it polls `/api/auth/session`, which does not exist in this
 * build. Identity comes from `useUserId` instead.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <UserProfileProvider>{children}</UserProfileProvider>;
}
