"use client";

/**
 * The local user's id.
 *
 * On the web this read `session.user.backendId` from NextAuth. A desktop app with a
 * local SQLite database has exactly one user and no sign-in server, so there is nothing
 * to authenticate against — the whole auth surface (`auth.ts`, `middleware.ts`,
 * `/api/auth/*`, the login and register forms) is absent from this build.
 *
 * This stays a hook, and every caller keeps calling it, but not for the reason it used to give.
 *
 * It said the data layer "still puts `X-User-Id` on its requests". It no longer does: the header
 * is gone from `makeHeaders`, because the transport seam answers over IPC in the same process and
 * main already knows which window asked — the broker binds a mode to the sender. An unverified
 * header asserting identity to yourself is at best noise. (An earlier version of this comment said
 * "sends it to the bundled API"; there is no bundled API — bundling one was considered and
 * rejected, which `lib/api/client.ts` records.)
 *
 * What survives is the `userId` argument itself, which rows are keyed on locally.
 *
 * And when hosted sync arrives it needs exactly one place to change — reverting to a real session
 * means editing this file, not the nine components that read it.
 *
 * Deliberately never `undefined`: the web code paths treat a missing id as "signed out"
 * and skip their fetches, which on the desktop would silently disable half the app.
 */

/**
 * Stable across launches, so rows written today are still yours tomorrow.
 *
 * A fixed literal rather than a generated id: the database is already per-user because
 * it lives in Electron's `userData`, so randomising per install would add nothing and
 * would make a restored backup look like a different person's data.
 */
export const LOCAL_USER_ID = "local-user";

export function useUserId(): string | undefined {
  return LOCAL_USER_ID;
}
