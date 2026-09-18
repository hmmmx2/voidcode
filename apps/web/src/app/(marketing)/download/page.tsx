import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/sections/MarketingNav";
import { DownloadSection } from "@/components/marketing/sections/DownloadSection";
import { MarketingFooter } from "@/components/marketing/sections/MarketingFooter";

export const metadata: Metadata = {
  title: "Download — VoidCode AI",
  description:
    "Download VoidCode for macOS and Windows. Free and open source; the editor, the problems and the grader all run on your own machine.",
};

/**
 * `/download`.
 *
 * ITS OWN PAGE, NOT A SECTION AT THE BOTTOM OF THE OVERVIEW. A download is a destination: it gets
 * linked to from the desktop app's update notice, from a forum reply, from a message to a
 * colleague — and every one of those wants a URL that opens on the installers rather than on a
 * pitch the reader has already been convinced by. It also keeps the overview page from carrying
 * the only client component on the site.
 *
 * The section itself is unchanged and still lives in `components/marketing/sections`, because the
 * pricing page's free column and the overview's hero both link into it and it must stay one thing.
 */
export default function DownloadPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <DownloadSection />
      </main>
      <MarketingFooter />
    </>
  );
}
