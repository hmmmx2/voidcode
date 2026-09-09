"use client";

import { UserProfileProvider } from "@/lib/context/UserProfileContext";
// Imported for its side effect: `client.ts` installs the IPC transport interceptor at
// module load. Every api module imports it too, so this is belt and braces — but it makes
// the dependency visible at the root rather than implicit three imports down.
import "@/lib/api/client";

/**
 * Root providers.
 *
 * `SessionProvider` is gone: it polls `/api/auth/session`, which does not exist in this
 * build. Identity comes from `useUserId` instead.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <UserProfileProvider>{children}</UserProfileProvider>;
}
