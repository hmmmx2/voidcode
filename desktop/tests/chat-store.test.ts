/**
 * Chat session persistence.
 *
 * The tutor streams but forgot everything on reload. These cover the properties the panel
 * depends on and that a naive implementation gets subtly wrong: message order, a count that
 * cannot drift from its rows, cascade on delete, and timestamps that survive the trip out of
 * SQLite — which has already caused two bugs elsewhere in this codebase.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { __useInMemory } = await import("../src/main/store/db.js");
const {
  createSession,
  getSession,
  listSessions,
  messagesFor,
  appendMessage,
  deleteSession,
  searchSessions,
  UnknownSessionError,
} = await import("../src/main/store/chat.js");

beforeEach(() => {
  __useInMemory();
});

describe("sessions", () => {
  it("returns the row it just wrote", () => {
    const session = createSession("sigmoid", "Getting started");

    expect(session.id).toBeTruthy();
    expect(session.problemId).toBe("sigmoid");
    expect(session.title).toBe("Getting started");
    // Read back from SQLite rather than invented in JS, so this is the value every
    // subsequent read will also return.
    expect(session.createdAt).toBeTruthy();
    expect(getSession(session.id)).toEqual(session);
  });

  it("allows a session with no problem and no title", () => {
    // The panel opens a conversation before the user has picked anything.
    const session = createSession(null, null);
    expect(session.problemId).toBeNull();
    expect(session.title).toBeNull();
  });

  it("reports nothing for an id it never issued", () => {
    expect(getSession("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

describe("messages", () => {
  it("comes back in the order it was written", () => {
    const session = createSession("sigmoid", null);
    appendMessage(session.id, { role: "user", content: "first" });
    appendMessage(session.id, { role: "assistant", content: "second" });
    appendMessage(session.id, { role: "user", content: "third" });

    // Ordered by `created_at, rowid` — three messages inside one second share a timestamp,
    // and without the rowid tiebreak a conversation would come back shuffled.
    expect(messagesFor(session.id).map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("keeps optional metadata nullable rather than zeroed", () => {
    const session = createSession(null, null);
    const message = appendMessage(session.id, { role: "user", content: "hi" });

    // A local model reports none of this. Zeros would make "no thinking budget" look
    // identical to "used none of it".
    expect(message.thinkingContent).toBeNull();
    expect(message.promptTokens).toBeNull();
    expect(message.detectedMode).toBeNull();
  });

  it("round-trips the metadata it is given", () => {
    const session = createSession(null, null);
    const message = appendMessage(session.id, {
      role: "assistant",
      content: "reply",
      detectedMode: "TEACHING",
      thinkingContent: "considering",
      thinkingTokenCount: 12,
      promptTokens: 300,
      completionTokens: 40,
    });

    expect(message.detectedMode).toBe("TEACHING");
    expect(message.thinkingTokenCount).toBe(12);
    expect(messagesFor(session.id)[0]?.completionTokens).toBe(40);
  });

  it("refuses a message for a session that does not exist", () => {
    expect(() => appendMessage("nope", { role: "user", content: "x" })).toThrow(
      UnknownSessionError
    );
  });

  it("does not mix one session's messages into another", () => {
    const a = createSession("sigmoid", null);
    const b = createSession("stable-softmax", null);
    appendMessage(a.id, { role: "user", content: "for a" });

    expect(messagesFor(b.id)).toEqual([]);
  });
});

describe("the session list", () => {
  it("counts messages from the rows themselves", () => {
    const session = createSession("sigmoid", null);
    appendMessage(session.id, { role: "user", content: "one" });
    appendMessage(session.id, { role: "assistant", content: "two" });

    const { sessions, total } = listSessions();
    expect(total).toBe(1);
    // A join, not a stored counter — so it cannot drift from the rows it describes.
    expect(sessions[0]?.messageCount).toBe(2);
  });

  it("includes a session with no messages", () => {
    createSession("sigmoid", null);

    const { sessions } = listSessions();
    // A LEFT JOIN, not an inner one: a conversation you opened and did not use still exists.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.messageCount).toBe(0);
  });

  it("puts the most recently used session first", () => {
    const older = createSession("sigmoid", "older");
    const newer = createSession("stable-softmax", "newer");

    // Writing to the older session should lift it above the newer one — position is "when
    // did I last speak to it", not "when was it created".
    appendMessage(older.id, { role: "user", content: "still working here" });

    const { sessions } = listSessions();
    expect(sessions[0]?.id).toBe(older.id);
    expect(sessions[1]?.id).toBe(newer.id);
  });

  it("pages without losing the total", () => {
    for (let i = 0; i < 5; i++) createSession(null, `session ${i}`);

    const page = listSessions(2, 0);
    expect(page.sessions).toHaveLength(2);
    // The total is the whole table, not the page — the panel uses it for "showing 2 of 5".
    expect(page.total).toBe(5);
    expect(listSessions(2, 4).sessions).toHaveLength(1);
  });
});

describe("deleting a session", () => {
  it("takes its messages with it", () => {
    const session = createSession("sigmoid", null);
    appendMessage(session.id, { role: "user", content: "one" });

    deleteSession(session.id);

    // ON DELETE CASCADE, which only works because `PRAGMA foreign_keys` is on — it is off by
    // default in SQLite and has to be asked for per connection. Orphaned rows would still be
    // counted by the list's join.
    expect(getSession(session.id)).toBeUndefined();
    expect(messagesFor(session.id)).toEqual([]);
    expect(listSessions().total).toBe(0);
  });
});

describe("searching", () => {
  it("matches a title", () => {
    const a = createSession(null, "Numerically stable softmax");
    createSession(null, "Cross-entropy loss");

    const found = searchSessions("softmax");

    expect(found.sessions.map((s) => s.id)).toEqual([a.id]);
    expect(found.sessions[0]?.matchedIn).toBe("title");
    // The title is already on screen in the list, so there is nothing to quote.
    expect(found.sessions[0]?.snippet).toBeNull();
  });

  it("matches a message body, and says which one", () => {
    // The reason search exists: nobody remembers a title, they remember what they asked.
    const session = createSession(null, "Untitled");
    appendMessage(session.id, { role: "user", content: "why does my gradient explode here" });

    const found = searchSessions("gradient");

    expect(found.sessions.map((s) => s.id)).toEqual([session.id]);
    expect(found.sessions[0]?.matchedIn).toBe("message");
    expect(found.sessions[0]?.snippet).toContain("gradient explode");
  });

  it("returns a session once however many messages match", () => {
    // A join without an EXISTS returns one row per matching message, so a long conversation
    // fills the whole result list with itself.
    const session = createSession(null, null);
    for (const text of ["tensor one", "tensor two", "tensor three"]) {
      appendMessage(session.id, { role: "user", content: text });
    }

    expect(searchSessions("tensor").sessions).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    const session = createSession(null, "Softmax");
    expect(searchSessions("SOFTMAX").sessions.map((s) => s.id)).toEqual([session.id]);
    expect(searchSessions("softmax").sessions.map((s) => s.id)).toEqual([session.id]);
  });

  describe("LIKE wildcards in the query", () => {
    /**
     * The bug a naive implementation ships, and it is not hypothetical here.
     *
     * `_` and `%` are wildcards in a LIKE *pattern*, so interpolating the user's text straight
     * in makes a search box that returns everything the moment someone types an underscore.
     * In a coding assistant the searches are identifiers, and `read_file` is the normal case
     * rather than the edge one.
     */
    it("treats _ as a literal underscore, not as any character", () => {
      const real = createSession(null, "read_file notes");
      createSession(null, "readXfile notes");
      createSession(null, "nothing relevant");

      // Underscore alone must not match every row.
      expect(searchSessions("_").sessions.map((s) => s.id)).toEqual([real.id]);
      // And the identifier must match itself and only itself.
      expect(searchSessions("read_file").sessions.map((s) => s.id)).toEqual([real.id]);
    });

    it("treats % as a literal percent", () => {
      const real = createSession(null, "100% coverage");
      createSession(null, "something else");

      expect(searchSessions("%").sessions.map((s) => s.id)).toEqual([real.id]);
    });

    it("treats a backslash as a literal backslash", () => {
      // The escape character itself. Without escaping *it*, a query containing one produces a
      // dangling escape and SQLite matches nothing at all -- and Windows paths are full of them.
      const real = createSession(null, String.raw`C:\Users notes`);
      createSession(null, "no slashes here");

      expect(searchSessions(String.raw`C:\Users`).sessions.map((s) => s.id)).toEqual([real.id]);
    });
  });

  it("lists everything for a blank query", () => {
    // So the panel can call one function as its box empties instead of switching between two.
    createSession(null, "one");
    createSession(null, "two");

    expect(searchSessions("").sessions).toHaveLength(2);
    expect(searchSessions("   ").sessions).toHaveLength(2);
  });

  it("finds nothing rather than everything when nothing matches", () => {
    createSession(null, "softmax");
    expect(searchSessions("zzzz").sessions).toEqual([]);
  });

  it("puts the most recently used conversation first", () => {
    const older = createSession(null, "softmax one");
    const newer = createSession(null, "softmax two");
    appendMessage(older.id, { role: "user", content: "bump" });

    expect(searchSessions("softmax").sessions.map((s) => s.id)).toEqual([older.id, newer.id]);
  });

  it("honours the limit", () => {
    for (let i = 0; i < 5; i += 1) createSession(null, `softmax ${i}`);
    expect(searchSessions("softmax", 2).sessions).toHaveLength(2);
  });
});

describe("deleting a session that ran the agent", () => {
  it("does not throw, and leaves the run behind", async () => {
    /**
     * `agent_runs.session_id` is `ON DELETE SET NULL`, and this is the test that fails if
     * anyone changes it to a bare reference -- which is the natural thing to write.
     *
     * A bare `REFERENCES` turns this delete into `FOREIGN KEY constraint failed` for exactly
     * the conversations where the agent was used. `CASCADE` would instead erase the record of
     * what the agent changed on disk because a chat was tidied away.
     */
    const { beginRun, recentRuns } = await import("../src/main/store/agent.js");
    const session = createSession(null, "refactor the parser");
    appendMessage(session.id, { role: "user", content: "rename it everywhere" });

    const runId = beginRun({
      projectRoot: "/w",
      question: "rename it everywhere",
      provider: "ollama",
      model: "llama3.1:8b",
      sessionId: session.id,
    });

    expect(() => deleteSession(session.id)).not.toThrow();

    const runs = recentRuns("/w", 10);
    expect(runs.map((r) => r.id)).toContain(runId);
  });
});

describe("keeping the two assistants apart", () => {
  /**
   * The tutor and the Build assistant share these tables, and that is deliberate — a saved
   * conversation is a saved conversation, and a second pair meaning the same thing would have
   * to be kept in step forever.
   *
   * What was missing is the one thing that genuinely differs: whose it is. Without it the
   * tutor's history listed the Build assistant's conversations and the other way round, and
   * nothing in the row could tell them apart — `problem_id` is null on tutor sessions too,
   * because the local problems are identified by slug and that column only ever held a UUID.
   */
  it("defaults to the tutor, which is what every older session is", () => {
    expect(createSession(null, "an old one").surface).toBe("tutor");
  });

  it("records the surface it was told", () => {
    expect(createSession(null, "a build one", "assistant").surface).toBe("assistant");
  });

  it("lists only the surface asked for", () => {
    createSession(null, "tutor one", "tutor");
    createSession(null, "build one", "assistant");

    expect(listSessions(20, 0, "tutor").sessions.map((s) => s.title)).toEqual(["tutor one"]);
    expect(listSessions(20, 0, "assistant").sessions.map((s) => s.title)).toEqual(["build one"]);
  });

  it("counts only the surface asked for", () => {
    // A total counting both would tell the tutor it had conversations it cannot show, which is
    // the sort of number someone tries to page to and cannot reach.
    createSession(null, "tutor one", "tutor");
    createSession(null, "build one", "assistant");
    createSession(null, "build two", "assistant");

    expect(listSessions(20, 0, "tutor").total).toBe(1);
    expect(listSessions(20, 0, "assistant").total).toBe(2);
    // Unfiltered still means both, for a caller that genuinely wants everything.
    expect(listSessions(20, 0).total).toBe(3);
  });

  it("searches only the surface asked for", () => {
    createSession(null, "softmax in the tutor", "tutor");
    createSession(null, "softmax in build", "assistant");

    expect(searchSessions("softmax", 30, "tutor").sessions.map((s) => s.title)).toEqual([
      "softmax in the tutor",
    ]);
    expect(searchSessions("softmax", 30, "assistant").sessions.map((s) => s.title)).toEqual([
      "softmax in build",
    ]);
    expect(searchSessions("softmax", 30).sessions).toHaveLength(2);
  });

  it("filters a blank query too, not just a matching one", () => {
    /**
     * The blank query takes a different code path — it delegates to `listSessions` rather than
     * running the LIKE — so it is the one that quietly stays unfiltered if the argument is not
     * threaded through. It is also the case the panel hits first, on open.
     */
    createSession(null, "tutor one", "tutor");
    createSession(null, "build one", "assistant");

    expect(searchSessions("", 30, "tutor").sessions.map((s) => s.title)).toEqual(["tutor one"]);
    expect(searchSessions("", 30, "assistant").sessions.map((s) => s.title)).toEqual(["build one"]);
  });

  it("matches a message body only within the surface", () => {
    const tutor = createSession(null, "untitled tutor", "tutor");
    const build = createSession(null, "untitled build", "assistant");
    appendMessage(tutor.id, { role: "user", content: "explain gradient clipping" });
    appendMessage(build.id, { role: "user", content: "add gradient clipping to trainer.py" });

    expect(searchSessions("gradient", 30, "tutor").sessions.map((s) => s.id)).toEqual([tutor.id]);
    expect(searchSessions("gradient", 30, "assistant").sessions.map((s) => s.id)).toEqual([build.id]);
  });
});

describe("timestamps", () => {
  it("stores a value that reads as UTC, not local time", () => {
    // The trap that has already produced two bugs here: SQLite writes
    // `2026-07-30 19:03:37` with no zone marker, and JavaScript parses that shape as LOCAL
    // time. Anything consuming these has to normalise, so this pins the stored format rather
    // than letting it drift into something ambiguous in a different way.
    const session = createSession(null, null);

    // Milliseconds, so two sessions created in the same second still order correctly.
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    const asUtc = new Date(`${session.createdAt.replace(" ", "T")}Z`);
    expect(Number.isNaN(asUtc.getTime())).toBe(false);
    // Written seconds ago, so reading it as UTC must land close to now. Reading it as local
    // would be out by the machine's offset — eight hours on the author's box.
    expect(Math.abs(Date.now() - asUtc.getTime())).toBeLessThan(60_000);
  });
});
