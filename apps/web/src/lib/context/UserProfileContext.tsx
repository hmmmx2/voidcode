"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useUserId } from "@/lib/hooks/useUserId";
import { fetchProfile, type UserProfile } from "@/lib/api/profile";

interface UserProfileContextValue {
  profile: UserProfile | null;
  isLoading: boolean;
  refreshProfile: () => Promise<void>;
}

const UserProfileContext = createContext<UserProfileContextValue>({
  profile: null,
  isLoading: true,
  refreshProfile: async () => {},
});

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const userId = useUserId();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await fetchProfile(userId);
      setProfile(data);
    } catch (err) {
      console.error("Failed to fetch profile:", err);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    refreshProfile().finally(() => setIsLoading(false));
  }, [userId, refreshProfile]);

  return (
    <UserProfileContext.Provider value={{ profile, isLoading, refreshProfile }}>
      {children}
    </UserProfileContext.Provider>
  );
}

export function useUserProfile() {
  return useContext(UserProfileContext);
}
