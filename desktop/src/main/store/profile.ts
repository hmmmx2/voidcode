/**
 * The local user's profile.
 *
 * On the web this was a row in `users`, created at registration and owned by an account
 * server. There is no account server here, so what remains is the part the user typed about
 * themselves — and it is worth keeping precisely because it is theirs: the point of the
 * profile page was that editing it did something, and until now editing it did nothing.
 *
 * `email` and `role` are absent by design rather than unfilled. An address is something you
 * registered with and a role is something a server granted; a local install has neither, and
 * inventing them would be putting a fact in the database that nothing established.
 */
import { openDatabase } from "./db.js";

export interface Profile {
  name: string | null;
  bio: string | null;
  /** ISO `YYYY-MM-DD`. */
  birthDate: string | null;
  country: string | null;
  occupation: string | null;
  profilePhotoUrl: string | null;
  timezone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Absent leaves a field alone; null clears it.
 *
 * The same rule as `interview_attempts`, and it matters for the same reason: the profile
 * form saves whichever fields it holds, so collapsing the two would let a save that only
 * carried a name wipe the bio.
 */
export interface ProfilePatch {
  name?: string | null | undefined;
  bio?: string | null | undefined;
  birthDate?: string | null | undefined;
  country?: string | null | undefined;
  occupation?: string | null | undefined;
  profilePhotoUrl?: string | null | undefined;
  timezone?: string | null | undefined;
}

export class InvalidBirthDateError extends Error {
  constructor(value: string) {
    super(`birth date must be YYYY-MM-DD and a real date (got ${value})`);
    this.name = "InvalidBirthDateError";
  }
}

const EMPTY: Profile = {
  name: null,
  bio: null,
  birthDate: null,
  country: null,
  occupation: null,
  profilePhotoUrl: null,
  timezone: null,
  createdAt: null,
  updatedAt: null,
};

const COLUMNS: Record<keyof ProfilePatch, string> = {
  name: "name",
  bio: "bio",
  birthDate: "birth_date",
  country: "country",
  occupation: "occupation",
  profilePhotoUrl: "profile_photo_url",
  timezone: "timezone",
};

export function getProfile(): Profile {
  const row = openDatabase()
    .prepare(
      `SELECT name, bio, birth_date, country, occupation, profile_photo_url, timezone,
              created_at, updated_at
         FROM profile WHERE id = 1`
    )
    .get() as Record<string, unknown> | undefined;

  // Never undefined. A profile nobody has edited is an empty profile, not a missing one, and
  // making the caller handle "no row" would put that decision in every reader.
  if (row === undefined) return EMPTY;

  return {
    name: (row.name as string | null) ?? null,
    bio: (row.bio as string | null) ?? null,
    birthDate: (row.birth_date as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    occupation: (row.occupation as string | null) ?? null,
    profilePhotoUrl: (row.profile_photo_url as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

export function updateProfile(patch: ProfilePatch): Profile {
  if (patch.birthDate !== undefined && patch.birthDate !== null) {
    assertIsoDate(patch.birthDate);
  }

  const columns: string[] = [];
  const values: (string | null)[] = [];

  for (const key of Object.keys(COLUMNS) as (keyof ProfilePatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    columns.push(COLUMNS[key]);
    // Trimmed, and an all-whitespace field becomes null rather than a string of spaces —
    // otherwise "has the user set a country?" is true for someone who pressed space.
    values.push(value === null ? null : value.trim() === "" ? null : value.trim());
  }

  const db = openDatabase();

  if (columns.length === 0) {
    db.prepare("INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING").run();
  } else {
    const assignments = columns.map((c) => `${c} = excluded.${c}`).join(", ");
    db.prepare(
      `INSERT INTO profile (id, ${columns.join(", ")}, updated_at)
       VALUES (1, ${columns.map(() => "?").join(", ")}, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET ${assignments}, updated_at = datetime('now')`
    ).run(...values);
  }

  return getProfile();
}

/**
 * Age in whole years, derived rather than stored.
 *
 * Subtracting one when the birthday has not happened yet this year is the whole of it, and
 * it is the part people get wrong — a plain year subtraction is right for roughly half the
 * year and silently off by one for the rest.
 */
export function ageFrom(birthDate: string | null, today = new Date()): number | null {
  if (birthDate === null) return null;
  const parts = birthDate.split("-").map(Number);
  const [year, month, day] = parts as [number, number, number];
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;

  let age = today.getFullYear() - year;
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) {
    age -= 1;
  }
  // A future birth date is not an age. Returning a negative number would render as
  // "-3 years old" rather than as the input error it is.
  return age < 0 ? null : age;
}

/**
 * `YYYY-MM-DD`, and a date that exists.
 *
 * The shape check alone accepts `2026-02-30`, which SQLite stores happily — it has no date
 * type — and which then produces an age computed from a day that never happened. The
 * round-trip through `Date` is what rejects it.
 */
function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidBirthDateError(value);

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new InvalidBirthDateError(value);
  if (parsed.toISOString().slice(0, 10) !== value) throw new InvalidBirthDateError(value);
}
