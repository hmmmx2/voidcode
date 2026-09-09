/**
 * The local user's profile.
 *
 * Two things here fail silently rather than loudly. The absent-versus-null distinction, which
 * decides whether saving a name wipes the bio — the same rule as `interview_attempts`, built
 * by hand again because SQL has no `exclude_unset`. And the date handling: a birth date is
 * the one field where a plausible-looking value can be impossible, and an age computed from
 * an impossible day is wrong in a way nobody checks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
/** `path.sep`, held in a constant because a literal backslash inside a regex in a heredoc is how
 * this line got written wrong twice. */
const SEP = path.sep;

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const { getProfile, updateProfile, ageFrom, InvalidBirthDateError } = await import(
  "../src/main/store/profile.js"
);

beforeEach(() => {
  __useInMemory();
});

describe("reading", () => {
  it("is empty rather than missing before anything is written", () => {
    // Never undefined. A profile nobody has edited is an empty profile, and making callers
    // handle "no row" would put that decision in every reader.
    expect(getProfile()).toEqual({
      name: null,
      bio: null,
      birthDate: null,
      country: null,
      occupation: null,
      profilePhotoUrl: null,
      timezone: null,
      createdAt: null,
      updatedAt: null,
    });
  });
});

describe("writing", () => {
  it("round-trips every field", () => {
    const saved = updateProfile({
      name: "Alwin",
      bio: "Learning transformers from scratch.",
      birthDate: "1998-03-14",
      country: "Australia",
      occupation: "Student",
      profilePhotoUrl: "app://bundle/icons/user.svg",
      timezone: "Australia/Melbourne",
    });

    expect(saved.name).toBe("Alwin");
    expect(saved.birthDate).toBe("1998-03-14");
    expect(saved.timezone).toBe("Australia/Melbourne");
    expect(getProfile()).toEqual(saved);
  });

  it("leaves an omitted field alone but clears an explicit null", () => {
    updateProfile({ name: "Alwin", bio: "Learning transformers." });

    // Omitted: the bio survives a name-only save. This is the bug the server avoided with
    // Pydantic's `exclude_unset`, rebuilt here by hand.
    const afterName = updateProfile({ name: "Alwin T." });
    expect(afterName.name).toBe("Alwin T.");
    expect(afterName.bio).toBe("Learning transformers.");

    // Explicit null: clearing has to stay possible, which is why this is not COALESCE.
    const cleared = updateProfile({ bio: null });
    expect(cleared.bio).toBeNull();
    expect(cleared.name).toBe("Alwin T.");
  });

  it("treats a field of spaces as cleared, not as a value", () => {
    updateProfile({ country: "Australia" });
    // Otherwise "has the user set a country?" is true for someone who pressed the spacebar.
    expect(updateProfile({ country: "   " }).country).toBeNull();
  });

  it("trims what it stores", () => {
    expect(updateProfile({ name: "  Alwin  " }).name).toBe("Alwin");
  });

  it("touches updated_at but not created_at", () => {
    const first = updateProfile({ name: "Alwin" });
    expect(first.createdAt).not.toBeNull();

    const second = updateProfile({ bio: "later" });
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("creates the row for an empty patch, so 'opened the page' is recorded once", () => {
    expect(updateProfile({}).createdAt).not.toBeNull();
  });

  it("cannot produce a second profile", () => {
    updateProfile({ name: "Alwin" });
    updateProfile({ name: "Someone else" });

    // The CHECK (id = 1) is what makes "one user" true rather than a convention. A table
    // that allowed a second row would eventually get one, and then "the profile" becomes a
    // question about ordering.
    const rows = openDatabase().prepare("SELECT COUNT(*) AS n FROM profile").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    expect(getProfile().name).toBe("Someone else");
  });
});

describe("birth dates", () => {
  it("rejects a date that does not exist", () => {
    // The shape check alone accepts this, and SQLite stores it happily — it has no date
    // type — after which the age is computed from a day that never happened.
    expect(() => updateProfile({ birthDate: "2026-02-30" })).toThrow(InvalidBirthDateError);
    expect(() => updateProfile({ birthDate: "1998-13-01" })).toThrow(InvalidBirthDateError);
    expect(() => updateProfile({ birthDate: "14/03/1998" })).toThrow(InvalidBirthDateError);
    expect(() => updateProfile({ birthDate: "tomorrow" })).toThrow(InvalidBirthDateError);
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(updateProfile({ birthDate: "2024-02-29" }).birthDate).toBe("2024-02-29");
    expect(() => updateProfile({ birthDate: "2023-02-29" })).toThrow(InvalidBirthDateError);
  });

  it("does not write anything when the date is rejected", () => {
    updateProfile({ name: "Alwin" });
    expect(() => updateProfile({ name: "Changed", birthDate: "2026-02-30" })).toThrow();
    // Validation runs before the write, so a bad date cannot take a good name down with it.
    expect(getProfile().name).toBe("Alwin");
  });

  it("still allows clearing", () => {
    updateProfile({ birthDate: "1998-03-14" });
    expect(updateProfile({ birthDate: null }).birthDate).toBeNull();
  });
});

describe("age", () => {
  it("is null without a birth date", () => {
    expect(ageFrom(null)).toBeNull();
  });

  it("subtracts a year when the birthday has not happened yet", () => {
    // The part people get wrong: a plain year subtraction is right for roughly half the
    // year and silently off by one for the rest.
    expect(ageFrom("1998-03-14", new Date("2026-03-13T12:00:00Z"))).toBe(27);
    expect(ageFrom("1998-03-14", new Date("2026-03-14T12:00:00Z"))).toBe(28);
    expect(ageFrom("1998-03-14", new Date("2026-03-15T12:00:00Z"))).toBe(28);
  });

  it("handles a December birthday from January", () => {
    expect(ageFrom("1998-12-31", new Date("2026-01-01T12:00:00Z"))).toBe(27);
  });

  it("refuses to report a negative age", () => {
    // A future birth date is an input error, not someone who is minus three.
    expect(ageFrom("2030-01-01", new Date("2026-08-01T12:00:00Z"))).toBeNull();
  });
});

/**
 * The renderer's `UserProfile` against the table it claims to describe.
 *
 * `role: string` was declared here and no column has ever held a role. Main synthesised `"learner"`
 * in `toProfilePayload` to satisfy the shape, and nothing in the renderer read it — a field invented
 * at the boundary to answer a question the renderer should not have been asking, which
 * `types/host.d.ts` already states as a rule. `email: string` was the same defect with a consumer:
 * `TopNavigation` guarded it with `userProfile?.email && …` while the type insisted it could not be
 * absent, so the guard was load-bearing and the type said it was dead code.
 *
 * A declaration table rather than "every field is a column", because one legitimately is not: `age`
 * is derived from `birth_date` on every read so it cannot be stale on the user's next birthday. The
 * point is that a *new* non-column field has to be justified here before it compiles green.
 */
describe("the renderer's profile type", () => {
  /** Fields with no column, and why each is allowed to exist. */
  const NOT_COLUMNS: Record<string, string> = {
    age: "derived from birth_date on every read, so it cannot be stale on a birthday",
    email: "always null; there is no account server an address could be registered with",
  };

  const schema = (): string => {
    const source = readFileSync(path.join(here, "../src/main/store/db.ts"), "utf8");
    const table = /CREATE TABLE IF NOT EXISTS profile \(([\s\S]*?)\n\);/.exec(source)?.[1];
    expect(table, "the profile table is not in db.ts any more").toBeDefined();
    return table as string;
  };

  const columns = (): Set<string> =>
    new Set(
      schema()
        .split("\n")
        .map((line) => /^\s{2}([a-z_]+)\s/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined)
    );

  const declaredFields = (): string[] => {
    const source = readFileSync(path.join(here, "../renderer/src/lib/api/profile.ts"), "utf8");
    const body = /export interface UserProfile \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, "UserProfile is not declared as an interface any more").toBeDefined();
    return [...(body as string).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
  };

  /** `birthDate` in the renderer is `birth_date` in SQLite; the transport swap is meant to be invisible. */
  const toSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  it("finds both halves, so the comparison is not vacuous", () => {
    expect(columns().size).toBeGreaterThan(6);
    expect(columns()).toContain("birth_date");
    expect(declaredFields().length).toBeGreaterThan(6);
  });

  it("declares no field the table lacks without saying why", () => {
    const present = columns();
    const unexplained = declaredFields()
      .filter((field) => !present.has(toSnake(field)))
      .filter((field) => !(field in NOT_COLUMNS));

    expect(
      unexplained,
      "fields with no column and no entry in NOT_COLUMNS — either add the column or say why it is synthesised"
    ).toEqual([]);
  });

  it("has dropped `role` at both ends", () => {
    /**
     * Both, because either alone leaves the defect. A type without the field but a payload that still
     * sends it is dead weight on the wire; a payload without it and a type that still declares it is
     * `undefined` rendering as a real value.
     */
    expect(declaredFields()).not.toContain("role");
    const main = readFileSync(path.join(here, "../src/main/ipc/handlers/index.ts"), "utf8");
    const payload = /function toProfilePayload\(\)[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    expect(payload, "toProfilePayload not found").not.toBe("");
    expect(payload).not.toMatch(/\brole:/);
  });

  it("keeps NOT_COLUMNS from becoming a place to hide things", () => {
    // Every exemption has to be a field that is actually declared, or the table grows stale excuses.
    const declared = new Set(declaredFields());
    for (const field of Object.keys(NOT_COLUMNS)) {
      expect(declared, `NOT_COLUMNS names ${field}, which UserProfile no longer declares`).toContain(
        field
      );
    }
  });
});

/**
 * One `testCaseToStdin`, not two.
 *
 * `lib/mock-data.ts` held a copy without the `tc.stdin ??` fallback that the live one in
 * `lib/api/problems.ts` has. Nothing imported the copy — `WorkspaceClient` takes the real one — so
 * this was a latent trap rather than a live bug: two functions with one name, one of them subtly
 * wrong, and an import auto-completed from the wrong module would have silently dropped every
 * explicit stdin.
 */
describe("no shadowed helper", () => {
  it("defines testCaseToStdin exactly once in the renderer", () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && /function testCaseToStdin\b/.test(readFileSync(full, "utf8"))) {
          found.push(path.relative(here, full).split(SEP).join("/"));
        }
      }
    };
    walk(path.join(here, "../renderer/src"));

    expect(found).toEqual(["../renderer/src/lib/api/problems.ts"]);
  });
});
