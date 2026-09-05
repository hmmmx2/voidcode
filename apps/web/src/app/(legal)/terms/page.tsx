import type { Metadata } from "next";
import TermsClient from "@/components/Legal/TermsClient";

export const metadata: Metadata = {
  title: "Terms of Use — VoidCode AI",
  description: "Terms of Use for the VoidCode AI platform.",
};

export default function TermsPage() {
  return <TermsClient />;
}
