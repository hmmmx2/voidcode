/**
 * Local persistence: one SQLite file, no server.
 *
 * Uses `node:sqlite` from Node's standard library rather than `better-sqlite3`. That
 * choice is about the open-source goal as much as ergonomics: a native module means
 * every contributor needs a working C++ toolchain, and every release needs a prebuild
 * matrix across three platforms and two architectures. `node:sqlite` needs neither,
 * which is why Electron was moved to 43 (Node 24) to get it.
 *
 * Everything here is local and user-owned (spec §2.11). Nothing is synced, and the
 * file is a plain SQLite database the user can open, inspect, back up or delete with
 * any tool — which is the point of a local-first app rather than an incidental
 * property of it.
 */
import { DatabaseSync } from "node:sqlite";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

let db: DatabaseSync | undefined;

/**
 * Schema, applied idempotently.
 *
 * `user_version` rather than a migrations table: this is a single-writer local file
 * with a handful of tables, and a full migration framework would be more machinery
 * than the problem deserves until the schema actually churns.
 */
/**
 * 2 adds `chat_sessions` and `chat_messages`. 3 adds `interview_attempts`. 4 adds
 * `notifications`. 5 adds `profile`. 6 adds `recent_projects`. 7 adds `windows` and
 * `window_workspace`. 8 adds `chat_messages.content_format`, which is the first change that
 * needs a real step — see `MIGRATIONS`. 9 adds `memory_consent`. 10 adds `agent_runs` and
 * `agent_steps`. 11 adds `agent_runs.session_id`, which needs a step -- see `MIGRATIONS`.
 * 12 widens `agent_steps.kind`, which needs a table rebuild. 13 adds
 * `chat_sessions.surface`, which needs a step and a backfill. 14 removes
 * `chat_messages.content_format`, which nothing ever read. 15 adds the three
 * `interview_attempts.assessed_*` columns, which need a step. 16 adds `secrets`, so an API key
 * survives a restart instead of being re-entered every launch.
 *
 * 15 was missing from this list until 16 was added, which is worth noting rather than quietly
 * fixing: `agent_plans` and `agent_designs` arrived with no bump at all — correctly, since a new
 * table needs no step — so the numbering here tracks *steps that needed writing down*, and a gap
 * reads as a lost entry rather than as an absence of work.
 *
 * No migration step is needed for any of these — `SCHEMA` is executed on every open and is
 * entirely `CREATE ... IF NOT EXISTS`, so an existing file gains the tables the next time it
 * is opened. The bump records that the schema moved, so the first migration that *does* need
 * steps has an accurate version to branch on.
 */
const SCHEMA_VERSION = 16;

/**
 * Steps that `CREATE ... IF NOT EXISTS` cannot express.
 *
 * Empty at 7, and added now rather than later on purpose: the first change that genuinely
 * needs a step — an `ALTER TABLE`, a backfill, a column whose default has to be computed —
 * should not also be the change that invents the runner. Everything so far has been a new
 * table, which the schema block handles by itself.
 *
 * A CHECK constraint cannot be altered. Rewriting one means building a new table and copying,
 * which is a real migration with a real risk of data loss and belongs in a change of its own.
 * Migration 12 is that change, for `agent_steps.kind`; `chat_messages.role` is still narrow
 * and still deliberately so, since agent transcripts have their own tables.
 */
const MIGRATIONS: ReadonlyArray<{ to: number; up: (db: DatabaseSync) => void }> = [
  {
    to: 8,
    up(database) {
      /**
       * `ALTER TABLE ... ADD COLUMN` with a default is the one schema change SQLite does
       * cheaply — it does not rewrite the table, so this is instant on any real database.
       *
       * Existing rows are all `text`, which is correct: every message written before this
       * column existed was a plain string.
       *
       * Note what is deliberately NOT here: the `role` CHECK on this table still excludes
       * `tool`, and it stays that way. SQLite cannot alter a constraint, so widening it means
       * building a new table and copying — a real migration with real data-loss risk, for a
       * gain that is not needed. Agent transcripts are a different thing from tutor chat and
       * get their own tables when the agent lands.
       */
      const columns = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
        name?: string;
      }>;
      if (columns.some((column) => column.name === "content_format")) return;

      database.exec(
        `ALTER TABLE chat_messages ADD COLUMN content_format TEXT NOT NULL DEFAULT 'text'`
      );
    },
  },
  {
    to: 11,
    up(database) {
      /**
       * `agent_runs.session_id`, so a run can say which conversation it came from.
       *
       * The `SCHEMA` block above declares this column too, for databases created fresh. This
       * step is for the ones that already exist, since `CREATE TABLE IF NOT EXISTS` does
       * nothing to a table that is already there -- the trap that makes "just add it to the
       * DDL" appear to work on a developer's machine and change nothing on a user's.
       *
       * Two SQLite facts this depends on, both verified against a real database rather than
       * assumed:
       *
       *   1. `ADD COLUMN` may carry a `REFERENCES` clause only when the default is NULL.
       *      It is, so this is legal and cheap -- no table rewrite.
       *   2. `ON DELETE SET NULL` is doing real work, because `PRAGMA foreign_keys = ON` is
       *      set per connection below. Without the clause, `deleteSession` would throw
       *      `FOREIGN KEY constraint failed` for any conversation that had run the agent.
       */
      const columns = database.prepare("PRAGMA table_info(agent_runs)").all() as Array<{
        name?: string;
      }>;

      /**
       * Three states, and only one of them is work.
       *
       * An empty result means the table does not exist at all — `PRAGMA table_info` reports
       * that as no rows rather than as an error. In `openDatabase` that cannot happen, because
       * `SCHEMA` runs first and creates it *with* this column; but migrations are also run on
       * their own by `__runMigrationsForTest`, and a step that assumes a table into existence
       * throws `no such table` there.
       *
       * Returning is the correct answer rather than a defensive one: migrations alter tables,
       * `SCHEMA` creates them. A database without `agent_runs` will be given the current shape
       * by the schema block, so there is nothing here left to add.
       */
      if (columns.length === 0) return;
      if (columns.some((column) => column.name === "session_id")) return;

      database.exec(
        `ALTER TABLE agent_runs
           ADD COLUMN session_id TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL`
      );
    },
  },
  {
    to: 12,
    up(database) {
      /**
       * Widen `agent_steps.kind` to admit 'command' and 'applied'.
       *
       * This is the table rebuild the note above says belongs in its own change, and it is
       * its own change. SQLite cannot alter a CHECK constraint: the only way is to build a
       * new table with the constraint you want, copy every row across, drop the old one and
       * rename. Everything that can go wrong here loses data, so what follows is deliberate.
       *
       * **Mapping the new kinds onto `tool` instead would have avoided all of this, and it
       * is the wrong trade.** The audit log is precisely where "it ran `rm -rf build`" has to
       * be legible, and a `command` recorded as a `tool` is a shell invocation filed under
       * the same label as reading a file.
       *
       * ## Why this is safe inside the migration runner's transaction
       *
       * The canonical 12-step recipe in SQLite's own documentation opens with
       * `PRAGMA foreign_keys=OFF`, and the runner has already issued `BEGIN` by the time this
       * is called — where that pragma is a **silent no-op**. SQLite ignores it inside a
       * transaction and does not report anything. Following the recipe literally would
       * therefore produce a migration that believed foreign keys were off while they were on.
       *
       * Checked against a real database rather than reasoned about, and the conclusion is
       * that the pragma is not needed here at all. That step exists for tables which are
       * *referenced* by others: dropping such a table with enforcement on would break the
       * referrers, or — with `legacy_alter_table` off — silently rewrite their clauses to
       * point at the temporary name. `agent_steps` is the child. It references `agent_runs`
       * and nothing references it, so there is nothing for the drop to break.
       *
       * The copy satisfies the foreign key by construction, since every `run_id` being copied
       * already pointed at a real run. Verified afterwards: rows preserved, the widened CHECK
       * accepting the new kinds, the old ones still rejected, the foreign key still enforced,
       * and `ON DELETE CASCADE` still cascading. `store.test.ts` asserts each of those.
       */
      const columns = database.prepare("PRAGMA table_info(agent_steps)").all() as Array<{
        name?: string;
      }>;
      // No table means `SCHEMA` has not run yet and will create the current shape. See the
      // same guard in migration 11.
      if (columns.length === 0) return;

      /**
       * Skip when the constraint is already wide enough.
       *
       * Read from `sqlite_master`, because a CHECK is not visible through `table_info` — the
       * only place the constraint text exists is the stored CREATE statement. Without this
       * the rebuild would run on every open of an up-to-date database, which is a table copy
       * per launch and a data-loss window per launch.
       */
      const ddl = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_steps'")
        .get() as { sql?: string } | undefined;
      if (ddl?.sql?.includes("'command'") === true) return;

      database.exec(`
        CREATE TABLE agent_steps_v12 (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id     TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
          seq        INTEGER NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('thought', 'tool', 'proposal', 'error', 'command', 'applied')),
          tool_name  TEXT,
          diff_id    TEXT,
          text       TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- COALESCE on the two NOT NULL columns whose old rows might not have one.
        --
        -- The v11 table declares both with defaults, so in principle no row can be null. In
        -- practice this is a user's own SQLite file, which they are invited to open with any
        -- tool -- and the failure without this is severe out of proportion to the cause: one
        -- null row aborts the copy, the runner rolls the whole transaction back, and
        -- user_version stays at 11. The app then retries the same doomed migration on every
        -- launch, with no way out from inside it.
        --
        -- Substituting is the lesser evil and an honest one for an audit log: a step whose
        -- time was never recorded gets the time it was noticed missing.
        --
        -- (No backticks. This is inside a template literal; that is the fifth time.)
        INSERT INTO agent_steps_v12 (id, run_id, seq, kind, tool_name, diff_id, text, created_at)
          SELECT id, run_id, seq, kind, tool_name, diff_id,
                 COALESCE(text, ''), COALESCE(created_at, datetime('now'))
            FROM agent_steps;

        DROP TABLE agent_steps;
        ALTER TABLE agent_steps_v12 RENAME TO agent_steps;

        CREATE INDEX IF NOT EXISTS ix_agent_steps_run ON agent_steps (run_id, seq);
      `);
    },
  },
  {
    to: 13,
    up(database) {
      /**
       * `chat_sessions.surface`, so the tutor's history stops listing the Build assistant's
       * conversations and the other way round.
       *
       * Both surfaces share these tables deliberately. What was missing is the only thing that
       * genuinely differs between them -- whose conversation it is -- and without it there was
       * no way to tell: `problem_id` is null on tutor sessions too, because the local problems
       * are identified by slug and the column only ever held a UUID.
       *
       * `ADD COLUMN` with a NOT NULL DEFAULT is the cheap change SQLite does without rewriting
       * the table, and it accepts the CHECK, so a migrated database ends up with exactly the
       * constraint a fresh one has rather than a weaker version of it.
       */
      const columns = database.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{
        name?: string;
      }>;
      // No table means `SCHEMA` has not run and will create the current shape. Same guard as
      // migrations 11 and 12.
      if (columns.length === 0) return;
      if (columns.some((column) => column.name === "surface")) return;

      database.exec(
        `ALTER TABLE chat_sessions
           ADD COLUMN surface TEXT NOT NULL DEFAULT 'tutor'
           CHECK (surface IN ('tutor', 'assistant'))`
      );

      /**
       * Backfilled from evidence rather than assumed.
       *
       * Defaulting everything to 'tutor' would be *nearly* right -- the Build assistant only
       * started saving conversations one schema version ago -- but "nearly" would silently
       * misfile every Build conversation a user already has, and they are the ones most likely
       * to be looking for them.
       *
       * `agent_runs.session_id` is the record of which conversations ran the agent, and only
       * the Build assistant can. It is a fact already in the database, so the backfill reads
       * it instead of guessing. Sessions nothing points at stay 'tutor', which is correct:
       * the tutor has no runs.
       */
      database.exec(`
        UPDATE chat_sessions
           SET surface = 'assistant'
         WHERE id IN (SELECT session_id FROM agent_runs WHERE session_id IS NOT NULL)
      `);
    },
  },
  {
    to: 14,
    up(database) {
      /**
       * Remove `chat_messages.content_format`, which nothing has ever read.
       *
       * Migration 8 added it for a distinction between markdown and plain text that was never
       * built. Every row holds `'text'`, no query selects it, no type carries it, and no
       * renderer branches on it.
       *
       * **It is not merely unused — it is unusable, because the fact it would hold is
       * derivable.** Assistant prose is markdown and a user's own turn is shown verbatim;
       * `Markdown.tsx` makes exactly that split, and it makes it from `role`. This file argues
       * the same point about `messageCount` being a join rather than a column, "so it cannot
       * drift from the rows it describes". A stored `content_format` could drift from `role`;
       * a derived one cannot.
       *
       * So the choice is not between using it and dropping it. It is between dropping it and
       * leaving a column that invites the next person to wire something to it inconsistently.
       *
       * Migration 8 stays rather than being deleted. The list of versions above is a record of
       * what happened to databases that exist, and a user who ran 8 did gain this column —
       * rewriting that to claim they never did would make the history a worse guide than no
       * history. Add-then-drop is instant and honest.
       *
       * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35+; `node:sqlite` here is 3.49.
       */
      const columns = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
        name?: string;
      }>;
      if (columns.length === 0) return;
      if (!columns.some((column) => column.name === "content_format")) return;

      database.exec(`ALTER TABLE chat_messages DROP COLUMN content_format`);
    },
  },
  {
    to: 15,
    up(database) {
      /**
       * Keep the assessment verdict, which was being computed and thrown away.
       *
       * `interviews:assess` runs a model over a written answer and returns
       * `correct | partial | incorrect | unknown | too_short`. Nothing stored it: the row held
       * only the *self*-rating, so the app's record of how someone was doing was entirely
       * self-reported, and the one independent read on an answer lived as long as the panel
       * was open.
       *
       * Three columns rather than one, because a verdict alone is not enough to trust later.
       * `assessed_model` records what produced it — `firstUsableModel()` picks whatever is
       * installed, so two verdicts a month apart may come from different models — and
       * `assessed_at` distinguishes a verdict from a stale one against a since-edited answer.
       *
       * `ADD COLUMN` three times rather than a rebuild: all three are nullable with no
       * default, which is the case SQLite does in place. No CHECK, deliberately — see the
       * schema comment, and migration 12 for what widening one costs.
       *
       * **Guarded by `table_info`, the way migration 8 is, and not optionally.** `openDatabase`
       * runs `SCHEMA` before the runner, so on a fresh database these columns already exist and
       * an unguarded `ADD COLUMN` raises "duplicate column name" — which is every first launch,
       * not an edge case. The seam's own docstring says as much: a migration run against
       * `SCHEMA` should find its column already there and pass.
       */
      const existing = new Set(
        (database.prepare("PRAGMA table_info(interview_attempts)").all() as Array<{
          name?: string;
        }>).map((column) => column.name)
      );

      /**
       * No table, nothing to alter — and this is not a defensive flourish.
       *
       * The runner is handed whatever shape a database is in, and `store.test.ts` exercises the
       * ladder against minimal databases holding only the tables a given step needs. `PRAGMA
       * table_info` on a table that does not exist returns an empty list rather than throwing,
       * so without this the loop falls straight through to "no such table". Skipping is correct
       * rather than merely safe: a database with no `interview_attempts` gets one, complete with
       * these columns, from `SCHEMA`.
       */
      if (existing.size === 0) return;

      for (const column of ["assessed_verdict", "assessed_model", "assessed_at"]) {
        if (existing.has(column)) continue;
        database.exec(`ALTER TABLE interview_attempts ADD COLUMN ${column} TEXT`);
      }
    },
  },
];

const SCHEMA = `
-- Every graded run, append-only. Kept in full rather than as "best attempt" because
-- the history is the interesting part for a learner, and for the tutor: what someone
-- tried and why it failed is the context that makes a hint specific.
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id    TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  solved        INTEGER NOT NULL CHECK (solved IN (0, 1)),
  outcome       TEXT    NOT NULL,
  passed_count  INTEGER NOT NULL,
  total_count   INTEGER NOT NULL,
  slowest_ms    REAL    NOT NULL,
  python_peak   INTEGER NOT NULL,
  submitted_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_submissions_problem
  ON submissions (problem_id, submitted_at DESC);

-- The editor buffer, one row per problem. Overwritten, not appended: this is
-- "what I was in the middle of", not history.
CREATE TABLE IF NOT EXISTS drafts (
  problem_id TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Derived from submissions, kept separately so the common "have I solved this?"
-- query does not scan history.
CREATE TABLE IF NOT EXISTS progress (
  problem_id     TEXT PRIMARY KEY,
  first_solved_at TEXT,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  last_seen_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Tutor conversations. Kept because a tutor that forgets the last question is a
-- worse teacher than one that remembers it — the thread is the context.
--
-- TEXT ids from randomUUID rather than an AUTOINCREMENT rowid: the renderer's
-- api/chat.ts types every id as a string, and a String(rowid) conversion at the
-- seam is the kind of thing that gets forgotten on one of four routes.
-- (No backticks anywhere in here: this whole block is a template literal.)
--
-- MILLISECOND precision, unlike every other table here, and it is load-bearing.
-- datetime('now') resolves to whole seconds, so two sessions created in the same
-- second tie on updated_at and the list falls back to creation order — meaning
-- writing to an older session never lifts it to the top. Submissions get away with
-- second precision because they tiebreak on a monotonic rowid; a UUID primary key
-- cannot.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  problem_id TEXT,
  title      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  -- Ordering is by THIS, not by updated_at, and the distinction is not pedantic:
  -- a timestamp of any precision can tie. Milliseconds tie too — two sessions
  -- created and touched inside the same millisecond ordered arbitrarily, which
  -- showed up as a test that passed alone and failed in the suite. A counter
  -- makes "most recently used" a total order instead of a very likely one.
  -- Safe as MAX+1 because this is a single-writer local file.
  updated_seq INTEGER NOT NULL DEFAULT 0,
  -- Which assistant this conversation belongs to.
  --
  -- Both surfaces share these tables, which is right -- a saved conversation is a saved
  -- conversation, and a second pair meaning the same thing would have to be kept in step
  -- forever. What was missing is the one thing that differs: WHOSE it is. Without it the
  -- tutor's history listed the Build assistant's conversations, and neither list was what
  -- anyone asked for.
  --
  -- Defaults to 'tutor' because that is what every session predating the Build assistant is.
  surface TEXT NOT NULL DEFAULT 'tutor' CHECK (surface IN ('tutor', 'assistant'))
);

-- ON DELETE CASCADE is real here: PRAGMA foreign_keys = ON is set per connection
-- below. Without it, deleting a session would leave orphaned rows that the
-- message count still counts.
CREATE TABLE IF NOT EXISTS chat_messages (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role                 TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content              TEXT NOT NULL,
  -- Everything below is optional metadata the panel round-trips. Nullable
  -- because a local model reports none of it, and inventing zeros would make
  -- "no thinking budget" indistinguishable from "used none of it".
  detected_mode        TEXT,
  thinking_content     TEXT,
  thinking_token_count INTEGER,
  thinking_budget_used INTEGER,
  prompt_tokens        INTEGER,
  completion_tokens    INTEGER,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

-- The only query shape: a session's messages, oldest first.
CREATE INDEX IF NOT EXISTS ix_chat_messages_session
  ON chat_messages (session_id, created_at);

-- One row per interview question the user has touched. Absent means untouched,
-- which is why every field is nullable and there is no "created empty" path:
-- "attempted" is the existence of this row, so writing one speculatively would
-- inflate progress with questions nobody opened.
--
-- No user_id column, unlike the server's table. There is one user — the person
-- at the machine — and a column that is the same value on every row is a join
-- key for a join that never happens.
--
-- Keyed on the question slug rather than an id: slugs are the stable identity in
-- the content module and the only thing the renderer ever sends.
CREATE TABLE IF NOT EXISTS interview_attempts (
  slug            TEXT PRIMARY KEY,
  -- 1 could not answer, 2 shaky, 3 solid. NULL until self-rated, and the
  -- distinction matters: unrated is not the same as rated badly.
  self_rating     INTEGER CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 3),
  notes           TEXT,
  -- Sticky once true. "Did you look at the answer before rating yourself solid"
  -- is the signal this whole surface exists to preserve, so it must not be
  -- clearable by a later write that happens to omit it.
  revealed_answer INTEGER NOT NULL DEFAULT 0 CHECK (revealed_answer IN (0, 1)),
  -- Time of the FIRST submit, never overwritten — it is what the timer measures
  -- against.
  submitted_at    TEXT,
  elapsed_seconds INTEGER,
  -- The last verdict interviews:assess produced, and what produced it.
  --
  -- DELIBERATELY NO CHECK CONSTRAINT, unlike self_rating four fields up. That
  -- one's domain is 1/2/3 and will never grow; this one is a TypeScript union
  -- that plausibly will, and migration 12 is the record of what widening a
  -- CHECK costs here -- a whole table rebuild, because SQLite cannot alter one.
  -- The vocabulary is enforced in store/interviews.ts against the union itself,
  -- so there is one list rather than two that can disagree.
  --
  -- The feedback prose is NOT stored. It is redacted best-effort against
  -- leaking the model answer (redactReference in interview-assess.ts), and
  -- persisting it would turn a best-effort redaction into a permanent one.
  assessed_verdict TEXT,
  -- Which model said so. A verdict is only as good as what produced it, and
  -- firstUsableModel means that changes with whatever is installed.
  -- NULL for too_short, which is decided locally and never reaches a model.
  assessed_model   TEXT,
  assessed_at      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What happened while you were not looking.
--
-- No user_id, unlike the server's table: there is one user, the person at the
-- machine. No Redis either — the web published through pub/sub so an event
-- raised on one node reached a client connected to another, and a desktop app
-- has one process and one window to tell.
--
-- MILLISECOND precision, for the same reason chat_sessions has it: two
-- notifications from one submission land in the same second, and whole-second
-- timestamps would order them arbitrarily in a list whose only sort is "newest
-- first". Milliseconds tie too, so the list breaks ties on rowid — see the
-- ORDER BY in store/notifications.ts. This table keeps its implicit rowid
-- deliberately: do not make it WITHOUT ROWID.
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (
                 type IN ('submission_accepted', 'submission_failed',
                          'welcome', 'streak', 'system')),
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  is_read      INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  -- The thing it is about, e.g. a problem id. Nullable: 'welcome' is about nothing.
  reference_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

-- The two query shapes: the list, and the unread badge.
CREATE INDEX IF NOT EXISTS ix_notifications_unread
  ON notifications (is_read, created_at DESC);

-- The local user's own details.
--
-- ONE ROW, and the CHECK is what makes that true rather than a convention
-- everyone remembers. A desktop install has exactly one user; a table that
-- allowed a second would eventually get one, and then "the profile" becomes a
-- question about ordering.
--
-- No email and no role column. There is no account server to have registered an
-- address with, and a role is something a server grants — inventing either would
-- be putting a fact in the database that nothing established.
--
-- No age column either: it is derived from birth_date on read. Storing it would
-- make it wrong on the user's next birthday, which is the kind of bug that takes
-- a year to notice.
CREATE TABLE IF NOT EXISTS profile (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  name              TEXT,
  bio               TEXT,
  -- ISO 'YYYY-MM-DD'. Validated before it gets here; SQLite has no date type
  -- and would happily store 'tomorrow'.
  birth_date        TEXT,
  country           TEXT,
  occupation        TEXT,
  profile_photo_url TEXT,
  timezone          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ciphertext from Electron's safeStorage, one row per named secret.
--
-- WHAT IS AND IS NOT PROTECTED BY THIS FILE. The bytes here are useless on their own: the key
-- that decrypts them lives in the OS credential store (DPAPI, Keychain, libsecret/kwallet), not
-- in SQLite. Copying voidcode.db to another machine yields a row that cannot be decrypted, which
-- is the intended outcome and is handled rather than thrown -- see inference/vault.ts, which
-- treats an undecryptable row as absent and deletes it.
--
-- So this table is not "somewhere safe to put a password". It is a durable handle to a secret the
-- operating system is holding. The distinction is why there is deliberately no channel that reads
-- a value back out of it, only one that reports whether a row exists.
--
-- BLOB, not TEXT: safeStorage.encryptString returns raw bytes. Base64-ing them to fit a TEXT
-- column would be a lossy-looking round trip for no gain, and node:sqlite binds a Uint8Array
-- directly.
--
-- Not every secret reaches this table. A Linux desktop whose environment Electron does not
-- recognise selects the 'basic_text' backend, which encrypts with a hardcoded key -- persisting
-- that ciphertext would put a recoverable credential on disk, so vault.ts keeps it in memory for
-- the session instead and the UI says so.
CREATE TABLE IF NOT EXISTS secrets (
  -- The logical name the contract's key enum carries ('openrouter'), not a provider object.
  -- (No backticks: SCHEMA is a template literal and one here closes it. Fifth time -- the count
  --  is in the agent_runs comment below, and this comment is why it went up.)
  name       TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Folders opened in Build mode, for File > Open Recent.
--
-- The absolute path is the primary key, because the same folder opened twice is
-- one entry rather than two. Reopening updates opened_at, which is what moves it
-- back to the top of the menu.
--
-- Paths only. The file tree is deliberately NOT cached here: it would be wrong
-- the moment anything changed on disk, and a stale tree is worse than a slower
-- open.
CREATE TABLE IF NOT EXISTS recent_projects (
  path      TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Ordering is by THIS, not by opened_at, for the same reason chat_sessions has
  -- updated_seq. datetime('now') is whole seconds, so opening three folders in
  -- one second ties; and unlike a plain insert there is no rowid to fall back on,
  -- because an upsert keeps the original rowid — so a reopened project could
  -- never climb back to the top. A counter makes "most recently opened" a total
  -- order. Safe as MAX+1 because this is a single-writer local file.
  opened_seq INTEGER NOT NULL DEFAULT 0
);

-- One row per window that should come back on next launch.
--
-- restorable is the whole design. It is 1 for a window's life and set to 0 only when the
-- user explicitly closes THAT window. Launch reopens every row that is still 1, so: a crash
-- brings everything back, closing one window keeps it gone, and quitting with three windows
-- open returns all three. No "was the last exit clean?" heuristic is needed, which matters
-- because that heuristic is exactly what gets it wrong after a crash.
--
-- Bounds are recorded by main from the window's own move/resize events, never sent from the
-- renderer — a renderer cannot lie about where its window is.
CREATE TABLE IF NOT EXISTS windows (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (mode IN ('study', 'build')),
  -- NULL means no folder was open. Restoring re-grants it only if it is still in
  -- recent_projects, so a project the user has since forgotten does not come back.
  project_root TEXT,
  route        TEXT NOT NULL DEFAULT '/',
  bounds       TEXT NOT NULL,
  maximised    INTEGER NOT NULL DEFAULT 0 CHECK (maximised IN (0, 1)),
  full_screen  INTEGER NOT NULL DEFAULT 0 CHECK (full_screen IN (0, 1)),
  restorable   INTEGER NOT NULL DEFAULT 1 CHECK (restorable IN (0, 1)),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Same reason chat_sessions and recent_projects have one: datetime('now') is whole
  -- seconds, and restore order has to be a total order.
  updated_seq  INTEGER NOT NULL DEFAULT 0
);

-- What a window had open, as one versioned JSON document.
--
-- A blob rather than columns because this is the part that will churn — tab groups today,
-- whatever the layout grows into next — and a versioned document means that churn never
-- needs DDL. The version lives inside the JSON so a reader can decline to interpret a shape
-- it does not know rather than guessing.
--
-- PATHS ONLY, NEVER BUFFER CONTENTS. Storing dirty text would make this file a second,
-- silently diverging copy of the user's source, and restoring it would resurrect edits they
-- believe they discarded. The close handshake is what protects unsaved work; this restores
-- an arrangement.
-- Whether the user has agreed to VoidCode writing an index into a project folder.
--
-- HERE, NOT IN THE PROJECT. Storing the answer inside .voidcode/ would let a repository grant
-- its own permission: clone something with a "consented" file in it and the index builds with
-- no prompt. Nothing inside a project may decide what the app is allowed to do to it.
--
-- A decline is recorded rather than left absent, so "no" stays no instead of becoming a fresh
-- prompt on the next launch.
CREATE TABLE IF NOT EXISTS memory_consent (
  project_root TEXT PRIMARY KEY,
  granted      INTEGER NOT NULL CHECK (granted IN (0, 1)),
  decided_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS window_workspace (
  window_id  TEXT PRIMARY KEY REFERENCES windows (id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent transcripts.
--
-- Their own tables rather than rows in chat_messages, exactly as the note on the migration to
-- 8 promised: that table's role CHECK admits only 'user' and 'assistant', a tool turn violates
-- it, and SQLite cannot alter a constraint. They are also a genuinely different thing — a
-- conversation is something a person reads back, a run is something a person audits.
--
-- The point of storing them is accountability. An agent read files, possibly fetched web
-- pages, and proposed changes to a repository; "what did it actually do" must be answerable
-- after the window is closed, which is the one time it is most likely to be asked.
CREATE TABLE IF NOT EXISTS agent_runs (
  id            TEXT PRIMARY KEY,
  project_root  TEXT NOT NULL,
  question      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  -- Null while in flight. A run whose window died mid-way keeps its steps and stays null,
  -- which is the honest record of what happened rather than a fabricated "stop".
  finish_reason TEXT,
  -- The conversation this run belongs to, once the assistant persists its turns. Null for
  -- every run recorded before sessions existed, and for any run started outside one.
  --
  -- ON DELETE SET NULL, not CASCADE and not bare. The choice matters and is not stylistic:
  --   * A bare REFERENCES makes deleting a conversation *fail* whenever it has a run --
  --     turning the delete button this phase exists to fix from silent into broken.
  --   * CASCADE would erase the record of what the agent did to the user's files because
  --     they tidied up a chat. The audit log outlives the conversation that prompted it.
  --
  -- (No backticks in this block: SCHEMA is a template literal, and a backtick in a SQL
  --  comment closes it. That is the fourth time in this repository.)
  session_id    TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  -- 'command' and 'applied' arrived with Auto mode. Widening this CHECK needed a table
  -- rebuild -- SQLite cannot alter a constraint -- which is migration 12.
  kind       TEXT NOT NULL CHECK (kind IN ('thought', 'tool', 'proposal', 'error', 'command', 'applied')),
  tool_name  TEXT,
  -- The diff id, not the diff. Diffs expire in memory after an hour and are not a durable
  -- object; keeping the id records that a change was proposed without implying it can still
  -- be applied.
  diff_id    TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The plan a run wrote, as one versioned JSON document.
--
-- ITS OWN TABLE, NOT A SEVENTH agent_steps.kind. That column is a CHECK constraint, and SQLite
-- cannot alter one -- widening it for 'command' and 'applied' is what migration 12 exists for,
-- and a whole table rebuild is a steep price for a shape that is going to change again. A new
-- table needs none of it, because CREATE TABLE IF NOT EXISTS runs on every open.
--
-- Nor could it have gone in a step's text: recordStep truncates at 4,000 characters, which for
-- an audit line is the right call and for a document the panel re-reads is silent corruption.
--
-- One plan per run, so run_id IS the key. A second write_plan call is a revision rather than a
-- second plan -- the model reconsidered -- and ON CONFLICT replaces it. Keeping both would
-- leave the pane to guess which one is current.
CREATE TABLE IF NOT EXISTS agent_plans (
  run_id     TEXT PRIMARY KEY REFERENCES agent_runs (id) ON DELETE CASCADE,
  -- {version, doc}, read by parseStoredPlan, which declines a version it does not know.
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The design spec a run wrote, as one versioned JSON document.
--
-- Its own table beside agent_plans, and for the identical reasons recorded there: agent_steps.kind
-- is a CHECK constraint SQLite cannot alter without a table rebuild, and recordStep truncates at
-- 4,000 characters. One spec per run, so run_id IS the key and a revision replaces rather than
-- accumulates.
CREATE TABLE IF NOT EXISTS agent_designs (
  run_id     TEXT PRIMARY KEY REFERENCES agent_runs (id) ON DELETE CASCADE,
  -- {version, doc}, read by parseStoredDesignSpec, which declines a version it does not know.
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The only query shape: one run's steps in order, and recent runs for a project.
CREATE INDEX IF NOT EXISTS ix_agent_steps_run ON agent_steps (run_id, seq);
CREATE INDEX IF NOT EXISTS ix_agent_runs_project ON agent_runs (project_root, created_at DESC);
`;

export function openDatabase(filename?: string): DatabaseSync {
  if (db !== undefined) return db;

  const file = filename ?? defaultPath();
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const opened = new DatabaseSync(file);

  // WAL so a long-running read cannot block a write. `foreign_keys` is off by
  // default in SQLite and has to be asked for per connection.
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA foreign_keys = ON");
  opened.exec(SCHEMA);

  const row = opened.prepare("PRAGMA user_version").get() as { user_version?: number };
  const current = row?.user_version ?? 0;
  if (current < SCHEMA_VERSION) {
    // In one transaction: a half-applied migration is a database nobody can reason about,
    // and the version stamp must not move unless every step before it succeeded.
    opened.exec("BEGIN");
    try {
      for (const migration of MIGRATIONS) {
        if (migration.to > current && migration.to <= SCHEMA_VERSION) migration.up(opened);
      }
      opened.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      opened.exec("COMMIT");
    } catch (err) {
      opened.exec("ROLLBACK");
      throw err;
    }
  }

  db = opened;
  return db;
}

function defaultPath(): string {
  /**
   * THE SMOKE GETS ITS OWN DATABASE, IN MEMORY, AND NEVER TOUCHES THE USER'S.
   *
   * It writes real data through the real paths, which is the point of it — submissions,
   * drafts, chat sessions, interview attempts, notifications and, once profile editing
   * landed, the user's own name. Against `voidcode.db` that meant every run overwrote
   * whoever was using this machine with `smoke-1785516640309`, and left behind submissions
   * and notifications that made the app look used by someone else.
   *
   * It also made assertions decay. "Refused before a submission existed" passed once and
   * then failed forever, because the submission it needed absent was one an earlier run had
   * written; the workaround was to pick a question the smoke never submits. A fresh
   * database makes that class of trap impossible rather than avoidable.
   *
   * `:memory:` rather than a temp file: everything the smoke does happens inside one
   * process, so there is nothing to persist, and nothing to clean up afterwards or leave
   * behind when it crashes.
   */
  if (process.env.VOIDCODE_SMOKE === "1") return ":memory:";

  // `userData` is the per-user, per-app directory Electron already manages, so the
  // file survives updates and lands somewhere a user can find.
  return path.join(app.getPath("userData"), "voidcode.db");
}

/**
 * Test seam.
 *
 * Exposes the runner so a migration can be exercised against a database built the way an
 * *older* install's actually looks. Running it against `SCHEMA` proves nothing — that block
 * always creates the current shape, so the step would find its column already there and pass
 * without doing anything.
 */
export function __runMigrationsForTest(database: DatabaseSync, from: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.to > from && migration.to <= SCHEMA_VERSION) migration.up(database);
  }
}

export function closeDatabase(): void {
  db?.close();
  db = undefined;
}

/** Test seam: a fresh in-memory database per test. */
export function __useInMemory(): DatabaseSync {
  closeDatabase();
  return openDatabase(":memory:");
}
