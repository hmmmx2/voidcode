/**
 * The Electron preload surface, as the renderer sees it.
 *
 * Optional at the top level: this same source builds for the web, where `window.host` is
 * genuinely absent. `isDesktop()` in `lib/api/client.ts` is the guard, and everything
 * below it may assume the object exists.
 */
interface VoidCodeHost {
  readonly windowMode: "study" | "build";
  /**
   * Opens a native menu under the clicked label. The window is frameless, so the renderer
   * draws the bar — but the menus stay native, because `role`-based items carry their
   * accelerators and OS edit behaviour with them.
   */
  menu: {
    popup(input: { menu: string; x: number; y: number }): Promise<unknown>;
    /**
     * Which commands are live right now, so the native menu can grey out the rest.
     *
     * Enabled rather than disabled: before the first publish the set is empty and everything
     * greys, so a renderer that has not mounted yet cannot present a live menu.
     */
    setState(input: { enabled: string[]; checked: string[] }): Promise<unknown>;
  };
  /**
   * Ship an error to the log file, which only main can write.
   *
   * Optional like every other member here, because the same renderer runs in a browser during
   * development where there is no host at all — so every caller has to cope with its absence
   * rather than assume the desktop.
   */
  log?: {
    write(input: {
      level: "error" | "warn";
      message: string;
      stack: string | null;
      context: Record<string, unknown> | null;
    }): Promise<unknown>;
  };
  /**
   * Menu and accelerator intents from main. Main delivers the intent; the shell decides
   * what it means, because the renderer owns the UI state it acts on.
   */
  /** Preview state as its dev server starts, becomes ready, or dies. Returns an unsubscribe. */
  onPreviewChanged?(cb: (state: import("@shared/preview").PreviewState) => void): () => void;
  onShellCommand?(cb: (payload: unknown) => void): () => void;
  /**
   * A notification the moment it is raised. This is what the web's SSE stream becomes here;
   * the seam turns these pushes back into the frames the bell already parses.
   */
  onNotification(cb: (payload: unknown) => void): () => void;
  /**
   * The VoidCode account changed — in this window or another, or because the server ended the
   * session. Carries the new state, so a listener never has to ask again.
   */
  onAccountChanged?(cb: (event: HostAccountChange) => void): () => void;
  /**
   * Something in the project changed on disk, from outside the editor.
   *
   * The preload has exposed this since Build Mode existed and it was never declared here, so
   * nothing could call it — which was academic, because nothing in main ever sent one either.
   * Build only: it names paths inside a folder the user granted.
   */
  onFileChanged?(cb: (batch: BuildFileChangeBatch) => void): () => void;
  mode: { get(): Promise<{ mode: "study" | "build" }> };
  /**
   * The machine, as measured.
   *
   * Typed from `@shared/hardware-types` rather than restated. The restatement was a strict
   * subset — no `unifiedMemory`, no `diskFreeMB`, no `backends`, none of `GpuInfo`'s optional
   * fields — so the renderer could not see most of what main had already measured, and no
   * test compared the two declarations. Inline `import(...)` because this file declares a
   * global: a top-level import would make it a module and `window.host` would vanish.
   */
  hw: {
    scan(): Promise<import("@shared/hardware-types").HardwareProfile>;
  };
    /**
   * The VoidCode platform: sign-in, balance, and buying credit.
   *
   * Every one of these returns an OUTCOME, never a credential. The session token lives in the OS
   * keychain and is read only in main — a renderer holding it would be a renderer whose devtools
   * console and crash dumps hold it too.
   */
  /**
   * The VoidCode account. Optional: nothing else in the application needs it.
   *
   * Every call returns an OUTCOME, never a credential. The session token lives in the OS keychain
   * and is read only in main. Signed out, `session()` answers without any network request.
   */
  account: {
    session(): Promise<HostAccountState>;
    refresh(): Promise<HostAccountState>;
    signInPassword(input: { email: string; password: string }): Promise<HostSignedIn | HostAccountFailure>;
    /** `acceptTerms` must be `true`; main adds which terms version this build displays. */
    register(input: {
      name: string;
      email: string;
      password: string;
      acceptTerms: true;
    }): Promise<HostSignedIn | HostAccountFailure>;
    /** The same answer whether or not the address has an account. */
    requestPasswordCode(input: { email: string }): Promise<{ ok: true; message: string } | HostAccountFailure>;
    resetPassword(input: {
      email: string;
      code: string;
      newPassword: string;
    }): Promise<HostSignedIn | HostAccountFailure>;
    changePassword(input: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ ok: true; message: string } | HostAccountFailure>;
    signOut(): Promise<{ ok: true }>;
    signOutEverywhere(): Promise<{ ok: true } | { ok: false; message: string }>;

    /**
     * Google and Microsoft, and whether this build can use them.
     *
     * Answered from build configuration with no network request, so it is safe to call on mount.
     * `timeoutSeconds` is how long main will wait on the browser, so a countdown shown here agrees
     * with the one being enforced there.
     */
    providers(): Promise<{ providers: HostProviderStatus[]; timeoutSeconds: number }>;
    /**
     * Open the system browser and wait for the person to finish signing in there.
     *
     * Two enums and no address: the renderer cannot influence where the browser is sent. Resolves
     * when the flow ends, which may be minutes later — or immediately with `not_configured` when
     * this build has no client id for that provider, in which case no browser is opened.
     */
    signInOAuth(input: {
      provider: HostProviderId;
      mode: "signIn" | "link";
    }): Promise<HostSignedIn | HostProviderLinked | HostAccountFailure>;
    /** Stop waiting. The pending `signInOAuth` resolves with `code: "cancelled"`. */
    cancelOAuth(): Promise<{ ok: true }>;
    /** Reopen the browser at the sign-in already in progress, for a tab closed by accident. */
    reopenOAuth(): Promise<{ ok: true } | HostAccountFailure>;
  };

  voidcode: {
    credits(): Promise<
      | {
          ok: true;
          balance: {
            availableCredits: number;
            reservedMicro: number;
            estimatedMinutes?: number;
            rateMicroPerSlotSecond?: number;
            /**
             * The wallet total, held credit included — and the right signal for "has a payment
             * landed". `availableCredits` is the wrong one: available is balance minus what
             * in-flight requests hold, so a question answered while a purchase settles can leave
             * it unchanged.
             */
            balanceMicro?: number;
          };
        }
      | { ok: false; message: string }
    >;
    packs(): Promise<{
      packs: Array<{ code: string; label: string; priceDisplay: string; credits: number }>;
    }>;
    /**
     * The most recent movements of credit, newest first, bounded at 200.
     *
     * A `hold` and a `release` carry an amount of zero: they move credit between available and
     * reserved without changing the balance. Whether to show them is the reader's question, not
     * the transport's — `CreditsClient` decides.
     */
    ledger(input: { limit?: number }): Promise<
      | { ok: true; entries: HostLedgerEntry[] }
      | { ok: false; message: string }
    >;
    /**
     * Start a purchase. Resolves once main has opened the browser.
     *
     * Returns no URL on purpose: main does the opening, after checking what our API handed back
     * is https. A renderer that could pass a URL to `shell.openExternal` could launch anything
     * the operating system has a handler registered for.
     */
    /**
     * Redeem a voucher code. The message on failure is the server's own wording, which
     * deliberately distinguishes "already redeemed" from "not valid" -- a second click is the
     * commonest way to reach a refusal.
     */
    redeem(input: { code: string }): Promise<
      { ok: true; credits: number } | { ok: false; message: string }
    >;
    checkout(input: { packCode: string }): Promise<
      { ok: true; opened: boolean } | { ok: false; message: string }
    >;
  };

  providers: {
    list(): Promise<{
      providers: Array<{
        id: string;
        label: string;
        /**
         * What this backend can do — and critically whether it is somewhere else.
         *
         * `remote` was returned by main all along and simply not declared here, so a caller
         * counting "installed models" summed OpenRouter's several-hundred-model catalogue
         * into the total and reported it as things on this machine.
         */
        capabilities: {
          remote: boolean;
          tools: boolean;
          grammar: boolean;
        };
        /** Servable now — not the download catalogue, and for a remote provider not local. */
        models: string[];
      }>;
    }>;
  };
  dashboard: { get(): Promise<unknown> };
  profile: {
    get(): Promise<unknown>;
    /**
     * Save the user's own details. Absent leaves a field alone; null clears it.
     *
     * No `email` and no `role`: there is no account server to have registered an address
     * with and none to grant a role, so neither is something the renderer may write.
     */
    update(input: {
      name?: string | null;
      bio?: string | null;
      birthDate?: string | null;
      country?: string | null;
      occupation?: string | null;
      profilePhotoUrl?: string | null;
      timezone?: string | null;
    }): Promise<unknown>;
  };
  submissions: { list(input: { problemId: string }): Promise<unknown> };
  problems: {
    list(): Promise<{ problems: unknown[] }>;
    get(input: { slug: string }): Promise<unknown>;
  };
  exec: {
    run(input: {
      problemId: string;
      source: string;
      tier: "pyodide" | "native";
      /** Optional so a run nobody can stop stays expressible. See exec/attempts.ts in main. */
      attemptId?: string;
    }): Promise<unknown>;
    /** `cancelled: false` means the attempt had already finished — a race, not a failure. */
    cancel(input: { attemptId: string }): Promise<{ cancelled: boolean }>;
  };
  /**
   * This window's arrangement, so the next launch can put it back.
   *
   * A JSON string main stores without interpreting. Which window it belongs to is decided in
   * main from the sender, never from the payload — a window may only describe itself.
   *
   * **Paths only, never buffer contents.** Storing dirty text would make the database a
   * second, silently diverging copy of the user's source, and restoring it would resurrect
   * edits they believe they discarded. Build only, like everything that names a file.
   */
  session?: {
    save(input: { state: string }): Promise<{ saved: boolean }>;
    load(): Promise<{ state: string | null }>;
  };
  /**
   * Project memory: an embedded index of the open project, on this machine.
   *
   * `index()` is always an explicit action and prompts for consent the first time, because it
   * writes into the user's own project folder. There is deliberately no automatic trigger.
   */
  memory?: {
    status(): Promise<{
      indexed: boolean;
      consent: "granted" | "declined" | "unasked";
      chunkCount: number;
      fileCount: number;
      /** A bound stopped indexing early — say so rather than implying completeness. */
      truncated: boolean;
      updatedAt: string | null;
      embeddingsAvailable: boolean;
      location: string;
    }>;
    /** `scope` narrows it to a subdirectory — the sane workflow on a large repository. */
    index(input: { scope?: string }): Promise<{
      indexed: number;
      chunks: number;
      truncated: boolean;
      skipped: number;
    }>;
    search(input: { query: string; limit?: number }): Promise<{
      hits: Array<{
        chunk: {
          path: string;
          startLine: number;
          endLine: number;
          text: string;
          symbol: string | null;
        };
        score: number;
        /** The file moved since it was embedded, so this text may be out of date. */
        stale: boolean;
      }>;
    }>;
  };
  /**
   * The agent.
   *
   * `open` streams one turn. Note what it does not have: no system prompt, no tool list. Both
   * are main's, chosen from the window's surface — a renderer that could name the agent's
   * tools would be choosing its own privileges.
   *
   * `proposedDiffIds` is what the run wants to change. **Nothing has been written.** They
   * cannot be applied through `fs.commitDiff` — that channel refuses agent-origin diffs — only
   * through `applyDiffs`, which shows a native dialog naming every file first.
   */
  agent?: {
    /**
     * One agentic turn, over a transferred port.
     *
     * Resolves to the stream, not to a result: prose, tool steps and proposals all arrive on it
     * in the order they happened, and closing it aborts the run. See
     * `lib/build/agent-stream.ts` for the event union.
     *
     * `content` mirrors `chat.open`'s — a string, or blocks including images.
     */
    open(input: {
      provider: "ollama" | "llamacpp" | "openrouter" | "hosted";
      model: string;
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | {
                type: "image";
                data: string;
                mediaType: "image/png" | "image/jpeg" | "image/webp";
              }
          >;
      /** The conversation this turn belongs to; main records it on the run. */
      sessionId?: string | null;
      /**
       * What the agent may do this turn.
       *
       * A closed set, and main narrows it against the surface — so naming one grants no
       * capability, the same argument that lets `surface` be named from here at all.
       *
       * `auto` is deliberately not in this union. It writes to disk with no per-batch dialog
       * and neither its consent mechanism nor its undo exists yet; main's schema would reject
       * it, so offering it would only produce a failed turn.
       */
      mode?: "plan" | "manual" | "acceptEdits" | "auto";
    }): Promise<ChatStream>;
    /**
     * Turn Auto mode on for this window and its open project.
     *
     * Takes no arguments: main reads the project from the sender, and the consent is the
     * window it shows. A root named from here would be the renderer choosing the scope of its
     * own grant. Returns whether the user agreed.
     */
    armAuto(): Promise<{ armed: boolean; root: string }>;
    disarmAuto(): Promise<{ armed: boolean }>;
    armStatus(): Promise<{ armed: boolean; root: string | null }>;
    /**
     * Undo the file changes an Auto run made.
     *
     * Files only. What the run's commands did — installs, migrations, pushes — is outside it,
     * and `truncated` says when even the file coverage was partial.
     */
    revertRun(input: { runId: string }): Promise<{
      restored: string[];
      deleted: string[];
      failed: Array<{ path: string; reason: string }>;
      truncated: boolean;
    }>;
    /** Shows a native dialog. `approved: false` means the user said no, and nothing was written. */
    applyDiffs(input: { ids: string[] }): Promise<{
      approved: boolean;
      results: Array<{ path: string; ok: boolean; reason: string | null }>;
    }>;
    /**
     * What the agent has done in this project, newest first.
     *
     * Scoped to the open project in main — no root is named here. `finishReason: null` means
     * the run never ended: it crashed, was cancelled, or died with its window. That is a real
     * state and worth showing as one.
     */
    history(input: { limit?: number }): Promise<{
      runs: Array<{
        id: string;
        question: string;
        provider: string;
        model: string;
        finishReason: string | null;
        createdAt: string;
        stepCount: number;
      }>;
    }>;
    /** One past run's steps. Returns nothing for a run belonging to another project. */
    steps(input: { runId: string }): Promise<{
      steps: Array<{
        seq: number;
        kind: "thought" | "tool" | "proposal" | "error" | "command" | "applied";
        toolName: string | null;
        diffId: string | null;
        text: string;
      }>;
      /**
       * The plan the run wrote, or null.
       *
       * Comes back alongside the steps and, unlike a diff, is still live: diffs expire in
       * memory after an hour, so a past run shows them as a record, while a plan is a durable
       * document that reads back exactly as it was written.
       */
      /*
        An inline `import(...)` type, and it has to be.

        This file is an ambient script, not a module: `interface Window` at the bottom augments
        the global one only while the file has no top-level import. Adding `import type { PlanDoc }`
        turns it into a module, `window.host` silently loses its type everywhere, and the project
        typecheck stays green because nothing it compiles touches `window.host` directly. An
        inline import keeps the file ambient.
      */
      plan: import("@shared/plan").PlanDoc | null;
      /** The design spec the run wrote, or null. Durable, exactly as the plan is. */
      design: import("@shared/design").DesignSpec | null;
    }>;
  };
  /**
   * The live preview.
   *
   * Build-only, so absent in a Study window — which is why the whole namespace is optional and
   * every call site reaches it through `?.`.
   *
   * Note what `start` does NOT take: a command. Main reads the project's own `package.json` and
   * decides; `ipc/contract.ts` records why a command field here would be arbitrary code
   * execution reachable from a renderer with no gate.
   */
  /**
   * The project's own design tokens, read from its CSS.
   *
   * Build-only, so absent in a Study window. No path argument: main finds the stylesheets under
   * the open project itself.
   */
  design?: {
    tokens(): Promise<{ tokens: import("@shared/design-tokens").DesignToken[] }>;
  };
  preview?: {
    /** What this project would run, so the button can say it before it does it. */
    detect(): Promise<{ command: { label: string; script: string } | null }>;
    start(): Promise<import("@shared/preview").PreviewState>;
    stop(): Promise<import("@shared/preview").PreviewState>;
    state(): Promise<import("@shared/preview").PreviewState>;
    /** Place the native view over this rectangle, in window coordinates. */
    show(bounds: { x: number; y: number; width: number; height: number }): Promise<{
      shown: boolean;
    }>;
    /** Take it off screen. The contents stay alive, so returning to the tab is not a reload. */
    hide(): Promise<Record<string, never>>;
  };
  /**
   * Where does this screenshot live in my code?
   *
   * A vision model transcribes the image, and what it reads is searched for in the project —
   * exact text first, the embedding index second. Note what is not here: no prompt. The
   * question put to the model is fixed in main, for the same reason `chat.open` has no
   * `system` role.
   *
   * `candidates` is empty when nothing matched, and that is the answer rather than a failure —
   * `searched` says which strings were tried, so the UI can show "I couldn't find these"
   * instead of the nearest-looking file.
   */
  vision?: {
    locate(input: {
      provider: "ollama" | "llamacpp" | "openrouter" | "hosted";
      model: string;
      image: { data: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };
    }): Promise<{
      candidates: Array<{
        path: string;
        line: number;
        symbol: string | null;
        /** Plain words naming the evidence, so the user can check it rather than trust a score. */
        why: string;
        /** `high` means both passes agreed; `low` means only the embedding did. */
        confidence: "high" | "medium" | "low";
      }>;
      facts: {
        visibleText: string[];
        identifiers: string[];
        uiElements: string[];
        errorText: string | null;
        appearance: string;
      };
      searched: string[];
      /** No index for this project, or no embedding model — exact-only results. */
      semanticUnavailable: boolean;
    }>;
  };
  /** Progress while an index builds. Minutes of work needs more than a pending promise. */
  onMemoryProgress?(
    cb: (progress: { phase: "scanning" | "embedding" | "writing"; done: number; total: number }) => void
  ): () => void;
  drafts: {
    save(input: { problemId: string; source: string }): Promise<{ saved: boolean }>;
    load(input: { problemId: string }): Promise<{ source: string | null }>;
  };
  /**
   * Opens a streaming chat. Tokens flow renderer↔provider over a transferred port rather
   * than through the broker, and closing the stream aborts generation.
   *
   * Resolves to a `ChatStream`, not the port itself — see that type for why.
   *
   * Note the absent `system` role: the persona is chosen in main from the window's mode
   * (`inference/personas.ts`). A Study window cannot ask for the Build assistant, and text
   * the tutor reads cannot inject one.
   */
  chat: {
    open(input: {
      /**
       * Which assistant. Main maps this to a persona and a tool set; the tutor gets no
       * filesystem tools, which is what lets both live in one window. This names a choice
       * from a closed set — it never supplies prompt text, and it grants no capability.
       */
      surface: "tutor" | "assistant";
      provider: "ollama" | "llamacpp" | "openrouter" | "hosted";
      model: string;
      /**
       * Content is a string, or blocks for a vision model.
       *
       * Images are bare base64 with no `data:` prefix; main builds whatever each provider
       * wants. Sending one to a *remote* provider prompts natively in main first — that check
       * is not here and cannot be skipped from this side.
       */
      messages: Array<{
        role: "user" | "assistant";
        content:
          | string
          | Array<
              | { type: "text"; text: string }
              | {
                  type: "image";
                  data: string;
                  mediaType: "image/png" | "image/jpeg" | "image/webp";
                }
            >;
      }>;
      temperature?: number;
      maxTokens?: number;
      json?: boolean;
    }): Promise<ChatStream>;

    /**
     * Conversation history, in local SQLite.
     *
     * Shapes here are the store's, named for the store. The wire translation into what
     * `api/chat.ts` parses happens at the seam in `client.ts` — emitting store-shaped rows
     * straight onto the wire is what broke submission history.
     */
    createSession(input: {
      problemId: string | null;
      title: string | null;
      /**
       * Which assistant this conversation belongs to. Defaults to the tutor.
       *
       * A closed set that grants no capability — the same argument that lets `chat.open`
       * accept one. Both surfaces share the tables; this is the only thing that differs, and
       * without it each was showing the other's history.
       */
      surface?: "tutor" | "assistant";
    }): Promise<StoredChatSession>;
    listSessions(input: {
      limit?: number;
      offset?: number;
      /** Omitted means both, which nothing in the UI wants. */
      surface?: "tutor" | "assistant";
    }): Promise<{ sessions: Array<StoredChatSession & { messageCount: number }>; total: number }>;
    getSession(input: { sessionId: string }): Promise<{
      session: StoredChatSession;
      messages: StoredChatMessage[];
    }>;
    saveMessage(input: {
      sessionId: string;
      role: "user" | "assistant";
      content: string;
      detectedMode?: string | null;
      thinkingContent?: string | null;
      thinkingTokenCount?: number | null;
      thinkingBudgetUsed?: number | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
    }): Promise<StoredChatMessage>;
    /**
     * Delete a conversation and its messages.
     *
     * Deleting an id that is already gone succeeds — the caller asked for it not to exist,
     * and it does not. Agent runs started from the conversation survive it: their foreign key
     * is `ON DELETE SET NULL`, so the record of what was changed on disk is not erased by
     * tidying up a chat.
     */
    deleteSession(input: { sessionId: string }): Promise<{ deleted: string }>;
    /** Titles and message bodies. A blank query lists everything. */
    searchSessions(input: {
      query: string;
      limit?: number;
      surface?: "tutor" | "assistant";
    }): Promise<{
      sessions: Array<
        StoredChatSession & {
          messageCount: number;
          matchedIn: "title" | "message";
          snippet: string | null;
        }
      >;
      total: number;
    }>;
  };
  /**
   * The interview question bank.
   *
   * Note what `list` and `get` cannot return: there is no `approach` and no `modelAnswer`
   * on either. That is not an omission in this type — main does not put them in the
   * payload, so the page physically cannot leak an answer nobody asked for. `reveal` is
   * the only way to get them, and asking for the answer is recorded.
   *
   * Shapes here are main's, named for main. The wire translation into what
   * `api/interviews.ts` parses happens at the seam in `client.ts`.
   */
  interviews: {
    list(): Promise<{
      questions: InterviewSummaryRow[];
      facets: {
        domains: InterviewFacetRow[];
        companies: InterviewFacetRow[];
        difficulties: InterviewFacetRow[];
        kinds: InterviewFacetRow[];
      };
      progress: { total: number; attempted: number; solid: number };
    }>;
    get(input: {
      slug: string;
    }): Promise<InterviewSummaryRow & { prompt: string; notes: string | null }>;
    reveal(input: { slug: string; stage: "approach" }): Promise<{
      stage: "approach";
      approach: string;
    }>;
    reveal(input: { slug: string; stage: "answer" }): Promise<{
      stage: "answer";
      modelAnswer: string;
      followUps: string[];
      redFlags: string[];
    }>;
    /**
     * Absent means "leave it alone"; null means "clear it". Rating and notes are written
     * by different interactions, so collapsing the two would let a notes-only save wipe a
     * rating by omission.
     */
    saveAttempt(input: {
      slug: string;
      selfRating?: number | null;
      notes?: string | null;
      elapsedSeconds?: number;
    }): Promise<{
      slug: string;
      selfRating: number | null;
      notes: string | null;
      revealedAnswer: boolean;
    }>;
    /** Rejects unless a real submission exists against the question's problem. */
    markSubmitted(input: { slug: string }): Promise<{ submittedAt: string | null }>;
    /**
     * Mark a written answer against the reference.
     *
     * Takes the answer and nothing else — no model, no prompt. The grading instructions and
     * the reference are assembled in main and never come back; only a verdict and feedback
     * do. `unknown` is the common case rather than the error case: a model tuned for
     * teaching coaches instead of emitting the verdict token, and the feedback is still the
     * useful part.
     */
    assess(input: {
      slug: string;
      answer: string;
    }): Promise<{
      verdict: "correct" | "partial" | "incorrect" | "unknown" | "too_short";
      feedback: string;
    }>;
    /**
     * The IDE payload. Every `expected_output` is null and that is deliberate — you write
     * against the spec and find out on submit. Nothing here can be made to return one.
     */
    workspace(input: { slug: string }): Promise<{
      problem: {
        id: string;
        order_index: number;
        title: string;
        difficulty: string;
        description: string;
        examples: Array<{ input: string; output: string; explanation?: string }>;
        constraints: string[];
        hints: string[];
      };
      testCases: Array<{
        id: string;
        label: string;
        inputs: Array<{ name: string; value: string }>;
        stdin: string;
        expected_output: null;
      }>;
      hidden_count: number;
      codeTemplates: Array<{
        id: string;
        language: string;
        template_code: string;
        driver_code: null;
      }>;
      elapsedSeconds: number;
      submittedAt: string | null;
      notes: string | null;
      companies: string[];
      domainLabel: string;
      difficulty: string;
      title: string;
    }>;
  };
  /**
   * Notifications. Read and mark-read only — there is no way to create one from here, and
   * that is the point: a renderer that could write its own could report a pass that never
   * happened. They are raised in main, beside the event that caused them.
   */
  notifications: {
    list(input: { unreadOnly?: boolean; limit?: number }): Promise<{
      notifications: NotificationRow[];
      unreadCount: number;
      total: number;
    }>;
    count(): Promise<{ unreadCount: number }>;
    /** Omit `ids` to mark every unread one read. Returns how many actually changed. */
    markRead(input: { ids?: string[] }): Promise<{ updated: number }>;
  };
  /**
   * The close handshake. Main asks via `shell:command { window.confirmClose }`, waits three
   * seconds, and closes regardless — so a hung renderer cannot make the app unquittable.
   */
  window: {
    allowClose(): Promise<unknown>;
    /**
     * The controls the renderer draws, now that the OS overlay is gone.
     *
     * None take an argument: a window may only act on itself, and the target is derived from
     * the sender in main. `close` goes through the same path as the OS button, so the
     * unsaved-work handshake still runs.
     */
    minimize(): Promise<{ ok: boolean }>;
    toggleMaximize(): Promise<{ ok: boolean; maximized?: boolean }>;
    close(): Promise<{ ok: boolean }>;
  };
  /**
   * Whether this window is maximised. Pushed, because the OS can maximise it without going
   * through our button — Win+Up, edge snapping, double-clicking the drag region.
   */
  onWindowState?(cb: (state: { maximized: boolean }) => void): () => void;
  /**
   * The download catalogue and what fits on this machine.
   *
   * `list` is what we offer, NOT what is installed — `providers.list()` is the installed set.
   * Confusing the two makes a fresh machine look like it already has twenty models.
   *
   * `recommend` and `pull` worked at runtime long before they were typed: the preload
   * generates `host.<ns>.<method>` from the channel list, so this is the types catching up
   * with a surface that already existed.
   */
  /**
   * The OpenRouter API key. Write-only, by design.
   *
   * **This namespace was exposed by the preload and absent from this file**, which is why nothing
   * called it: the channels existed, the handlers existed, and to TypeScript the object did not.
   * The consequence was a declared provider nobody could configure — OpenRouter is listed in the
   * registry and shown in the model manager, and the only way to give it a key was to not have one.
   *
   * There is deliberately no channel that returns the key. `set` hands it to Electron's
   * safeStorage in main, and `has` reports existence only — so the renderer can say whether one is
   * stored and can never read it back.
   *
   * That write-only shape is also why `clear` has to exist. With no getter, a user who suspects the
   * wrong key is stored cannot look; before keys persisted, restarting was the remedy, and now it
   * is not one.
   */
  vault: {
    /**
     * `storedDurably` is the answer to "will this still be here tomorrow", and it is not always yes.
     *
     * The key is persisted only when the OS credential store's ciphertext is safe to keep on disk.
     * On a Linux desktop Electron does not recognise, the selected backend encrypts with a hardcoded
     * key, so main keeps it in memory for the session instead — see `inference/vault.ts`. The UI has
     * to read this rather than assume, or it goes back to promising a lifetime it does not have.
     *
     * Rejects with `E_UNAVAILABLE` when the system has no credential store at all; the message is
     * written for the user and is safe to show.
     */
    set(input: {
      key: "openrouter";
      value: string;
    }): Promise<{ stored: boolean; storedDurably: boolean }>;
    has(input: { key: "openrouter" }): Promise<boolean>;
    /** `cleared: false` means there was nothing stored — not a failure. */
    clear(input: { key: "openrouter" }): Promise<{ cleared: boolean }>;
  };
  models: {
    list(): Promise<{ models: import("@shared/hardware-types").ModelSpec[] }>;
    recommend(input: {
      contextTokens: number;
    }): Promise<{
      profile: import("@shared/hardware-types").HardwareProfile;
      recommendations: Array<{
        model: import("@shared/hardware-types").ModelSpec;
        fit: import("@shared/hardware-types").FitVerdict;
      }>;
    }>;
    /**
     * Ollama only — every other provider throws "Only Ollama can download models".
     *
     * Resolves when the pull finishes. Progress arrives separately on `onModelPullProgress`,
     * because a promise cannot report the nine minutes in between.
     */
    pull(input: { id: string }): Promise<{ id: string; done: boolean }>;
    /**
     * Delete a model's weights. Shows a native confirmation in main first.
     *
     * `removed: false` means the user cancelled at the dialog — not an error, and not
     * something to report as one. A rejection means the deletion was attempted and failed.
     */
    remove(input: { id: string }): Promise<{ id: string; removed: boolean }>;
  };
  /**
   * Download progress. Fires many times per pull, for whichever model the payload names.
   *
   * `status` is Ollama's own string, and `"success"` is the only frame meaning finished.
   * Keying completion off `fraction >= 1` leaves the bar stuck at 100% — the layer downloads
   * complete before the manifest write does.
   */
  /**
   * Live load, roughly once a second. Null fields mean "this machine does not report it" —
   * GPU utilisation is NVIDIA-only — and must never be rendered as zero.
   */
  onHardwareTelemetry?(
    cb: (sample: import("@shared/hardware-types").TelemetrySample) => void
  ): () => void;
  onModelPullProgress?(
    cb: (progress: {
      id: string;
      status: string;
      fraction?: number;
      completedBytes?: number;
      totalBytes?: number;
    }) => void
  ): () => void;
  /**
   * A shell. Build mode only, and absent entirely in a Study window.
   *
   * Takes only a size: main chooses the shell and the working directory, and requires a
   * project to be open. A renderer that could name the command would have code execution
   * outside the sandbox with no dialog at all.
   *
   * Resolves to a port interface like `chat.open` — but bidirectional, since keystrokes and
   * resizes have to reach the pty.
   */
  pty?: {
    spawn(input: { cols: number; rows: number }): Promise<{
      send(message: unknown): void;
      onChunk(callback: (chunk: unknown) => void): void;
      close(): void;
    }>;
  };
  /**
   * The project's own linter, over one file.
   *
   * Build Mode only. Takes a path and never a command — everything about *what* runs is decided
   * in main, which is what makes this safe to call on every save.
   *
   * Typed from `@shared/diagnostics` rather than restated, for the reason `hw.scan` is: a
   * hand-mirrored shape is the drift `chat-chunk-parity.test.ts` exists to catch.
   */
  lint?: {
    run(input: { path: string }): Promise<import("@shared/diagnostics").LintResult>;
  };
  /** Build Mode only — absent in a Study window, by construction rather than by flag. */
  fs?: {
    /**
     * Opens a native directory picker. Takes no argument on purpose: the dialog *is* the
     * authorisation, so there is no way for renderer code to name a root it was not given.
     */
    openProject(): Promise<
      { opened: false } | ({ opened: true } & BuildOpenedProject)
    >;
    /**
     * Read a file as text, or report that it is not one.
     *
     * `binary` is a result rather than an error: clicking a PNG in the tree is an ordinary
     * thing to do, and the tree lists every file. When it is true, `contents` is empty — never
     * mojibake, which is what `fs.readFile(_, "utf8")` used to return for a binary while every
     * layer above treated it as the file.
     */
    read(input: { path: string }): Promise<{
      path: string;
      contents: string;
      binary: boolean;
      /** The file's real size, present only when it is binary — so a caller can say how big. */
      bytes?: number;
    }>;
    /**
     * The project this window already has open, if any.
     *
     * Asked on mount rather than waiting to be told. A restored window has its root re-granted
     * in main before the page even loads, and a push would have to land after React attached
     * its listener — a race it loses, leaving "No project open" over a granted root.
     */
    currentProject(): Promise<
      { opened: false } | ({ opened: true } & BuildOpenedProject)
    >;
    /**
     * Re-read the project tree.
     *
     * The tree used to arrive once and never again, so anything created outside the editor
     * stayed invisible until the folder was reopened. `onFileChanged` says that something
     * moved; this is how the sidebar catches up.
     */
    tree(): Promise<{ tree: BuildProjectTree }>;
    /** Create an empty file or a directory. Refuses an existing path rather than overwriting. */
    create(input: {
      path: string;
      kind: "file" | "directory";
    }): Promise<{ path: string; kind: "file" | "directory" }>;
    /** Rename or move — one operation. Refuses an existing destination. */
    rename(input: {
      from: string;
      to: string;
    }): Promise<{ path: string; kind: "file" | "directory" }>;
    /**
     * Delete, to the OS trash.
     *
     * Rejects rather than falling back to an unrecoverable delete if the OS refuses, so a
     * network share cannot quietly turn a recoverable action into a permanent one.
     */
    delete(input: { path: string }): Promise<{ path: string; kind: "file" | "directory" }>;
    /**
     * Plain-text search across the open project. No regex — see the contract entry.
     *
     * `truncated` means a bound stopped it early, so the UI can say "the first N" rather than
     * implying it found everything.
     */
    search(input: { query: string; caseSensitive?: boolean }): Promise<{
      matches: Array<{ path: string; line: number; column: number; preview: string }>;
      truncated: boolean;
      filesSearched: number;
    }>;
    /**
     * Reopen a folder from the recent list.
     *
     * Refuses any path not already remembered, so this cannot be used to name an arbitrary
     * directory — the native dialog remains the only way a folder enters that list.
     */
    openRecent(input: { path: string }): Promise<{ opened: true } & BuildOpenedProject>;
    /**
     * Computes a diff and returns it. **Writes nothing.** The proposed content is
     * deliberately not in the response — applying it requires `commitDiff` with the id,
     * so no renderer path can write a file the user has not seen as a diff.
     */
    writeWithDiff(input: { path: string; next: string }): Promise<BuildDiff>;
    commitDiff(input: { diffId: string }): Promise<{ path: string; bytes: number }>;
    /**
     * Write an editor buffer straight to disk.
     *
     * `baseline` is what the buffer was opened or last saved against; `null` means the file
     * did not exist. Rejects when it no longer matches, so a save cannot silently discard a
     * change the assistant or another tool made since the file was opened.
     *
     * This does not weaken the diff gate above — see the contract entry for why. The short
     * version: that gate is about reviewing model-authored text, and this writes the buffer
     * the user is looking at.
     */
    save(input: {
      path: string;
      contents: string;
      baseline: string | null;
    }): Promise<{ path: string; bytes: number }>;
    /**
     * Save As, through a native dialog.
     *
     * Sends contents and a suggested *name*, never a path: the dialog is the authorisation,
     * exactly as it is for `openProject`. `rebind` is false when the user chose somewhere
     * outside the project — the file is written once and the buffer keeps its old identity,
     * because rebinding to an out-of-root path would force every later `save` to accept one.
     */
    saveAs(input: {
      contents: string;
      suggestedName: string;
    }): Promise<
      { saved: false } | { saved: true; path: string; bytes: number; rebind: boolean }
    >;
    /** Native "save / don't save / cancel" for a buffer with unsaved changes. */
    confirmDiscard(input: {
      path: string;
    }): Promise<{ choice: "save" | "discard" | "cancel" }>;
  };
}

/** A saved conversation, as the store holds it. */
interface StoredChatSession {
  id: string;
  problemId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  detectedMode: string | null;
  thinkingContent: string | null;
  thinkingTokenCount: number | null;
  thinkingBudgetUsed: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

/**
 * A live generation, owned by the preload.
 *
 * Not a `MessagePort`: one cannot cross `contextBridge` — it arrives stripped of its methods.
 * The preload keeps the real port and exposes this over it.
 */
interface ChatStream {
  onChunk(callback: (chunk: unknown) => void): void;
  /** Ends the stream. This is also the abort path — closing the port stops generation. */
  close(): void;
}

interface BuildTreeNode {
  name: string;
  /** Project-relative, forward slashes — the form `fs.read` expects back. */
  path: string;
  kind: "file" | "directory";
  children?: BuildTreeNode[];
}

/**
 * What comes back when a folder becomes this window's project.
 *
 * `watching` is not decoration. Without a watcher the sidebar and the open buffers can drift
 * from disk silently, and the difference between "nothing has changed" and "I can no longer
 * tell" is one the user has to be able to see — so the reason travels with the answer.
 */
interface BuildOpenedProject {
  tree: BuildProjectTree;
  watching: boolean;
  watchReason: string | null;
}

interface BuildFileChange {
  /** Project-relative, forward slashes. */
  path: string;
  kind: "created" | "changed" | "deleted" | "unknown";
}

interface BuildFileChangeBatch {
  changes: BuildFileChange[];
  /**
   * A bound stopped the batch short. Refetch the tree rather than applying `changes` and
   * believing the sidebar is current.
   */
  overflow: boolean;
}

interface BuildProjectTree {
  root: string;
  name: string;
  entries: BuildTreeNode[];
  /** The walk hit its entry or depth cap. Must be surfaced, never swallowed. */
  truncated: boolean;
}

interface BuildDiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  before?: number;
  after?: number;
}

interface BuildDiff {
  id: string;
  path: string;
  displayPath: string;
  isNew: boolean;
  lines: BuildDiffLine[];
  added: number;
  removed: number;
  createdAt: number;
}

/**
 * A catalogue row, as main projects it.
 *
 * Already camelCase — unlike the web API, which speaks Python and only camelCases its
 * responses. The seam still translates, because `api/interviews.ts` reads a wire shape
 * with `promptPreview` alongside snake_case neighbours elsewhere, and emitting store
 * shapes straight onto the wire is what broke submission history.
 */
interface InterviewSummaryRow {
  slug: string;
  title: string;
  promptPreview: string;
  domain: string;
  domainLabel: string;
  kind: "derivation" | "computation" | "code";
  kindLabel: string;
  difficulty: "easy" | "medium" | "hard";
  companies: string[];
  categories: string[];
  orderIndex: number;
  selfRating: number | null;
  revealedAnswer: boolean;
  attempted: boolean;
  hasWorkspace: boolean;
  solved: boolean;
}

/** A notification as main holds it. The seam snake_cases it for `parseNotification`. */
interface NotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  referenceId: string | null;
  createdAt: string;
}

interface InterviewFacetRow {
  key: string;
  label: string;
  total: number;
}

/** Who is signed in to VoidCode on this device. Details are in memory in main, never stored locally. */
interface HostAccountUser {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  emailVerified: boolean;
  providers: string[];
}

interface HostAccountState {
  signedIn: boolean;
  /** Null until the server has confirmed the session this launch. */
  user: HostAccountUser | null;
  /** The last attempt to check with the server could not connect. */
  offline: boolean;
  /** False when the session lasts only until the app quits (no usable keyring). */
  durable: boolean;
}

interface HostAccountChange {
  reason: "signedIn" | "signedOut" | "expired" | "updated";
  state: HostAccountState;
}

interface HostSignedIn {
  ok: true;
  user: { id: string; email: string; name: string };
  /** True when this sign-in created the account — registration, or a first provider sign-in. */
  created: boolean;
  /**
   * True when attaching a provider removed a password that had been set on this address without the
   * address ever being proven. Say so: someone's password has just stopped working.
   */
  passwordCleared: boolean;
}

/**
 * A ledger row. One declaration, in `src/shared/credits.ts`, because main parses this shape and the
 * renderer both renders it and decides from it whether a payment has landed.
 *
 * An inline `import(...)` type, like `onPreviewChanged` above: a top-level import would make this
 * file a module and `window.host` would lose its type everywhere at once.
 */
type HostLedgerEntry = import("@shared/credits").LedgerEntry;

type HostProviderId = "google" | "microsoft";

interface HostProviderStatus {
  id: HostProviderId;
  /** As the provider writes it — "Google", "Microsoft". What the button says. */
  label: string;
  /** False when this build has no client id for it, in which case draw no button. */
  configured: boolean;
}

/** A provider attached to the account already signed in. No new session was issued. */
interface HostProviderLinked {
  ok: true;
  linked: true;
  provider: HostProviderId;
}

interface HostAccountFailure {
  ok: false;
  /** Stable, to branch on: `offline`, `not_configured`, `rate_limited`, or the server's own code. */
  code: string;
  /** Written to be shown as it is. */
  message: string;
  /** The form field the message belongs to, when the server named one. */
  field?: string;
}

interface Window {
  host?: VoidCodeHost;
}
