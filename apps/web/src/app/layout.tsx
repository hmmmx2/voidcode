import type { Metadata } from "next";
// Playfair Display used to be loaded here and exposed as `--font-playfair`. A
// full search of `src/` found zero consumers — no `font-playfair` utility, no
// `var(--font-playfair)`, and no mapping into a `@theme` `--font-*` token. It was
// a font download on every page for nothing. The landing page's display type is
// Inter at weight 200–300, which is also what the reference sites use.
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";

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
  // correct here — this must not reach the browser bundle. AUTH_URL is already
  // the canonical frontend origin (NextAuth uses it for callback URLs).
  metadataBase: new URL(process.env.AUTH_URL ?? "http://localhost:3000"),
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
