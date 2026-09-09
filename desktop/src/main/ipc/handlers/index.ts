/**
 * Handler registration.
 *
 * Registering a handler for a channel that is not in the contract throws at startup,
 * so this file cannot drift ahead of the privilege table. Channels declared in the
 * contract but not yet implemented are deliberately left unregistered: the broker
 * answers those with `E_HANDLER_FAILED / has no handler`, which is an honest
 * "declared, not built" rather than a stub returning fabricated data.
 *
 * Implemented so far: Phase 1's `mode:get` and `fs:read`, and Phase 2's execution.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, MessageChannelMain, dialog } from "electron";
import { write, logError } from "../../log.js";
import { setHandler, IpcError } from "../broker.js";
import { popupMenu, setMenuState } from "../../menu.js";
import {
  readWorkspaceFile,
  openProjectViaDialog,
  openRecentProject,
  currentProjectRoot,
  NoWorkspaceError,
} from "../../workspace.js";
import { lintFile } from "../../lint/index.js";
import { searchInFiles, NoProjectError } from "../../build/search.js";
import { readProjectTree } from "../../build/tree.js";
import {
  createEntry,
  renameEntry,
  deleteEntry,
  EntryExistsError,
  RootProtectedError,
  TrashUnavailableError,
} from "../../build/fsops.js";
import { startWatching, stopWatching, noteOwnWrite } from "../../build/watcher.js";
import { proposeWrite, commitDiff, commitAgentDiffs, AgentDiffError } from "../../build/diffs.js";
import { saveWorkspaceFile, saveWorkspaceFileAs, SaveConflictError } from "../../build/save.js";
import {
  spawnTerminal,
  forgetTerminal,
  killTerminalsFor,
  TerminalUnavailableError,
} from "../../terminal/pty.js";
import { allowClose, sessionIdFor } from "../../windows.js";
import { saveWorkspaceState, loadWorkspaceState } from "../../store/session.js";
import { beginAttempt, endAttempt, cancelAttempt } from "../../exec/attempts.js";
import { gradeSubmission } from "../../exec/grader.js";
import { getProblem, listProblems } from "../../content/problems.js";
import { buildDashboard } from "../../content/dashboard.js";
import { buildProblemDetail } from "../../content/detail.js";
import { scanHardware } from "../../hardware/scan.js";
import { CATALOGUE, findModel } from "../../hardware/catalogue.js";
import { recommend } from "../../hardware/fit.js";
import {
  availableProviders,
  providerById,
  openChatStream,
  destinationFor,
} from "../../inference/registry.js";
import {
  setSecret,
  hasSecret,
  clearSecret,
  EncryptionUnavailableError,
} from "../../inference/vault.js";
import { systemPromptForSurface, surfaceForMode } from "../../inference/personas.js";
import { groundingFor } from "../../content/grounding.js";
import { assertImagesMatch, ImageMismatchError } from "../../inference/images.js";
import { UnsupportedCapabilityError } from "../../inference/types.js";
import { countImages, confirmImageUpload } from "../../inference/consent.js";
import { locateScreenshot } from "../../vision/locate.js";
import { openAgentStream, questionText } from "../../agent/stream.js";
import { DEFAULT_MODE } from "../../agent/modes.js";
import { armAuto, armedState, disarmAuto } from "../../agent/arming.js";
import { revertRun } from "../../agent/checkpoint.js";
import { pickAgentModel } from "../../agent/models.js";
import { confirmAgentWrite } from "../../agent/approve.js";
import { recentRuns, stepsFor, planForRun, designForRun } from "../../store/agent.js";
import { detectPreviewCommand, type PreviewCommand } from "../../preview/detect.js";
import { withOpenFile } from "../../agent/open-file.js";
import { readTextFile } from "../../build/text-file.js";
import { startPreview, stopPreview, previewState } from "../../preview/server.js";
import { showPreview, hidePreview, destroyPreview } from "../../preview/view.js";
import { parseCssTokens, type DesignToken } from "../../design/tokens.js";
import {
  buildIndex,
  memoryStatus,
  searchMemory,
  forgetFile,
  MemoryConsentDeclined,
} from "../../memory/index.js";
import { EmbeddingsUnavailableError } from "../../memory/embed.js";
import {
  createSession as createChatSession,
  getSession as getChatSession,
  listSessions as listChatSessions,
  messagesFor,
  appendMessage as appendChatMessage,
  deleteSession as deleteChatSession,
  searchSessions as searchChatSessions,
} from "../../store/chat.js";
import {
  recordSubmission,
  recentSubmissions,
  saveDraft,
  loadDraft,
  allProgress,
} from "../../store/submissions.js";
import {
  QUESTIONS,
  getQuestion,
  toSummary,
  toDetail,
  facets,
  progress as interviewProgress,
  UnknownQuestionError,
} from "../../content/interviews.js";
import {
  assessAnswer as assessInterviewAnswer,
  TutorUnavailableError,
} from "../../content/interview-assess.js";
import {
  buildInterviewWorkspace,
  hasInterviewWorkspace,
  problemIdForQuestion,
  NoWorkspaceForQuestionError,
} from "../../content/interview-detail.js";
import {
  getProfile,
  updateProfile,
  ageFrom,
  InvalidBirthDateError,
} from "../../store/profile.js";
import {
  createNotification,
  listNotifications,
  unreadCount,
  markRead as markNotificationsRead,
} from "../../store/notifications.js";
import {
  allAttempts,
  getAttempt,
  saveAttempt as saveInterviewAttempt,
  recordAssessment,
  markRevealed,
  markSubmitted as markInterviewSubmitted,
} from "../../store/interviews.js";

/**
 * The profile, as the API shaped it.
 *
 * Snake_case because `parseProfile` reads `birth_date` and `profile_photo_url`; the transport
 * swap is meant to be invisible to the UI.
 *
 * `email` is null — there is no account server an address could have been registered with. It
 * stays in the payload because the renderer's type declares it nullable and `TopNavigation`
 * renders it when present; null is the honest value for something a local install cannot know,
 * and it is different from the empty string a user typed.
 *
 * `role` was here too, synthesised as `"learner"` to satisfy a field the renderer's type declared.
 * No column has ever held a role, no server grants one, and nothing in the renderer read it — a
 * value invented at the boundary to answer a question the renderer should not have been asking,
 * which `types/host.d.ts` already states as a rule. Both ends are gone, and
 * `tests/profile.test.ts` holds them that way.
 *
 * `age` is derived from `birth_date` on every read rather than stored, so it cannot be wrong
 * on the user's next birthday.
 */
function toProfilePayload(): Record<string, unknown> {
  const profile = getProfile();
  const solved = allProgress().filter((p) => p.solved).length;

  return {
    id: "local-user",
    // "You" only until they say otherwise. A stored empty name is still no name.
    name: profile.name ?? "You",
    email: null,
    bio: profile.bio,
    birth_date: profile.birthDate,
    age: ageFrom(profile.birthDate),
    country: profile.country,
    occupation: profile.occupation,
    timezone: profile.timezone,
    profile_photo_url: profile.profilePhotoUrl,
    problems_solved: solved,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

/**
 * Turn the interview domain errors into ones that survive the boundary.
 *
 * The broker replaces any ordinary handler error with `${channel} failed`, so a seam route
 * that branches on the text of an `Error` is branching on a string it will never see. That
 * is not hypothetical: the 404 for an unknown interview slug was written that way and was
 * dead from the moment it shipped. `IpcError` is rethrown untouched, so this is the channel.
 */
function interviewError(err: unknown): never {
  if (err instanceof UnknownQuestionError) {
    throw new IpcError("E_NOT_FOUND", "Question not found");
  }
  if (err instanceof NoWorkspaceForQuestionError) {
    throw new IpcError("E_NOT_FOUND", "Question has no executable form");
  }
  if (err instanceof TutorUnavailableError) {
    // Carries "Your answer is saved", which is the difference between a recoverable pause
    // and apparent lost work.
    throw new IpcError("E_UNAVAILABLE", err.message);
  }
  throw err;
}

/**
 * Turn a filesystem-operation error into one whose message survives the broker.
 *
 * Same reasoning as `interviewError`: every ordinary error becomes `${channel} failed`, and
 * "already exists" versus "outside the project" versus "the trash refused it" are three
 * different things the user has to be told apart to act on. Anything unrecognised is rethrown
 * and stays anonymous, which is the right default for an unexpected failure.
 */
async function fsOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EntryExistsError) throw new IpcError("E_BAD_INPUT", err.message);
    if (err instanceof RootProtectedError) throw new IpcError("E_BAD_INPUT", err.message);
    if (err instanceof TrashUnavailableError) throw new IpcError("E_UNAVAILABLE", err.message);
    if (err instanceof NoWorkspaceError) {
      throw new IpcError("E_UNAVAILABLE", "No project is open");
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IpcError("E_NOT_FOUND", "That file is no longer there");
    }
    throw err;
  }
}

/**
 * Everything that happens when a project becomes the window's project.
 *
 * Shared by the dialog and Open Recent paths so the watcher cannot be wired to one and not the
 * other — which is the shape of bug that leaves external changes detected in some sessions and
 * not others, depending on how the folder was opened.
 *
 * A failed watch is reported, never thrown: the editor is perfectly usable without one, but
 * "nothing has changed" and "I can no longer tell" must not look the same.
 */
async function openedProject(
  sender: Electron.WebContents,
  root: string
): Promise<{ tree: Awaited<ReturnType<typeof readProjectTree>>; watching: boolean; watchReason: string | null }> {
  const tree = await readProjectTree(root);

  // A tree that hit its own bound means the project is big enough that recursive watching is
  // a poor bet too — on Linux it would burn one inotify watch per directory and likely fail
  // anyway. Declining up front, with a reason, beats failing obscurely later.
  if (tree.truncated) {
    stopWatching(sender);
    return {
      tree,
      watching: false,
      watchReason: "the project is too large to watch; use the refresh button after external changes",
    };
  }

  const status = startWatching(sender, root, (batch) => {
    if (!sender.isDestroyed()) sender.send("fs:changed", batch);
  });

  return { tree, watching: status.watching, watchReason: status.reason };
}

export function registerHandlers(): void {
  /**
   * Write a renderer error to the log, attributed to the renderer.
   *
   * `source: "renderer"` rather than `"main"` matters more than it looks: the two processes
   * fail for different reasons and are fixed in different files, and a log that blurs them
   * sends whoever reads it to the wrong half of the codebase.
   *
   * The window's mode goes in the context because the same route renders differently in
   * study and build, and "only reproduces in Build Mode" is otherwise a fact nobody records.
   */
  setHandler("log:write", async (input, ctx) => {
    write({
      level: input.level,
      source: "renderer",
      message: input.message,
      stack: input.stack,
      context: { ...(input.context ?? {}), windowMode: ctx.mode },
    });
    return { ok: true };
  });

  setHandler("mode:get", async (_input, ctx) => {
    // The authoritative answer. `host.windowMode` in the renderer is a convenience
    // copy from argv; this comes from the registry the broker itself gates on.
    return { mode: ctx.mode };
  });

  setHandler("lint:run", async (input, ctx) => {
    // Same door as `fs:read`: this throws if the path escapes the project, before any process is
    // started. `lintFile` does no confinement of its own and says so.
    const absolute = await readWorkspaceFile(ctx.sender, input.path);
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new NoWorkspaceError();
    return await lintFile(root, absolute);
  });

  setHandler("fs:read", async (input, ctx) => {
    // Build-only, enforced by the contract rather than by a check here. If this
    // handler is running, gate 2 has already established the caller is a Build window.
    const absolute = await readWorkspaceFile(ctx.sender, input.path);
    /**
     * `binary` is reported, not thrown.
     *
     * Clicking a PNG in the file tree is an ordinary thing to do, not an error — the tree lists
     * every file, so the only way to find out is to open one. An error dialog for a normal act
     * is worse than a pane that says what the file is. `contents` is empty rather than mojibake,
     * which is the whole point: `fs.readFile(_, "utf8")` never fails and returns replacement
     * characters that every layer above treats as the file.
     */
    const file = await readTextFile(absolute);
    return file.kind === "binary"
      ? { path: absolute, contents: "", binary: true as const, bytes: file.bytes }
      : { path: absolute, contents: file.contents, binary: false as const };
  });

  /**
   * The native dialog is the authorisation, which is why this takes no argument. There is
   * deliberately no channel that accepts a root path from the renderer: that would let a
   * compromised renderer — or a model acting on instructions injected into a file it read —
   * widen its own sandbox to `/` without the user ever seeing a prompt.
   */
  setHandler("fs:openProject", async (_input, ctx) => {
    const root = await openProjectViaDialog(ctx.sender);
    if (root === undefined) return { opened: false as const };
    return { opened: true as const, ...(await openedProject(ctx.sender, root)) };
  });

  /**
   * Computes a diff and stores it. Writes nothing — `fs:commitDiff` is the only path to
   * disk. This is what makes an unrestricted assistant safe to point at a real repo: it
   * cannot produce a file change in a single step, so every edit is reviewable before it
   * lands.
   */
  setHandler("fs:writeWithDiff", async (input, ctx) =>
    proposeWrite(ctx.sender, input.path, input.next)
  );

  setHandler("fs:commitDiff", async (input, ctx) => {
    try {
      const result = await commitDiff(ctx.sender, input.diffId);
      noteOwnWrite(ctx.sender, result.path);
      return result;
    } catch (err) {
      /**
       * An agent's diff arriving here is the attack this phase closes, so it gets a message
       * that names the real rule.
       *
       * Without the translation it would reach the renderer as `fs:commitDiff failed`, which
       * is indistinguishable from an expired id — and a control whose refusal looks like a
       * transient error is one that gets "fixed" by retrying.
       */
      if (err instanceof AgentDiffError) throw new IpcError("E_WRONG_ROUTE", err.message);
      throw err;
    }
  });

  /**
   * The user's own edit, written directly. See the contract entry for why this coexists with
   * the diff gate rather than undermining it.
   */
  setHandler("fs:search", async (input, ctx) => {
    try {
      return await searchInFiles(ctx.sender, input.query, {
        ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {}),
      });
    } catch (err) {
      if (err instanceof NoProjectError) {
        throw new IpcError("E_UNAVAILABLE", "Open a project before searching");
      }
      throw err;
    }
  });

  setHandler("fs:openRecent", async (input, ctx) => {
    const root = openRecentProject(ctx.sender, input.path);
    if (root === undefined) {
      // Either the renderer invented a path, or the folder was forgotten. Both are "not
      // one of yours" from here, and neither should read as a crash.
      throw new IpcError("E_NOT_FOUND", "That project is no longer in your recent list");
    }
    return { opened: true as const, ...(await openedProject(ctx.sender, root)) };
  });

  setHandler("fs:currentProject", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) return { opened: false as const };
    // Through `openedProject`, so a restored window starts its watcher exactly as an
    // explicitly opened one does — otherwise external changes would go undetected for the
    // whole session, and only in restored windows.
    return { opened: true as const, ...(await openedProject(ctx.sender, root)) };
  });

  setHandler("fs:tree", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    return { tree: await readProjectTree(root) };
  });

  /**
   * Create, rename and delete.
   *
   * Each notes its own result with the watcher before returning, so the event the write
   * itself produces does not come back to the renderer as external news — otherwise creating
   * a file would immediately look like someone else created it.
   */
  setHandler("fs:create", async (input, ctx) => {
    const result = await fsOperation(() => createEntry(ctx.sender, input.path, input.kind));
    noteOwnWrite(ctx.sender, result.path);
    return result;
  });

  setHandler("fs:rename", async (input, ctx) => {
    const result = await fsOperation(() => renameEntry(ctx.sender, input.from, input.to));
    noteOwnWrite(ctx.sender, input.from);
    noteOwnWrite(ctx.sender, result.path);
    return result;
  });

  setHandler("fs:delete", async (input, ctx) => {
    const result = await fsOperation(() => deleteEntry(ctx.sender, input.path));
    noteOwnWrite(ctx.sender, result.path);

    /**
     * Prune the memory index, and never let that failure reach the user.
     *
     * The delete has already happened — through the OS trash — by the time this runs. Rejecting
     * here would report a *successful* destructive action as failed, which is the one direction
     * this must not get wrong: the user would look in the file tree, see the file gone, and be told
     * it did not work. Logged instead, and the index self-corrects on the next build regardless.
     *
     * Files only, deliberately: `forgetFile` takes one path and the index has no tree, so a
     * directory's descendants fall back to the staleness flag. See its own comment.
     */
    if (result.kind === "file") {
      const root = currentProjectRoot(ctx.sender);
      if (root !== undefined) {
        try {
          await forgetFile(root, result.path);
        } catch (err) {
          logError("main", err, { hint: "forgetFile after fs:delete", path: result.path });
        }
      }
    }

    return result;
  });

  setHandler("fs:save", async (input, ctx) => {
    try {
      const result = await saveWorkspaceFile(ctx.sender, input.path, input.contents, input.baseline);
      noteOwnWrite(ctx.sender, result.path);
      return result;
    } catch (err) {
      if (err instanceof SaveConflictError) {
        // `IpcError`, because the broker replaces every ordinary error message with
        // `${channel} failed` — and "the file changed under you" is the one sentence the
        // user actually needs to read here.
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }
  });

  /**
   * The window's own arrangement, stored opaquely.
   *
   * A string rather than a parsed object on the wire: main has no business validating a shape
   * the renderer owns, and re-serialising it here would be two chances to change it.
   */
  setHandler("session:save", async (input, ctx) => {
    const sessionId = sessionIdFor(ctx.sender);
    if (sessionId === undefined) return { saved: false as const };
    // Parsed once so a malformed document is rejected at the boundary rather than stored and
    // thrown away at restore time, when the user is watching.
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.state);
    } catch {
      throw new IpcError("E_BAD_INPUT", "Workspace state is not valid JSON");
    }
    saveWorkspaceState(sessionId, parsed);
    return { saved: true as const };
  });

  setHandler("session:load", async (_input, ctx) => {
    const sessionId = sessionIdFor(ctx.sender);
    if (sessionId === undefined) return { state: null };
    const state = loadWorkspaceState(sessionId);
    return { state: state === undefined ? null : JSON.stringify(state) };
  });

  setHandler("memory:status", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    return memoryStatus(root);
  });

  setHandler("memory:index", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");

    // A scope is a path from the renderer, so it goes through the same confinement as every
    // other one — indexing a directory outside the project would read files the user never
    // granted.
    const scope =
      input.scope === undefined ? undefined : await readWorkspaceFile(ctx.sender, input.scope);

    try {
      return await buildIndex({
        sender: ctx.sender,
        projectRoot: root,
        ...(scope !== undefined ? { scope } : {}),
        // Progress is a push, not a return value: indexing takes minutes on a real project and
        // a promise that resolves at the end tells the user nothing while they wait.
        onProgress: (progress) => {
          if (!ctx.sender.isDestroyed()) ctx.sender.send("memory:progress", progress);
        },
      });
    } catch (err) {
      if (err instanceof MemoryConsentDeclined) {
        throw new IpcError("E_BAD_INPUT", "Indexing was declined for this project");
      }
      if (err instanceof EmbeddingsUnavailableError) {
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }
  });

  setHandler("memory:search", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    try {
      return { hits: await searchMemory(root, input.query, input.limit) };
    } catch (err) {
      if (err instanceof EmbeddingsUnavailableError) {
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }
  });

  /**
   * One agentic turn, over a transferred port.
   *
   * The same two image gates `chat:open` applies, for the same reasons and in the same order —
   * this is a second path from a renderer-supplied image to a model, and a control enforced on
   * one of two paths is not enforced.
   */
  setHandler("agent:open", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");

    try {
      assertImagesMatch(input.content);
    } catch (err) {
      if (err instanceof ImageMismatchError) throw new IpcError("E_BAD_INPUT", err.message);
      throw err;
    }

    const provider = providerById(input.provider);
    const images = countImages([{ role: "user", content: input.content }]);
    if (images > 0 && provider?.capabilities.remote === true) {
      const agreed = await confirmImageUpload({
        sender: ctx.sender,
        destination: destinationFor(input.provider),
        imageCount: images,
        modelLabel: provider.label,
      });
      if (!agreed) throw new IpcError("E_BAD_INPUT", "Sending images was cancelled");
    }

    /**
     * The surface is main's decision, not the renderer's.
     *
     * `surfaceForMode` pins a Study window to the tutor — which gets no tools at all — and the
     * channel is Build-only anyway. Both together mean there is no request shape that reaches
     * the agent with a tool set the window was not entitled to.
     */
    const surface = surfaceForMode(ctx.mode) ?? "assistant";

    /**
     * The model is resolved here, not taken as given.
     *
     * A renderer naming a model that cannot call tools is not a request to fail silently — and
     * that is exactly what the panel's hardcoded default did. Same shape as any resolver picking
     * its own model rather than trusting a preference that may not be installed.
     */
    const provider2 = providerById(input.provider);
    const installed = provider2 === undefined ? [] : (await provider2.listModels()).map((m) => m.id);
    const choice = pickAgentModel(installed, input.model);
    if (choice === undefined) {
      throw new IpcError(
        "E_UNAVAILABLE",
        "No model is installed. Pull one — llama3.1:8b works well for this — and try again."
      );
    }

    /**
     * The open file joins the turn here, in the form this mode can actually use.
     *
     * Before `questionText`, so the transcript records what was sent — and after the image
     * checks above, which are about `input.content` as the renderer sent it.
     */
    const agentMode = input.mode ?? DEFAULT_MODE;
    const content = withOpenFile(input.content, input.openFile, agentMode);

    let stream;
    try {
      stream = openAgentStream(ctx.sender, {
        projectRoot: root,
        surface,
        providerId: input.provider,
        model: choice.model,
        unverifiedModel: choice.unverified,
        question: content,
        questionText: questionText(content),
        sessionId: input.sessionId ?? null,
        // `input.mode` is the AGENT mode; `ctx.mode` one scope away is the WINDOW mode. The
        // schema only admits the selectable ones, so this cannot be `auto`.
        agentMode,
      });
    } catch (err) {
      if (err instanceof UnsupportedCapabilityError) {
        // llama.cpp reports `tools: false`, so this is the honest answer rather than a run
        // that quietly never calls anything.
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }

    ctx.sender.postMessage("agent:open:port", null, [stream.port]);
    return { streaming: true };
  });

  setHandler("agent:history", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    return await Promise.resolve({ runs: recentRuns(root, input.limit) });
  });

  setHandler("agent:steps", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    // The root is passed to the query, not merely checked here — a run belonging to another
    // project returns nothing rather than being filtered afterwards.
    // The plan comes back with the steps, and unlike a diff it is still real: diffs expire in
    // memory after an hour, so a past run renders them as a record — a plan is a durable
    // document, and a restored run that dropped it would look like a run that never planned.
    return await Promise.resolve({
      steps: stepsFor(root, input.runId),
      plan: planForRun(root, input.runId),
      design: designForRun(root, input.runId),
    });
  });

  /**
   * The live preview.
   *
   * The project root comes from the sender on all four, and the command from the project's own
   * `package.json` — never from the payload. `ipc/contract.ts` records why a `command` field
   * here would be arbitrary code execution reachable from a renderer with no gate.
   */
  setHandler("preview:detect", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    const command = await detectFor(root);
    // Null is an answer, not a failure: plenty of projects have no dev server, and the pane
    // says so rather than offering a button that cannot work.
    return command === null ? { command: null } : { command: { label: command.label, script: command.script } };
  });

  setHandler("preview:start", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");

    const command = await detectFor(root);
    if (command === null) {
      throw new IpcError("E_UNAVAILABLE", "This project has no dev, start or serve script.");
    }

    const { sender } = ctx;
    return startPreview(root, command, (state) => {
      // The window may be gone by the time a dev server finishes starting — ninety seconds is
      // long enough for someone to close it — and sending to destroyed contents throws.
      if (!sender.isDestroyed()) sender.send("preview:changed", state);
    });
  });

  setHandler("preview:stop", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    stopPreview(root);
    // The view goes with the server. Leaving it up would show a page that is no longer being
    // served — which looks like a working preview until the first navigation.
    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (window !== null) destroyPreview(window);
    return await Promise.resolve(previewState(root));
  });

  /**
   * Put the view on screen at the pane's rectangle, or take it off.
   *
   * `show` is called on every layout change as well as on first display — a sash drag moves the
   * pane, and the view is a native surface that does not reflow with the DOM. `showPreview`
   * reuses the existing contents for the same origin, so this is a move rather than a reload.
   */
  setHandler("preview:show", async (input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    const { url } = previewState(root);
    // Nothing to show until the server has answered on its address. Not an error: the renderer
    // calls this whenever the tab is open, and "not ready yet" is most of that time.
    if (url === null) return await Promise.resolve({ shown: false });

    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (window === null) return await Promise.resolve({ shown: false });
    showPreview(window, url, input);
    return await Promise.resolve({ shown: true });
  });

  setHandler("design:tokens", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    return { tokens: await readProjectTokens(root) };
  });

  setHandler("preview:hide", async (_input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    // Kept alive, not destroyed — see `hidePreview`. A tab switch must not reload the page.
    if (window !== null) hidePreview(window);
    return await Promise.resolve({});
  });

  setHandler("preview:state", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) throw new IpcError("E_UNAVAILABLE", "No project is open");
    return await Promise.resolve(previewState(root));
  });

  /**
   * Arming, disarming, and reporting.
   *
   * The project root comes from the sender, never from the payload — the same rule every
   * file-touching channel here follows. A renderer that could name the folder it was being
   * armed for would be choosing the scope of its own grant.
   */
  setHandler("agent:revertRun", async (input) => {
    // No sender check on the run id: `agent:history` already scopes what a window can see to
    // its own project, and the checkpoint stores the root it was captured against — so a
    // revert writes where the run wrote, not where the asking window happens to be pointed.
    return await revertRun(input.runId);
  });

  setHandler("agent:armAuto", async (_input, ctx) => {
    const root = currentProjectRoot(ctx.sender);
    if (root === undefined) {
      throw new IpcError("E_UNAVAILABLE", "Open a project before turning on Auto mode");
    }
    return { armed: await armAuto(ctx.sender, root), root };
  });

  setHandler("agent:disarmAuto", async (_input, ctx) => {
    disarmAuto(ctx.sender);
    return { armed: false };
  });

  setHandler("agent:armStatus", async (_input, ctx) => {
    const state = armedState(ctx.sender);
    const root = currentProjectRoot(ctx.sender) ?? null;
    // Armed *and still for this project*. A window armed for one folder and then pointed at
    // another is not armed, and the status has to say so or the UI will claim otherwise.
    return { armed: state !== null && state.root === root, root: state?.root ?? null };
  });

  setHandler("agent:applyDiffs", async (input, ctx) => {
    // `confirmAgentWrite` is passed in rather than reached for inside `diffs.ts`, so the module
    // that writes files has no dialog code in it and stays unit-testable.
    return await commitAgentDiffs(ctx.sender, input.ids, {
      approve: (batch) => confirmAgentWrite({ sender: ctx.sender, batch }),
    });
    // No `armed` here, deliberately. This channel is the *review* path: the user pressed a
    // button asking to see the batch, so they get the dialog whether or not Auto is armed.
    // Arming skips the dialog on the path Auto writes through, not on the one a human chose.
  });

  /**
   * Where does this screenshot live in my code?
   *
   * The two gates `chat:open` applies to images apply here too, and for exactly the same
   * reasons — this is a second path from a renderer-supplied image to a model, and a control
   * enforced on one of two paths is not enforced.
   */
  setHandler("vision:locate", async (input, ctx) => {
    const image = { type: "image" as const, data: input.image.data, mediaType: input.image.mediaType };

    try {
      assertImagesMatch([image]);
    } catch (err) {
      if (err instanceof ImageMismatchError) throw new IpcError("E_BAD_INPUT", err.message);
      throw err;
    }

    const provider = providerById(input.provider);
    if (provider?.capabilities.remote === true) {
      const agreed = await confirmImageUpload({
        sender: ctx.sender,
        destination: destinationFor(input.provider),
        imageCount: 1,
        modelLabel: provider.label,
      });
      if (!agreed) throw new IpcError("E_BAD_INPUT", "Sending images was cancelled");
    }

    try {
      return await locateScreenshot(ctx.sender, {
        providerId: input.provider,
        model: input.model,
        image: { data: input.image.data, mediaType: input.image.mediaType },
      });
    } catch (err) {
      // Both become `E_UNAVAILABLE` with their own message, because "no project is open" and
      // "this provider cannot do vision" are things the user can act on — and an ordinary
      // error would reach the renderer as the useless `vision:locate failed`.
      if (err instanceof UnsupportedCapabilityError || err instanceof NoProjectError) {
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }
  });

  setHandler("fs:saveAs", async (input, ctx) => {
    const result = await saveWorkspaceFileAs(ctx.sender, input.contents, input.suggestedName);
    if (result === undefined) return { saved: false as const };
    // Only worth suppressing when the buffer will keep living at that path — a one-off export
    // outside the project produces no event the watcher is looking at anyway.
    if (result.rebind) noteOwnWrite(ctx.sender, result.path);
    return { saved: true as const, ...result };
  });

  setHandler("fs:confirmDiscard", async (input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    const choice = await dialog.showMessageBox(window ?? undefined!, {
      type: "warning",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      // Escape maps to Cancel, so dismissing the dialog never destroys work.
      cancelId: 2,
      message: `Do you want to save the changes you made to ${input.path}?`,
      detail: "Your changes will be lost if you don't save them.",
    });

    return { choice: (["save", "discard", "cancel"] as const)[choice.response] ?? "cancel" };
  });

  setHandler("window:allowClose", async (_input, ctx) => {
    allowClose(ctx.sender);
    return { closing: true };
  });

  /**
   * The window controls the renderer draws.
   *
   * Each resolves the target from `ctx.sender` — a window may only act on itself. A window that
   * has already gone returns `{ ok: false }` rather than throwing: the renderer that asked is
   * being torn down anyway, and a rejected promise there surfaces as an error toast about a
   * window nobody can see.
   */
  setHandler("window:minimize", async (_input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (window === null) return { ok: false as const };
    window.minimize();
    return { ok: true as const };
  });

  setHandler("window:toggleMaximize", async (_input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (window === null) return { ok: false as const, maximized: false };
    // Read the real state rather than tracking one: the OS maximises windows behind our back
    // via Win+Up, edge snapping and a double-click on the drag region.
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return { ok: true as const, maximized: window.isMaximized() };
  });

  setHandler("window:close", async (_input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (window === null) return { ok: false as const };
    /**
     * `close()`, never `destroy()`.
     *
     * The unsaved-work handshake hangs off the `close` event. `destroy()` skips it, so a custom
     * close button would silently discard work the OS button would have prompted about — which
     * is precisely the regression a hand-drawn title bar invites.
     */
    window.close();
    return { ok: true as const };
  });


  setHandler("menu:popup", async (input, ctx) => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    // The window can be gone between the click and this handler running — the user hit a
    // menu label while closing. Nothing to open, and nothing worth reporting.
    if (window === null || window.isDestroyed()) return { opened: false };
    popupMenu(window, input.menu, input.x, input.y);
    return { opened: true };
  });

  /**
   * The renderer telling main which commands are live right now.
   *
   * Sets are rebuilt wholesale rather than diffed: the payload is bounded by the command
   * table, and a diff protocol would need sequence numbers to survive a dropped message —
   * machinery for a message that cannot be dropped over IPC.
   */
  setHandler("menu:setState", async (input, ctx) => {
    setMenuState(ctx.sender, {
      enabled: new Set(input.enabled),
      checked: new Set(input.checked),
    });
    return { applied: input.enabled.length };
  });

  setHandler("chat:createSession", async (input) =>
    createChatSession(input.problemId, input.title, input.surface ?? "tutor")
  );

  setHandler("chat:listSessions", async (input) =>
    listChatSessions(input.limit ?? 20, input.offset ?? 0, input.surface)
  );

  setHandler("chat:getSession", async (input) => {
    const session = getChatSession(input.sessionId);
    if (session === undefined) throw new Error(`No chat session ${input.sessionId}`);
    return { session, messages: messagesFor(input.sessionId) };
  });

  setHandler("chat:saveMessage", async (input) => {
    const { sessionId, ...message } = input;
    return appendChatMessage(sessionId, message);
  });

  /**
   * Deleting an id that is already gone is not an error.
   *
   * `DELETE FROM ... WHERE id = ?` affects zero rows and reports success, and that is the
   * right answer: the caller asked for the session to not exist, and it does not. Throwing
   * would only make a double-click look like a failure.
   */
  setHandler("chat:deleteSession", async (input) => {
    deleteChatSession(input.sessionId);
    return { deleted: input.sessionId };
  });

  setHandler("chat:searchSessions", async (input) =>
    searchChatSessions(input.query, input.limit ?? 30, input.surface)
  );

  setHandler("interviews:list", async () => {
    const attempts = allAttempts();
    return {
      questions: QUESTIONS.map((q) =>
        toSummary(q, attempts.get(q.slug), hasInterviewWorkspace(q.slug))
      ),
      facets: facets(),
      progress: interviewProgress(attempts),
    };
  });

  setHandler("interviews:get", async (input) => {
    try {
      const question = getQuestion(input.slug);
      return toDetail(question, getAttempt(input.slug), hasInterviewWorkspace(input.slug));
    } catch (err) {
      return interviewError(err);
    }
  });

  setHandler("interviews:reveal", async (input) => {
    // `getQuestion` first, so an unknown slug is a 404 rather than a row written against
    // a question that does not exist.
    const question = getQuestion(input.slug);

    if (input.stage === "approach") {
      // Not recorded. Reading where to start is the intended path through the exercise;
      // only asking for the answer is the thing worth knowing about later.
      return { stage: "approach" as const, approach: question.approach };
    }

    markRevealed(input.slug);
    return {
      stage: "answer" as const,
      modelAnswer: question.modelAnswer,
      followUps: question.followUps,
      redFlags: question.redFlags,
    };
  });

  setHandler("interviews:saveAttempt", async (input) => {
    const question = getQuestion(input.slug);
    const { slug: _slug, ...patch } = input;
    const attempt = saveInterviewAttempt(question.slug, patch);
    return {
      slug: question.slug,
      selfRating: attempt.selfRating,
      notes: attempt.notes,
      revealedAnswer: attempt.revealedAnswer,
    };
  });

  setHandler("interviews:markSubmitted", async (input) => {
    const question = getQuestion(input.slug);
    const problemId = problemIdForQuestion(question.slug);

    if (problemId === undefined) {
      throw new Error(`Question is not executable: ${question.slug}`);
    }

    // DERIVED FROM `submissions`, NOT TAKEN ON TRUST. The client calls this after a
    // submit, but the client is not the authority — and on the desktop it is even less
    // of one, since the user can edit the renderer. A call with no matching submission
    // row would otherwise unlock the tutor for someone who never wrote anything.
    if (recentSubmissions(problemId, 1).length === 0) {
      throw new Error(`No submission for this question: ${question.slug}`);
    }

    const attempt = markInterviewSubmitted(question.slug);
    return { submittedAt: attempt.submittedAt };
  });

  setHandler("interviews:workspace", async (input) => {
    try {
      return buildInterviewWorkspace(input.slug);
    } catch (err) {
      return interviewError(err);
    }
  });

  setHandler("interviews:assess", async (input) => {
    try {
      const assessment = await assessInterviewAnswer(input.slug, input.answer);

      /**
       * Recorded before returning, and a failure here does not lose the verdict.
       *
       * The person is waiting on this call to see their marking. A store that is locked or
       * unwritable is a reason to have no *record*, not a reason to throw away an assessment
       * that already cost a model round-trip — so the write is attempted and its failure
       * swallowed, the same trade `agent/stream.ts` makes when recording a step mid-run.
       *
       * The feedback prose is deliberately not passed: see the column comment in `store/db.ts`.
       */
      try {
        recordAssessment(input.slug, assessment.verdict, assessment.model);
      } catch {
        // No record, but the marking still reaches the screen.
      }

      return assessment;
    } catch (err) {
      return interviewError(err);
    }
  });

  setHandler("notifications:list", async (input) =>
    listNotifications({
      ...(input.unreadOnly !== undefined ? { unreadOnly: input.unreadOnly } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
  );

  setHandler("notifications:count", async () => ({ unreadCount: unreadCount() }));

  setHandler("notifications:markRead", async (input) => ({
    updated: markNotificationsRead(input.ids),
  }));

  setHandler("dashboard:get", async () => buildDashboard());

  setHandler("problems:list", async () => ({ problems: listProblems() }));

  setHandler("problems:get", async (input) => {
    // Position in the catalogue, so the workspace's "Question: n/N" counter and its
    // prev/next chevrons agree with the list.
    const order = listProblems().findIndex((p) => p.id === input.slug) + 1;
    const detail = await buildProblemDetail(input.slug, order);
    if (detail === undefined) throw new Error(`Unknown problem: ${input.slug}`);
    return detail;
  });

  setHandler("exec:run", async (input, ctx) => {
    // Tier B is Build-only even though the channel is shared, because a Study window
    // must never reach native execution (spec §2.6). The contract cannot express
    // "this field is restricted", so it is checked here.
    if (input.tier === "native" && ctx.mode !== "build") {
      throw new Error("Native execution is not available in Study mode");
    }
    if (input.tier === "native") {
      // Phase 2 ships Tier A only. Saying so is better than silently running the code
      // in Pyodide and letting a torch import fail confusingly.
      throw new Error("Tier B (native CPython) is not implemented yet");
    }

    const problem = getProblem(input.problemId);
    if (problem === undefined) {
      throw new Error(`Unknown problem: ${input.problemId}`);
    }

    // The grader owns the cases, the allowlist and the limits. Nothing the caller
    // sent influences the verdict beyond the source itself.
    //
    // Registered for the whole grade — both sandbox runs and the gap between them — and
    // always released, or a later Stop reusing the id would act on nothing.
    if (input.attemptId !== undefined) beginAttempt(input.attemptId);
    let grade;
    try {
      grade = await gradeSubmission(problem, input.source, input.attemptId);
    } finally {
      if (input.attemptId !== undefined) endAttempt(input.attemptId);
    }

    // Persist unless our own reference was broken, or the user stopped it. Recording a
    // verdict we know is meaningless would put a false failure in the learner's history
    // permanently — and "stopped" is exactly as meaningless as "our reference is broken".
    // Pressing Stop must not cost an attempt, and must not be able to reset a streak.
    if (grade.referenceBroken === undefined && grade.outcome !== "cancelled") {
      const { firstSolve } = recordSubmission(input.source, grade);

      /**
       * FIRST SOLVE ONLY.
       *
       * The web raised one of these per submission, pass or fail, and that was right for a
       * web app where you might submit and close the tab. Here the verdict is already on
       * screen and Submission History is a tab away, so a row per submission fills the bell
       * with things you have just read and acted on — which trains you to ignore it, and
       * then it is worth nothing when something you *would* have missed arrives.
       *
       * A first solve happens once per problem and is the one event in this flow you cannot
       * get back to. `firstSolve` is computed inside the write transaction, so a re-solve
       * cannot masquerade as one.
       *
       * Raised here rather than in the store, and never from a channel: a renderer that
       * could write its own notifications could claim a solve that did not happen. Guarded
       * by the same condition as the write above, because a broken reference produces no
       * history row and must not announce one either.
       */
      if (firstSolve) {
        createNotification({
          type: "submission_accepted",
          title: `Solved: ${problem.title}`,
          message: `All ${grade.verdicts.length} test cases passed on attempt ${
            allProgress().find((p) => p.problemId === problem.id)?.attemptCount ?? 1
          }.`,
          referenceId: problem.id,
        });
      }
    }
    return grade;
  });

  setHandler("hw:scan", async () => scanHardware());

  setHandler("models:list", async () => ({
    // Includes the licence, so the UI can show it before a multi-gigabyte download.
    models: CATALOGUE,
  }));

  setHandler("models:recommend", async (input) => {
    const profile = await scanHardware();
    const ranked = recommend(CATALOGUE, profile, input.contextTokens);
    return {
      profile,
      // Every candidate with its verdict, not just the winner: a user on an 8 GB card
      // deserves to see *why* the 14B was passed over rather than having it vanish.
      recommendations: ranked,
    };
  });

  setHandler("drafts:save", async (input) => {
    saveDraft(input.problemId, input.source);
    return { saved: true };
  });

  setHandler("drafts:load", async (input) => {
    const source = loadDraft(input.problemId);
    // `null` rather than the template: the renderer already has the template from
    // `problems:list`, and returning it here would make "untouched" indistinguishable
    // from "deliberately reset to the template".
    return { source: source ?? null };
  });

  setHandler("submissions:list", async (input) => ({
    submissions: recentSubmissions(input.problemId, input.limit ?? 20),
  }));

  setHandler("profile:get", async () => toProfilePayload());

  setHandler("profile:update", async (input) => {
    try {
      updateProfile(input);
    } catch (err) {
      if (err instanceof InvalidBirthDateError) {
        throw new IpcError("E_BAD_INPUT", err.message);
      }
      throw err;
    }
    // The same projection as `profile:get`, so a save cannot return a differently-shaped
    // profile from the one a reload produces. `updateProfile` returns the stored row, but
    // the payload is more than the row — the derived age and the fields a local install
    // cannot know are added here, in one place.
    return toProfilePayload();
  });

  setHandler("providers:list", async () => ({ providers: await availableProviders() }));

  setHandler("models:pull", async (input, ctx) => {
    const provider = providerById("ollama");
    if (provider?.pull === undefined) {
      // llama.cpp takes a GGUF path and OpenRouter is remote — neither has anything to
      // pull. Saying so beats a progress bar that never moves.
      throw new Error("Only Ollama can download models");
    }

    await provider.pull(input.id, (progress) => {
      // Progress is a push, not a return value: a download runs for minutes and the UI
      // needs to move during it. Guarded because the window may close mid-pull.
      if (!ctx.sender.isDestroyed()) {
        ctx.sender.send("models:pullProgress", { id: input.id, ...progress });
      }
    });

    return { id: input.id, done: true };
  });

  /**
   * Delete a model's weights, behind a native dialog.
   *
   * **The confirmation is in main, not the renderer** — the same rule `consent.ts` states for
   * image uploads. A prompt the renderer draws is one a compromised renderer skips, and a
   * native `showMessageBox` cannot be styled invisible or scrolled off. Deleting nine
   * gigabytes is not recoverable from this UI: the only undo is a re-download over whatever
   * connection the user has.
   *
   * Cancel is the default and Escape maps to it, matching the upload dialog: keeping the
   * model is always recoverable, deleting is not.
   *
   * The dialog names the model and its size, because "Remove this model?" is a question
   * nobody can answer wrongly and everybody can answer carelessly.
   */
  setHandler("models:remove", async (input, ctx) => {
    const provider = providerById("ollama");
    if (provider?.remove === undefined) {
      throw new IpcError("E_UNAVAILABLE", "Only Ollama can remove models");
    }

    const spec = findModel(input.id);
    const size = spec === undefined ? "" : ` It is ${spec.downloadGB} GB.`;
    const window = BrowserWindow.fromWebContents(ctx.sender);

    const choice = await dialog.showMessageBox(window ?? undefined!, {
      type: "warning",
      buttons: ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      message: `Remove "${input.id}" from this machine?`,
      detail:
        `The weights are deleted from disk and anything using this model stops working ` +
        `until it is downloaded again.${size}`,
    });

    if (choice.response !== 1) return { id: input.id, removed: false };

    await provider.remove(input.id);
    return { id: input.id, removed: true };
  });

  setHandler("chat:open", async (input, ctx) => {
    /**
     * The declared media type has to match the bytes.
     *
     * The schema checks that `mediaType` is one of three strings; nothing in it says the data
     * is that kind of image. Without this a renderer can label anything `image/png` and every
     * layer downstream believes the label — the provider wraps it in a `data:` URL, and a
     * future attachment store would write it to a file named for a type it is not.
     */
    try {
      for (const message of input.messages) assertImagesMatch(message.content);
    } catch (err) {
      if (err instanceof ImageMismatchError) throw new IpcError("E_BAD_INPUT", err.message);
      throw err;
    }

    const surface = surfaceForMode(ctx.mode) ?? input.surface;

    /**
     * Images do not leave this machine without the user saying so.
     *
     * ENFORCED HERE, IN MAIN, and that placement is the whole control. A prompt the renderer
     * shows is a prompt a compromised renderer skips; there is no path from an image block to
     * a remote provider that does not pass through this line.
     *
     * Local providers are not asked about, because nothing leaves — prompting anyway would
     * train people to click through it, and then it is worth nothing when it matters.
     */
    const images = countImages(input.messages);
    const provider = providerById(input.provider);
    if (images > 0 && provider?.capabilities.remote === true) {
      const agreed = await confirmImageUpload({
        sender: ctx.sender,
        destination: destinationFor(input.provider),
        imageCount: images,
        modelLabel: provider.label,
      });
      if (!agreed) {
        // A refusal is not an error to be retried. `E_BAD_INPUT` rather than `E_UNAVAILABLE`
        // so nothing treats it as a transient failure worth trying again.
        throw new IpcError("E_BAD_INPUT", "Sending images was cancelled");
      }
    }

    const { port } = openChatStream(ctx.sender, input.provider, {
      model: input.model,
      // The persona is prepended here. The renderer names which surface it is, but never
      // supplies prompt text — the schema has no `system` role — so this is the only way
      // instructions enter a conversation.
      //
      // A restricted `study`-mode window is pinned to the tutor whatever it asks for; the
      // unified window chooses per conversation.
      messages: [
        {
          role: "system" as const,
          /**
           * The tutor gets sources; the assistant does not.
           *
           * Retrieved here rather than offered as a tool, because the tutor has no tools and
           * that is what lets both assistants share a window safely — see `content/grounding.ts`.
           * The assistant surface is excluded because it has `web_fetch` and a project index of
           * its own, and a second grounding channel would be a second thing to keep current.
           *
           * Empty when retrieval finds nothing, so an off-topic question falls back to the plain
           * persona rather than to a heading with no passages under it.
           */
          content:
            surface === "tutor"
              ? `${systemPromptForSurface(surface)}${groundingFor(input.messages, input.itemId).block}`
              : systemPromptForSurface(surface),
        },
        ...input.messages,
      ],
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.json !== undefined ? { json: input.json } : {}),
      /**
       * NO TOOLS ON THIS CHANNEL YET, AND THAT IS DELIBERATE.
       *
       * The plumbing is complete — `toolDefinitionsForSurface(surface)` returns exactly what
       * this would send, the providers stream calls, and the accumulator reassembles them.
       * What does not exist yet is a dispatcher: `sseFromPort` in `renderer/src/lib/api/client.ts`
       * handles `token`, `reasoning`, `done` and
       * `error`, and would drop a `tool_call` on the floor.
       *
       * Turning it on here would therefore produce the precise failure this phase's tool
       * plumbing was written to avoid — a turn where the model asked for a tool, nothing ran,
       * and the assistant appears to have done nothing at all. Worse than the fenced-block
       * convention it would be replacing, which at least works.
       *
       * It gets switched on in the same change that adds the dispatcher, so the first request
       * that can produce a call is also the first that can service one.
       */
    });

    // The port is transferred, not serialised. Tokens then flow renderer<->provider
    // without passing through the broker (spec §2.3).
    ctx.sender.postMessage("chat:open:port", null, [port]);
    return { streaming: true };
  });

  /**
   * A shell, over a transferred port.
   *
   * Same transport as `chat:open`: the port goes to the renderer once and the bytes flow
   * directly, rather than every keystroke and every line of output passing through the
   * broker.
   *
   * The renderer supplies only a size. Main picks the shell and the working directory — see
   * `terminal/pty.ts` for why that is the whole security design rather than a detail.
   */
  setHandler("pty:spawn", async (input, ctx) => {
    let terminal;
    try {
      terminal = spawnTerminal(ctx.sender, input.cols, input.rows);
    } catch (err) {
      if (err instanceof TerminalUnavailableError) {
        // Named, so the UI can say "open a project first" rather than "something failed".
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }

    const { port1, port2 } = new MessageChannelMain();
    const { child } = terminal;

    child.onData((data) => {
      try {
        port1.postMessage({ t: "data", d: data });
      } catch {
        // The port closed between the pty producing output and us forwarding it.
      }
    });

    child.onExit(({ exitCode, signal }) => {
      try {
        port1.postMessage({ t: "exit", code: exitCode, signal: signal ?? null });
      } catch {
        // Same race, at the end of life.
      }
      forgetTerminal(ctx.sender, child);
      port1.close();
    });

    /**
     * Everything arriving from the renderer is validated here.
     *
     * This is the one place renderer input reaches `child.write()`, and zod is not reachable
     * on a raw port message — so the checks are explicit. `resize` is range-checked to the
     * same bounds as the spawn schema: an absurd `cols` kills the pty outright.
     */
    port1.on("message", (event) => {
      const message = event.data as { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };
      if (typeof message?.t !== "string") return;

      if (message.t === "data" && typeof message.d === "string") {
        child.write(message.d);
        return;
      }
      if (message.t === "resize") {
        const { cols, rows } = message;
        if (
          typeof cols === "number" &&
          typeof rows === "number" &&
          Number.isInteger(cols) &&
          Number.isInteger(rows) &&
          cols >= 1 &&
          cols <= 2000 &&
          rows >= 1 &&
          rows <= 2000
        ) {
          child.resize(cols, rows);
        }
        return;
      }
      if (message.t === "kill") child.kill();
    });
    port1.start();

    // The port dies with the window, so this is the whole lifecycle tie: close the port and
    // the shell goes with it, whether that came from the user or from the window closing.
    port1.on("close", () => {
      child.kill();
      forgetTerminal(ctx.sender, child);
    });
    ctx.sender.once("destroyed", () => killTerminalsFor(ctx.sender));

    ctx.sender.postMessage("pty:spawn:port", null, [port2]);
    return { pid: terminal.pid, shell: terminal.shell };
  });

  setHandler("vault:set", async (input) => {
    try {
      // `input.key` is threaded rather than ignored. It was, when there was one enum member and a
      // single module variable named after the provider — so a second member would silently have
      // overwritten the first one's key.
      const { storedDurably } = setSecret(input.key, input.value);
      return { stored: true, storedDurably };
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) {
        // A named code with the real reason, because the user can act on this one: no keyring is
        // running. `E_HANDLER_FAILED` would render as "vault:set failed" and strand them.
        throw new IpcError("E_UNAVAILABLE", err.message);
      }
      throw err;
    }
  });

  // Reports existence only. There is deliberately no channel that returns the key.
  setHandler("vault:has", async (input) => hasSecret(input.key));

  setHandler("vault:clear", async (input) => ({ cleared: clearSecret(input.key) }));

  setHandler("exec:cancel", async (input) => {
    // `cancelled: false` when the attempt had already finished. Not an error — that is the
    // race a Stop button always has — but the caller is told the truth rather than handed a
    // success for something that did not happen.
    return { cancelled: cancelAttempt(input.attemptId) };
  });
}

/**
 * What this project's dev server is, read from disk.
 *
 * Both reads are tolerated failing. A project with no `package.json` is simply one with no
 * preview, and an unreadable directory is the same answer — neither is worth an error dialog,
 * because the pane's honest response to both is "there is nothing to preview here".
 */
async function detectFor(root: string): Promise<PreviewCommand | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }

  let filenames: string[] = [];
  try {
    filenames = await fs.readdir(root);
  } catch {
    // The lockfile only picks the package manager; npm is the documented default without one.
  }

  return detectPreviewCommand(parsed, filenames);
}

/**
 * Where a project keeps its tokens.
 *
 * A short, ordered list rather than a search: walking a repository for every `.css` file means
 * reading `node_modules`, build output, and vendored stylesheets — thousands of files to find
 * one, and the wrong answer if a dependency happens to define `--color-primary`. These are the
 * conventional locations, and a project that keeps them elsewhere reports none rather than the
 * wrong ones.
 */
const TOKEN_FILES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/globals.css",
  "src/index.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/app.css",
  "app.css",
];

/**
 * Every token the project declares, from whichever of those files exist.
 *
 * All of them, not the first that matches: a project can split primitives and semantics across
 * two files, and `parseCssTokens` resolving `var()` across the pair only works if it sees both.
 * Later files win, which is the same rule the parser applies within one file.
 */
async function readProjectTokens(root: string): Promise<DesignToken[]> {
  const sources: string[] = [];
  for (const relative of TOKEN_FILES) {
    try {
      sources.push(await fs.readFile(path.join(root, relative), "utf8"));
    } catch {
      // Absent, which is the common case for most of this list.
    }
  }
  return sources.length === 0 ? [] : parseCssTokens(sources.join("\n"));
}
