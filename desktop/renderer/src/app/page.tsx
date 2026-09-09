"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Root route.
 *
 * The web app served the marketing landing page here. A desktop app has no visitors to
 * market to — someone who has installed it is already a user — so the landing page and its
 * ~25 three.js files are not in this build.
 *
 * **It lands in the IDE, not the dashboard.** The editor is the product; Interview Prep is a
 * section of it. Opening onto a list of exercises made the thing most people launched this to
 * use into somewhere you navigate to, and put a study dashboard in front of a developer who
 * opened a code editor.
 *
 * A client redirect rather than `redirect()` from `next/navigation`: that is a server function
 * and there is no server under a static export.
 */
export default function Root() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/build");
  }, [router]);
  return null;
}
