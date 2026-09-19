/**
 * The IPC contract: every channel, its input schema, and which modes may call it.
 *
 * This file is the single source of truth for the privilege boundary described in
 * spec §2.2. It is data, not behaviour — handlers are attached separately (see
 * `broker.ts`) so that reviewing "what is reachable from a Study window?" means
 * reading one table rather than auditing a dozen handler files.
 *
 * Adding a channel without a `modes` entry is a type error, which is the point:
 * there is no way to expose something to the renderer and forget to say who may
 * call it.
 */
import { z } from "zod";
import { SELECTABLE_MODES } from "../agent/modes.js";
import { WINDOW_MODES, type WindowMode } from "../modes.js";
import { MENU_IDS } from "../menu-ids.js";
import { COMMAND_IDS } from "../../shared/commands.js";

const BOTH = WINDOW_MODES;
const BUILD_ONLY = ["build"] as const satisfies readonly WindowMode[];

/**
 * A path supplied by the renderer.
 *
 * Deliberately only a shape check. Confinement to the project root is enforced
 * in the handler via realpath + prefix check (spec §2.11), because a string
 * predicate cannot answer "does this resolve inside the workspace?" — symlinks
 * mean only the filesystem knows.
 */
const RendererPath = z.string().min(1).max(4096);

export const CHANNELS = {
  // ── Available in both modes ───────────────────────────────────────────────
  /**
   * A renderer error, on its way to the log file.
   *
   * The renderer cannot write to disk — it is sandboxed, which is the point — so an error it
   * catches has nowhere to go but the console, and in a packaged app nobody is reading that.
   * This is the one door out.
   *
   * Everything is bounded by the schema rather than trusted. A stack is attacker-influenced
   * in the sense that any page content can end up inside a thrown message, and an unbounded
   * string on a path that appends to a file is how a log becomes a disk-filling primitive.
   * The caps are generous enough for a real React stack and small enough that a loop cannot
   * do damage before rotation catches it.
   */
  "log:write": {
    input: z.object({
      level: z.enum(["error", "warn"]),
      message: z.string().max(4_000),
      stack: z.string().max(16_000).nullable(),
      context: z.record(z.string(), z.unknown()).nullable(),
    }),
    modes: BOTH,
  },
  "mode:get": {
    input: z.undefined(),
    modes: BOTH,
  },
  "hw:scan": {
    input: z.undefined(),
    modes: BOTH,
  },
  "models:list": {
    input: z.undefined(),
    modes: BOTH,
  },
  "models:recommend": {
    input: z.object({
      // Both models must fit together in Build Mode (spec §2.5), so the caller
      // says what it needs rather than the scanner guessing.
      contextTokens: z.number().int().min(512).max(1_048_576),
    }),
    modes: BOTH,
  },
  "models:pull": {
    input: z.object({ id: z.string().min(1).max(256) }),
    modes: BOTH,
  },
  /**
   * Delete a model's weights. Gated by a native dialog in main — see the handler.
   *
   * `modes: BOTH` like the rest of `models:*`: the same weights serve both products, and a
   * Study window is a perfectly reasonable place to notice a disk is full.
   */
  "models:remove": {
    input: z.object({ id: z.string().min(1).max(256) }),
    modes: BOTH,
  },
  "providers:list": {
    input: z.undefined(),
    modes: BOTH,
  },
  // ── The VoidCode account ──────────────────────────────────────────────────
  //
  // Every account channel is BOTH-mode: a Study window is exactly where someone signs in to use the
  // VoidCode tutor. And every one returns an outcome, never a credential — the session token lives
  // in the OS keychain and is read only in main (`account/session.ts`).
  //
  // Passwords cross these channels once and are never stored. Emails are bounded at 320 (the RFC
  // maximum) and passwords at 4096, matching the API, so an absurd payload is refused here rather
  // than forwarded.

  /**
   * Whether this device has a session, who it belongs to if known, and whether the last server check
   * failed for want of a connection. Signed out, answered from the keychain with NO network request.
   */
  "account:session": { input: z.undefined(), modes: BOTH },
  /** Ask the server who this session belongs to. Signed out: no request. */
  "account:refresh": { input: z.undefined(), modes: BOTH },
  "account:signInPassword": {
    input: z.object({
      email: z.string().min(3).max(320),
      password: z.string().min(1).max(4096),
    }),
    modes: BOTH,
  },
  /**
   * Create an account and sign in.
   *
   * `acceptTerms` is a literal `true`: an account cannot be requested without the box ticked, and the
   * renderer cannot send a terms VERSION at all — main adds the one this build displays
   * (`shared/legal.ts`), so a compromised renderer cannot record consent to a document nobody saw.
   */
  "account:register": {
    input: z.object({
      name: z.string().min(1).max(200),
      email: z.string().min(3).max(320),
      password: z.string().min(1).max(4096),
      acceptTerms: z.literal(true),
    }),
    modes: BOTH,
  },
  /** Email a six-digit reset code. The answer is the same whether or not the address has an account. */
  "account:requestPasswordCode": {
    input: z.object({ email: z.string().min(3).max(320) }),
    modes: BOTH,
  },
  /** Set a new password with the emailed code; signs this device in and every other device out. */
  "account:resetPassword": {
    input: z.object({
      email: z.string().min(3).max(320),
      code: z.string().regex(/^\d{6}$/),
      newPassword: z.string().min(1).max(4096),
    }),
    modes: BOTH,
  },
  "account:changePassword": {
    input: z.object({
      currentPassword: z.string().min(1).max(4096),
      newPassword: z.string().min(1).max(4096),
    }),
    modes: BOTH,
  },
  "account:signOut": { input: z.undefined(), modes: BOTH },
  "account:signOutEverywhere": { input: z.undefined(), modes: BOTH },

  // ── The research library ──────────────────────────────────────────────────
  //
  // A SLUG, NEVER A URL. `research:openPdf` ends at `shell.openExternal`, so the set of addresses
  // a renderer can cause to be opened in the person's browser is the set of papers our own API
  // publishes — main takes the address from the fetched paper, checks it is https, and opens it.
  // The slug pattern is the API's own: lower-case, digits and hyphens.
  //
  // Both modes. A paper explains the thing a problem asks you to implement, and the IDE is a
  // perfectly reasonable place to go and read why the maths works.

  "research:list": { input: z.undefined(), modes: BOTH },
  "research:get": {
    input: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,128}$/) }),
    modes: BOTH,
  },
  /** Record that a section was opened. Refused without a session, before any request. */
  "research:markRead": {
    input: z.object({
      slug: z.string().regex(/^[a-z0-9-]{1,128}$/),
      // The API validates the same four against the same pattern; `shared/research.ts` owns the
      // list and a test pins the two together.
      section: z.enum(["architecture", "implementation", "systems", "mathematics"]),
    }),
    modes: BOTH,
  },
  "research:openPdf": {
    input: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,128}$/) }),
    modes: BOTH,
  },

  "voidcode:credits": { input: z.undefined(), modes: BOTH },
  "voidcode:packs": { input: z.undefined(), modes: BOTH },
  /**
   * The most recent movements of credit, newest first.
   *
   * `limit` is optional with a server default of 50, and bounded here at the same 200 the API
   * clamps to — so an absurd value is refused at the boundary rather than quietly reinterpreted
   * two processes later, and the two numbers cannot drift apart unnoticed.
   *
   * A read of the caller's own wallet: it names no user, because the session does.
   */
  "voidcode:ledger": {
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    modes: BOTH,
  },
  /**
   * Start a purchase. Returns nothing useful to the renderer on purpose: main opens the buyer's
   * browser itself, so a compromised renderer cannot use this to navigate a person anywhere.
   */
  /**
   * Redeem a voucher code.
   *
   * Bounded at 128 characters: a code is 32 characters of base64url, and anything an order of
   * magnitude larger is a paste accident or someone probing the endpoint. Rejecting it here costs
   * nothing and keeps it off the rate limiter's budget.
   */
  "voidcode:redeem": {
    input: z.object({ code: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  "voidcode:checkout": {
    input: z.object({ packCode: z.string().min(1).max(64) }),
    modes: BOTH,
  },
  "chat:open": {
    input: z.object({
      // The persona is derived from the window mode, never sent from here: a Study window
      // gets the tutor and its restricted context, and cannot ask for the unrestricted
      // Build assistant (spec §2.2).
      //
      // Note the absence of `"system"` below, which is what makes the sentence above true.
      // It used to be in this enum, and the handler passed `messages` straight through — so
      // the tutor's restraint was whatever the caller prepended, and a single injected turn
      // could swap the Study persona for the unrestricted one. The renderer sends
      // conversation turns; `inference/personas.ts` supplies the persona.
      //
      // `surface` selects *which* main-defined persona, now that both live in one window.
      // That is a much weaker thing to accept from the renderer than prompt text: the choice
      // is from a closed set we control, and it grants no capability — filesystem access
      // comes from the folder-picker consent, and writes still require diff review. Content
      // cannot reach this either way, since a paper or a model reply is text the renderer
      // displays, not code that can open a channel.
      surface: z.enum(["tutor", "assistant"]),
      provider: z.enum(["ollama", "llamacpp", "openrouter", "hosted"]),
      model: z.string().min(1).max(256),
      messages: z
        .array(
          z
            .object({
              role: z.enum(["user", "assistant"]),
              /**
               * A string, or content blocks for a vision model.
               *
               * The string form is first in the union so every existing caller validates
               * against it unchanged — and so a plain conversation cannot accidentally be
               * read as a one-element block array.
               *
               * The bounds are not decoration. A base64 image is ~4/3 its byte size, so
               * these caps are what stop a renderer pushing a hundred megabytes through
               * the broker and into a model's context in one call.
               */
              content: z.union([
                z.string().max(200_000),
                z
                  .array(
                    z.union([
                      z.object({ type: z.literal("text"), text: z.string().max(200_000) }).strict(),
                      z
                        .object({
                          type: z.literal("image"),
                          // ~12 MB of base64. Beyond this the request is slower to send than
                          // the model is to answer.
                          data: z.string().min(1).max(16_000_000),
                          mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
                        })
                        .strict(),
                    ])
                  )
                  .min(1)
                  .max(16),
              ]),
            })
            // `.strict()`, so an injected `toolCalls` or `tools` key is a rejection rather
            // than a silently ignored one. The renderer names a surface; main decides what
            // that surface may reach — the same argument that keeps the persona out of here.
            .strict()
        )
        .min(1)
        .max(200),
      /**
       * What the learner is working on, if anything — a curriculum problem id or an interview
       * slug.
       *
       * An id, never a topic or a query. Main maps it through the concept graph to scope
       * reference retrieval, so a renderer naming one is choosing *which of its own items* it is
       * on, not steering what the tutor is told. Unknown ids map to no concepts and cost
       * relevance rather than correctness.
       */
      itemId: z.string().min(1).max(128).optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(32_768).optional(),
      json: z.boolean().optional(),
    }),
    modes: BOTH,
  },
  /**
   * Open a real native menu under the renderer's menu bar.
   *
   * The window is frameless, so on Windows and Linux the renderer draws the bar — but the
   * menus themselves stay native, because `role`-based items ("copy", "undo") carry their
   * accelerators, enabled state and OS edit behaviour with them. Reimplementing that in the
   * page means reimplementing it wrongly.
   *
   * Coordinates are viewport CSS pixels, clamped by the handler. A menu id outside the list
   * is rejected by the schema, so this cannot be used to open something unintended.
   */
  "menu:popup": {
    input: z.object({
      menu: z.enum(MENU_IDS),
      x: z.number().min(0).max(20_000),
      y: z.number().min(0).max(20_000),
    }),
    modes: BOTH,
  },
  /**
   * What the focused window can currently do, so the native menu can grey out the rest.
   *
   * ENABLED, NOT DISABLED, and the direction is the whole point. Before the first publish the
   * set is empty and every command item is greyed — so a renderer that has not mounted yet, or
   * has crashed, shows a dead menu rather than a live one that does nothing. A `disabled` list
   * would fail the other way.
   *
   * Both modes: a command a mode cannot service is simply never bound, so it never appears in
   * the enabled set. There is nothing here for a mode gate to add.
   */
  "menu:setState": {
    input: z.object({
      enabled: z.array(z.enum(COMMAND_IDS)).max(COMMAND_IDS.length),
      checked: z.array(z.enum(COMMAND_IDS)).max(COMMAND_IDS.length),
    }),
    modes: BOTH,
  },
  /**
   * Tutor conversation history. Both modes: the Build assistant does not use it today, but
   * nothing about a saved conversation is privileged, and a Build-only restriction here
   * would be a rule with no threat behind it.
   */
  "chat:createSession": {
    input: z.object({
      problemId: z.string().min(1).max(128).nullable(),
      title: z.string().max(200).nullable(),
    // Which assistant this conversation belongs to. A closed set that grants no
    // capability -- the same argument that lets `chat:open` accept one.
      surface: z.enum(["tutor", "assistant"]).optional(),
    }),
    modes: BOTH,
  },
  "chat:listSessions": {
    input: z.object({
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      // Omitted means both, which nothing in the UI wants: each surface asks for its own.
      surface: z.enum(["tutor", "assistant"]).optional(),
    }),
    modes: BOTH,
  },
  "chat:getSession": {
    input: z.object({ sessionId: z.string().uuid() }),
    modes: BOTH,
  },
  /**
   * Delete a conversation and everything in it.
   *
   * This channel is the missing half of a button that has existed, visible and clickable, since
   * the history dropdown shipped. `store/chat.ts` exported `deleteSession`, the dropdown called
   * `DELETE /v1/chat/sessions/{id}` -- and no route matched it, so the request fell through to
   * the transport's 501 and the panel logged it to a console nobody has open. The row simply
   * stayed on screen.
   *
   * Messages go with the session by `ON DELETE CASCADE`. Agent runs do NOT: their foreign key
   * is `ON DELETE SET NULL`, so the record of what the agent changed on disk survives the
   * conversation being tidied away.
   */
  "chat:deleteSession": {
    input: z.object({ sessionId: z.string().uuid() }),
    modes: BOTH,
  },
  /**
   * Search titles and message bodies.
   *
   * A `LIKE` scan, not FTS5. An index would be a migration, a second copy of every message and
   * triggers to keep the two agreeing -- worth it over a corpus that does not fit in memory,
   * and not worth it over one person's local chat history.
   */
  "chat:searchSessions": {
    input: z.object({
      // Bounded like every other free-text input here. An empty string is legal and means
      // "everything", so the panel can call this as its search box empties rather than
      // switching between two channels and getting the transition wrong.
      query: z.string().max(200),
      limit: z.number().int().min(1).max(100).optional(),
      surface: z.enum(["tutor", "assistant"]).optional(),
    }),
    modes: BOTH,
  },
  "chat:saveMessage": {
    input: z.object({
      sessionId: z.string().uuid(),
      // No system role, for the same reason `chat:open` has none: the persona is main's.
      role: z.enum(["user", "assistant"]),
      content: z.string().max(200_000),
      detectedMode: z.string().max(64).nullable().optional(),
      thinkingContent: z.string().max(200_000).nullable().optional(),
      thinkingTokenCount: z.number().int().min(0).nullable().optional(),
      thinkingBudgetUsed: z.number().int().min(0).nullable().optional(),
      promptTokens: z.number().int().min(0).nullable().optional(),
      completionTokens: z.number().int().min(0).nullable().optional(),
    }),
    modes: BOTH,
  },
  /**
   * The interview question bank.
   *
   * `interviews:reveal` is the only channel that returns an approach or a model answer,
   * and that is the design rather than an implementation detail: the list and detail
   * channels physically cannot leak one, because the bank lives in main and the
   * projections that cross the boundary do not carry those fields.
   *
   * Both modes. Nothing here is privileged — it is study content and the user's own
   * notes about it — and a Build-only restriction would be a rule with no threat
   * behind it.
   */
  "interviews:list": {
    input: z.undefined(),
    modes: BOTH,
  },
  "interviews:get": {
    input: z.object({ slug: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  "interviews:reveal": {
    input: z.object({
      slug: z.string().min(1).max(128),
      stage: z.enum(["approach", "answer"]),
    }),
    modes: BOTH,
  },
  "interviews:saveAttempt": {
    input: z.object({
      slug: z.string().min(1).max(128),
      // `.optional()` and `.nullable()` mean different things here and both are load
      // bearing: absent leaves the column alone, null clears it. Collapsing them would
      // make a notes-only save silently wipe a rating.
      selfRating: z.number().int().min(1).max(3).nullable().optional(),
      notes: z.string().max(10_000).nullable().optional(),
      elapsedSeconds: z.number().int().min(0).max(86_400).optional(),
    }),
    modes: BOTH,
  },
  "interviews:markSubmitted": {
    input: z.object({ slug: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  /**
   * The IDE payload for a question's executable form.
   *
   * Carries no expected outputs — see `content/interview-detail.ts`. Grading happens in
   * main against `iq-`-prefixed problems the renderer never sees the reference for, so
   * this is the same privilege shape as `problems:get`.
   */
  "interviews:workspace": {
    input: z.object({ slug: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  /**
   * Mark a written answer against the reference.
   *
   * The input is the candidate's answer and nothing else — no model, no prompt, no system
   * turn. That is the same rule as `chat:open`, for a stronger reason: the grading prompt
   * carries the model answer, so a renderer that could shape the request could ask the
   * model to repeat it back.
   */
  "interviews:assess": {
    input: z.object({
      slug: z.string().min(1).max(128),
      answer: z.string().min(1).max(10_000),
    }),
    modes: BOTH,
  },
  /**
   * Notifications.
   *
   * Read and mark-read only. There is deliberately no `notifications:create` — a renderer
   * that could write one could tell the user their submission passed when it did not, and
   * reporting what actually happened is the entire job of this surface. They are raised in
   * main, beside the event that caused them.
   */
  "notifications:list": {
    input: z.object({
      unreadOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    modes: BOTH,
  },
  "notifications:count": {
    input: z.undefined(),
    modes: BOTH,
  },
  "notifications:markRead": {
    input: z.object({
      // Empty means all of them, which is what the bell's "mark all read" sends. Bounded
      // because it arrives from the renderer and an unbounded IN clause is an unbounded
      // statement.
      ids: z.array(z.string().min(1).max(64)).max(200).optional(),
    }),
    modes: BOTH,
  },
  /**
   * The local user's own details.
   *
   * Every field is `.nullable().optional()`, and both halves carry meaning: absent leaves a
   * field alone, null clears it. Collapsing them would let a save that only carried a name
   * wipe the bio.
   *
   * No `email` and no `role`. There is nothing to register an address with and nothing to
   * grant a role, so accepting either would let the renderer write a fact that no server
   * ever established.
   */
  "profile:update": {
    input: z.object({
      name: z.string().max(120).nullable().optional(),
      bio: z.string().max(2_000).nullable().optional(),
      // Shape only. That a date exists — `2026-02-30` does not — is checked in the store,
      // because a regex cannot know how many days February has.
      birthDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      country: z.string().max(120).nullable().optional(),
      occupation: z.string().max(120).nullable().optional(),
      profilePhotoUrl: z.string().max(2_000).nullable().optional(),
      timezone: z.string().max(120).nullable().optional(),
    }),
    modes: BOTH,
  },
  "dashboard:get": {
    input: z.undefined(),
    modes: BOTH,
  },
  "problems:get": {
    input: z.object({ slug: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  "problems:list": {
    input: z.undefined(),
    modes: BOTH,
  },
  /**
   * Submit a solution for grading.
   *
   * Note what the renderer does *not* get to send: no test cases, no import
   * allowlist, no time or memory limit. All of that comes from the problem store in
   * main (`content/problems.ts`). An earlier version of this channel accepted all
   * four from the caller, which meant a client could grade itself against one trivial
   * input, grant itself scipy on a NumPy-only exercise, and award itself a 120-second
   * budget. In an app the user can patch, the client must not hold the answer key —
   * otherwise "solved" stops meaning anything to the person relying on it.
   */
  "exec:run": {
    input: z.object({
      problemId: z.string().min(1).max(128),
      source: z.string().max(1_000_000),
      // Tier B is Build-only; the handler rejects "native" for Study windows even
      // though the channel itself is shared (spec §2.6).
      tier: z.enum(["pyodide", "native"]),
      /**
       * The handle Stop uses. Optional, because a run nobody can stop is still a valid run
       * and the field would otherwise be a breaking change to every caller.
       *
       * From the renderer on purpose. An id minted here and returned with the result arrives
       * after the run is over; an id pushed back on an event leaves a gap at the start where
       * Stop does nothing. The renderer knows it before the call goes out, so Stop works from
       * the first millisecond. See exec/attempts.ts — it grants no capability.
       */
      attemptId: z.string().uuid().optional(),
    }),
    modes: BOTH,
  },
  /**
   * Stop a run.
   *
   * Takes the attemptId the caller sent to `exec:run`, not a runId. A grade performs two
   * sandbox runs with two internally-generated ids, so no runId identifies the thing the user
   * is waiting on — which is why this channel was registered and unreachable for so long.
   */
  "exec:cancel": {
    input: z.object({ attemptId: z.string().uuid() }),
    modes: BOTH,
  },
  "drafts:save": {
    input: z.object({
      problemId: z.string().min(1).max(128),
      source: z.string().max(1_000_000),
    }),
    modes: BOTH,
  },
  "drafts:load": {
    input: z.object({ problemId: z.string().min(1).max(128) }),
    modes: BOTH,
  },
  "submissions:list": {
    input: z.object({
      problemId: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    modes: BOTH,
  },
  "profile:get": {
    input: z.undefined(),
    modes: BOTH,
  },
  /**
   * THE RENDERER MAY ONLY TOUCH KEYS THE USER PASTES IN — never the VoidCode session.
   *
   * The session token is minted by our API and written only by main, after main itself made the
   * sign-in call. When these enums also accepted `"voidcode"`, a compromised renderer could not
   * read the token but could OVERWRITE it — planting an attacker's session so the learner's
   * questions and purchases went to someone else's account — or clear it without revoking it on
   * the server. Reading was never the only threat; writing is how a session gets swapped.
   * `renderer/src/types/host.d.ts` already declared only `"openrouter"`; this makes the boundary
   * that is actually enforced agree with the one that was documented.
   */
  "vault:set": {
    input: z.object({
      key: z.enum(["openrouter"]),
      value: z.string().min(1).max(4096),
    }),
    modes: BOTH,
  },
  /**
   * Note what is absent: there is no `vault:get`. Secrets are attached to
   * outbound requests inside main (spec §2.3), so a compromised renderer has no
   * channel through which to exfiltrate a key — only to ask whether one exists.
   */
  "vault:has": {
    input: z.object({ key: z.enum(["openrouter"]) }),
    modes: BOTH,
  },
  /**
   * Forget a key. Necessary once `vault:set` persists rather than lasting a session.
   *
   * While keys died with the process, "remove" was a restart, so there was nothing to add. Now a
   * key survives, which means a wrong one, a revoked one, or one left behind on a shared machine
   * also survives — and with no getter, the user cannot even confirm which key is stored. Replacing
   * it was the only remedy, and that requires having another key to hand.
   */
  "vault:clear": {
    input: z.object({ key: z.enum(["openrouter"]) }),
    modes: BOTH,
  },

  // ── Build Mode only ──────────────────────────────────────────────────────
  "fs:openProject": {
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  "fs:read": {
    input: z.object({ path: RendererPath }),
    modes: BUILD_ONLY,
  },
  /**
   * Lint one file with the project's own linter.
   *
   * **A path, never a command.** Which tool runs, where its binary comes from and what arguments
   * it gets are all decided in `lint/index.ts`. A channel that accepted a command string would be
   * `run_command` reachable from a save, with none of the consent that surrounds it.
   *
   * Request/response, and nothing cancels it: a stale run finishes in main and the renderer drops
   * the answer by request id. `RendererPath` is the same door `fs:read` uses, so the path is
   * confined to the project before anything is spawned.
   */
  "lint:run": {
    input: z.object({ path: RendererPath }),
    modes: BUILD_ONLY,
  },
  /**
   * Returns a diff. It does not write — `fs:commitDiff` does, and only for a
   * diff the user has seen (spec §2.3). An agent therefore cannot write a file
   * in one step, which is what makes an unrestricted agent reviewable.
   */
  "fs:writeWithDiff": {
    input: z.object({ path: RendererPath, next: z.string().max(8_000_000) }),
    modes: BUILD_ONLY,
  },
  "fs:commitDiff": {
    input: z.object({ diffId: z.string().uuid() }),
    modes: BUILD_ONLY,
  },
  /**
   * Write an editor buffer straight to disk.
   *
   * THIS DOES NOT WEAKEN THE REVIEW GATE ABOVE, and the reason is worth stating precisely,
   * because the obvious reading is the wrong one.
   *
   * `writeWithDiff`/`commitDiff` enforce two *steps* in main. They do not enforce two
   * *parties*: nothing in `diffs.ts` requires a human to have seen the diff before
   * `commitDiff` is called. The review is enforced by `AssistantPanel`'s UI, in the renderer,
   * which is the component we already assume can be compromised. So a compromised renderer
   * can already write arbitrary confined content today, in two calls instead of one.
   * `fs:save` grants it nothing it does not have.
   *
   * What bounds both paths is the same thing: `writeWorkspacePath`, and the fact that
   * `projectRoot` is only ever set by the user picking a folder in a native dialog.
   *
   * The gate stays for the assistant because its value is human review of *model-authored*
   * text — content the user has not read. This writes the buffer they are looking at,
   * character for character.
   *
   * `baseline` is what the buffer was opened or last saved against, and `null` means the file
   * did not exist. The handler refuses when it no longer matches, so a save cannot silently
   * discard a change made by the assistant or another tool since the file was opened.
   */
  /**
   * Folders opened before, for File > Open Recent.
   *
   * Reading the list is harmless; opening one is not, which is why `fs:openRecent` refuses
   * any path that is not already remembered. The dialog is still the only way a folder can
   * enter that list, so this cannot be used to widen the sandbox.
   */
  /**
   * Plain-text search across the open project.
   *
   * No regex, deliberately: a pattern from the renderer running in the main process is a
   * denial-of-service surface, and catastrophic backtracking is easy to write by accident.
   * Regex search needs a bounded engine and a timeout, which is its own change.
   */
  "fs:search": {
    input: z.object({
      query: z.string().min(1).max(500),
      caseSensitive: z.boolean().optional(),
    }),
    modes: BUILD_ONLY,
  },
  /**
   * Re-read the project tree.
   *
   * The tree used to arrive once, with `fs:openProject`, and never again — so a file created
   * by the terminal, a branch switch, or anything outside the editor stayed invisible until
   * the folder was reopened. The watcher (`fs:changed`) says *that* something moved; this is
   * how the sidebar catches up.
   */
  /**
   * The project this window already has open, if any.
   *
   * A PULL, DELIBERATELY, replacing a push. Restore used to re-grant the root in main and then
   * send the renderer a `file.openRecent` intent on `did-finish-load` — which loses a race it
   * cannot win: React attaches its shell-command listener in an effect that runs after the
   * page load event, so the message arrived before anything was listening and the window came
   * back showing "No project open" over an empty sidebar.
   *
   * Asking on mount has no such ordering to get right, and it answers a second question for
   * free: navigating to Build after a project was opened elsewhere in the app.
   */
  "fs:currentProject": {
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  "fs:tree": {
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  /**
   * Create an empty file or a directory.
   *
   * Refuses an existing path rather than overwriting. A "New File" that silently truncated
   * one is a data-loss bug with a friendly name on it.
   */
  "fs:create": {
    input: z.object({ path: RendererPath, kind: z.enum(["file", "directory"]) }),
    modes: BUILD_ONLY,
  },
  /**
   * Rename or move — one syscall, because on every filesystem here they are one operation.
   *
   * Both ends are confined independently: the source must already exist inside the root, the
   * destination must not exist and must resolve inside it too.
   */
  "fs:rename": {
    input: z.object({ from: RendererPath, to: RendererPath }),
    modes: BUILD_ONLY,
  },
  /**
   * Delete, to the OS trash.
   *
   * Not `fs.rm`. This is the one destructive action a user reaches for casually and sometimes
   * on the wrong row, and the trash is where they already know to look. If the OS refuses,
   * the handler fails rather than falling back to an unrecoverable delete.
   */
  "fs:delete": {
    input: z.object({ path: RendererPath }),
    modes: BUILD_ONLY,
  },
  "fs:openRecent": {
    input: z.object({ path: RendererPath }),
    modes: BUILD_ONLY,
  },
  "fs:save": {
    input: z.object({
      path: RendererPath,
      contents: z.string().max(8_000_000),
      baseline: z.string().max(8_000_000).nullable(),
    }),
    modes: BUILD_ONLY,
  },
  /**
   * What this window had open, so the next launch can put it back.
   *
   * A versioned document the renderer owns the shape of — main stores and returns it without
   * interpreting it, because the layout will churn and a schema that had to move with it
   * would be the tail wagging the dog. The window it belongs to comes from `ctx.sender`, never
   * from the payload: a window may only describe itself.
   *
   * PATHS ONLY. The renderer must not put buffer contents in here; see `db.ts`. Bounded so a
   * runaway layout cannot grow the database without limit.
   */
  "session:save": {
    input: z.object({ state: z.string().max(256_000) }),
    modes: BUILD_ONLY,
  },
  "session:load": {
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  /**
   * Project memory.
   *
   * `memory:index` is deliberately an explicit action with no automatic trigger. A folder
   * picker that quietly starts reading thousands of files and running a model over them is not
   * something anyone asked for, and on a large repository it looks like the app has hung.
   *
   * `scope` narrows it to a subdirectory — the primary affordance on a monorepo rather than a
   * fallback. It is a project-relative path and goes through the same confinement as every
   * other path the renderer names.
   */
  "memory:status": {
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  "memory:index": {
    input: z.object({ scope: RendererPath.optional() }),
    modes: BUILD_ONLY,
  },
  "memory:search": {
    input: z.object({
      query: z.string().min(1).max(2_000),
      limit: z.number().int().min(1).max(32).optional(),
    }),
    modes: BUILD_ONLY,
  },
  /**
   * One agentic turn, streamed over a transferred port.
   *
   * Replaces the earlier `agent:run`, which resolved once at the end. That shape forced chat
   * and the agent to be separate surfaces: one could stream prose and not call tools, the
   * other called tools and stayed silent until it finished. This carries tokens, tool steps and
   * proposals over a single port, so there is one conversation rather than two modes.
   *
   * Closing the port aborts the run — which is how Stop works, with no second channel and no
   * run-id bookkeeping. `agent:run` had no way to stop at all.
   *
   * NO SYSTEM PROMPT AND NO TOOL LIST, for the same reason `chat:open` has neither: both are
   * chosen in main from the surface. A renderer that could name the agent's tools would be
   * choosing its own privileges.
   *
   * `content` mirrors `chat:open`'s union, so a screenshot can be part of the question — the
   * whole point of unifying rather than bolting vision onto a second surface.
   */
  "agent:open": {
    input: z
      .object({
        provider: z.enum(["ollama", "llamacpp", "openrouter", "hosted"]),
        model: z.string().min(1).max(200),
        content: z.union([
          z.string().min(1).max(200_000),
          z
            .array(
              z.union([
                z.object({ type: z.literal("text"), text: z.string().max(200_000) }).strict(),
                z
                  .object({
                    type: z.literal("image"),
                    data: z.string().min(1).max(16_000_000),
                    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
                  })
                  .strict(),
              ])
            )
            .min(1)
            .max(16),
        ]),
        /**
         * The conversation this turn belongs to, so the run is attributable afterwards.
         *
         * Optional and nullable: a turn sent before a session exists is still a valid turn.
         * Main writes it to `agent_runs.session_id`; an id naming no session is rejected by
         * the foreign key rather than stored, which is the behaviour worth having.
         */
        sessionId: z.string().uuid().nullable().optional(),
        /**
         * The file on screen, as a path and its bytes — not as a sentence about it.
         *
         * The renderer used to wrap this in "Currently open file ..." and a fenced block and
         * send it as part of `content`. That is prompt text composed in a renderer, which
         * `personas.ts` says never happens, and it also decided something the renderer cannot
         * know: whether the model has a `read_file` to reach for. `agent/open-file.ts` makes
         * that call from the mode's own policy table, and records the measurements behind it.
         *
         * Bounded well under `content`'s own limit. A file larger than this is one the model
         * should be reading itself in pieces.
         */
        openFile: z
          .object({
            path: z.string().min(1).max(1_024),
            contents: z.string().max(200_000),
          })
          .strict()
          .optional(),
        /**
         * What the agent may do this turn.
         *
         * Accepting this from the renderer is safe for the same reason `surface` is, and only
         * while that reason holds: a mode can only ever NARROW what the surface permits --
         * `toolsFor` in `agent/modes.ts` intersects the two -- so naming one grants no
         * capability. There is no value here that hands the tutor a filesystem tool.
         *
         * **Which is exactly why the enum is built from `SELECTABLE_MODES` and not from
         * `AgentMode`.** `auto` breaks that reasoning: it writes to disk with no per-batch
         * dialog, so naming it *would* grant a capability, and its consent mechanism and its
         * undo are not built yet. It is defined in the policy table -- the table is the design
         * -- and it is not reachable from here. Adding it to that list is the switch that
         * turns it on, and it belongs in the change that also builds arming and the
         * checkpoint.
         */
        mode: z.enum(SELECTABLE_MODES).optional(),
      })
      .strict(),
    modes: BUILD_ONLY,
  },
  /**
   * Apply diffs the agent proposed, after a human says yes.
   *
   * The ids are the renderer's only input, and they are checked in main against what was
   * actually proposed, by this window, and not yet expired. A native dialog naming every file
   * is what authorises the write — see `agent/approve.ts` for why that dialog is the only
   * genuine second party available.
   */
  /**
   * Turn Auto mode on for this window and its open project.
   *
   * Takes no arguments, exactly like `fs:openProject` and for the same reason: the consent is
   * the window main shows, not the payload the renderer sends. A root named here would be a
   * renderer choosing what it was granted access to. Main reads the project from the sender.
   *
   * Returns whether the user said yes. There is no path through this that returns true
   * without a click on a window the renderer cannot reach.
   */
  /**
   * Undo the file changes an Auto run made.
   *
   * **Files, not side effects.** The checkpoint covers what the run wrote; it does not cover
   * what its commands did. `npm install`, a migration and a `git push` are all outside it, and
   * the result carries `truncated` so a partial undo can say so rather than implying more.
   */
  "agent:revertRun": {
    input: z.object({ runId: z.string().uuid() }),
    modes: BUILD_ONLY,
  },
  "agent:armAuto": {
    // `z.undefined()`, matching `fs:currentProject`. A no-argument channel is called with
    // no argument, and `z.object({})` rejects that rather than accepting it.
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  /** Always available and never asks. Turning a capability off needs no ceremony. */
  "agent:disarmAuto": {
    // `z.undefined()`, matching `fs:currentProject`. A no-argument channel is called with
    // no argument, and `z.object({})` rejects that rather than accepting it.
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  /** For the status line: is this window armed, and for what. */
  "agent:armStatus": {
    // `z.undefined()`, matching `fs:currentProject`. A no-argument channel is called with
    // no argument, and `z.object({})` rejects that rather than accepting it.
    input: z.undefined(),
    modes: BUILD_ONLY,
  },
  "agent:applyDiffs": {
    input: z
      .object({ ids: z.array(z.string().uuid()).min(1).max(32) })
      .strict(),
    modes: BUILD_ONLY,
  },
  /**
   * What the agent has done in this project.
   *
   * Scoped to the open project in main — the renderer names no root, so a window cannot read
   * back runs from a repository it does not currently have open.
   */
  "agent:history": {
    input: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
    modes: BUILD_ONLY,
  },
  "agent:steps": {
    input: z.object({ runId: z.string().uuid() }).strict(),
    modes: BUILD_ONLY,
  },

  /**
   * The live preview: four channels, and none of them takes a command.
   *
   * **`preview:start` has no `command` field, and that is the whole security design of this
   * feature.** A channel that accepted one would be arbitrary code execution reachable from a
   * renderer with no gate — `run_command` is bound in exactly one mode behind an explicit Auto
   * grant so that "the app runs what it is told to run" is a decision the user makes once and
   * can see, and this would route straight past it. Main reads the project's own `package.json`
   * and decides; see `preview/detect.ts`.
   *
   * No project root either, on the same rule every file-touching channel here follows: it comes
   * from the sender. A renderer that could name the folder to start a server in would be
   * choosing the scope of its own grant.
   *
   * `preview:detect` exists so the UI can SHOW what it is about to run before running it.
   * Starting a dev server executes the project's own code, which opening a folder did not
   * consent to — so the button says `pnpm run dev` rather than "Start".
   *
   * BUILD_ONLY throughout. A Study window has no project and nothing to preview.
   *
   * `z.undefined()` rather than `z.object({}).strict()`, which is the convention the other
   * argument-less channels here already follow — and not a stylistic choice. The preload's
   * generated method is `(arg?: unknown) => ipcRenderer.invoke(channel, arg)`, so calling
   * `host.preview.detect()` sends `undefined`; an empty-object schema rejects that with
   * "Invalid payload" before any handler runs. The unit tests never saw it because they call
   * `dispatch` directly with whatever payload they choose — it took driving the real app.
   */
  "preview:detect": { input: z.undefined(), modes: BUILD_ONLY },
  "preview:start": { input: z.undefined(), modes: BUILD_ONLY },
  "preview:stop": { input: z.undefined(), modes: BUILD_ONLY },
  "preview:state": { input: z.undefined(), modes: BUILD_ONLY },
  /**
   * Where to draw it, measured by the renderer from its own pane.
   *
   * A rectangle is not a capability, so taking it from the renderer is fine — and it has to
   * come from there, because only the renderer knows where its pane ended up after a sash drag.
   * `preview/view.ts` clamps it to the window anyway: the one thing a wrong rectangle could do
   * is cover the app's chrome with content from the project.
   *
   * Bounded so a number that is not a rectangle cannot reach the platform layer, where a NaN or
   * an Infinity is a crash rather than a misdraw.
   */
  "preview:show": {
    input: z
      .object({
        x: z.number().finite().min(-10_000).max(100_000),
        y: z.number().finite().min(-10_000).max(100_000),
        width: z.number().finite().min(0).max(100_000),
        height: z.number().finite().min(0).max(100_000),
      })
      .strict(),
    modes: BUILD_ONLY,
  },
  "preview:hide": { input: z.undefined(), modes: BUILD_ONLY },

  /**
   * The project's own design tokens, read from its CSS.
   *
   * No path from the renderer: main finds the stylesheets under the open project itself, on the
   * rule every file-touching channel here follows. A channel taking a path would be a general
   * "read me any file and parse it" with a narrow name on it.
   *
   * Reading only. `design/tokens.ts` records why a JavaScript Tailwind config is deliberately
   * not executed to get at the same values.
   */
  "design:tokens": { input: z.undefined(), modes: BUILD_ONLY },
  /**
   * Find where a screenshot's contents live in the project.
   *
   * One image, not an array. The cross-reference searches the project once per extracted
   * string, so a call carrying four screenshots is four times the work and produces a merged
   * ranking across unrelated pictures — which is not a question anyone is asking. One image is
   * the honest unit.
   *
   * NO PROMPT FIELD. The renderer supplies the picture; the question asked about it is fixed in
   * `vision/describe.ts`, on the same argument that keeps `system` out of `chat:open` — a
   * channel that took a prompt here would be a general-purpose "ask the vision model anything
   * about my screen" with a narrow name on it.
   */
  "vision:locate": {
    input: z
      .object({
        provider: z.enum(["ollama", "llamacpp", "openrouter", "hosted"]),
        model: z.string().min(1).max(200),
        image: z
          .object({
            // Same bound as `chat:open`'s block — ~12 MB of base64.
            data: z.string().min(1).max(16_000_000),
            mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          })
          .strict(),
      })
      .strict(),
    modes: BUILD_ONLY,
  },
  /**
   * Save As.
   *
   * TAKES NO PATH, exactly like `fs:openProject`. The native dialog is the authorisation; a
   * channel that accepted a destination from the renderer would be an arbitrary file write
   * with a friendly name on it.
   *
   * `suggestedName` is a filename only — it seeds the dialog's default and is not a path.
   */
  "fs:saveAs": {
    input: z.object({
      contents: z.string().max(8_000_000),
      suggestedName: z.string().min(1).max(255),
    }),
    modes: BUILD_ONLY,
  },
  /**
   * Ask the user what to do about an unsaved buffer, natively.
   *
   * Native rather than a React modal because this is a "you are about to lose work" prompt.
   * It cannot be styled into invisibility, cannot be missed, and still works if the renderer
   * is mid-crash — which is exactly when it matters most.
   */
  "fs:confirmDiscard": {
    input: z.object({ path: RendererPath }),
    modes: BUILD_ONLY,
  },
  /**
   * The renderer saying it has finished dealing with unsaved work and the window may close.
   *
   * Both modes: a Study window has nothing to save today, but the close handshake is a window
   * concern rather than a Build one, and gating it would make the Study window's close path
   * depend on a channel it cannot call.
   */
  "window:allowClose": {
    input: z.undefined(),
    modes: BOTH,
  },
  /**
   * The window controls the renderer now draws.
   *
   * `BOTH`, because every window in the app is frameless — a Study window has no OS title bar
   * either, so denying it these would leave it with no way to be minimised or closed.
   *
   * None of them take an argument. A window may only ever act on *itself*: the target is
   * derived from `ctx.sender` in main, exactly as the project root and the window mode are. A
   * channel that accepted a window id would let any renderer close any window, which is a
   * privilege nothing here needs.
   */
  "window:minimize": {
    input: z.undefined(),
    modes: BOTH,
  },
  /**
   * Maximise, or restore if already maximised.
   *
   * One channel rather than two, because the renderer must never be the thing that decides
   * which is correct — the OS can maximise a window behind our back (Win+Up, a snap, a
   * double-click on the drag region) and a renderer acting on a stale belief would restore a
   * window the user just maximised.
   */
  "window:toggleMaximize": {
    input: z.undefined(),
    modes: BOTH,
  },
  /**
   * Close, through the same path as the OS button.
   *
   * `close()`, never `destroy()` — the unsaved-work handshake lives on `before-quit`/`close`
   * and a destroyed window skips it, which is how a custom close button silently discards
   * work the native one would have prompted about.
   */
  "window:close": {
    input: z.undefined(),
    modes: BOTH,
  },
  "pty:spawn": {
    input: z.object({
      cols: z.number().int().min(1).max(2000),
      rows: z.number().int().min(1).max(2000),
    }),
    modes: BUILD_ONLY,
  },
} as const satisfies Record<string, ChannelSpec>;

export interface ChannelSpec {
  input: z.ZodTypeAny;
  modes: readonly WindowMode[];
}

export type ChannelName = keyof typeof CHANNELS;
export type ChannelInput<C extends ChannelName> = z.infer<(typeof CHANNELS)[C]["input"]>;

export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];

/** Which channels a given mode may call. The preload uses this to decide what to expose. */
export function channelsForMode(mode: WindowMode): ChannelName[] {
  return CHANNEL_NAMES.filter((name) =>
    (CHANNELS[name].modes as readonly string[]).includes(mode)
  );
}

/**
 * ── ONE MODE GATE, TWO CALLERS ────────────────────────────────────────────────
 *
 * These two functions are the whole gate, and they exist as functions because
 * this file used to hold a **second implementation of it that nothing called**.
 * `isChannelAllowedInMode` below did exactly what `broker.ts`'s gates 1 and 2 do,
 * inline, and had precisely one reference in the repository: its own definition.
 *
 * The hazard was not that the dead copy was wrong — it was correct. It was that
 * it looked authoritative. It was exported, it was named as the canonical
 * predicate, and its comment referred to "the broker's gate 1" as though the two
 * were coordinated, so anyone wiring the preload or a new surface to it would
 * have been relying on a copy no test had ever executed, and any later change to
 * the real gate would have silently left it behind.
 *
 * Deleting it was the wrong fix: that leaves the live gate inlined in `dispatch`
 * and reachable only through a full request, so there would still be no named
 * thing to reason about. Extracting the two primitives instead means there is one
 * implementation, the broker runs it on every IPC call, and `mode-gate.test.ts`
 * covers it by construction. Breaking either function now fails that suite —
 * before this change, breaking the predicate failed nothing at all.
 *
 * They stay separate because the broker must tell three failures apart:
 * `E_UNKNOWN_CHANNEL` is our caller's bug, `E_NO_MODE` is a request with no
 * provenance, and `E_MODE_DENIED` is a privilege denial. A single boolean cannot
 * carry that distinction, and collapsing them would make the smoke test's
 * assertion on `E_MODE_DENIED` unwritable.
 */

/**
 * Look a channel up without touching the prototype chain.
 *
 * `Object.hasOwn`, not property access, and not `=== undefined`. The name is
 * attacker-controlled: `CHANNELS["__proto__"]` evaluates to `Object.prototype`
 * and `CHANNELS["toString"]` to a function, so a plain lookup lets inherited keys
 * past the "is this a channel" question and then throws a TypeError deeper in —
 * a crash where a denial belongs.
 */
export function channelSpec(name: string): ChannelSpec | undefined {
  if (!Object.hasOwn(CHANNELS, name)) return undefined;
  return (CHANNELS as Record<string, ChannelSpec>)[name];
}

/** Whether a channel's declared modes admit this one. */
export function specAllowsMode(spec: ChannelSpec, mode: WindowMode): boolean {
  return (spec.modes as readonly string[]).includes(mode);
}

/**
 * The gate as a single predicate, for callers that only need yes or no.
 *
 * Now defined in terms of the primitives above rather than repeating them, so it
 * cannot drift from what the broker enforces.
 */
export function isChannelAllowedInMode(name: string, mode: WindowMode): boolean {
  const spec = channelSpec(name);
  return spec !== undefined && specAllowsMode(spec, mode);
}
