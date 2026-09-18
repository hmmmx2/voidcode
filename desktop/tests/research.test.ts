/**
 * The research library from main's side: a public catalogue with a private overlay.
 *
 * THE AUTH RULE HERE IS THE UNUSUAL ONE IN THIS APPLICATION, and it is what most of this file is
 * about. Every other call either needs a session or does not; these two want one *optionally* — the
 * papers are public and the reading ticks are the reader's. Three properties follow, and none of
 * them is obvious from the code alone:
 *
 *   1. A session is sent when there is one, so the ticks come back.
 *   2. A 401 does NOT end the reading. The session is cleared (that is what a 401 means everywhere
 *      in this app) and the request is retried anonymously, so an expired session leaves somebody
 *      reading a public library rather than staring at an error about a paper that was never
 *      private. Exactly one retry.
 *   3. Marking a section read is refused with no request at all when signed out — the one direction
 *      that writes per-person state.
 *
 * The other half is `openPdf`, which is the only path in this feature that ends at
 * `shell.openExternal`. The renderer names a slug; main resolves the address from the paper our own
 * API returned and checks it. A URL accepted from the renderer would make this the one channel that
 * can ask the operating system to launch anything it has a handler for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { __useInMemory } = await import("../src/main/store/db.js");
const { __safeStorage, __shell } = await import("./stubs/electron.js");
const { setSecret, secretValue, __resetSessionSecrets } = await import("../src/main/inference/vault.js");
const { __setOverridesAllowed } = await import("../src/main/platform/config.js");
const session = await import("../src/main/account/session.js");
const papers = await import("../src/main/research/papers.js");
const { CHANNELS } = await import("../src/main/ipc/contract.js");
const { SECTION_ORDER } = await import("../src/shared/research.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = (relative: string): string =>
  fs.readFileSync(path.join(root, "..", "apps/api", relative), "utf8");

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];

type Reply = { status: number; body?: unknown } | Error;

function stubFetch(respond: (url: string, attempt: number) => Reply): void {
  let attempt = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      attempt += 1;
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        authorization: headers.authorization,
        body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      });
      const reply = respond(String(input), attempt);
      if (reply instanceof Error) throw reply;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      });
    }),
  );
}

const SUMMARY = {
  slug: "attention-is-all-you-need",
  title: "Attention Is All You Need",
  authors: "Vaswani et al.",
  year: 2017,
  venue: "NeurIPS",
  arxivId: "1706.03762",
  abstract: "The dominant sequence transduction models…",
  difficulty: "hard",
  categories: ["transformers"],
  orderIndex: 0,
  relatedProblemSlugs: ["scaled-dot-product-attention"],
  sectionsRead: [] as string[],
  sectionCount: 4,
  completedAt: null,
};

const LIBRARY = {
  papers: [SUMMARY],
  sections: SECTION_ORDER.map((key) => ({ key, label: key })),
  progress: { papers: 1, finished: 0, sectionsRead: 0, sectionsTotal: 4 },
};

const DETAIL = {
  ...SUMMARY,
  pdfUrl: "https://arxiv.org/pdf/1706.03762",
  keyEquations: [{ label: "Scaled dot-product attention", latex: "\\mathrm{softmax}(QK^T/\\sqrt{d_k})V" }],
  sections: SECTION_ORDER.map((key) => ({ key, label: key, body: `# ${key}` })),
};

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
  __shell.reset();
  papers.__resetPdfCache();
  calls = [];
  __setOverridesAllowed(true);
  process.env.VOIDCODE_API_URL = "http://127.0.0.1:59996/v1";
  session.__resetSessionMemory();
  session.setAccountBroadcaster(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setOverridesAllowed(undefined);
  delete process.env.VOIDCODE_API_URL;
  session.setAccountBroadcaster(() => {});
});

// ── Reading the library ──────────────────────────────────────────────────────

describe("the library is public", () => {
  it("is fetched without a session, and asks for it anonymously", async () => {
    stubFetch(() => ({ status: 200, body: LIBRARY }));

    const result = await papers.list();

    expect(result.ok && result.library.papers[0]?.slug).toBe(SUMMARY.slug);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:59996/v1/papers");
    // No Authorization header at all, rather than an empty one.
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it("carries the session when there is one, so the reader's own ticks come back", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({
      status: 200,
      body: { ...LIBRARY, papers: [{ ...SUMMARY, sectionsRead: ["architecture"] }] },
    }));

    const result = await papers.list();

    expect(result.ok && result.library.papers[0]?.sectionsRead).toEqual(["architecture"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer tok-1");
  });

  it("keeps reading after the session expires, signed out", async () => {
    /**
     * THE PROPERTY THIS MODULE EXISTS FOR. A 401 means the stored session is dead, and `http.ts`
     * clears it — but the library was never private, so answering the reader with an error about
     * authentication would be refusing them a public catalogue because of a credential they did
     * not need.
     */
    setSecret("voidcode", "tok-1");
    stubFetch((_url, attempt) =>
      attempt === 1 ? { status: 401, body: { detail: "Not signed in." } } : { status: 200, body: LIBRARY },
    );

    const result = await papers.list();

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.authorization)).toEqual(["Bearer tok-1", undefined]);
    // The dead session is gone, which is what made the second attempt the right one.
    expect(secretValue("voidcode")).toBeUndefined();
  });

  it("retries once and only once, and only for a 401", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 401, body: { detail: "Not signed in." } }));

    const result = await papers.list();

    // Two attempts, then the answer — a loop here would turn a bad minute on our server into two.
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);

    calls = [];
    setSecret("voidcode", "tok-2");
    stubFetch(() => ({ status: 500, body: { detail: "boom" } }));
    const failed = await papers.list();
    // A 500 is the answer, not a reason to ask again unauthenticated.
    expect(calls).toHaveLength(1);
    expect(failed).toEqual({ ok: false, code: "http_500", message: "Could not read the library." });
  });

  it("says the library needs a connection when there is none", async () => {
    stubFetch(() => new TypeError("fetch failed"));

    expect(await papers.list()).toEqual({
      ok: false,
      code: "offline",
      message: "The research library needs a connection. Check yours and try again.",
    });
  });

  it("refuses a body that is not a library rather than rendering nothing", async () => {
    stubFetch(() => ({ status: 200, body: { papers: "soon" } }));
    expect(await papers.list()).toMatchObject({ ok: false, code: "bad_response" });
  });
});

describe("one paper", () => {
  it("comes back with its sections and is asked for by slug", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));

    const result = await papers.get(SUMMARY.slug);

    expect(result.ok && result.paper.sections.map((s) => s.key)).toEqual([...SECTION_ORDER]);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:59996/v1/papers/${SUMMARY.slug}`);
  });

  it("reports an unknown slug as no such paper, not as a failure", async () => {
    stubFetch(() => ({ status: 404, body: { detail: "Paper not found" } }));

    expect(await papers.get("not-a-paper")).toEqual({
      ok: false,
      code: "not_found",
      message: "There is no paper with that name.",
    });
  });

  it("does not retry a 404 as though the session were the problem", async () => {
    // The retry is for a 401 alone. A 404 with a session is a 404 without one.
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 404, body: { detail: "Paper not found" } }));

    await papers.get("not-a-paper");
    expect(calls).toHaveLength(1);
  });
});

// ── Marking a section read ───────────────────────────────────────────────────

describe("recording what has been read", () => {
  it("makes no request at all with nobody signed in", async () => {
    stubFetch(() => ({ status: 200, body: { sectionsRead: ["architecture"], completedAt: null } }));

    const result = await papers.markRead(SUMMARY.slug, "architecture");

    expect(result).toEqual({
      ok: false,
      code: "signed_out",
      message: "Sign in to keep track of what you have read.",
    });
    // The server would refuse it too, and a 401 from that refusal would be a 401 nothing caused.
    expect(calls).toEqual([]);
  });

  it("posts the section and returns what the server now holds", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({
      status: 200,
      body: { slug: SUMMARY.slug, sectionsRead: ["architecture", "systems"], completedAt: null },
    }));

    const result = await papers.markRead(SUMMARY.slug, "systems");

    expect(result).toEqual({
      ok: true,
      sectionsRead: ["architecture", "systems"],
      completedAt: null,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`http://127.0.0.1:59996/v1/papers/${SUMMARY.slug}/read`);
    expect(calls[0]?.authorization).toBe("Bearer tok-1");
    expect(calls[0]?.body).toEqual({ section: "systems" });
  });

  it("carries the completion stamp through when the fourth section lands", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({
      status: 200,
      body: { sectionsRead: [...SECTION_ORDER], completedAt: "2026-09-19T10:00:00+00:00" },
    }));

    expect(await papers.markRead(SUMMARY.slug, "mathematics")).toMatchObject({
      ok: true,
      completedAt: "2026-09-19T10:00:00+00:00",
    });
  });

  it("reports an ended session as signed out rather than as an error", async () => {
    setSecret("voidcode", "tok-1");
    stubFetch(() => ({ status: 401, body: { detail: "Sign in to do this." } }));

    expect(await papers.markRead(SUMMARY.slug, "architecture")).toMatchObject({
      ok: false,
      code: "signed_out",
    });
    // And this one DOES end the session: it was sent with a credential the server rejected.
    expect(secretValue("voidcode")).toBeUndefined();
  });
});

// ── Opening the PDF ──────────────────────────────────────────────────────────

describe("opening a paper's PDF", () => {
  it("opens the address our API gave for that slug", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));

    expect(await papers.openPdf(SUMMARY.slug)).toEqual({ ok: true });
    expect(__shell.opened).toEqual([DETAIL.pdfUrl]);
  });

  it("uses the address from the paper already fetched, without asking twice", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));
    await papers.get(SUMMARY.slug);
    calls = [];

    expect(await papers.openPdf(SUMMARY.slug)).toEqual({ ok: true });
    // Pressing "Open PDF" on a paper you are reading should not need a round trip first.
    expect(calls).toEqual([]);
    expect(__shell.opened).toEqual([DETAIL.pdfUrl]);
  });

  it("refuses anything that is not a plain https address, and says which kind of wrong", async () => {
    /**
     * `shell.openExternal` launches whatever the operating system has a handler for, so this is the
     * check that makes "open the PDF" mean "show a document". Every one of these came from our own
     * API in this test, which is the point: the guard is against our own content being wrong, not
     * against a hostile renderer — the renderer cannot pass an address at all.
     *
     * THE CODE IS ASSERTED, NOT JUST THE REFUSAL, and that is what a mutation found. Replacing the
     * empty-address check with `if (false)` left every case still refused — an empty string is not
     * a URL either — so a test that only checked `ok: false` passed with the branch gone. The two
     * codes mean different things to whoever reads the message: `no_pdf` is a paper we published
     * without a file, and `unsafe_pdf` is a paper whose address is wrong.
     *
     * `http://127.0.0.1` is in the list for the same reason: `allowLoopbackHttp: true` would accept
     * it while every other case here stayed refused, so its absence hid that mutation too.
     */
    for (const [url, code] of [
      ["file:///C:/Windows/System32/calc.exe", "unsafe_pdf"],
      ["http://arxiv.org/pdf/1706.03762", "unsafe_pdf"],
      ["http://127.0.0.1:8080/pdf", "unsafe_pdf"],
      ["https://user:pass@arxiv.org/pdf/1706.03762", "unsafe_pdf"],
      ["javascript:alert(1)", "unsafe_pdf"],
      ["", "no_pdf"],
    ] as const) {
      papers.__resetPdfCache();
      __shell.reset();
      calls = [];
      stubFetch(() => ({ status: 200, body: { ...DETAIL, pdfUrl: url } }));

      const result = await papers.openPdf(SUMMARY.slug);
      expect(result, `opened or misreported ${JSON.stringify(url)}`).toMatchObject({
        ok: false,
        code,
      });
      expect(__shell.opened, `opened ${JSON.stringify(url)}`).toEqual([]);
    }
  });

  it("passes a failure to fetch the paper straight through", async () => {
    stubFetch(() => new TypeError("fetch failed"));

    expect(await papers.openPdf(SUMMARY.slug)).toMatchObject({ ok: false, code: "offline" });
    expect(__shell.opened).toEqual([]);
  });
});

// ── The boundary ─────────────────────────────────────────────────────────────

describe("the channels the renderer calls", () => {
  it("take a slug and a section, and nothing that could name an address", () => {
    const get = CHANNELS["research:get"].input;
    expect(get.safeParse({ slug: "attention-is-all-you-need" }).success).toBe(true);
    // The API's own slug shape: lower-case, digits and hyphens.
    expect(get.safeParse({ slug: "Attention" }).success).toBe(false);
    expect(get.safeParse({ slug: "../../etc/passwd" }).success).toBe(false);
    expect(get.safeParse({ slug: "" }).success).toBe(false);
    expect(get.safeParse({ slug: "a".repeat(129) }).success).toBe(false);

    /**
     * THE ASSERTION THIS FILE EXISTS FOR, on the IPC side. `research:openPdf` is one of two paths
     * from a renderer to `shell.openExternal` in this application (the other is a provider
     * sign-in). A `url` field here would make the set of things it can open unbounded. zod strips
     * unknown keys rather than refusing them, so the check is on the PARSED value.
     */
    const parsed = CHANNELS["research:openPdf"].input.parse({
      slug: "attention-is-all-you-need",
      url: "file:///C:/Windows/System32/calc.exe",
    });
    expect(Object.keys(parsed)).toEqual(["slug"]);
  });

  it("accepts only the four sections the server knows", () => {
    const schema = CHANNELS["research:markRead"].input;
    for (const section of SECTION_ORDER) {
      expect(schema.safeParse({ slug: "a-paper", section }).success, section).toBe(true);
    }
    expect(schema.safeParse({ slug: "a-paper", section: "conclusion" }).success).toBe(false);
  });

  it("is readable in both window modes", () => {
    // A paper explains what a problem asks you to implement, so the IDE is a reasonable place to
    // go and read why the maths works.
    for (const channel of ["research:list", "research:get", "research:markRead", "research:openPdf"] as const) {
      expect(CHANNELS[channel].modes, channel).toEqual(["study", "build"]);
    }
  });
});

describe("the four sections", () => {
  it("are the same four, in the same order, as the API's", () => {
    /**
     * Two languages, one list. A fifth key here would post a section the server refuses with a
     * 422; a missing key would leave every paper permanently unfinishable, because completion is
     * "all four read" — and a DIFFERENT ORDER would silently change which breakdown opens first
     * and therefore which one gets marked read by simply arriving on the page.
     */
    const router = apiSource("src/routers/papers.py");
    const declared = /SECTION_ORDER = \[([^\]]+)\]/.exec(router);
    expect(declared, "SECTION_ORDER is not where this test looks for it").not.toBeNull();
    const keys = [...((declared as RegExpExecArray)[1] ?? "").matchAll(/"([a-z]+)"/g)].map(
      (m) => m[1] as string,
    );

    expect(keys.length, "no section keys were parsed, so this assertion is vacuous").toBe(4);
    expect([...SECTION_ORDER]).toEqual(keys);
  });

  it("are the same four the server validates a POST against", () => {
    // The endpoint has its own pattern, and it is the thing that actually refuses a bad value.
    const pattern = /pattern="\^\(([a-z|]+)\)\$"/.exec(apiSource("src/routers/papers.py"));
    expect(pattern, "the /read endpoint no longer constrains its section").not.toBeNull();
    expect(((pattern as RegExpExecArray)[1] ?? "").split("|").sort()).toEqual(
      [...SECTION_ORDER].sort(),
    );
  });
});
