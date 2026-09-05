"use client";

import { useSession } from "next-auth/react";

/**
 * The backend user id from the session, or `undefined`.
 *
 * BEWARE: `undefined` MEANS TWO DIFFERENT THINGS.
 *
 * It is returned while next-auth is still resolving the session, AND when there
 * is no signed-in user, AND when a session token was minted without `backendId`
 * (only the `jwt` callback sets it, and only when `user` is present — see
 * `src/auth.ts`). A caller that writes
 *
 *     useEffect(() => { if (!userId) return; fetch(...) }, [userId])
 *
 * with `isLoading` initialised to `true` therefore hangs on its skeleton
 * FOREVER in the second and third cases — no error, no empty state, just a
 * permanent shimmer. Four pages did exactly that.
 *
 * Prefer `useSessionUser` below, which separates "not ready yet" from "no id".
 */
export function useUserId(): string | undefined {
  const { data: session } = useSession();
  return (session?.user as { backendId?: string } | undefined)?.backendId;
}

/**
 * The id plus whether the session has finished resolving.
 *
 * `ready` is true once next-auth reports either `authenticated` or
 * `unauthenticated` — both are settled answers. Guard effects on `ready`, then
 * fetch regardless of whether `userId` is defined: the API treats a missing
 * identity as the anonymous visitor and still returns the public catalogue, so an
 * unauthenticated reader gets content rather than a skeleton.
 *
 * This is the pattern `QuestionRouter` and `PaperReaderClient` already used
 * correctly; the four catalogue pages did not.
 */
export function useSessionUser(): { userId: string | undefined; ready: boolean } {
  const { data: session, status } = useSession();
  return {
    userId: (session?.user as { backendId?: string } | undefined)?.backendId,
    ready: status !== "loading",
  };
}
