import type { Metadata } from "next";
// Playfair Display used to be loaded here and exposed as `--font-playfair`. A
// full search of `src/` found zero consumers — no `font-playfair` utility, no
// `var(--font-playfair)`, and no mapping into a `@theme` `--font-*` token. It was
// a font download on every page for nothing. The landing page's display type is
// Inter at weight 200–300, which is also what the reference sites use.
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  // Next resolves every relative metadata URL — og:image above all — against
  // this. Unset, it silently falls back to http://localhost:3000, so the
  // Open Graph card ships pointing at a machine nobody else can reach. The
  // failure is invisible locally; only crawlers see it.
  //
  // `metadata` is evaluated on the server, so a non-NEXT_PUBLIC_ variable is
  // correct here — this must not reach the browser bundle.
  //
  // THIS READ `AUTH_URL`, whose name is now a lie. It was NextAuth's canonical-origin variable,
  // and NextAuth went with the logged-in UI; nothing here signs anything. The name mattered
  // because this site deploys to Vercel, where `AUTH_URL` is a name people set expecting an auth
  // library to read it — a variable whose name describes a system that does not exist is worse
  // than one with no name at all. `SITE_URL` says what it is: the origin crawlers resolve
  // og:image against.
  //
  // `VERCEL_PROJECT_PRODUCTION_URL` is the fallback because Vercel sets it on every deployment,
  // so a deploy that forgets `SITE_URL` still gets a reachable origin instead of localhost —
  // which is the failure that is invisible locally and visible only to crawlers.
  metadataBase: new URL(
    process.env.SITE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL !== undefined
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3000")
  ),
  title: "VoidCode AI",
  description: "Guided preparation for machine learning and systems interviews.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>
        {/*
          NO PROVIDER WRAPPER. This held `SessionProvider` and a user-profile context for the
          logged-in application. Both went with it: sign-in is in the desktop app, and what is left
          here — the landing page, the legal documents and Stripe's two return pages — has neither a
          session nor a profile. `SessionProvider` was worse than unused: it polls
          `/api/auth/session` on every page load, and that route no longer exists.
        */}
        {children}
      </body>
    </html>
  );
}
