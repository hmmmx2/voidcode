"use client";

import { SessionProvider } from "next-auth/react";
import { UserProfileProvider } from "@/lib/context/UserProfileContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <UserProfileProvider>{children}</UserProfileProvider>
    </SessionProvider>
  );
}
