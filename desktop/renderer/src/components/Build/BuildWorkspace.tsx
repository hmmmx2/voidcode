"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { IdePanel, useToast } from "@/components/app";
import FileTree from "./FileTree";
import AssistantPanel from "./AssistantPanel";
import { usePublishBuildActions, type BuildActions } from "@/lib/shell/build-actions";
import { usePanelState } from "@/lib/shell/usePanels";
import { DEFAULT_DOCK_TAB, type DockTab } from "@/lib/build/dock";
import { DEFAULT_WORKSPACE_TAB, type WorkspaceTab } from "@/lib/build/workspace-tabs";
import {
  parseWorkspaceDocument,
  serializeWorkspaceDocument,
} from "@/lib/build/workspace-session";
import { EMPTY_RUN_VIEW, type RunView } from "@/lib/build/run-view";
import type { AgentStepPayload } from "@/lib/build/agent-stream";
import WorkspaceSurface from "./WorkspaceSurface";
import EditorTabs from "./EditorTabs";
import EditorPane from "./EditorPane";
import {
  CHAT_TAB,
  MAX_OPEN_TABS,
  atCapacity,
  closeTab,
  parseCentreTab,
  serializeCentreTab,
  type CentreTab,
} from "@/lib/build/editor-tabs";
import { useTerminals } from "@/lib/build/useTerminals";
import {
  appendTo,
  clearChannel,
  emptyOutput,
  type OutputChannel,
} from "@/lib/build/output";
import DockGrid from "@/components/Layout/DockGrid";
import {
  applyVisibility,
  defaultWorkspaceLayout,
  isDefaultWorkspaceLayout,
  serializeWorkspace,
  workspaceConstraints,
  type WorkspacePane,
} from "@/lib/build/workspace-layout";
import type { GridLayout } from "@/lib/layout/grid-model";

/**
 * Build Mode: the standalone IDE.
 *
 * Three columns — project, editor, assistant — on the same surfaces, type and radii as the
 * Study workspace, because they are two windows of one app. What differs is what the window
 * is *allowed* to do: `host.fs` exists here and is `undefined` in a Study window, decided at
 * window creation and not togglable.
 */

// Client-only: each of these touches `window` at module scope — xterm for the terminal, and
// the search and memory panels through `window.host` — so none can be server-rendered by the
// static export.
const BottomDock = dynamic(() => import("./BottomDock"), { ssr: false });
const SearchPanel = dynamic(() => import("./SearchPanel"), { ssr: false });
const MemoryPanel = dynamic(() => import("./MemoryPanel"), { ssr: false });


/**
 * The assistant's model, which has to be one that can call tools.
 *
 * This was `qwen2.5-coder:7b`, and the agent path could never honour it: `pickAgentModel`
 * denies completion variants by name — `qwen2.5-coder` is the model that whole denylist exists
 * for — so every agentic turn silently fell through to "the largest tool-capable model
 * installed". The panel reported the substitution through `answeredBy`, so it was visible
 * rather than hidden, but the *request* was always for a model that could not serve it.
 *
 * A preference the resolver is guaranteed to reject is not a preference. `qwen3:8b` is one it
 * can honour, and is what `noToolModelMessage` already tells users to pull.
 */
const DEFAULT_MODEL = "qwen3:8b";



/**
 * A file the workspace has read.
 *
 * `baseline` is what was last seen on disk. Nothing here edits *yet* — the viewer is read-only
 * until the save family lands — so it does not currently diverge from `contents` by typing. It
 * is what the watcher compares against to decide whether a file changed underneath us, and it is
 * what `fs:save`'s optimistic-concurrency check will be handed when editing arrives. `null`
 * means the file is gone from disk, which `deleteEntry` and `reconcile` both set.
 *
 * THIS LIST IS THE TAB STRIP. There is no second array of open paths, deliberately: `renameEntry`
 * and `reconcile` already rewrite paths here, and a parallel list would be a second place to
 * remember to do that. `lib/build/editor-tabs.ts` holds the transitions as pure functions over
 * the paths this list yields.
 */
interface FileBuffer {
  path: string;
  contents: string;
  baseline: string | null;
}

export default function BuildWorkspace() {
  const [host, setHost] = useState<NonNullable<Window["host"]> | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState<BuildProjectTree | undefined>(undefined);
  /**
   * Every open buffer, plus which one is showing.
   *
   * This was a single `openFile`, so clicking a second file silently discarded the first —
   * including unsaved edits, with nothing to go back to. The list is what makes opening a
   * second file safe, not merely convenient.
   */
  const [files, setFiles] = useState<FileBuffer[]>([]);
  /**
   * The file the viewer is showing.
   *
   * This was an `EditorLayout` — a tree of groups, each with its own tab list and focus — because
   * the pane was an editor you could split. One string replaces all of it: there is one viewer,
   * it shows one file, and the panes that can still be arranged are the grid's. Splits are not
   * coming back with the tab strip; the grid is the only thing that arranges panes here.
   */
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const openFile = files.find((f) => f.path === activePath);

  /**
   * Whether the centre pane is showing the conversation or the file.
   *
   * TWO VALUES, NOT ONE, and the second is only a discriminator. The path lives in `activePath`
   * and nowhere else, so a rename — which `renameEntry` and `reconcile` both perform on `files`
   * and `activePath` — cannot leave the tab pointing at a name that no longer exists. Storing the
   * path here as well would be a third copy of it and a third place to follow a rename.
   *
   * It also keeps the two axes separate: which file the viewer holds, and whether the viewer is
   * what you are looking at. Collapsing them would drop the file tabs out of the strip the moment
   * you switched to Chat, and blink the file tree's own highlight off with them.
   */
  const [centreView, setCentreView] = useState<"chat" | "file">("chat");
  const openPaths = useMemo(() => files.map((f) => f.path), [files]);
  const centreTab: CentreTab =
    centreView === "file" && activePath !== undefined
      ? { kind: "file", path: activePath }
      : CHAT_TAB;

  /**
   * A line to reveal, and a nonce so revealing the same one twice still works.
   *
   * `@monaco-editor/react`'s own `line` prop is an update-effect keyed on the value, so asking
   * for line 42 a second time does nothing — and "jump to the error I just clicked" is precisely
   * the case where the same line is asked for again.
   */
  const [reveal, setReveal] = useState<
    { line: number; column: number; nonce: number } | undefined
  >(undefined);

  /**
   * The buffers, readable from a callback that must not depend on them.
   *
   * `reconcile` runs from the watcher subscription. Depending on `files` directly would tear
   * down and re-register that subscription on every keystroke, and a change arriving during
   * the gap would be lost — which is the one thing a watcher must not do.
   */
  const filesRef = useRef<FileBuffer[]>([]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);


  /**
   * The preload surface and the toast function, for the save coordinator.
   *
   * It is built once and lives for the component's life, so it cannot close over either
   * directly — a coordinator rebuilt to pick up a new `host` would drop its pending timer, and
   * that timer is the only thing standing between a burst of typing and lost work.
   */
  const hostRef = useRef<NonNullable<Window["host"]> | undefined>(undefined);
  useEffect(() => {
    hostRef.current = host;
  }, [host]);

  /** Same reason, for the one place a tree action needs to open what it just created. */
  const openFileAtRef = useRef<(path: string) => Promise<void>>(async () => {});
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Whether main is watching the project, and why not when it isn't.
   *
   * Surfaced rather than assumed. Without a watcher the sidebar and the buffers can drift
   * from disk silently, and "nothing changed" must not be indistinguishable from "I stopped
   * being able to tell".
   */
  const [watch, setWatch] = useState<{ watching: boolean; reason: string | null }>({
    watching: false,
    reason: null,
  });
  /** Open buffers a watcher event changed under, still holding the user's own edits. */
  const [externallyChanged, setExternallyChanged] = useState<ReadonlySet<string>>(new Set());
  /**
   * Where every pane is and how large, as one tree.
   *
   * This was two pieces of state and three nested `SplitContainer`s: `paneSizes` keyed by column
   * plus a bare `centreSizes` pair, with `pane-sizes.ts` renormalising around collapsed panes.
   * A tree needs none of that — nesting is the only structure, and a hidden leaf keeps its own
   * share, so the special case stops being special. See `workspace-layout.ts`.
   */
  const [dockLayout, setDockLayout] = useState<GridLayout<WorkspacePane>>(defaultWorkspaceLayout);

  const notify = useToast();
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  /*
    No ghost text. Completion suggests what to type next, and this pane cannot be typed in —
    the provider would keep asking a model for text no one can accept. The whole hook goes with
    the editor machinery in the next pass; the call is removed here so it stops doing work.
  */

  /*
    Nothing publishes open buffers any more.

    The palette offered them because there were several open at once and switching between them
    was a thing you did constantly. The viewer shows one file, chosen from the tree or by the
    assistant, so the list would always have been a list of one.
  */

  // `window.host` only exists under Electron, so it is read after mount rather than during
  // render — the static export prerenders this file in Node, where there is no window.
  useEffect(() => {
    setHost(window.host);
    setReady(true);
  }, []);

  /**
   * Adopt a project main already has open for this window.
   *
   * Two cases reach here. A **restored window**, whose root was re-granted before the page
   * loaded — this is what puts the tree back, and the reason it is a pull: a push on
   * `did-finish-load` arrives before React has attached its listener and is simply lost.
   * And **navigating to Build** after a folder was opened from somewhere else in the app.
   *
   * Runs once, and only while no project is showing, so it can never clobber one the user
   * opened themselves.
   */
  const adoptedRef = useRef(false);

  useEffect(() => {
    if (host?.fs === undefined || tree !== undefined || adoptedRef.current) return;
    adoptedRef.current = true;

    void (async () => {
      try {
        const result = await host.fs!.currentProject();
        if (!result.opened) return;
        setTree(result.tree);
        setWatch({ watching: result.watching, reason: result.watchReason });
      } catch {
        // No project, or the window cannot ask. Either way the empty state is correct.
      }
    })();
  }, [host, tree]);

  /**
   * What this window had open, restored on mount and saved as it changes.
   *
   * PATHS ONLY. Buffer contents are deliberately absent: persisting dirty text would make the
   * database a second, silently diverging copy of the user's source, and restoring it would
   * resurrect edits they believe they discarded. Files are re-read from disk, so what comes
   * back is the arrangement, not the work in progress.
   *
   * The gate is both a ref and a state flag, and it needs to be both. The ref stops the
   * restore running twice; the state is what the save effect depends on, because flipping a
   * ref does not re-run an effect — so with only a ref the first save waited for the layout to
   * change, and a window restored and closed untouched wrote nothing back.
   *
   * Without either, the first render would write an empty layout over the one it is about to
   * load, and the restore would race its own erasure.
   */
  const restoredRef = useRef(false);
  const [restored, setRestored] = useState(false);

  const { panels, setPanel } = usePanelState();
  /**
   * The dock's tabs and its terminals.
   *
   * Held here rather than inside `BottomDock` for one reason: "New Terminal" from the menu has to
   * add a tab to a dock that is already open, and a command bound in `Workbench` cannot reach
   * state that lives inside a component further down.
   *
   * The cost is that this component has to remember to forget them — see the effect below.
   */
  const [dockTab, setDockTab] = useState<DockTab>(DEFAULT_DOCK_TAB);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(DEFAULT_WORKSPACE_TAB);
  /**
   * The current run, as the chat sees it.
   *
   * Deliberately not persisted. It is derived from a transcript that lives in `AssistantPanel`
   * and is rebuilt on every mount; writing it to the session document would create a second,
   * staler copy that outlived the run it describes — a plan on screen from a conversation the
   * panel no longer has.
   */
  const [runView, setRunView] = useState<RunView<AgentStepPayload>>(EMPTY_RUN_VIEW);
  const terminals = useTerminals();

  /**
   * Output, and the linter that writes to one of its channels.
   *
   * `appendOutput` is stable so producers can hold it without re-subscribing; every channel here
   * has an existing producer, which is why this adds no IPC.
   */
  const [output, setOutput] = useState(emptyOutput);
  const [outputChannel, setOutputChannel] = useState<OutputChannel>("agent");
  const appendOutput = useCallback((channel: OutputChannel, text: string) => {
    setOutput((prev) => appendTo(prev, channel, text));
  }, []);
  /*
    No diagnostics. Linting ran on a successful save, and nothing here saves — the assistant
    writes through a reviewed diff, and the tools it runs report their own output. Problems had
    exactly one producer and it has gone, so the tab would have been permanently empty.
  */

  /**
   * Collapsing the dock unmounts its panes, and a pane's cleanup kills its shell. So the tabs
   * have to go with them; otherwise reopening shows a strip of buttons for dead processes.
   */
  /*
   * Collapsing the dock no longer ends its terminals.
   *
   * This used to call `resetTerminals()` whenever `panels.bottom` went false, and the dock was
   * rendered conditionally besides, so hiding the panel killed every shell in it. Under the grid
   * a hidden pane keeps its subtree mounted — the same reason the dock's own tabs are a hidden
   * stack rather than swapped children — so reopening returns you to the shells you left, which
   * is what a panel toggle should do. `killTerminalsFor` in main still ends them with the window.
   */


  useEffect(() => {
    if (host?.session === undefined || tree === undefined || restoredRef.current) return;
    restoredRef.current = true;

    void (async () => {
      try {
        const { state } = await host.session!.load();
        if (state === null) return;
        const document = parseWorkspaceDocument(state);
        if (document === null) return;

        setDockTab(document.dock);
        setWorkspaceTab(document.workspace);
        setDockLayout(document.grid);

        /**
         * Only paths that still exist. A file deleted since last session would otherwise restore
         * a tab that errors the moment it is clicked.
         *
         * Read in parallel and then filtered rather than short-circuiting on the first miss: one
         * deleted file must not cost the rest of the strip. A path that has become a binary is
         * dropped too, for the same reason `openFileAt` refuses one — a tab holding replacement
         * characters is worse than no tab.
         */
        const contents = await Promise.all(
          document.openPaths.map(async (path) => {
            try {
              const file = await host.fs!.read({ path });
              return file.binary ? undefined : { path, contents: file.contents };
            } catch {
              return undefined;
            }
          })
        );
        const loaded = contents.filter(
          (f): f is { path: string; contents: string } => f !== undefined
        );

        setFiles(
          loaded.map((f) => ({ path: f.path, contents: f.contents, baseline: f.contents }))
        );
        const alive = loaded.map((f) => f.path);
        const active =
          document.active !== null && alive.includes(document.active)
            ? document.active
            : // The document's active file is gone; show the first that came back rather than
              // nothing, since the strip is about to render its tabs either way.
              alive[0];
        setActivePath(active);
        setCentreView(parseCentreTab(document.centre, alive, active ?? null).kind);
      } catch {
        // A restore that cannot complete is not worth reporting: the window is perfectly
        // usable empty, and an error banner on launch would be alarming out of proportion.
      } finally {
        // In a `finally`, so a failed restore still opens the gate. Otherwise one bad
        // document would leave the window unable to save its arrangement for the rest of the
        // session — a small bug that compounds every launch.
        setRestored(true);
      }
    })();
  }, [host, tree]);

  useEffect(() => {
    if (host?.session === undefined || !restored) return;
    // Paths and arrangement only — see above. The format lives in `workspace-session.ts`, so the
    // reader and the writer cannot describe different documents.
    const state = serializeWorkspaceDocument({
      grid: serializeWorkspace(dockLayout, window.innerWidth, window.innerHeight),
      dock: dockTab,
      workspace: workspaceTab,
      openPaths,
      active: activePath,
      centre: serializeCentreTab(centreTab),
    });
    void host.session.save({ state }).catch(() => {});
  }, [
    host,
    activePath,
    openPaths,
    centreTab,
    dockLayout,
    dockTab,
    workspaceTab,
    restored,
  ]);

  const openProject = useCallback(async () => {
    if (host?.fs === undefined) return;
    setOpening(true);
    setError(undefined);
    try {
      const result = await host.fs.openProject();
      if (result.opened) {
        setTree(result.tree);
        setWatch({ watching: result.watching, reason: result.watchReason });
        // Buffers are paths inside the old project; keeping them would leave tabs pointing
        // at files that are no longer reachable. `EditorPane` disposes the Monaco models that
        // went with them, keyed off this now-empty list — without that, a same-named file in the
        // new project would inherit the old one's undo stack.
        setFiles([]);
        setActivePath(undefined);
        setCentreView("chat");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [host]);

  /**
   * Re-read the tree.
   *
   * The tree used to arrive once, with the folder, and never again — so a file created by the
   * terminal, or a branch switch, stayed invisible until the folder was reopened. The watcher
   * calls this on overflow; the user can call it from the sidebar.
   */
  const refreshTree = useCallback(async () => {
    if (host?.fs === undefined) return;
    try {
      const { tree: next } = await host.fs.tree();
      setTree(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [host]);

  /**
   * Reconcile open buffers with a change that happened outside the editor.
   *
   * Three cases, and the distinction between them is the whole point of watching:
   *
   *   - **Clean buffer, changed on disk.** Silently reload. The user has no edits to lose and
   *     showing them stale content is how a save later fails with a conflict they cannot
   *     explain.
   *   - **Dirty buffer, changed on disk.** Never auto-reload — that would discard their work
   *     to match someone else's. Mark it and let them choose.
   *   - **Deleted while open.** Keep the buffer and drop the baseline to `null`, so it reads
   *     as dirty and a save recreates the file. Closing the tab is still their call.
   */
  const reconcile = useCallback(
    async (batch: BuildFileChangeBatch) => {
      if (host?.fs === undefined) return;

      // The batch was capped, so its list is not the whole truth. Re-reading the tree is
      // cheaper than reconciling a thousand paths, and honest about what we know.
      if (batch.overflow) void refreshTree();

      const byPath = new Map(batch.changes.map((c) => [c.path, c.kind]));
      if (batch.changes.some((c) => c.kind !== "changed")) void refreshTree();

      const openNow = filesRef.current;
      const reloads: Array<{ path: string; contents: string }> = [];
      const conflicted: string[] = [];
      const orphaned: string[] = [];

      for (const buffer of openNow) {
        const kind = byPath.get(buffer.path);
        if (kind === undefined) continue;

        if (kind === "deleted") {
          orphaned.push(buffer.path);
          continue;
        }

        const dirty = buffer.contents !== buffer.baseline;
        if (dirty) {
          conflicted.push(buffer.path);
          continue;
        }

        try {
          const { contents } = await host.fs.read({ path: buffer.path });
          reloads.push({ path: buffer.path, contents });
        } catch {
          // Gone between the event and the read. The next batch will call it deleted.
        }
      }

      if (reloads.length > 0 || orphaned.length > 0) {
        setFiles((prev) =>
          prev.map((f) => {
            const reload = reloads.find((r) => r.path === f.path);
            if (reload !== undefined) return { ...f, contents: reload.contents, baseline: reload.contents };
            if (orphaned.includes(f.path)) return { ...f, baseline: null };
            return f;
          })
        );
      }

      setExternallyChanged((prev) => {
        if (conflicted.length === 0) return prev;
        const next = new Set(prev);
        for (const path of conflicted) next.add(path);
        return next;
      });

      if (conflicted.length > 0) {
        notify(
          conflicted.length === 1
            ? `${conflicted[0]} changed on disk`
            : `${conflicted.length} open files changed on disk`,
          { detail: "Your unsaved edits were kept. Reload from the tab to take the disk version.", tone: "warn" }
        );
      }
      if (orphaned.length > 0) {
        notify(
          orphaned.length === 1 ? `${orphaned[0]} was deleted` : `${orphaned.length} open files were deleted`,
          { detail: "The editor still has the text. Saving will recreate the file.", tone: "warn" }
        );
      }
    },
    [host, refreshTree, notify]
  );

  useEffect(() => {
    if (host === undefined) return;
    return host.onFileChanged?.((batch) => void reconcile(batch));
  }, [host, reconcile]);

  /**
   * Take the version on disk, discarding local edits.
   *
   * Only reachable from a tab the reconciler marked, so this is always a deliberate answer to
   * a question the user was asked rather than something that can happen to them.
   */
  const reloadFromDisk = useCallback(
    async (path: string) => {
      if (host?.fs === undefined) return;
      try {
        const file = await host.fs.read({ path });
        // Only reachable for a path already open as a text buffer, so `binary` here means the
        // file was replaced on disk by one. Leaving the buffer alone is the safe answer.
        if (file.binary) return;
        const { contents } = file;
        setFiles((prev) =>
          prev.map((f) => (f.path === path ? { ...f, contents, baseline: contents } : f))
        );
        setExternallyChanged((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [host]
  );

  /**
   * Create, rename and delete, from the tree.
   *
   * Each refetches rather than patching the tree in place. A local patch has to reproduce the
   * sort order, the skip list and the depth cap to stay correct, and getting any of them
   * subtly wrong shows as a sidebar that disagrees with the disk — the exact failure this
   * phase exists to remove.
   */
  const createEntry = useCallback(
    async (path: string, kind: "file" | "directory") => {
      if (host?.fs === undefined) return;
      setError(undefined);
      try {
        await host.fs.create({ path, kind });
        await refreshTree();
        if (kind === "file") await openFileAtRef.current(path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [host, refreshTree]
  );

  const renameEntry = useCallback(
    async (from: string, to: string) => {
      if (host?.fs === undefined) return;
      setError(undefined);
      try {
        const result = await host.fs.rename({ from, to });
        await refreshTree();
        // Follow the file: an open tab must not keep pointing at a path that no longer
        // exists, or its next save resurrects the old name.
        setFiles((prev) =>
          prev.map((f) =>
            f.path === from || f.path.startsWith(`${from}/`)
              ? { ...f, path: f.path === from ? result.path : `${result.path}${f.path.slice(from.length)}` }
              : f
          )
        );
        setActivePath((prev) => (prev === from ? result.path : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [host, refreshTree]
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (host?.fs === undefined) return;
      setError(undefined);
      try {
        await host.fs.delete({ path });
        await refreshTree();
        // Tabs under a deleted folder become orphans rather than closing: the text is still
        // the user's, and the trash makes the delete recoverable anyway.
        setFiles((prev) =>
          prev.map((f) =>
            f.path === path || f.path.startsWith(`${path}/`) ? { ...f, baseline: null } : f
          )
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [host, refreshTree]
  );

  /**
   * Reopen a folder chosen from File > Open Recent.
   *
   * Main sends the path with the intent and refuses anything not already in its list, so this
   * does not need to validate the path — but it does need to handle the refusal, which is what
   * a folder that has since been moved or deleted produces.
   */
  const openRecent = useCallback(
    async (path: string) => {
      if (host?.fs === undefined) return;
      setOpening(true);
      setError(undefined);
      try {
        const result = await host.fs.openRecent({ path });
        setTree(result.tree);
        setWatch({ watching: result.watching, reason: result.watchReason });
        // Same as `openProject`: a project change empties the strip, which is also what disposes
        // the Monaco models that belonged to the old project's paths.
        setFiles([]);
        setActivePath(undefined);
        setCentreView("chat");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOpening(false);
      }
    },
    [host]
  );

  useEffect(() => {
    const off = window.host?.onShellCommand?.((payload) => {
      const message = payload as { command?: string; path?: string } | undefined;
      if (message?.command === "file.openRecent" && typeof message.path === "string") {
        void openRecent(message.path);
      }
    });
    return off;
  }, [openRecent]);

  const openFileAt = useCallback(
    async (path: string) => {
      if (host?.fs === undefined) return;
      setError(undefined);
      // Already open: just show it. Re-reading would discard whatever is in the buffer,
      // which is the exact bug tabs exist to prevent.
      if (files.some((f) => f.path === path)) {
        setActivePath(path);
        setCentreView("file");
        return;
      }

      /**
       * Refused at the cap, not silently evicted.
       *
       * Evicting the oldest tab is the other obvious answer and it is the wrong one: it throws
       * away a buffer without asking, which is the bug the tab list exists to prevent. Said out
       * loud with the number in it, so the remedy is obvious.
       */
      if (atCapacity(openPaths)) {
        setError(
          `${String(MAX_OPEN_TABS)} files are already open. Close one to open ${path}.`
        );
        return;
      }

      try {
        const file = await host.fs.read({ path });
        /**
         * A binary is reported, not opened.
         *
         * The comment here used to say binary files "land in the catch", and they never did:
         * `fs.readFile(_, "utf8")` never fails, so a PNG opened as a buffer full of replacement
         * characters. Main now says which files are not text, and the answer is a sentence
         * rather than a tab holding nothing.
         */
        if (file.binary) {
          const size = file.bytes === undefined ? "" : ` (${String(file.bytes)} bytes)`;
          setError(`${path} is a binary file${size} and cannot be shown as text.`);
          return;
        }
        setFiles((prev) => [
          ...prev,
          { path, contents: file.contents, baseline: file.contents },
        ]);
        setActivePath(path);
        setCentreView("file");
      } catch (err) {
        // Unreadable paths — permissions, a file deleted between the tree walk and the click.
        // Reporting the path matters; the click that caused it is otherwise invisible.
        setError(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [host, files, openPaths]
  );

  useEffect(() => {
    openFileAtRef.current = openFileAt;
  }, [openFileAt]);

  /**
   * Close one tab: drop the buffer and move the selection.
   *
   * No prompt, because nothing here can be dirty yet — the viewer is read-only. The discard
   * handshake through `fs:confirmDiscard` arrives with editing, and this is the function it will
   * gate.
   */
  const closeFile = useCallback(
    (path: string) => {
      const next = closeTab(openPaths, activePath ?? null, path);
      setFiles((prev) => prev.filter((f) => f.path !== path));
      setActivePath(next.active ?? undefined);
      // Back to the conversation when the last file closes, rather than an empty editor: the
      // strip would otherwise leave you on a tab whose pane says "no file open".
      if (next.active === null) setCentreView("chat");
    },
    [openPaths, activePath]
  );

  /**
   * Open a cross-reference result at the line it named.
   *
   * THE LINE IS USED AGAIN. This took the line and threw it away — `_line`, with a comment
   * saying "there is nothing in this window to reveal it in" — for as long as the centre pane
   * had no editor. Now there is one, so a search hit lands on the line rather than at the top of
   * the file, which is most of what makes search worth using.
   *
   * The reveal is set after `openFileAt` resolves, not beside it. The pane has to be showing the
   * right file before a line in it means anything, and `openFileAt` is what switches it; asking
   * to reveal first would address the file that was open a moment ago.
   */
  const openLocation = useCallback(
    (path: string, line: number, column = 1) => {
      void openFileAt(path).then(() => {
        // The nonce is what makes a repeat request arrive — see `reveal`'s declaration.
        setReveal((prev) => ({ line, column, nonce: (prev?.nonce ?? 0) + 1 }));
      });
    },
    [openFileAt]
  );

  /*
    No save path, no coordinator, no close-with-prompt.

    Everything that stood here was autosave and the machinery around it: a debounce, a dirty
    set, Save As, conflict quarantine when a file changed underneath an unsaved buffer, and a
    confirm-discard prompt for closing a tab with unwritten work. All of it existed because the
    pane was an editor.

    Writes go through `fs:writeWithDiff` and a review step now, which is a different mechanism
    with its own conflict check — content is captured when the diff is proposed and re-checked
    at commit, so a file that moved underneath is refused rather than clobbered.

    Two of the audit's data-loss defects lived in here and are retired rather than fixed: the
    reconcile that decided a buffer was clean, awaited a read, and then wrote into state that
    had changed during the await; and Close Group dropping dirty buffers with no prompt while
    closing a tab asked. Neither has anything left to lose.
  */

  /**
   * Offer the file commands to the shell.
   *
   * This is what makes File > Open Folder, Save, Save All and Close Editor real. Open Folder
   * has been in the menu since the beginning, emitting an intent nobody handled.
   */
  const publishBuildActions = usePublishBuildActions();


  /**
   * The tree with the panel toggles applied.
   *
   * The toggles stay the source of truth for *whether* a pane is open — they are per-destination
   * and read before first paint, and shared with Prep where this grid does not exist. The grid
   * owns where a pane sits and how wide. Reconciling on every render is free: `applyVisibility`
   * returns the same object when nothing changed.
   *
   * `panels.left` and `panels.right` reached Build for the first time here. They existed, had
   * commands and accelerators bound, and were consumed only by the *shell's* section sidebar —
   * which the `code` destination does not have. So Cmd+B toggled a flag nothing read.
   */
  const visibleLayout = useMemo(
    () => applyVisibility(dockLayout, { left: panels.left, right: panels.right, bottom: panels.bottom }),
    [dockLayout, panels.left, panels.right, panels.bottom]
  );

  /*
    No flush before a terminal runs. It existed so a shell would not execute a three-second-old
    autosaved copy of what you had just typed; nothing here holds unwritten text.
  */
  // Explorer or Search in the left rail — one at a time, as every editor does it.
  const [leftView, setLeftView] = useState<"explorer" | "search" | "memory">("explorer");

  const buildActions = useMemo<BuildActions>(
    () => ({
      openProject: () => void openProject(),
      closeProject: () => {
        setTree(undefined);
        setFiles([]);
        setActivePath(undefined);
      },
      openMemory: () => {
        setPanel("left", true);
        setLeftView("memory");
      },
      findInFiles: () => {
        // The rail has to be showing for the panel to be reachable.
        setPanel("left", true);
        setLeftView("search");
      },
      openTerminal: () => {
        // Opening the dock spawns one, so adding a tab as well here would give two.
        if (panels.bottom) terminals.open();
        else setPanel("bottom", true);
      },
      focusTerminal: () => {
        setPanel("bottom", true);
        setDockTab("terminal");
      },
      closeTerminal: () => setPanel("bottom", false),
      clearTerminal: () => terminals.clearActive(),
      terminalOpen: panels.bottom,
      hasProject: tree !== undefined,
      hasActive: activePath !== undefined,
      // Structure only. Which panels are open is `panels`, and reset has no business touching it.
      resetLayout: () => setDockLayout(defaultWorkspaceLayout()),
      layoutIsDefault: isDefaultWorkspaceLayout(dockLayout),
    }),
    [openProject, activePath, tree, setPanel, panels.bottom, setLeftView, setDockTab, terminals, dockLayout]
  );

  useEffect(() => {
    publishBuildActions(buildActions);
    return () => publishBuildActions(undefined);
  }, [publishBuildActions, buildActions]);


  if (!ready) return null;

  // A Study window reaching this route has no `host.fs` at all — not a stub that throws, but
  // an absent namespace. Say so plainly rather than rendering a dead IDE.
  // Normally present. Absent in two cases: the same source built for the web, and a
  // restricted `--mode=study` window, where the namespace does not exist at all rather than
  // throwing on use.
  if (host?.fs === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-light text-ink">The editor needs the desktop app</h1>
          <p className="mt-2 text-sm text-ink-3">
            Working on your own files needs filesystem access, which only the desktop build
            has. Everything else — problems, interviews and the tutor — works here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ide-gutter">

      {error !== undefined && (
        <p className="shrink-0 border-b border-line bg-ide-panel px-4 py-2 text-xs text-diff-remove-ink">
          {error}
        </p>
      )}

      {/*
        Four panes in a tree, resizable and collapsible.

        This was three nested `SplitContainer`s over two separate size arrays. `DockGrid` renders
        one tree instead: nesting is the only structure, and the arithmetic — which pane is where,
        how minimums compose, what a drag does — is pure and tested in `lib/layout/` rather than
        living in this file.

        **The panes are positioned, never unmounted.** A hidden pane gets a zero rectangle and
        keeps its subtree, which is why collapsing the dock no longer ends its terminals. The
        editor groups below stay a `SplitContainer`: they have their own model, their own tabs and
        their own focus rules, and folding them into this tree would make one structure answer
        both "where is the terminal" and "which split has focus".
      */}
      <div className="min-h-0 flex-1 p-1">
      <DockGrid
        layout={visibleLayout}
        onLayoutChange={setDockLayout}
        keyFor={(pane) => pane}
        constraintsFor={workspaceConstraints}
        // Panes can be rearranged here. The tree is persisted, so where you put them is where
        // they are next time.
        movable
        renderPane={(pane) => (
          /*
            `h-full` is load-bearing. The grid positions this box absolutely and gives it a height,
            but a plain block child inside it sizes to its *content* — without this the panes
            render at the height of whatever is in them and the rest of the window is empty, which
            looks like the layout failed rather than like a missing height rule.
          */
          <div className="flex h-full min-h-0 min-w-0 flex-col">
        {pane === "left" ? (
          leftView === "search" ? (
          <SearchPanel
            onOpenMatch={openLocation}
            onClose={() => setLeftView("explorer")}
          />
        ) : leftView === "memory" ? (
          <MemoryPanel
            onOpenMatch={openLocation}
            onClose={() => setLeftView("explorer")}
          />
        ) : (
          <FileTree
            tree={tree}
            activePath={openFile?.path}
            onOpenFile={(path) => void openFileAt(path)}
            onOpenProject={() => void openProject()}
            onRefresh={() => void refreshTree()}
            onCreate={(path, kind) => void createEntry(path, kind)}
            onRename={(from, to) => void renameEntry(from, to)}
            onDelete={(path) => void deleteEntry(path)}
            watching={watch.watching}
            watchReason={watch.reason}
            busy={opening}
          />
          )
        ) : pane === "chat" ? (
          /*
            The centre pane: the conversation and the open files, as tabs.

            No `onClose`. The prop is optional and its button renders only when it is passed, so
            omitting it is the whole change — and it should be omitted, because the centre is the
            one pane `applyVisibility` never collapses. A close button that cannot close anything
            is worse than none, and its accelerator would toggle a flag nothing reads.

            BOTH CHILDREN ARE RENDERED, ALWAYS. `hidden` switches which one you see, exactly as
            `BottomDock` does with its panes and for the same class of reason — except that here
            each child is expensive in a different way. Gating on `centreTab.kind === "chat"`
            would unmount `AssistantPanel` on every tab click, dropping the transcript, the
            streaming cancel handle and the session id; and unmounting `EditorPane` would dispose
            the editor and every buffer's undo stack. Both failures look like the app forgetting
            what you were doing.

            The pane owns the frame now, which is why `AssistantPanel` is no longer wrapped in one
            of its own: two nested `IdePanel`s draw two borders (`IdeFrame.tsx`).
          */
          <IdePanel className="min-h-0">
            <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-ide-bar">
              <EditorTabs
                paths={openPaths}
                tab={centreTab}
                onSelect={(next) => {
                  if (next.kind === "chat") {
                    setCentreView("chat");
                    return;
                  }
                  setActivePath(next.path);
                  setCentreView("file");
                }}
                onClose={closeFile}
              />
            </div>

            <div className="min-h-0 flex-1">
              <div hidden={centreTab.kind !== "chat"} className="h-full">
                <AssistantPanel
                  host={host}
                  model={DEFAULT_MODEL}
                  openFile={openFile}
                  onOpenLocation={openLocation}
                  onAgentLog={(text) => appendOutput("agent", text)}
                  onRunView={setRunView}
                />
              </div>

              <div hidden={centreTab.kind !== "file"} className="h-full">
                <EditorPane
                  path={openFile?.path}
                  contents={openFile?.contents}
                  openPaths={openPaths}
                  visible={centreTab.kind === "file"}
                  reveal={reveal}
                  changedOnDisk={
                    openFile !== undefined && externallyChanged.has(openFile.path)
                  }
                  watching={watch.watching}
                />
              </div>
            </div>
          </IdePanel>
        ) : pane === "dock" ? (
          <IdePanel className="min-h-0 overflow-hidden bg-ide-code">
            <BottomDock
              visible={panels.bottom}
              tab={dockTab}
              onTabChange={setDockTab}
              terminals={terminals}
              output={output}
              outputChannel={outputChannel}
              onOutputChannelChange={setOutputChannel}
              onClearOutput={() => setOutput((prev) => clearChannel(prev, outputChannel))}
              onTerminalExit={(id, code, signal) =>
                appendOutput(
                  "terminal",
                  // The pane shows this too, but a pane you switched away from is `hidden`, so a
                  // build that failed in a background terminal otherwise left no trace at all.
                  signal === null
                    ? `Terminal ${id} exited with code ${code}`
                    : `Terminal ${id} killed by signal ${signal}`
                )
              }
              onClose={() => setPanel("bottom", false)}
            />
          </IdePanel>
        ) : (
          <IdePanel className="flex h-full min-w-0 flex-col bg-ide-code">
            <WorkspaceSurface
              tab={workspaceTab}
              onTabChange={setWorkspaceTab}
              run={runView}
              hasProject={tree !== undefined}
              opening={opening}
              onOpenProject={() => void openProject()}
              contextPath={openFile?.path}
              host={host}
              projectRoot={tree?.root}
            />
          </IdePanel>
        )}
          </div>
        )}
      />
      </div>
    </div>
  );
}
