"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import MenuBar from "./MenuBar";
import ActivityBar from "./ActivityBar";
import SectionSidebar from "./SectionSidebar";
import CommandPalette, { type PaletteItem } from "./CommandPalette";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting } from "@/lib/shell/report-error";
import ShortcutsDialog from "./ShortcutsDialog";
import StatusBar from "./StatusBar";
import { AppBackdrop, ToastProvider } from "@/components/app";
import { AccountProvider } from "@/lib/account/AccountProvider";
import { problemPosition, slugAtPosition } from "@/lib/curriculum";
import { PROJECTS } from "@/lib/projects";
import { EditorHostProvider } from "@/lib/shell/editor-host";
import {
  WorkspaceActionsProvider,
  useWorkspaceActions,
} from "@/lib/shell/workspace-actions";
import { BuildActionsProvider, useBuildActions } from "@/lib/shell/build-actions";
import { useEditorCommands } from "@/lib/shell/editor-commands";
import { PanelsProvider, usePanelState } from "@/lib/shell/usePanels";
import {
  CommandRegistryProvider,
  useCommands,
  useRegisterCommands,
  useSetCommandChecked,
  type CommandBinding,
} from "@/lib/shell/commands";
import { MENU_IDS, MENU_LABELS } from "@shared/commands";
import { formatAccelerator } from "@/lib/shell/keybindings";
import {
  DESTINATIONS,
  destinationForPath,
  isAccountRoute,
  isModelsRoute,
  isPlatformRoute,
  isBareRoute,
  type DestinationId,
} from "@/lib/shell/destinations";

/**
 * The frame every surface lives in.
 *
 * Mounted from the root layout so it survives navigation — panel state, the selected
 * destination and the palette all persist as you move between routes. A shell mounted per
 * route group would rebuild itself on every link, losing that state and flashing.
 *
 * Renders children bare in two cases: on routes that are documents rather than tools, and
 * in the web build, where there is no frameless window to draw a title bar for and the page
 * should look like an ordinary page.
 */

/**
 * Derived, not written down. This was a hand-copied list of the same eight labels main
 * already had in `MENU_LABELS` — two sources for one fact, in two processes, with nothing
 * to keep them in step.
 */
const MENUS = MENU_IDS.map((id) => ({ id, label: MENU_LABELS[id] }));

/**
 * The provider has to sit above the shell, because the shell is what reads it.
 *
 * A thin wrapper rather than moving the provider into the root layout: this keeps the whole
 * arrangement — who publishes, who consumes — in one file instead of splitting it across a
 * layout that otherwise knows nothing about buffers.
 *
 * `AccountProvider` sits directly inside the toasts because it raises them ("Signed in as…", "Your
 * session ended"), and above everything else because the title bar, the Models page and a failed
 * chat all open the same sign-in dialog.
 */
export default function Workbench({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AccountProvider>
        <EditorHostProvider>
          <BuildActionsProvider>
            <WorkspaceActionsProvider>
              <PanelsForPath>
                <CommandRegistryProvider>
                  <WorkbenchFrame>{children}</WorkbenchFrame>
                </CommandRegistryProvider>
              </PanelsForPath>
            </WorkspaceActionsProvider>
          </BuildActionsProvider>
        </EditorHostProvider>
      </AccountProvider>
    </ToastProvider>
  );
}

/**
 * Panel state, scoped to the destination the current route belongs to.
 *
 * Its own component because the provider needs the destination and the destination comes from
 * the pathname — and `WorkbenchFrame` is a *consumer* of the panels, so it cannot also be the
 * thing that provides them.
 */
function PanelsForPath({ children }: { children: React.ReactNode }) {
  const destination = destinationForPath(usePathname());
  return <PanelsProvider destination={destination.id}>{children}</PanelsProvider>;
}

function WorkbenchFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [isDesktop, setIsDesktop] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [ready, setReady] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * Before anything else the shell does, so a failure during its own setup is recorded.
   *
   * Its own effect with no dependencies: folding it into the platform-detection effect below
   * would tie teardown to a value that changes, and re-installing listeners on every change
   * is how the same error comes to be reported four times.
   */
  useEffect(() => installErrorReporting(), []);

  useEffect(() => {
    setIsDesktop(window.host !== undefined);
    // `userAgent` rather than the deprecated `platform`, and only for a cosmetic decision —
    // whether to draw menus in the window and how far to indent past the traffic lights.
    setIsMac(/Mac/i.test(window.navigator.userAgent));
    setReady(true);
  }, []);

  const destination = destinationForPath(pathname);

  /**
   * Account is not a product, so it lights no rail icon and names itself in the status bar.
   *
   * `destinationForPath` has to return *something*, and its fallback is the IDE — correct for
   * an unknown route, wrong for this one. Without the check the account page reported itself
   * as Code in two places at once.
   */
  const onAccountRoute = isAccountRoute(pathname);
  /**
   * Platform rather than product — account, models, and whatever comes next.
   *
   * `onAccountRoute` stays because the status bar names the specific page. The rail only
   * needs to know that *no* product owns this route, and asking that once is what keeps the
   * third platform page from being a fourth `||` in four places.
   */
  const onPlatformRoute = isPlatformRoute(pathname);
  const { panels, toggle, setPanel } = usePanelState();

  /**
   * Real counts, not written down.
   *
   * These were hardcoded to `{ problems: 12, interviews: 3, projects: 2 }`, and the catalogue
   * has since grown to 14 — so the rail said 12 while the dashboard beside it said 14. A
   * number that disagrees with the page it points at is worse than no number, because the
   * user cannot tell which one is lying.
   *
   * Projects come from the module, problems from main. Interviews have no source yet, so
   * they get no count rather than an invented one.
   */
  const [problems, setProblems] = useState<Array<{ id: string; title: string }>>([]);
  const counts = useMemo(
    () => ({ problems: problems.length || undefined, projects: PROJECTS.length }),
    [problems.length]
  );

  useEffect(() => {
    let cancelled = false;
    void window.host?.problems
      ?.list()
      .then((result) => {
        if (!cancelled) {
          // Kept whole rather than counted and discarded: the palette needs the titles, and
          // this is the same call that was already being made for the sidebar's number.
          setProblems(result.problems as Array<{ id: string; title: string }>);
        }
      })
      .catch(() => {
        // No count is the correct fallback: the rail keeps working, it just says less.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goToDestination = useCallback(
    (id: DestinationId) => {
      const target = DESTINATIONS.find((d) => d.id === id);
      if (target !== undefined) router.push(target.home);
    },
    [router]
  );

  /**
   * The rail click, which is not the same gesture as the Go command.
   *
   * Clicking the destination you are already in toggles its section list. That is the way
   * back from collapsing the sidebar by its header: the header removes the panel, so it
   * cannot also be what restores it, and the rail is the one control for this destination
   * that is on screen either way.
   *
   * `go.prep` and `go.code` keep using `goToDestination`, which only ever navigates — a menu
   * item called "Interview Prep" that hid a panel because you were already there would be
   * doing something its label does not say.
   */
  const selectFromRail = useCallback(
    (id: DestinationId) => {
      const target = DESTINATIONS.find((d) => d.id === id);
      if (target === undefined) return;

      // `destination` falls back to the IDE on an account route, so without the account check
      // clicking Code from /profile would toggle a panel instead of taking you to the editor.
      const alreadyHere = id === destination.id && !onPlatformRoute;
      if (alreadyHere && target.sections.length > 0) {
        toggle("left");
        return;
      }
      router.push(target.home);
    },
    [destination.id, onPlatformRoute, router, toggle]
  );

  /**
   * The commands the shell itself can service.
   *
   * This replaced an if/else chain over command strings that silently dropped anything it
   * did not recognise — which is how six menu items came to emit intents nobody handled while
   * looking perfectly live. Now a command exists because something binds it, so the chain
   * cannot fall through: an unbound id is greyed in the menu and absent from the palette.
   *
   * Panel toggles bind here rather than in `MenuBar` because the menu needs them too, and the
   * bar's buttons and the menu's checkboxes must not be able to disagree about what is open.
   */
  const shellCommands = useMemo<CommandBinding[]>(
    () => [
      // Toggle, not open: ⌘K closing the palette again is what the hand-rolled listener did,
      // and losing that on the way through the registry would be a quiet regression.
      { id: "view.commandPalette", run: () => setPaletteOpen((open) => !open) },
      { id: "view.togglePanel.left", run: () => toggle("left") },
      { id: "view.togglePanel.right", run: () => toggle("right") },
      { id: "view.togglePanel.bottom", run: () => toggle("bottom") },

      { id: "go.prep", run: () => goToDestination("prep") },
      { id: "go.code", run: () => goToDestination("code") },
      { id: "go.dashboard", run: () => router.push("/homepage") },
      { id: "go.problems", run: () => router.push("/problems") },
      { id: "go.interviews", run: () => router.push("/interviews") },
      { id: "go.projects", run: () => router.push("/projects") },
      { id: "go.account", run: () => router.push("/profile") },
      { id: "go.models", run: () => router.push("/models") },
      { id: "go.back", run: () => router.back() },
      { id: "go.forward", run: () => router.forward() },

      { id: "file.preferences", run: () => router.push("/profile") },

      /**
       * The shell's fallback for Open Folder: get to the IDE, where the real one lives.
       *
       * `BuildWorkspace` binds the same id with the actual dialog and mounts later, so it
       * wins while you are in Build mode. The registry's last-binding-wins rule is what lets
       * both exist without either knowing about the other.
       */
      { id: "file.openFolder", run: () => router.push("/build") },

      /**
       * The shortcut list, which the registry already knows in full.
       *
       * Bound in the shell rather than main because it is a renderer surface, and always
       * available: "what are the shortcuts" is a question you can ask from anywhere.
       */
      { id: "help.keyboardShortcuts", run: () => setShortcutsOpen(true) },
    ],
    [toggle, goToDestination, router]
  );

  useRegisterCommands(shellCommands);

  /**
   * Move through the catalogue without going back to the list.
   *
   * Bound only while you are on a problem — the commands are meaningless on the dashboard, and the
   * registry expresses that by there being nothing to bind.
   *
   * Where in the curriculum the open problem sits, whatever form the URL took.
   *
   * The pattern used to be `(\d+)`, which meant the chevrons were dead on any slug route — and
   * every route is a slug route now, because a numeric route id renumbers when a problem is
   * inserted mid-list. `problemPosition` accepts either form, so this keeps working if a numeric
   * link survives somewhere.
   *
   * `undefined` when the path is not a problem at all, which is what makes these commands absent
   * rather than disabled on other surfaces.
   */
  const problemIndex = useMemo(() => {
    const match = /^\/problems\/([^/]+)/.exec(pathname);
    return match?.[1] === undefined ? undefined : problemPosition(match[1]);
  }, [pathname]);

  const problemCommands = useMemo<CommandBinding[]>(() => {
    if (problemIndex === undefined || problems.length === 0) return [];
    return [
      // Counted in positions, because "next" is an ordinal idea — then converted back to a slug,
      // because that is what the route is addressed by.
      {
        id: "go.previousProblem",
        run: () => {
          const slug = slugAtPosition(problemIndex - 1);
          if (slug !== undefined) router.push(`/problems/${slug}`);
        },
        enabled: problemIndex > 1,
      },
      {
        id: "go.nextProblem",
        run: () => {
          const slug = slugAtPosition(problemIndex + 1);
          if (slug !== undefined) router.push(`/problems/${slug}`);
        },
        enabled: problemIndex < problems.length,
      },
    ];
  }, [problemIndex, problems.length, router]);

  useRegisterCommands(problemCommands);

  // Find, Replace, the selection and line operations, Go to Line/Definition/References.
  // Binds nothing when no editor is mounted, which is what greys the Edit and Selection
  // menus on the dashboard without a single route check.
  useEditorCommands();

  /**
   * Run, Submit and Reset, when a workspace is mounted to provide them.
   *
   * `enabled` rather than simply not binding, because "there is a workspace but it is mid-run"
   * is a different state from "there is no workspace" and the user should see the difference:
   * the item is present and greyed while a run is in flight, rather than vanishing.
   *
   * `run.stop` is now bound, and its enablement is the inverse of the others: it is live
   * exactly while something is running. It was greyed for three phases because `exec:cancel`
   * took the runId `gradeSubmission` mints internally, and nothing here could name a run —
   * the seam now sends an attempt id it chose itself, so Stop has a handle from the first
   * millisecond of a run. See `exec/attempts.ts` in main for why an attempt is not a run.
   */
  const workspace = useWorkspaceActions();

  const workspaceCommands = useMemo<CommandBinding[]>(() => {
    if (workspace === undefined) return [];
    return [
      { id: "run.execute", run: workspace.run, enabled: workspace.canRun && !workspace.busy },
      { id: "run.submit", run: workspace.submit, enabled: workspace.canSubmit && !workspace.busy },
      { id: "run.reset", run: workspace.reset, enabled: !workspace.busy },
      { id: "run.stop", run: workspace.stop, enabled: workspace.busy },
    ];
  }, [workspace]);

  /**
   * The file commands, when Build mode is mounted to provide them.
   *
   * `file.openFolder` binds here too, and wins over the shell's route-to-/build fallback
   * because this mounts later — the registry's last-binding-wins rule, doing the job it was
   * designed for with no coordination between the two.
   */
  const build = useBuildActions();

  const buildCommands = useMemo<CommandBinding[]>(() => {
    if (build === undefined) return [];
    return [
      { id: "file.openFolder", run: build.openProject },
      { id: "file.closeFolder", run: build.closeProject, enabled: build.hasProject },
      /*
        No save family. The workspace views files rather than authoring them — changes arrive as
        diffs the assistant proposes and the user reviews — so there is never an unsaved buffer
        for Save, Save All or Save As to act on. They are gone from the command table rather
        than greyed, because a permanently unavailable menu item is a worse answer than no item.
      */

      /**
       * The Terminal menu, which has carried two hardcoded `enabled: false` placeholders
       * since it was written. They are derived now: a project must be open, because main
       * refuses to spawn a shell without one — the folder-picker consent is what makes a
       * terminal legitimate.
       */
      { id: "edit.findInFiles", run: build.findInFiles, enabled: build.hasProject },
      { id: "edit.projectMemory", run: build.openMemory, enabled: build.hasProject },

      /*
        No editor groups. Splitting existed to compare two files while typing in them; the pane
        shows one file, read-only, and the panes that matter are the grid's — which have their
        own move and reset commands.
      */
      // Greyed when the layout is already the default: the item is there to undo a rearrangement,
      // and offering it when there is nothing to undo teaches people to ignore it.
      { id: "view.resetLayout", run: build.resetLayout, enabled: !build.layoutIsDefault },

      { id: "terminal.new", run: build.openTerminal, enabled: build.hasProject },
      { id: "terminal.focus", run: build.focusTerminal, enabled: build.hasProject },
      { id: "terminal.kill", run: build.closeTerminal, enabled: build.terminalOpen },
      // Clears the terminal you are looking at. Unbound until the dock could hold more than one,
      // when "the terminal panel owns its buffer" stopped describing anything.
      { id: "terminal.clear", run: build.clearTerminal, enabled: build.terminalOpen },
    ];
  }, [build]);

  /*
    No flush wrapper any more.

    `FLUSH_BEFORE` existed because Run, Submit and a new terminal all execute what is on disk,
    and a three-second-old autosaved copy is a wrong answer that looks like a right one. The
    workspace no longer holds unsaved buffers — it views files and the assistant writes them
    through a reviewed diff — so there is nothing pending to write before those commands run.
  */


  useRegisterCommands(workspaceCommands);
  useRegisterCommands(buildCommands);

  /**
   * Main asking whether the window may close.
   *
   * Not a registry command: it is a handshake rather than something a user invokes, it has no
   * menu item, and main starts a three-second timer the moment it asks. Saving everything is
   * the right default — the alternative is prompting per file at shutdown, which is the
   * behaviour everyone clicks through without reading.
   */
  useEffect(() => {
    const off = window.host?.onShellCommand?.((payload) => {
      const command = (payload as { command?: string } | undefined)?.command;
      if (command !== "window.confirmClose") return;

      /*
        Nothing to save, so nothing to weigh.

        This used to attempt a save-all and then allow the close on *either* outcome — success
        and failure both called `finish`, so a file that failed to write was closed over
        silently. That whole path is gone rather than fixed: a read-only workspace has no
        unsaved buffer to lose.
      */
      void window.host?.window?.allowClose?.();
    });
    return off;
  }, [build]);

  /**
   * Menu items and accelerators arrive as intents from main; the registry runs them.
   *
   * Main deliberately does not model the UI — it knows the user chose "Toggle Panel", not
   * which panels exist or whether one is open.
   */
  const { list: commands, run: runCommand } = useCommands();

  useEffect(() => {
    const off = window.host?.onShellCommand?.((payload) => {
      const command = (payload as { command?: string } | undefined)?.command;
      if (command !== undefined) runCommand(command as Parameters<typeof runCommand>[0]);
    });
    return off;
  }, [runCommand]);

  // The menu's checkboxes read this, so "Primary Side Bar" shows a tick when the rail is open.
  const setChecked = useSetCommandChecked();
  useEffect(() => {
    setChecked("view.togglePanel.left", panels.left);
    setChecked("view.togglePanel.right", panels.right);
    setChecked("view.togglePanel.bottom", panels.bottom);
  }, [setChecked, panels]);


  /**
   * Group order is the order the groups first appear here, and it is a judgement about what
   * you are most likely to be reaching for: a problem, then a project, then a place, then a
   * command.
   */
  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      /*
        No "Open files" group. It listed the buffers the editor had open so you could switch
        between them; the workspace shows one file at a time, chosen from the tree or by the
        assistant, so the group would always have held a single row — the one already on screen.
      */
      ...problems.map((problem, index) => ({
        id: `problem:${problem.id}`,
        label: problem.title,
        hint: `#${index + 1}`,
        group: "Problems",
        // The hint still shows a position because that is a useful thing to read, but the route is
        // the id — a position that shifts when content is inserted is not an address.
        run: () => router.push(`/problems/${problem.id}`),
      })),
      ...PROJECTS.map((project) => ({
        id: `project:${project.slug}`,
        label: project.title,
        hint: "Project",
        group: "Projects",
        run: () => router.push(`/projects/${project.slug}`),
      })),
      /**
       * Destinations and their sections.
       *
       * A destination with no sections — the IDE, whose left panel is a file tree — is its
       * own entry. There used to be a hardcoded `{ id: "code" }` immediately after this,
       * which duplicated the entry this branch already produces: two rows with the same
       * label and the same React key.
       */
      ...DESTINATIONS.flatMap((d) =>
        d.sections.length === 0
          ? [
              {
                id: `go:${d.id}`,
                label: d.label,
                hint: "Go",
                group: "Go",
                run: () => goToDestination(d.id),
              },
            ]
          : d.sections.map((s) => ({
              id: `go:${s.href}`,
              label: s.label,
              hint: d.label,
              group: "Go",
              run: () => router.push(s.href),
            }))
      ),

      /**
       * Account, which the Go group above cannot produce.
       *
       * That group is built from `DESTINATIONS`, and account deliberately belongs to no
       * destination — while the registry sweep below excludes every `go.*` id, because the
       * destinations know better labels for them. Account falls through both, so it is named
       * here explicitly. It used to appear as an Interview Prep section; losing it from the
       * palette when it moved out of the study product would be a quiet downgrade of the one
       * surface people search from.
       */
      {
        id: "go:account",
        label: "Account",
        hint: "Profile and preferences",
        group: "Go",
        run: () => router.push("/profile"),
      },
      {
        id: "go:models",
        label: "Models",
        hint: "Local model manager",
        group: "Go",
        run: () => router.push("/models"),
      },

      /**
       * Everything the registry currently offers, minus `go.*`.
       *
       * The Go group above is built from `DESTINATIONS`, which knows which destination a
       * section belongs to and can say "Interview Prep" rather than "Go" — a better hint
       * than the registry can produce. So the registry supplies the rest: Find, Save, Run,
       * Format Document, and everything added in later phases, each with its shortcut.
       *
       * Filtered to enabled, which is what makes this honest. The palette lists what you can
       * actually do right now rather than the whole table, so it stays in step with the menu
       * without either knowing about the other.
       */
      ...commands
        .filter((command) => command.enabled && !command.id.startsWith("go."))
        .map((command) => ({
          id: `cmd:${command.id}`,
          label: command.label,
          ...(command.accelerator !== null
            ? { hint: formatAccelerator(command.accelerator, isMac) }
            : {}),
          group: "Commands",
          run: () => runCommand(command.id),
        })),
    ],
    [goToDestination, router, problems, commands, runCommand, isMac]
  );

  // Until the platform is known, render nothing rather than guessing. Guessing "desktop"
  // paints a title bar the web build then removes; guessing "web" flashes an unframed page
  // inside a frameless window, which looks like the app failed to load.
  if (!ready) return null;

  if (!isDesktop || isBareRoute(pathname)) return <>{children}</>;

  return (
    // `relative isolate` is load-bearing, not cosmetic: `AppBackdrop` paints at `-z-20`, and
    // without a stacking context here it falls behind the root background and disappears —
    // taking with it the only thing the chrome's glass has to refract. That failure is
    // silent: the bar still renders, just as a flat grey band.
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-ide-gutter text-ink-2">
      {/* `workspace` tone, not `page`: the IDE fills the viewport with panels rather than
          scrolling a document past a masthead, so the page-height gradient would lift the
          whole editor region into grey instead of falling off behind the chrome. */}
      <AppBackdrop tone="workspace" />

      <MenuBar
        menus={MENUS}
        panels={panels}
        onTogglePanel={toggle}
        onOpenPalette={() => setPaletteOpen(true)}
        isMac={isMac}
      />

      <div className="flex min-h-0 flex-1">
        <ActivityBar
          active={onPlatformRoute ? null : destination.id}
          sidebarOpen={panels.left}
          onSelect={selectFromRail}
          onOpenModels={() => router.push("/models")}
          onModelsRoute={isModelsRoute(pathname)}
          onOpenSettings={() => router.push("/profile")}
        />

        {/* The IDE has no section list — its left panel is the file tree, which the
            destination owns. Rendering an empty 240px rail there would be worse than
            yielding the slot. */}
        {panels.left && destination.sections.length > 0 && (
          <SectionSidebar
            destination={destination}
            pathname={pathname}
            counts={counts}
            onCollapse={() => setPanel("left", false)}
          />
        )}

        {/*
          Around the page, not around the window.

          A crashing page leaves the title bar, the rail and the menus alive — so you can still
          navigate away, open the log, or close the window. Wrapping the whole workbench would
          take those down with it and leave a frameless blank rectangle with no way out, which
          is the failure this exists to prevent.
        */}
        <main className="min-w-0 flex-1 overflow-hidden">
          <ErrorBoundary region="page">{children}</ErrorBoundary>
        </main>
      </div>

      {/* Outside the panel row, so it spans the full width including under the activity rail
          — a status bar that starts 48px in reads as belonging to the content rather than to
          the window. */}
      <StatusBar
        context={
          onAccountRoute ? "Account" : isModelsRoute(pathname) ? "Models" : destination.label
        }
      />

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
