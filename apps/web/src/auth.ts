import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraId from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** What `/v1/auth/login` and `/v1/auth/password-login` both return. */
type BackendUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google,
    MicrosoftEntraId({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID || "common"}/v2.0`,
      authorization: {
        params: {
          scope: "openid profile email User.Read",
        },
      },
    }),

    /**
     * Email + password.
     *
     * `LoginForm` has always called `signIn("credentials", …)`, and this
     * provider did not exist — so NextAuth rejected every attempt before any
     * network call, and the form showed "That email and password don't match an
     * account" no matter what was typed. There was no wrong password to get
     * right; there was no provider.
     *
     * `authorize` MUST return `null` for every failure rather than throwing.
     * A thrown error surfaces as `CallbackRouteError` and, in development,
     * NextAuth logs the cause — which here would be the submitted password.
     * `null` produces the `CredentialsSignin` code the form already maps to a
     * sentence.
     */
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        try {
          const response = await fetch(`${API_URL}/v1/auth/password-login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: email.trim().toLowerCase(),
              password,
            }),
            cache: "no-store",
          });

          if (!response.ok) {
            // 401 is the expected shape of "wrong credentials" and is not worth
            // logging; anything else means the API is unhappy and is.
            if (response.status !== 401) {
              console.error("[auth] password-login failed:", response.status);
            }
            return null;
          }

          const data = (await response.json()) as BackendUser;
          return {
            id: data.id,
            email: data.email,
            name: data.name,
            // Carried through the jwt callback below, exactly as the OAuth path
            // does, so every page can read one id regardless of how you signed in.
            backendId: data.id,
          };
        } catch (error) {
          console.error("[auth] cannot reach API at", API_URL, error);
          return null;
        }
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account }) {
      /**
       * CREDENTIALS SIGN-IN MUST SKIP THIS ENTIRE CALLBACK.
       *
       * `/v1/auth/login` is find-or-create: it makes an account for any email
       * it does not recognise. Running it after a password sign-in is at best a
       * redundant round trip, and at worst it re-creates a user that
       * `authorize` has already authenticated — while overwriting nothing and
       * silently defeating the deactivated-account check, since find-or-create
       * happily returns `is_active` accounts it just made.
       *
       * `authorize` has already proven who this is and attached `backendId`.
       * There is nothing left for this callback to do.
       */
      if (account?.provider === "credentials") return true;

      if (!user.email) return false;

      try {
        const response = await fetch(`${API_URL}/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: user.email,
            name: user.name ?? user.email.split("@")[0],
            provider: account?.provider ?? "unknown",
            avatar_url: user.image ?? null,
          }),
          cache: "no-store",
        });

        if (!response.ok) {
          console.error("Auth login failed:", response.status);
          return false;
        }

        const data = (await response.json()) as BackendUser;
        // Attach backend user ID to user object for the jwt callback
        (user as typeof user & { backendId: string }).backendId = data.id;
        return true;
      } catch (err) {
        /**
         * THIS IS WHY GOOGLE AND MICROSOFT SIGN-IN FAIL WHEN THE API IS DOWN.
         *
         * OAuth itself succeeds — the provider authenticates you and redirects
         * back — and then this fetch throws `ECONNREFUSED`, the catch returns
         * `false`, and NextAuth denies the sign-in and sends you to
         * `/login?error=AccessDenied`. The result is indistinguishable from
         * "your Google account is not allowed", which is what it looked like.
         *
         * Returning `false` is still correct: without a backend user record
         * there is no `backendId`, and every authed page would 401 on its first
         * request. The fix is not to loosen this — it is to have the API
         * running. The log line below is what makes that diagnosable.
         */
        console.error(
          `[auth] ${account?.provider ?? "oauth"} sign-in denied: cannot reach API at ${API_URL}.`,
          "Start the API (uvicorn on :8000) and try again.",
          err
        );
        return false;
      }
    },

    async jwt({ token, user }) {
      if (user) {
        token.backendId = (user as typeof user & { backendId?: string })
          .backendId;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },

    async session({ session, token }) {
      (session.user as unknown as Record<string, unknown>).backendId =
        token.backendId as string | undefined;
      session.user.email = token.email as string;
      // `name` was set on the token but never copied onto the session, so every
      // consumer fell back to "Student" after a reload even though the value
      // was sitting in the JWT.
      if (token.name) session.user.name = token.name as string;
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },
});
