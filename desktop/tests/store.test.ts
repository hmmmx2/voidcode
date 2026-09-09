/**
 * Persistence, against a real in-memory SQLite database.
 *
 * `node:sqlite` needs no native build, so these run anywhere the tests run — which was
 * the reason for choosing it over `better-sqlite3` and is worth demonstrating rather
 * than asserting.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// `db.ts` reads `app.getPath("userData")` for its default location. These tests always
// pass an explicit `:memory:` path, but the import must not fail.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory, closeDatabase } = await import("../src/main/store/db.js");
const { recordSubmission, recentSubmissions, saveDraft, loadDraft, allProgress } =
  await import("../src/main/store/submissions.js");

import type { Grade } from "../src/main/exec/grader.js";

function grade(over: Partial<Grade> = {}): Grade {
  return {
    problemId: "sigmoid",
    solved: true,
    outcome: "ran",
    verdicts: [
      { id: "a", label: "A", visible: true, passed: true, elapsedMs: 0.1 },
      { id: "b", label: "B", visible: false, passed: true, elapsedMs: 0.2 },
    ],
    stdout: "",
    measurements: {
      wallMs: 12,
      slowestCaseMs: 0.2,
      pythonPeakBytes: 1024,
      wasmHeapBytes: 0,
      wasmGrowthBytes: 0,
    },
    limits: { timeLimitMs: 200, memoryLimitMb: 64 },
    ...over,
  };
}

beforeEach(() => {
  closeDatabase();
  __useInMemory();
});

describe("submissions", () => {
  it("records a run and reports pass counts", () => {
    const row = recordSubmission("def sigmoid(x): ...", grade());
    expect(row.solved).toBe(true);
    expect(row.passedCount).toBe(2);
    expect(row.totalCount).toBe(2);
    expect(row.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("keeps history rather than only the best attempt", () => {
    // The history is the interesting part for a learner, and it is the context that
    // lets a tutor be specific about what they already tried.
    recordSubmission("v1", grade({ solved: false }));
    recordSubmission("v2", grade({ solved: false }));
    recordSubmission("v3", grade({ solved: true }));

    const history = recentSubmissions("sigmoid");
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.solved)).toEqual([true, false, false]); // newest first
  });

  it("keeps problems separate", () => {
    recordSubmission("a", grade({ problemId: "sigmoid" }));
    recordSubmission("b", grade({ problemId: "min-max-scale" }));
    expect(recentSubmissions("sigmoid")).toHaveLength(1);
    expect(recentSubmissions("min-max-scale")).toHaveLength(1);
  });

  it("stores a partial pass count honestly", () => {
    const partial = grade({
      solved: false,
      verdicts: [
        { id: "a", label: "A", visible: true, passed: true, elapsedMs: 0.1 },
        { id: "b", label: "B", visible: false, passed: false, elapsedMs: 0.1 },
      ],
    });
    const row = recordSubmission("half", partial);
    expect(row.passedCount).toBe(1);
    expect(row.totalCount).toBe(2);
    expect(row.solved).toBe(false);
  });
});

describe("progress", () => {
  it("counts attempts and remembers the first solve", () => {
    recordSubmission("v1", grade({ solved: false }));
    recordSubmission("v2", grade({ solved: true }));

    const [progress] = allProgress();
    expect(progress?.attemptCount).toBe(2);
    expect(progress?.solved).toBe(true);
    expect(progress?.firstSolvedAt).not.toBeNull();
  });

  it("does not un-solve a problem after a later failure", () => {
    // Having solved it once is a fact. A later broken edit does not undo it, and a
    // learner would rightly be annoyed if it did.
    recordSubmission("good", grade({ solved: true }));
    const first = allProgress()[0]?.firstSolvedAt;

    recordSubmission("broken", grade({ solved: false }));
    const after = allProgress()[0];

    expect(after?.solved).toBe(true);
    expect(after?.firstSolvedAt).toBe(first);
    expect(after?.attemptCount).toBe(2);
  });

  it("leaves firstSolvedAt null until something passes", () => {
    recordSubmission("nope", grade({ solved: false }));
    const [progress] = allProgress();
    expect(progress?.solved).toBe(false);
    expect(progress?.firstSolvedAt).toBeNull();
  });
});

describe("drafts", () => {
  it("returns undefined before anything is typed, so callers fall back to the template", () => {
    expect(loadDraft("sigmoid")).toBeUndefined();
  });

  it("overwrites rather than accumulating", () => {
    // A draft is "what I was in the middle of", not history — that is what submissions
    // are for.
    saveDraft("sigmoid", "first");
    saveDraft("sigmoid", "second");
    expect(loadDraft("sigmoid")).toBe("second");
  });

  it("keeps drafts per problem", () => {
    saveDraft("sigmoid", "s");
    saveDraft("min-max-scale", "m");
    expect(loadDraft("sigmoid")).toBe("s");
    expect(loadDraft("min-max-scale")).toBe("m");
  });
});

describe("migrating an existing database", () => {
  it("carries a message through the whole ladder without touching it", async () => {
    /**
     * Migrations 8 and 14 are a pair, and this asserts where they leave a database rather than
     * where either one leaves it.
     *
     * 8 added `content_format` for a markdown-versus-text distinction that was never built, and
     * 14 removes it. This test used to assert the column exists — the intermediate state — and
     * so it failed the moment the drop landed, which is the test working: an assertion on a
     * halfway point is only ever true by accident of where the ladder happens to stop.
     *
     * What has to hold is that a message written before any of this survives it unchanged.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT
      );
    `);
    raw.prepare("INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?)").run(
      "m1",
      "s1",
      "user",
      "written before any of this",
      "2026-01-01"
    );

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 7);

    const columns = (raw.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
      name?: string;
    }>).map((c) => c.name);
    // Added by 8, removed by 14. A database that ran both ends up as if neither had.
    expect(columns).not.toContain("content_format");

    // And the row is untouched, which is the only thing that ever mattered about it.
    const row = raw.prepare("SELECT id, role, content FROM chat_messages WHERE id = 'm1'").get();
    expect(row).toEqual({ id: "m1", role: "user", content: "written before any of this" });
  });

  it("leaves a database that never had content_format alone", async () => {
    // A fresh install runs the whole ladder from 0, so 14 meets a table that never gained the
    // column. Dropping what is not there is an error, so the guard is not decoration.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL, created_at TEXT, content_format TEXT NOT NULL DEFAULT 'text'
      );
    `);
    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 13);

    expect(() => __runMigrationsForTest(raw, 13)).not.toThrow();
    const columns = (raw.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
      name?: string;
    }>).map((c) => c.name);
    expect(columns).not.toContain("content_format");
  });

  it("adds agent_runs.session_id to a database that predates conversations", async () => {
    /**
     * Migration 11, built the way a schema-10 install's table actually looks.
     *
     * `SCHEMA` declares this column too, for databases created fresh -- so running the step
     * against a table the schema block just made would find it already there and pass while
     * doing nothing. An existing user's `agent_runs` is the only case that can fail, so it is
     * the one constructed here.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE agent_runs (
        id            TEXT PRIMARY KEY,
        project_root  TEXT NOT NULL,
        question      TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        finish_reason TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw.prepare("INSERT INTO agent_runs (id, project_root, question, provider, model) VALUES (?,?,?,?,?)")
      .run("r1", "/w", "rename the thing", "ollama", "llama3.1:8b");

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 10);

    const columns = (raw.prepare("PRAGMA table_info(agent_runs)").all() as Array<{
      name?: string;
    }>).map((c) => c.name);
    expect(columns).toContain("session_id");

    // The run that predates sessions keeps everything it had, and belongs to no conversation.
    const row = raw.prepare("SELECT question, session_id FROM agent_runs WHERE id = 'r1'").get() as {
      question?: string;
      session_id?: string | null;
    };
    expect(row.question).toBe("rename the thing");
    expect(row.session_id ?? null).toBeNull();
  });

  it("keeps the run when its conversation is deleted, rather than blocking or erasing it", async () => {
    /**
     * Why the column is `ON DELETE SET NULL`, asserted rather than described.
     *
     * The two alternatives both fail, and neither fails loudly:
     *   - A bare `REFERENCES` makes `DELETE FROM chat_sessions` throw `FOREIGN KEY constraint
     *     failed` for any conversation that ran the agent -- which would break the delete
     *     button this very phase exists to fix, for exactly the users who use the agent most.
     *   - `CASCADE` would delete the record of which files the agent changed because someone
     *     tidied up a chat.
     *
     * `foreign_keys` is ON here for the same reason it is on in `openDatabase`: without it the
     * clause is inert and this test would pass against any of the three choices.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_root TEXT NOT NULL, question TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, finish_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 10);

    raw.prepare("INSERT INTO chat_sessions (id) VALUES ('s1')").run();
    raw.prepare(
      "INSERT INTO agent_runs (id, project_root, question, provider, model, session_id) VALUES (?,?,?,?,?,?)"
    ).run("r1", "/w", "rewrite main.ts", "ollama", "llama3.1:8b", "s1");

    expect(() => raw.prepare("DELETE FROM chat_sessions WHERE id = 's1'").run()).not.toThrow();

    const row = raw.prepare("SELECT question, session_id FROM agent_runs WHERE id = 'r1'").get() as {
      question?: string;
      session_id?: string | null;
    };
    expect(row.question).toBe("rewrite main.ts");
    expect(row.session_id ?? null).toBeNull();
  });

  it("refuses a run pointing at a session that does not exist", async () => {
    // The other half of the foreign key. `SET NULL` must not be mistaken for "unenforced".
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_root TEXT NOT NULL, question TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, finish_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 10);

    expect(() =>
      raw.prepare(
        "INSERT INTO agent_runs (id, project_root, question, provider, model, session_id) VALUES (?,?,?,?,?,?)"
      ).run("r1", "/w", "q", "ollama", "m", "no-such-session")
    ).toThrow(/FOREIGN KEY/i);
  });

  it("widens agent_steps.kind without losing rows, the key, or the cascade", async () => {
    /**
     * Migration 12: a table rebuild, which is the migration shape that can actually lose data.
     *
     * Built the way a schema-11 install looks -- the narrow CHECK, the foreign key, the index
     * -- and with a row in it, because a rebuild that drops the table is indistinguishable
     * from a correct one when there is nothing in it to lose.
     *
     * `foreign_keys` is ON, matching `openDatabase`, and the whole thing runs inside a
     * transaction the way the real runner does. Both matter: SQLite silently ignores
     * `PRAGMA foreign_keys=OFF` inside a transaction, so a migration written to the standard
     * recipe would believe enforcement was off while it was on.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_root TEXT NOT NULL, question TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, finish_reason TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_steps (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('thought', 'tool', 'proposal', 'error')),
        tool_name  TEXT,
        diff_id    TEXT,
        text       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX ix_agent_steps_run ON agent_steps (run_id, seq);
    `);
    raw.prepare("INSERT INTO agent_runs (id, project_root, question, provider, model) VALUES (?,?,?,?,?)")
      .run("r1", "/w", "do the thing", "ollama", "llama3.1:8b");
    raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, tool_name, text) VALUES (?,?,?,?,?)")
      .run("r1", 0, "tool", "read_file", "the old contents");

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    raw.exec("BEGIN");
    __runMigrationsForTest(raw, 11);
    raw.exec("COMMIT");

    // Nothing lost, down to the column values.
    const kept = raw.prepare("SELECT run_id, seq, kind, tool_name, text FROM agent_steps").all();
    expect(kept).toEqual([
      { run_id: "r1", seq: 0, kind: "tool", tool_name: "read_file", text: "the old contents" },
    ]);

    // The new kinds are admitted...
    expect(() =>
      raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, text) VALUES ('r1', 1, 'command', 'npm test')").run()
    ).not.toThrow();
    expect(() =>
      raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, text) VALUES ('r1', 2, 'applied', 'wrote a.ts')").run()
    ).not.toThrow();

    // ...and the constraint is still a constraint. A rebuild that dropped the CHECK would
    // pass every assertion above.
    expect(() =>
      raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, text) VALUES ('r1', 3, 'bogus', 'x')").run()
    ).toThrow(/CHECK/i);

    // The foreign key survived the rebuild -- easy to lose, since it lives in the CREATE
    // statement that was retyped.
    expect(() =>
      raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, text) VALUES ('ghost', 4, 'tool', 'x')").run()
    ).toThrow(/FOREIGN KEY/i);

    // And so did ON DELETE CASCADE.
    raw.prepare("DELETE FROM agent_runs WHERE id = 'r1'").run();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM agent_steps").get() as { n: number }).n).toBe(0);

    // The index is back. Without it, one run's steps become a table scan.
    const indexes = (raw.prepare("PRAGMA index_list(agent_steps)").all() as Array<{ name?: string }>)
      .map((i) => i.name);
    expect(indexes).toContain("ix_agent_steps_run");
  });

  it("does not rebuild agent_steps a second time", async () => {
    /**
     * Re-running must be free, not merely survivable.
     *
     * The skip is read from `sqlite_master`, because a CHECK is invisible to `table_info` --
     * the constraint text exists only in the stored CREATE statement. Without that check the
     * rebuild would run on every launch of an up-to-date database: a full table copy each
     * time, and a data-loss window each time.
     *
     * Asserted on the stored DDL rather than on "did not throw", which would pass against an
     * implementation that silently copied the table again on every open.
     *
     * This fixture also has a NULL `created_at`, which the real v11 table's default makes
     * impossible -- deliberately, to exercise the `COALESCE` in the copy. Without it one such
     * row aborts the migration, the runner rolls back, `user_version` stays at 11, and the
     * app retries the same doomed migration on every launch with no way out from inside it.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
        question TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        finish_reason TEXT, session_id TEXT, created_at TEXT);
      CREATE TABLE agent_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('thought', 'tool', 'proposal', 'error')),
        tool_name TEXT, diff_id TEXT, text TEXT NOT NULL, created_at TEXT);
    `);
    raw.prepare("INSERT INTO agent_runs (id, project_root, question, provider, model) VALUES ('r1','/w','q','ollama','m')").run();
    raw.prepare("INSERT INTO agent_steps (run_id, seq, kind, text) VALUES ('r1', 0, 'tool', 'x')").run();

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    const identity = (): { sql: string; rootpage: number } =>
      raw
        .prepare("SELECT sql, rootpage FROM sqlite_master WHERE type='table' AND name='agent_steps'")
        .get() as { sql: string; rootpage: number };

    __runMigrationsForTest(raw, 11);
    const first = identity();

    expect(() => __runMigrationsForTest(raw, 11)).not.toThrow();
    const second = identity();

    /**
     * `rootpage`, not just the DDL.
     *
     * A second rebuild produces a byte-identical CREATE statement, so comparing SQL alone
     * cannot tell "skipped" from "did it all again" -- mutation testing showed exactly that,
     * with the skip deleted and the test still green. `rootpage` is where the table's b-tree
     * starts, and dropping and recreating moves it. Same page means the table was left alone.
     */
    expect(second.sql).toBe(first.sql);
    expect(second.rootpage, "the table was rebuilt a second time").toBe(first.rootpage);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM agent_steps").get() as { n: number }).n).toBe(1);
  });

  it("adds chat_sessions.surface and backfills it from the agent runs", async () => {
    /**
     * Migration 13, and the backfill is the part worth testing.
     *
     * Defaulting every existing row to 'tutor' would be *nearly* right — the Build assistant
     * only started saving conversations one version earlier — but "nearly" misfiles every
     * Build conversation a user already has, and those are the ones they are most likely to go
     * looking for.
     *
     * `agent_runs.session_id` is a fact already in the database: only the Build assistant can
     * run the agent, so anything a run points at is its conversation. The backfill reads that
     * rather than guessing.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY, problem_id TEXT, title TEXT,
        created_at TEXT, updated_at TEXT, updated_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_root TEXT NOT NULL, question TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, finish_reason TEXT,
        session_id TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
        created_at TEXT
      );
    `);
    raw.prepare("INSERT INTO chat_sessions (id, title) VALUES ('s-tutor', 'why does softmax overflow')").run();
    raw.prepare("INSERT INTO chat_sessions (id, title) VALUES ('s-build', 'rename it everywhere')").run();
    raw.prepare(
      "INSERT INTO agent_runs (id, project_root, question, provider, model, session_id) VALUES ('r1','/w','q','ollama','m','s-build')"
    ).run();

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 12);

    const rows = raw
      .prepare("SELECT id, surface FROM chat_sessions ORDER BY id")
      .all() as Array<{ id: string; surface: string }>;
    expect(rows).toEqual([
      { id: "s-build", surface: "assistant" },
      { id: "s-tutor", surface: "tutor" },
    ]);

    /**
     * The CHECK came with the column.
     *
     * `ADD COLUMN` accepts one, so a migrated database ends up with exactly the constraint a
     * fresh one has rather than a weaker version of it — which is the kind of divergence that
     * only shows up years later on somebody else's machine.
     */
    expect(() =>
      raw.prepare("INSERT INTO chat_sessions (id, surface) VALUES ('bad', 'nonsense')").run()
    ).toThrow(/CHECK/i);
  });

  it("leaves a database that already has surface alone", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY, surface TEXT NOT NULL DEFAULT 'tutor'
      );
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, session_id TEXT);
    `);
    raw.prepare("INSERT INTO chat_sessions (id, surface) VALUES ('s1', 'assistant')").run();

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    expect(() => __runMigrationsForTest(raw, 12)).not.toThrow();

    // Not re-backfilled, and not reset. A second run must not reclassify anything.
    const row = raw.prepare("SELECT surface FROM chat_sessions WHERE id = 's1'").get() as {
      surface: string;
    };
    expect(row.surface).toBe("assistant");
  });

  it("is idempotent, so a re-run cannot fail on a duplicate column", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);

    const { __runMigrationsForTest } = await import("../src/main/store/db.js");
    __runMigrationsForTest(raw, 7);
    expect(() => __runMigrationsForTest(raw, 7)).not.toThrow();
  });
});
