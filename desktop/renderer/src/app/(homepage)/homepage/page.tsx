import type { Metadata } from "next";
import HomepageClient from "@/components/Homepage/HomepageClient";

export const metadata: Metadata = {
  title: "Homepage — VoidCode AI",
  description: "Your learning homepage",
};

export default function HomepagePage() {
  return <HomepageClient />;
}
