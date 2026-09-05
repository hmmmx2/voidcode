/**
 * Profile API client — fetch and update user profile.
 */

import { API_BASE, makeHeaders } from "./client";

// ── Types ──────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  bio: string | null;
  birthDate: string | null; // "YYYY-MM-DD"
  age: number | null;
  country: string | null;
  occupation: string | null;
  profilePhotoUrl: string | null;
  timezone: string | null;
  /**
   * Whether the account has a password at all. OAuth-only accounts do not, and a
   * change-password form rendered for one can only fail. Presence only — the API
   * never sends the hash or anything about its strength.
   */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileUpdatePayload {
  name?: string;
  bio?: string | null;
  birth_date?: string | null;
  country?: string | null;
  occupation?: string | null;
  profile_photo_url?: string | null;
  timezone?: string | null;
}

// ── Parsers ────────────────────────────────────────────────────

function parseProfile(data: Record<string, unknown>): UserProfile {
  return {
    id: data.id as string,
    email: data.email as string,
    name: data.name as string,
    role: data.role as string,
    bio: (data.bio as string) ?? null,
    birthDate: (data.birth_date as string) ?? null,
    age: (data.age as number) ?? null,
    country: (data.country as string) ?? null,
    occupation: (data.occupation as string) ?? null,
    profilePhotoUrl: (data.profile_photo_url as string) ?? null,
    timezone: (data.timezone as string) ?? null,
    // Defaults to false, so a payload missing the field hides the form rather than
    // showing one that cannot succeed.
    hasPassword: (data.has_password as boolean) ?? false,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

// ── API Functions ─────────────────────────────────────────────

export async function fetchProfile(userId?: string): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/v1/profile`, {
    headers: makeHeaders(userId),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch profile: ${res.status}`);
  }

  const data = await res.json();
  return parseProfile(data);
}

export async function updateProfile(
  payload: ProfileUpdatePayload,
  userId?: string
): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/v1/profile`, {
    method: "PUT",
    headers: makeHeaders(userId),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to update profile: ${res.status}`);
  }

  const data = await res.json();
  return parseProfile(data);
}
