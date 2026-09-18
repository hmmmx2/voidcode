"use client";

import { usePathname } from "next/navigation";
import PaperReader from "@/components/Research/PaperReader";

/**
 * The slug, read from the URL rather than from route params.
 *
 * The page above prerenders one shell for every paper, so `params` would always say `placeholder`.
 * `usePathname` is the actual address, which is what the handler served this shell for.
 */
export default function Client() {
  const pathname = usePathname();
  const slug = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return <PaperReader slug={slug} />;
}
