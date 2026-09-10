/**
 * The transport seam.
 *
 * On the web every call here went to FastAPI over HTTP. On the desktop some routes are
 * served by the Electron main process — Pyodide grading, the local SQLite store, the
 * hardware scan — and the rest still need the bundled API. Rather than editing a dozen
 * call sites, the decision is made once, here.
 *
 * Two properties this is shaped around:
 *
 *   1. **Callers do not change.** Every module keeps calling `fetch(`${API_BASE}/v1/…`)`
 *      with `makeHeaders(userId)`. `API_BASE` becomes an `app://api` marker intercepted
 *      below, so the two SSE readers — the tutor panel and the notification bell — keep
 *      using `response.body.getReader()` on a real `Response` and need no rewrite.
 *
 *   2. **What is local is one table.** `IPC_ROUTES` is the single answer to "which
 *      endpoints work offline?". Adding one is a line here plus a handler in main.
 *
 * **There is no HTTP fallback.** Bundling `apps/api` was considered and rejected: it pulls
 * torch, transformers, bitsandbytes, Postgres and Redis, which is roughly a 3 GB installer
 * plus two database servers to run an offline IDE — the opposite of spec §4.4. Its torch
 * stack is also redundant, because main already has a full inference layer (Ollama,
 * llama.cpp, OpenRouter).
 *
 * So every route ends up here eventually. A route not yet in `IPC_ROUTES` fails loudly
 * rather than silently degrading, and `PENDING_ROUTERS` below is the running score. (It was
 * called `MIGRATED` when this header was written.)
 */

/**
 * Routers still to move from FastAPI into main.
 *
 * EMPTY, AND KEPT. Every router the client calls is now served locally — problems, submit,
 * drafts, dashboard, submissions, chat, interviews, notifications and profile — so nothing
 * falls through to a "not migrated yet" message any more.
 *
 * The mechanism stays because it is the honest answer for the next router, not because it
 * has one today: an unmatched path now gets "No local handler for METHOD /path", which names
 * the route rather than blaming the network. Deleting this would mean rebuilding it the
 * first time a route is added ahead of its handler.
 */
const PENDING_ROUTERS: readonly string[] = [];

/**
 * What a tutor turn may carry: prose, or prose plus images.
 *
 * Mirrors the `chat:open` contract exactly rather than approximating it. A renderer type that
 * drifted from the schema would fail at the boundary with "Invalid payload", which says nothing
 * about which field was wrong.
 */
export type TutorContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" }
    >;

export function isDesktop(): boolean {
  return typeof window !== "undefined" && window.host !== undefined;
}

/**
 * Kept as an exported constant because every module interpolates it.
 *
 * A marker, not a reachable origin: `installTransport` matches on the path that follows and
 * never lets a request out to it.
 *
 * **It used to be a ternary**, falling back to `NEXT_PUBLIC_API_URL || "http://localhost:8000"`
 * when `isDesktop()` was false — the address of the retired web repo's FastAPI server. Three
 * things were wrong with that, in increasing order of consequence:
 *
 *   1. There is no non-desktop target. This renderer is a static export loaded over `app://`
 *      inside Electron and nowhere else, so the branch described a deployment that no longer
 *      exists and an env var nothing sets.
 *
 *   2. It is evaluated at module load, and during `next build`'s prerender `window` is
 *      undefined — so `localhost:8000` was **baked into a shipped chunk**. Dead at runtime,
 *      because the preload has already set `window.host` by the time this evaluates in the
 *      browser, but present in the artifact and greppable in it.
 *
 *   3. If the preload ever *did* fail, every API call would quietly aim at a network address
 *      on the user's own machine instead of failing where the fault is. An unmatched
 *      `app://api` path fails locally and says so, which is the diagnosis you want.
 *
 * `isDesktop()` stays for its other callers, which guard behaviour rather than name a host.
 */
export const API_BASE = "app://api";

/**
 * ── `X-User-Id` IS GONE, AND THE `userId` PARAMETER IS NOT ────────────────────────────────────
 *
 * The header was the retired HTTP API's identity mechanism, and it was never verified — any client
 * could claim to be anyone by setting it. That was recorded as a hard blocker before any billing
 * path, and it is moot here for a reason worth stating: there is no server. `API_BASE` is
 * `app://api`, requests are answered by main in the same process, and main knows which window asked
 * because the IPC broker binds a mode to the sender. A header asserting identity to yourself is at
 * best noise and at worst a habit that survives into a build that does have a server.
 *
 * The `userId` parameter stays, and so do the hook and its nine call sites. That is a declared
 * accepted state rather than an oversight: `useUserId.ts` argues the threading should survive for
 * hosted sync, and a forty-site refactor of something no user can observe is the wrong risk to take
 * near a release. What is removed is the only part that crossed a boundary.
 */
export function makeHeaders(_userId?: string): HeadersInit {
  return { "Content-Type": "application/json" };
}

/**
 * The preload surface, asserted non-null.
 *
 * Every use sits inside `installTransport`, which returns early unless `isDesktop()`, so
 * by the time a route runs the object exists. Narrowing through the optional at each of
 * the seven call sites would only add noise.
 */
function host(): NonNullable<Window["host"]> {
  return window.host as NonNullable<Window["host"]>;
}

/**
 * The attempt Stop would cancel, if one is running.
 *
 * Module scope rather than React state because the id is minted inside this seam — the
 * component calls `submitCode`, which calls `fetch`, which lands here. Threading an id back
 * out through the API client and into a `useState` would touch every layer in between to
 * carry something none of them have any use for.
 *
 * One slot, mirroring main's one-run-at-a-time invariant. `WorkspaceClient` already refuses
 * to start a second run while `busy`, so a second attempt overwriting this would mean that
 * guard had failed first.
 */
let currentAttemptId: string | undefined;

/**
 * Stop the run in flight. Resolves to whether there was one.
 *
 * The id is cleared by the route's own `finally`, not here: this only asks main to stop, and
 * the run is not over until `exec.run` resolves — which it will, with a cancelled outcome.
 */
export async function cancelCurrentRun(): Promise<boolean> {
  const attemptId = currentAttemptId;
  if (attemptId === undefined || !isDesktop()) return false;
  const { cancelled } = await host().exec.cancel({ attemptId });
  return cancelled;
}

/**
 * Run through the sandbox, registered so Stop can name it.
 *
 * Both grading routes go through here rather than calling `host().exec.run` directly, so
 * neither can acquire a run that Stop cannot reach.
 */
async function runWithAttempt(input: { problemId: string; source: string }): Promise<unknown> {
  const attemptId = crypto.randomUUID();
  currentAttemptId = attemptId;
  try {
    return await host().exec.run({ ...input, tier: "pyodide", attemptId });
  } finally {
    // Only if it is still ours. A superseded attempt clearing the slot on its way out would
    // leave the run that replaced it unstoppable.
    if (currentAttemptId === attemptId) currentAttemptId = undefined;
  }
}

/** A route main serves, and the `host` call that serves it. */
type IpcRoute = (init: RequestInit | undefined, url: URL) => Promise<unknown>;

/**
 * The provider and model the tutor will actually use.
 *
 * Whatever is installed, rather than a hardcoded tag. Hardcoding a default is how inline
 * completion shipped pointing at a 1.5b nobody had, failing silently on every keystroke.
 *
 * Exported because the panel needs to answer "can the model that will read this see images?"
 * *before* the turn is sent, and answering it by re-deriving the same first-usable-provider rule
 * would be two copies of a policy that has to agree. One function, so they cannot drift.
 */
export async function usableProvider(): Promise<{ id: string; model: string } | null> {
  const { providers } = await host().providers.list();
  const usable = providers.find((p) => p.models.length > 0);
  if (usable === undefined) return null;
  return { id: usable.id, model: usable.models[0]! };
}

function body<T>(init: RequestInit | undefined): T {
  return init?.body === undefined ? ({} as T) : (JSON.parse(String(init.body)) as T);
}

/**
 * Routes main implements. Anything absent falls through to the sidecar.
 *
 * Matched longest-prefix-first, so `/v1/problems/{slug}` stays distinguishable from
 * `/v1/problems`.
 */
const IPC_ROUTES: Array<[string, IpcRoute]> = [
  /**
   * Grading. Local, and better than the web path: Pyodide with an enforced import allowlist
   * and real time and memory limits, rather than Judge0 over the network.
   *
   * Two things this got wrong, both the same class of mistake as the drafts routes:
   *
   *   The body is **snake_case**. `judge0.ts` sends `problem_id` and `source_code`; this read
   *   `b.problemId` and `b.sourceCode`, so the problem id was always undefined and every
   *   submission came back "Unknown problem".
   *
   *   The **response has to be the wire shape**, not main's `Grade`. `submitSolution` reads
   *   `data.test_case_results` and calls `.map` on it, so returning the grade verbatim threw
   *   a TypeError in the client before any of it reached the UI. Submit had never worked.
   */
  [
    "POST /v1/submit",
    async (init) => {
      const b = body<{ problem_id: string; source_code: string }>(init);
      const grade = await runWithAttempt({
        problemId: b.problem_id,
        source: b.source_code,
      });
      return toSubmissionPayload(grade as Grade);
    },
  ],
  [
    "POST /v1/execute",
    async (init) => {
      /**
       * `/v1/execute` needs a problem id here, unlike on the web.
       *
       * This used to read "the bare run-this path, so there is nothing to grade against" and
       * substitute `problemId: b.problem_id ?? ""`. That was true of FastAPI plus Judge0,
       * where the endpoint took source and stdin and ran them in a sandbox that knew nothing
       * about problems. On the desktop the same path is `exec:run`, which grades in main and
       * cannot run anything without knowing what against.
       *
       * The empty string was then rejected by the channel's `min(1)`, so every Run failed
       * with `Invalid payload for exec:run` — an internal channel name shown to a learner, for
       * a request this seam had made invalid on its way past.
       *
       * A missing id is now answered plainly instead of being forwarded as a lie.
       */
      const b = body<{ problem_id?: string; source_code: string }>(init);
      if (b.problem_id === undefined || b.problem_id === "") {
        return jsonResponse(
          { detail: "Running needs a problem to run against." },
          400
        );
      }

      const grade = (await runWithAttempt({
        problemId: b.problem_id,
        source: b.source_code,
      })) as Grade;

      return {
        stdout: grade.stdout,
        stderr: grade.error ?? grade.traceback ?? null,
        compile_output: null,
        status_id: grade.outcome === "ran" ? 3 : 11,
        status_description: describeOutcome(grade),
        time: (grade.measurements.wallMs / 1000).toFixed(3),
        memory: Math.round(grade.measurements.pythonPeakBytes / 1024),
        exit_code: grade.outcome === "ran" ? 0 : 1,
        /**
         * The part that was being computed and discarded.
         *
         * This response was shaped to imitate Judge0, which could only report a process's
         * stdout and stderr. `exec:run` does not run a process and hope — it invokes the
         * function on every case and compares the result — so `grade.verdicts` already holds
         * what the code returned and what it should have returned.
         *
         * Dropping them meant a correct solution that defines a function and prints nothing
         * displayed "No output produced", which reads as Run having done nothing at all.
         *
         * Visible cases only. The hidden ones are what Submit is for, and their expected
         * values are deliberately absent from a verdict — see `CaseVerdict.expected`.
         */
        cases: grade.verdicts
          .filter((verdict) => verdict.visible)
          .map((verdict) => ({
            label: verdict.label,
            passed: verdict.passed,
            expected: verdict.expected ?? null,
            actual: verdict.actual ?? null,
            error: verdict.error ?? null,
            elapsed_ms: verdict.elapsedMs,
          })),
      };
    },
  ],

  /**
   * The editor buffer, in local SQLite.
   *
   * `PUT`, because that is what `api/drafts.ts` sends and because it is the right verb for
   * an idempotent upsert of "the draft for this problem". This entry said `POST` from the
   * migration onward, so nothing matched, the request fell through to the 501 fallback, and
   * `useAutosave` turned that into "Save failed" — every keystroke, for every problem, with
   * no draft ever persisted. The failure was quiet because the UI has a perfectly good error
   * state for it and used it faithfully.
   */
  [
    "PUT /v1/drafts",
    async (init) => {
      // snake_case, because that is what `api/drafts.ts` sends and what FastAPI emitted.
      // This read `b.problemId` and `b.sourceCode`, so both were always `undefined` and the
      // zod schema behind `drafts:save` rejected every request — a 500 sitting directly
      // behind the 501 caused by the wrong verb.
      const b = body<{ problem_id: string; language: string; source_code: string }>(init);
      await host().drafts.save({ problemId: b.problem_id, source: b.source_code });

      // `DraftResponse` in `api/drafts.ts` is the contract. The transport swap is meant to
      // be invisible to the UI, so this emits that shape rather than a convenient one.
      return {
        id: b.problem_id,
        problem_id: b.problem_id,
        language: b.language,
        source_code: b.source_code,
        updated_at: new Date().toISOString(),
      };
    },
  ],
  [
    "GET /v1/drafts",
    async (_init, url) => {
      const problemId = url.searchParams.get("problem_id") ?? "";
      const language = url.searchParams.get("language") ?? "python";
      const { source } = await host().drafts.load({ problemId });

      // Always an object with a `draft` key. `loadDraft` does `data.draft ?? null`, so
      // returning a bare `null` here threw a TypeError on the client rather than reading as
      // "no draft" — the third way this one endpoint was broken.
      return {
        draft:
          source === null
            ? null
            : {
                id: problemId,
                problem_id: problemId,
                language,
                source_code: source,
                updated_at: new Date().toISOString(),
              },
      };
    },
  ],

  /**
   * The tutor's completion stream.
   *
   * `VoidCodeAIPanel` reads this with `response.body.getReader()` and parses OpenAI-style SSE.
   * That reader — with its 20fps render throttle and its buffer-splitting — is about 150 lines
   * of the panel, and rewriting it to consume a `MessagePort` would be the same feature at
   * much higher risk. So the port is bridged into a `ReadableStream` that emits exactly the
   * frames it already parses, and the panel is not touched at all. This is what the header of
   * this file means by "the two SSE readers keep using `response.body.getReader()` on a real
   * `Response` and need no rewrite".
   */
  [
    "POST /v1/chat/completions",
    async (init) => {
      const b = body<{
        /**
         * `content` is a string or OpenAI-style parts, because the tutor takes images now.
         *
         * The union is not a convenience: the contract has admitted image blocks on this
         * channel all along and the renderer was the only thing narrowing them away, casting
         * to `string` on the way through.
         */
        messages: Array<{ role: string; content: TutorContent }>;
        max_tokens?: number;
        temperature?: number;
        /**
         * What the learner is working on — a curriculum problem id or interview slug.
         *
         * Not part of the OpenAI shape, and this is our own shim rather than a proxy to one.
         * Main maps it through the concept graph to scope reference retrieval; without it the
         * grounding added in D3 still works but searches unscoped.
         */
        itemId?: string;
      }>(init);

      const usable = await usableProvider();
      if (usable === null) {
        throw new Error(
          "No local model is available. Start Ollama and pull a model, or add an OpenRouter key."
        );
      }

      const stream = await host().chat.open({
        // Fixed here, not taken from the caller. The panel is the tutor; a renderer that
        // could name its own surface could ask for the unrestricted assistant instead.
        surface: "tutor",
        provider: usable.id as "ollama" | "llamacpp" | "openrouter" | "hosted",
        model: usable.model,
        // The contract admits only user and assistant turns — the persona is main's. Any
        // system turn is dropped rather than passed through, because passing it would make
        // the whole request fail schema validation for a message nobody meant to send.
        messages: b.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-200) as Array<{ role: "user" | "assistant"; content: TutorContent }>,
        ...(b.itemId !== undefined ? { itemId: b.itemId } : {}),
        ...(b.max_tokens !== undefined ? { maxTokens: Math.min(b.max_tokens, 32_768) } : {}),
        ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
      });

      return sseFromPort(stream);
    },
  ],

  /**
   * Chat sessions.
   *
   * **Two entries, not four.** The matcher is longest-prefix, so `GET /v1/chat/sessions/{id}`
   * also matches `GET /v1/chat/sessions` — exactly the collision `/v1/problems/{slug}`
   * documents below. Splitting inside the handler is the only way both reach their own code;
   * as separate entries the detail request would silently receive the list.
   */
  [
    "GET /v1/chat/sessions",
    async (_init, url) => {
      const id = url.pathname.replace(/^\/v1\/chat\/sessions\/?/, "");

      if (id === "") {
        const surface = url.searchParams.get("surface");
        const { sessions, total } = await host().chat.listSessions({
          limit: Number(url.searchParams.get("limit") ?? 20),
          offset: Number(url.searchParams.get("offset") ?? 0),
          // Passed through only when asked for. An absent parameter means "both", which is
          // what a caller predating surfaces meant and what a debugging one still wants.
          ...(surface === "tutor" || surface === "assistant" ? { surface } : {}),
        });
        // `is_active` is read-only in api/chat.ts — nothing sets it — so it is derived as
        // "the one you used last" rather than stored in a column nothing writes.
        return {
          sessions: sessions.map((s, index) => toSessionSummary(s, index === 0)),
          total,
        };
      }

      const { session, messages } = await host().chat.getSession({ sessionId: id });
      return toSessionDetail(session, messages);
    },
  ],
  [
    "POST /v1/chat/sessions",
    async (init, url) => {
      // Same collision on the write side: creating a session and appending a message are
      // both POSTs under the same prefix.
      const messageMatch = /^\/v1\/chat\/sessions\/([^/]+)\/messages$/.exec(url.pathname);

      if (messageMatch?.[1] !== undefined) {
        const b = body<{
          role: "user" | "assistant";
          content: string;
          detected_mode?: string | null;
          thinking_content?: string | null;
          thinking_token_count?: number | null;
          thinking_budget_used?: number | null;
          prompt_tokens?: number | null;
          completion_tokens?: number | null;
        }>(init);

        const saved = await host().chat.saveMessage({
          sessionId: messageMatch[1],
          role: b.role,
          content: b.content,
          detectedMode: b.detected_mode ?? null,
          thinkingContent: b.thinking_content ?? null,
          thinkingTokenCount: b.thinking_token_count ?? null,
          thinkingBudgetUsed: b.thinking_budget_used ?? null,
          promptTokens: b.prompt_tokens ?? null,
          completionTokens: b.completion_tokens ?? null,
        });
        return toMessage(saved);
      }

      const b = body<{
        problem_id?: string | null;
        title?: string | null;
        surface?: "tutor" | "assistant";
      }>(init);
      const session = await host().chat.createSession({
        problemId: b.problem_id ?? null,
        title: b.title ?? null,
        ...(b.surface !== undefined ? { surface: b.surface } : {}),
      });
      // A freshly created session has no messages; `parseSessionDetail` maps `messages`
      // unconditionally, so omitting the key would throw rather than read as empty.
      return toSessionDetail(session, []);
    },
  ],
  [
    "DELETE /v1/chat/sessions",
    /**
     * The route that was missing.
     *
     * `api/chat.ts` has exported `deleteSession` since the history dropdown shipped, and the
     * dropdown has had a visible delete button calling it. There was no entry here, so the
     * request matched nothing, fell through to the 501 fallback, and the panel logged the
     * rejection to a console nobody has open — a button that looked live and did nothing.
     *
     * The id is split out here rather than declared as a second route, for the same reason
     * the GET above does it: `matchIpcRoute` is longest-prefix, so `DELETE /v1/chat/sessions`
     * and `DELETE /v1/chat/sessions/{id}` would be the same entry anyway. Splitting inside is
     * the only way the two cases can differ — and a bare prefix with no id must not be
     * allowed to delete anything.
     */
    async (_init, url) => {
      const id = url.pathname.replace(/^\/v1\/chat\/sessions\/?/, "");
      // 400, not 501: the route exists and works, this particular request is malformed.
      // Falling through with an empty id would send `sessionId: ""` to main, where zod
      // rejects it — correct, but reported as a channel failure rather than as the caller's
      // mistake, which is a worse message for whoever has to read it.
      if (id === "") return jsonResponse({ detail: "A session id is required" }, 400);

      await host().chat.deleteSession({ sessionId: id });
      // The caller checks `response.ok` and ignores the body.
      return {};
    },
  ],
  [
    "GET /v1/chat/search",
    async (_init, url) => {
      const surface = url.searchParams.get("surface");
      const { sessions, total } = await host().chat.searchSessions({
        query: url.searchParams.get("q") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 30),
        ...(surface === "tutor" || surface === "assistant" ? { surface } : {}),
      });
      return {
        sessions: sessions.map((s, index) => ({
          // `toSessionSummary` is typed `unknown`, as every wire mapper here is — nothing
          // downstream reads these except the parser. Spreading needs an object type, hence
          // the cast; it is asserting the shape this file wrote three lines up, not a guess.
          ...(toSessionSummary(s, index === 0) as Record<string, unknown>),
          matched_in: s.matchedIn,
          snippet: s.snippet,
        })),
        total,
      };
    },
  ],

  /**
   * Interviews: the catalogue, one question, and the two sub-paths that are not built.
   *
   * **Three entries, not seven**, and for the reason `/v1/chat/sessions` documents above:
   * the matcher is longest-prefix, so `GET /v1/interviews/{slug}` and
   * `GET /v1/interviews/{slug}/workspace` both match `GET /v1/interviews`. As separate
   * entries the longest one wins and the others silently receive the wrong handler.
   *
   * `/workspace` and `/assess` return 501 **explicitly**, which is the whole reason they
   * are named here. Dropping "interviews" from `PENDING_ROUTERS` removed the fallback that
   * used to answer them, so without these two branches the slug regex would swallow
   * `"cuda-tiling/workspace"` as a question slug and report "unknown interview question" —
   * a 500 blaming the user's URL for work we have not done.
   */
  [
    "GET /v1/interviews",
    async (_init, url) => {
      const rest = url.pathname.replace(/^\/v1\/interviews\/?/, "");
      if (rest === "") return host().interviews.list();

      const workspace = /^([^/]+)\/workspace$/.exec(rest);
      if (workspace?.[1] !== undefined) {
        return host().interviews.workspace({ slug: decodeURIComponent(workspace[1]) });
      }

      // A slug nobody authored is a 404, not a 500. The generic catch below turns every
      // thrown error into 500, which would report "we broke" for a URL that is simply wrong.
      //
      // Matched on "Question not found", which main throws as an `IpcError`. The first
      // version matched "unknown interview question" — the text of an ordinary `Error` —
      // and the broker replaces those with "${channel} failed" before they leave main, so
      // it never matched anything. Nothing failed; the route just always answered 500.
      try {
        return await host().interviews.get({ slug: decodeURIComponent(rest) });
      } catch (err) {
        if ((err as Error).message.includes("Question not found")) {
          return jsonResponse({ detail: "Question not found" }, 404);
        }
        throw err;
      }
    },
  ],
  [
    "POST /v1/interviews",
    async (init, url) => {
      const rest = url.pathname.replace(/^\/v1\/interviews\/?/, "");

      const reveal = /^([^/]+)\/reveal$/.exec(rest);
      if (reveal?.[1] !== undefined) {
        const b = body<{ stage: "approach" | "answer" }>(init);
        // The overloads on `host().interviews.reveal` are keyed on the literal stage, so
        // the branch is what gives each call its own return type. A single call with a
        // union argument resolves to the first overload and mistypes the answer.
        return b.stage === "answer"
          ? host().interviews.reveal({ slug: decodeURIComponent(reveal[1]), stage: "answer" })
          : host().interviews.reveal({ slug: decodeURIComponent(reveal[1]), stage: "approach" });
      }

      const submitted = /^([^/]+)\/submitted$/.exec(rest);
      if (submitted?.[1] !== undefined) {
        return host().interviews.markSubmitted({ slug: decodeURIComponent(submitted[1]) });
      }

      const assess = /^([^/]+)\/assess$/.exec(rest);
      if (assess?.[1] !== undefined) {
        const b = body<{ answer: string }>(init);
        try {
          // Only the answer crosses. The grading prompt and the reference are assembled in
          // main and stay there — see `content/interview-assess.ts`.
          return await host().interviews.assess({
            slug: decodeURIComponent(assess[1]),
            answer: b.answer,
          });
        } catch (err) {
          const message = (err as Error).message;
          // 503, not 500: no model installed or a daemon that is not running is a service
          // that is not there *yet*, which is worth retrying — and it is what the web
          // endpoint returned. A 500 would say we broke, and send someone looking for a bug
          // instead of starting Ollama.
          if (message.includes("The tutor is unavailable")) {
            return jsonResponse({ detail: message }, 503);
          }
          throw err;
        }
      }

      return notMigrated(`No local handler for POST ${url.pathname}`);
    },
  ],
  [
    "PUT /v1/interviews",
    async (init, url) => {
      const attempt = /^\/v1\/interviews\/([^/]+)\/attempt$/.exec(url.pathname);
      if (attempt?.[1] === null || attempt?.[1] === undefined) {
        return notMigrated(`No local handler for PUT ${url.pathname}`);
      }

      // snake_case on the wire, because `api/interviews.ts` sends what the Python API
      // expected and this seam must read the same request the sidecar would have.
      const b = body<{
        self_rating?: number | null;
        notes?: string | null;
        elapsed_seconds?: number;
      }>(init);

      // Absent stays absent. Spreading a key with an `undefined` value would pass the
      // contract's `.optional()` but arrive at the store as a *present* key, which is
      // exactly the "clear it" branch — a notes-only save would blank the rating.
      return host().interviews.saveAttempt({
        slug: decodeURIComponent(attempt[1]),
        ...("self_rating" in b ? { selfRating: b.self_rating ?? null } : {}),
        ...("notes" in b ? { notes: b.notes ?? null } : {}),
        ...(b.elapsed_seconds !== undefined ? { elapsedSeconds: b.elapsed_seconds } : {}),
      });
    },
  ],

  /**
   * Notifications: the list, the badge count, and the stream.
   *
   * One entry again, because `GET /v1/notifications/count` and `/stream` both match
   * `GET /v1/notifications`. The stream returns a `Response` directly, which the transport
   * passes through untouched — the same mechanism the tutor's SSE uses.
   */
  [
    "GET /v1/notifications",
    async (_init, url) => {
      const rest = url.pathname.replace(/^\/v1\/notifications\/?/, "");

      if (rest === "count") {
        // snake_case, like the list below. `fetchUnreadCount` reads `data.unread_count` and
        // falls back to 0, so returning main's camelCase shape here produced a badge that
        // was permanently zero and never errored — caught by the smoke, not by a type.
        const { unreadCount } = await host().notifications.count();
        return { unread_count: unreadCount };
      }
      if (rest === "stream") return notificationStream();

      const { notifications, unreadCount, total } = await host().notifications.list({
        unreadOnly: url.searchParams.get("unread_only") === "true",
        limit: Number(url.searchParams.get("limit") ?? 50),
      });

      // snake_case on the wire, because `parseNotification` in api/notifications.ts reads
      // `is_read` and `reference_id`. Emitting the store's camelCase here is exactly the
      // mistake that broke submission history.
      return {
        notifications: notifications.map(toNotificationWire),
        unread_count: unreadCount,
        total,
      };
    },
  ],
  [
    "PATCH /v1/notifications",
    async (init, url) => {
      if (!url.pathname.endsWith("/read")) {
        return notMigrated(`No local handler for PATCH ${url.pathname}`);
      }
      const b = body<{ notification_ids?: string[] }>(init);
      // An empty array means "all of them" — the bell's mark-all-read sends `[]`, and
      // forwarding it as an explicit empty list would mark nothing.
      return host().notifications.markRead(
        b.notification_ids !== undefined && b.notification_ids.length > 0
          ? { ids: b.notification_ids }
          : {}
      );
    },
  ],

  // Migrated: a join of the problem store and the progress table, both already local.
  ["GET /v1/dashboard", async () => host().dashboard.get()],
  /**
   * Both the list and a single problem.
   *
   * The matcher treats `/v1/problems/sigmoid` as a match for this entry too, so the split
   * has to happen here rather than as a second route — otherwise a detail request quietly
   * receives the catalogue and the workspace renders nothing with no error to explain it.
   */
  [
    "GET /v1/problems",
    async (_init, url) => {
      const slug = url.pathname.replace(/^\/v1\/problems\/?/, "");
      return slug === "" ? host().problems.list() : host().problems.get({ slug });
    },
  ],
  /**
   * Submission history.
   *
   * This returned main's `SubmissionRow[]` verbatim — camelCase, and named for the store
   * rather than for the wire. `api/submissions.ts` reads `status`, `total_tests`,
   * `passed_tests`, `overall_runtime_ms`, `created_at` and `source_code`, so every one of
   * them was undefined: the history listed "Runtime Error" for every attempt regardless of
   * outcome, with no counts, no runtime and no timestamp.
   */
  [
    "GET /v1/submissions",
    async (_init, url) => {
      const rows = (await host().submissions.list({
        problemId: url.searchParams.get("problem_id") ?? "",
      })) as { submissions: StoredSubmission[] };

      return {
        submissions: rows.submissions.map((r) => ({
          id: String(r.id),
          status: submissionStatus(r),
          language: "python",
          total_tests: r.totalCount,
          passed_tests: r.passedCount,
          overall_runtime_ms: r.slowestMs,
          overall_memory_kb: Math.round(r.pythonPeak / 1024),
          created_at: toIso(r.submittedAt),
          source_code: r.source,
        })),
      };
    },
  ],
  // GET and PUT are separate entries, not one branching route: the matcher keys on
  // `${method} ${path}`, so they never collide the way `/v1/interviews/{slug}` does.
  ["GET /v1/profile", async () => host().profile.get()],
  [
    "PUT /v1/profile",
    async (init) => {
      // snake_case on the wire, because `updateProfile` in api/profile.ts sends what the
      // Python API expected and this seam must read the request the sidecar would have.
      const b = body<{
        name?: string | null;
        bio?: string | null;
        birth_date?: string | null;
        country?: string | null;
        occupation?: string | null;
        profile_photo_url?: string | null;
        timezone?: string | null;
      }>(init);

      // `in`, not `!== undefined`. Absent must stay absent: spreading a key whose value is
      // `undefined` passes the contract's `.optional()` and then arrives at the store as a
      // *present* key, which is the "clear it" branch — a save carrying only a name would
      // wipe the bio. The interviews attempt route documents the same trap.
      try {
        return await host().profile.update({
          ...("name" in b ? { name: b.name ?? null } : {}),
          ...("bio" in b ? { bio: b.bio ?? null } : {}),
          ...("birth_date" in b ? { birthDate: b.birth_date ?? null } : {}),
          ...("country" in b ? { country: b.country ?? null } : {}),
          ...("occupation" in b ? { occupation: b.occupation ?? null } : {}),
          ...("profile_photo_url" in b
            ? { profilePhotoUrl: b.profile_photo_url ?? null }
            : {}),
          ...("timezone" in b ? { timezone: b.timezone ?? null } : {}),
        });
      } catch (err) {
        const message = (err as Error).message;
        // 400, not 500: a birth date of 2026-02-30 is the user's input being wrong, and a
        // 500 would send them looking for a bug in the app instead of at the field.
        if (message.includes("birth date must be")) {
          return jsonResponse({ detail: message }, 400);
        }
        throw err;
      }
    },
  ],
  ["GET /v1/hardware", async () => host().hw.scan()],
  ["GET /v1/providers", async () => host().providers.list()],
];

/**
 * Main's grading result, as it crosses the seam.
 *
 * Declared here rather than imported: the renderer cannot import from `src/main`, and this
 * is the one place that needs to know the shape.
 */
interface Grade {
  solved: boolean;
  outcome: string;
  stdout: string;
  error?: string;
  traceback?: string;
  limitBreached?: "time" | "memory";
  verdicts: Array<{
    id: string;
    label: string;
    visible: boolean;
    passed: boolean;
    expected?: string;
    actual?: string;
    error?: string;
    elapsedMs: number;
  }>;
  measurements: {
    wallMs: number;
    slowestCaseMs: number;
    pythonPeakBytes: number;
  };
  limits: { timeLimitMs: number; memoryLimitMb: number };
  referenceBroken?: string;
}

type StoredSession = StoredChatSession & { messageCount?: number };

/** The wire shape `parseSessionSummary` reads. Timestamps through `toIso`, as everywhere. */
function toSessionSummary(session: StoredSession, isActive: boolean): unknown {
  return {
    id: session.id,
    title: session.title,
    problem_id: session.problemId,
    is_active: isActive,
    message_count: session.messageCount ?? 0,
    created_at: toIso(session.createdAt),
    updated_at: toIso(session.updatedAt),
  };
}

function toSessionDetail(session: StoredSession, messages: StoredChatMessage[]): unknown {
  return {
    id: session.id,
    title: session.title,
    problem_id: session.problemId,
    is_active: true,
    created_at: toIso(session.createdAt),
    updated_at: toIso(session.updatedAt),
    messages: messages.map(toMessage),
  };
}

function toMessage(message: StoredChatMessage): unknown {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    detected_mode: message.detectedMode,
    thinking_content: message.thinkingContent,
    thinking_token_count: message.thinkingTokenCount,
    thinking_budget_used: message.thinkingBudgetUsed,
    prompt_tokens: message.promptTokens,
    completion_tokens: message.completionTokens,
    created_at: toIso(message.createdAt),
  };
}

interface StoredSubmission {
  id: number;
  solved: boolean;
  outcome: string;
  passedCount: number;
  totalCount: number;
  slowestMs: number;
  pythonPeak: number;
  source: string;
  submittedAt: string;
}

/**
 * A store row's verdict in the vocabulary `STATUS_MAP` in `api/submissions.ts` understands.
 *
 * Anything it does not recognise falls through to "Runtime Error" there, which is how every
 * row in the history came to be labelled that way.
 */
function submissionStatus(row: StoredSubmission): string {
  if (row.solved) return "accepted";
  if (row.outcome === "timeout") return "time_limit_exceeded";
  if (row.outcome === "crashed") return "runtime_error";
  return "wrong_answer";
}

/**
 * SQLite writes UTC as `2026-07-30 19:03:37` — space separated, no zone marker — and both
 * `new Date()` and `Intl` read that shape as *local* time. The same trap the activity strip
 * hit: timestamps silently shift by the UTC offset, so "2 minutes ago" reads as "8 hours ago".
 */
function toIso(stored: string): string {
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(stored)
    ? stored
    : `${stored.replace(" ", "T")}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function describeOutcome(grade: Grade): string {
  if (grade.limitBreached === "time") return "Time Limit Exceeded";
  if (grade.limitBreached === "memory") return "Memory Limit Exceeded";
  // Before the catch-all, or pressing Stop reports "Runtime Error" — the console blaming the
  // learner's code for a thing they chose to do.
  if (grade.outcome === "cancelled") return "Stopped";
  if (grade.outcome !== "ran") return "Runtime Error";
  return grade.solved ? "Accepted" : "Wrong Answer";
}

/**
 * `Grade` in the shape `submitSolution` parses.
 *
 * `status_id` and `exit_code` are vestigial Judge0 vocabulary that nothing reads any more —
 * kept only because the client's `ExecutionResult` still declares them. Every field that
 * carries meaning here is a real measurement: `time` is the case's own elapsed milliseconds,
 * `stderr` is the Python error the sandbox reported.
 *
 * `elapsed_ms`, `slowest_case_ms` and `time_limit_ms` are additions rather than translations.
 * The budget travels with the result so a timing can be drawn against it — 3ms means nothing
 * without the 200ms it was allowed.
 */
function toSubmissionPayload(grade: Grade): unknown {
  return {
    total_tests: grade.verdicts.length,
    passed_tests: grade.verdicts.filter((v) => v.passed).length,
    all_passed: grade.solved,
    overall_time: (grade.measurements.wallMs / 1000).toFixed(3),
    overall_memory: Math.round(grade.measurements.pythonPeakBytes / 1024),
    slowest_case_ms: grade.measurements.slowestCaseMs,
    time_limit_ms: grade.limits.timeLimitMs,
    test_case_results: grade.verdicts.map((v) => ({
      test_case_id: v.id,
      label: v.label,
      is_hidden: !v.visible,
      passed: v.passed,
      elapsed_ms: v.elapsedMs,
      // Redacted in main for hidden cases, so these are already `undefined` there rather
      // than being blanked here — the redaction is the control, this is presentation.
      expected_output: v.expected ?? null,
      actual_output: v.actual ?? null,
      execution_result: {
        stdout: null,
        stderr: v.error ?? null,
        compile_output: null,
        status_id: v.passed ? 3 : 4,
        status_description: v.passed ? "Accepted" : "Wrong Answer",
        time: (v.elapsedMs / 1000).toFixed(4),
        memory: null,
        exit_code: null,
      },
    })),
  };
}

function matchIpcRoute(method: string, path: string): IpcRoute | undefined {
  const key = `${method} ${path}`;
  let best: [string, IpcRoute] | undefined;
  for (const entry of IPC_ROUTES) {
    if (key === entry[0] || key.startsWith(`${entry[0]}?`) || key.startsWith(`${entry[0]}/`)) {
      if (best === undefined || entry[0].length > best[0].length) best = entry;
    }
  }
  return best?.[1];
}

/**
 * Install the interceptor over `window.fetch`, so existing call sites are untouched.
 *
 * Only requests to the `app://api` marker are diverted; everything else — including
 * Monaco loading its own assets from `app://bundle` — passes straight through.
 */
export function installTransport(): void {
  if (!isDesktop()) return;

  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith("app://api")) return original(input, init);

    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = matchIpcRoute(method, url.pathname);

    if (handler !== undefined) {
      try {
        const result = await handler(init, url);
        // A route that builds its own `Response` — the tutor's SSE stream — passes through
        // untouched. Wrapping it would `JSON.stringify` the object into `{}` and the panel
        // would read an empty body as a completed, silent reply.
        return result instanceof Response ? result : jsonResponse(result);
      } catch (err) {
        // Shaped like the API's own errors, so callers need no desktop-specific branch.
        return jsonResponse({ detail: (err as Error).message }, 500);
      }
    }

    // Not migrated yet. 501 rather than 503: the distinction matters to whoever reads it —
    // this is work not done, not a service that failed to start, and no amount of retrying
    // or starting something will fix it. The UI's existing error states render this
    // correctly, which is why the dashboard says the data is unavailable rather than
    // showing a fabricated empty one.
    const router = PENDING_ROUTERS.find((r) => url.pathname.startsWith(`/v1/${r}`));
    return jsonResponse(
      {
        detail: router
          ? `The ${router} API has not been migrated to local IPC yet`
          : `No local handler for ${method} ${url.pathname}`,
      },
      501
    );
  };
}

/**
 * Installed at module load, not from a component.
 *
 * This first hung off a `useState` initialiser in `Providers`, on the reasoning that it
 * would run before any child could fetch. It did not run at all — and the failure was
 * silent, because an un-intercepted `app://api` request simply fails to fetch and every
 * caller has an error path for that. The workspace showed no problem and no error worth
 * reading.
 *
 * Module scope is the right place: `client.ts` is imported by every api module, so the
 * interceptor exists before any of them can call anything, with no dependency on a
 * component tree that may or may not include the provider.
 */
if (isDesktop()) {
  installTransport();
}

/**
 * A live generation, as the SSE stream the tutor panel already parses.
 *
 * Three frame shapes, all of which the panel handles today: a delta carrying content, a
 * `usage` event, and the `[DONE]` sentinel. Nothing new is invented — the format is read off
 * the panel's own parser rather than designed here.
 */
/**
 * The blank line that terminates an SSE event.
 *
 * A named constant because the panel's parser splits on exactly this, and a literal pair of
 * escapes sitting in a template is the kind of thing that gets reflowed into real newlines by
 * a careless edit — which produces a stream that looks right and parses as nothing.
 */
const SSE_END = "\n\n";

/**
 * MUST MATCH `ChatChunk` IN `src/main/inference/types.ts`.
 *
 * Hand-maintained, because the two projects are separate TypeScript builds and this type
 * crosses a MessagePort — there is no import that would make the compiler compare them.
 * `tests/chat-chunk-parity.test.ts` reads both files and checks the variants have not drifted.
 *
 * Named and hoisted out of the cast it used to live in, so that test has something to find.
 * While it was inline the parity test pointed at `lib/build/chat-stream.ts` instead — a file
 * with no importers left, so the check was passing over a copy nobody used while the live one
 * here went unguarded.
 */
type ChatChunk =
  | { kind: "token"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call: { id: string; name: string; argumentsJson: string } }
  | {
      kind: "done";
      finishReason?: "stop" | "tool_calls" | "length";
      promptTokens?: number;
      completionTokens?: number;
    }
  | { kind: "error"; message: string; retryable: boolean }
  /**
   * Waiting for a GPU slot on the hosted backend. Only `hosted` ever sends one.
   *
   * Present here because `tests/chat-chunk-parity.test.ts` compares this union against main's and
   * fails when they drift -- which is the check that exists because a kind added on one side and
   * missing on the other makes streaming stop silently.
   */
  | { kind: "queued"; position: number; ahead: number; backendState: string };

function sseFromPort(chat: ChatStream): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // SSE delimits events with a blank line. Built from a constant rather than written
      // inline so the two newlines cannot be mistaken for formatting and reflowed away.
      const frame = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}${SSE_END}`));

      chat.onChunk((raw) => {
        const chunk = raw as ChatChunk;

        if (chunk.kind === "token") {
          frame({ choices: [{ delta: { content: chunk.text } }] });
          return;
        }

        /**
         * Reasoning travels on its own field, never on `content`.
         *
         * A reasoning model streams its chain of thought before its answer. Folding it into
         * `content` would put it straight into the tutor's reply, and that reply is the one place
         * this product works hard to withhold the solution — a model reasoning aloud about a
         * problem states the answer as a matter of course.
         *
         * Forwarded rather than dropped because it is the only evidence that a model which
         * produced no answer was nevertheless working. Dropping it is what made an exhausted
         * thinking budget indistinguishable from a silent model.
         *
         * The panel reads `delta.content`, so nothing renders this today. That is the intended
         * default: a surface that wants to show a thinking indicator opts in.
         */
        if (chunk.kind === "reasoning") {
          frame({ choices: [{ delta: { reasoning: chunk.text } }] });
          return;
        }

        /**
         * Ignored, not terminal — and the distinction is the whole reason this branch exists.
         *
         * The `done` handling below used to be the `else`, so **any** chunk that was not a
         * token or an error fell into it: a `tool_call` would have emitted a usage frame, sent
         * `[DONE]`, closed the port and ended the conversation. Not a dropped call — a
         * finished turn, mid-thought, with nothing anywhere saying why.
         *
         * Latent rather than live, because `chat:open` is only ever called with
         * `surface: "tutor"` and `toolsForSurface("tutor")` is empty, so no provider is given
         * tools to call. That is a property of today's callers, not of this function, and it
         * is not something to leave a landmine under.
         */
        /**
         * Re-emitted in the SAME shape the hosted API sends over the wire.
         *
         * This function exists to hand the panel OpenAI-shaped SSE regardless of which provider
         * produced it, and the queue frame is the one case where the original was already in that
         * shape: main decoded it into a `queued` chunk to cross the port, and here it goes back to
         * being what it was. The payoff is that the panel's parsing is identical whether the app
         * is talking to the API directly or through this port -- one branch, one contract, and no
         * desktop-only frame format to keep in step.
         *
         * The empty delta is deliberate and is carried through: a chunk with no content is what
         * makes this invisible to any consumer that has not opted in.
         */
        if (chunk.kind === "queued") {
          frame({
            type: "queue",
            queue: {
              position: chunk.position,
              ahead: chunk.ahead,
              backendState: chunk.backendState,
            },
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          });
          return;
        }

        if (chunk.kind === "tool_call") return;

        if (chunk.kind === "error") {
          // Erroring the stream makes `reader.read()` reject, which lands in the panel's
          // existing catch. Closing quietly instead would look like a completed empty reply.
          chat.close();
          controller.error(new Error(chunk.message));
          return;
        }

        frame({
          type: "usage",
          usage: {
            prompt_tokens: chunk.promptTokens ?? 0,
            completion_tokens: chunk.completionTokens ?? 0,
            total_tokens: (chunk.promptTokens ?? 0) + (chunk.completionTokens ?? 0),
          },
        });
        controller.enqueue(encoder.encode(`data: [DONE]${SSE_END}`));
        chat.close();
        controller.close();
      });
    },

    /**
     * The cancel path, and the reason this is not just a loop.
     *
     * The panel aborts by dropping the reader. Closing the port is what actually stops
     * generation — main ties the model's `AbortSignal` to the port's lifetime — so without
     * this an abandoned conversation would keep the GPU busy to the end of its budget.
     */
    cancel() {
      chat.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

/**
 * A 501 from inside a route that is otherwise migrated.
 *
 * Returned as a `Response` rather than thrown, because a throw becomes a 500 — and 500 and
 * 501 say opposite things to whoever reads them. 500 is "this broke"; 501 is "this was
 * never built", which no retry will fix. The `PENDING_ROUTERS` fallback says the same
 * thing for a whole router; this says it for one path inside a router that has moved.
 */
/** The wire shape `parseNotification` reads. Timestamps through `toIso`, as everywhere. */
function toNotificationWire(n: {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  referenceId: string | null;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    is_read: n.isRead,
    reference_id: n.referenceId,
    created_at: toIso(n.createdAt),
  };
}

/**
 * `GET /v1/notifications/stream`, as the bell already consumes it.
 *
 * The bell holds this open forever and reconnects after 3s if it drops, so the stream must
 * behave like the server's: open immediately, stay open, and emit `{type: "notification"}`
 * frames. It is fed by a main→renderer push rather than by Redis, which is the whole of
 * that mechanism on a machine with one process.
 *
 * NO HEARTBEAT, DELIBERATELY. The web sent one every 30s so proxies and load balancers
 * would not close an idle connection. There is no proxy between two halves of the same
 * application, and the bell ignores heartbeat frames anyway — sending them would be
 * cargo-culting the shape of the old deployment.
 *
 * The unsubscribe hangs off `cancel`, which is what the browser calls when the reader is
 * released — including on the bell's own cleanup. Without it every remount would leave a
 * listener behind and a single notification would arrive N times.
 */
function notificationStream(): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}${SSE_END}`));

      // Sent once, immediately, exactly as the server did — the client treats a stream that
      // opens without it as one that has not connected.
      frame({ type: "connected" });

      unsubscribe = host().onNotification((raw) => {
        frame({ type: "notification", data: toNotificationWire(raw as Parameters<typeof toNotificationWire>[0]) });
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function notMigrated(detail: string): Response {
  return jsonResponse({ detail }, 501);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}
