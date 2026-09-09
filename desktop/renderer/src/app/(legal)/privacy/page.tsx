import type { Metadata } from "next";
import PrivacyClient from "@/components/Legal/PrivacyClient";

export const metadata: Metadata = {
  title: "Privacy Policy — VoidCode AI",
  description: "Privacy Policy for the VoidCode AI platform.",
};

export default function PrivacyPage() {
  return <PrivacyClient />;
}
