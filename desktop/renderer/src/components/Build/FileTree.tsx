"use client";

import { useEffect, useRef, useState } from "react";
import { IdePanel, IdeBar, EmptyState } from "@/components/app";
import { FileIcon, FolderIcon } from "./FileIcon";
import { Breadcrumbs } from "./Breadcrumbs";
import { encodeRefDrag, REF_MIME } from "@/lib/build/context-refs";

/**
 * The project sidebar.
 *
 * Rendered from the bounded tree `fs.openProject` returns — the whole thing arrives in one
 * response, so expansion here is purely visual and never hits IPC.
 *
 * The `truncated` notice is not decoration. The walk stops at 10k entries, and a tree that
 * silently stops reads as "your project has no `src/`" — which sends the user hunting for a
 * bug in their own repo rather than in ours.
 *
 * The tree was read-only until now: it could show a project but not change one, so creating a
 * file meant reaching for a terminal. It gains a context menu, inline rename and a refresh —
 * and it reports when main is not watching, because a sidebar that has quietly stopped
 * tracking disk is worse than one that never claimed to.
 */

interface FileTreeProps {
  tree: BuildProjectTree | undefined;
  activePath: string | undefined;
  onOpenFile: (path: string) => void;
  onOpenProject: () => void;
  onRefresh: () => void;
  onCreate: (path: string, kind: "file" | "directory") => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  /** False when main could not watch the project — surfaced, never swallowed. */
  watching: boolean;
  watchReason: string | null;
  busy?: boolean;
}

/** Which row's menu is open, and where to draw it. */
interface MenuTarget {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
}

/** A row that has become a text input: either a new entry or a rename in progress. */
interface EditTarget {
  /** Directory the new entry goes in, or the path being renamed. */
  parent: string;
  mode: "create-file" | "create-directory" | "rename";
  initial: string;
}

export default function FileTree({
  tree,
  activePath,
  onOpenFile,
  onOpenProject,
  onRefresh,
  onCreate,
  onRename,
  onDelete,
  watching,
  watchReason,
  busy = false,
}: FileTreeProps) {
  const [menu, setMenu] = useState<MenuTarget | undefined>(undefined);
  const [edit, setEdit] = useState<EditTarget | undefined>(undefined);

  // Any click elsewhere, or Escape, dismisses the menu. Without this it survives the action
  // that opened it and hangs over the tree.
  useEffect(() => {
    if (menu === undefined) return;
    const close = () => setMenu(undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const beginCreate = (parent: string, kind: "file" | "directory") => {
    setMenu(undefined);
    setEdit({ parent, mode: kind === "file" ? "create-file" : "create-directory", initial: "" });
  };

  const commitEdit = (name: string) => {
    const target = edit;
    setEdit(undefined);
    const trimmed = name.trim();
    if (target === undefined || trimmed === "") return;
    // No separators: creating `a/b/c.py` from one field is a path the user cannot see the
    // shape of, and main would resolve it relative to the project rather than the folder they
    // clicked. One name, one level.
    if (trimmed.includes("/") || trimmed.includes("\\")) return;

    if (target.mode === "rename") {
      const parent = target.parent.includes("/")
        ? target.parent.slice(0, target.parent.lastIndexOf("/"))
        : "";
      onRename(target.parent, parent === "" ? trimmed : `${parent}/${trimmed}`);
    } else {
      const path = target.parent === "" ? trimmed : `${target.parent}/${trimmed}`;
      onCreate(path, target.mode === "create-file" ? "file" : "directory");
    }
  };

  return (
    <IdePanel>
      {/* `IdeBar` rather than a hand-rolled row: it is `h-9`, and every other toolbar in
          the product is too. Three columns with three different bar heights is most of what
          made this screen read as unfinished. */}
      <IdeBar>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-3">
          {tree?.name ?? "Explorer"}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {tree !== undefined && (
            <>
              <button
                type="button"
                onClick={() => beginCreate("", "file")}
                title="New file in the project root"
                aria-label="New file"
                className="rounded-md border border-line px-1.5 py-0.5 text-[11px] leading-none text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                ＋
              </button>
              <button
                type="button"
                onClick={onRefresh}
                title={
                  watching
                    ? "Re-read the folder"
                    : (watchReason ?? "Re-read the folder — external changes are not detected")
                }
                aria-label="Refresh"
                className={`rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-colors duration-150 ease-void hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${
                  // Not watching is a real state with a real consequence, so the control that
                  // compensates for it is the one that draws attention.
                  watching ? "border-line text-ink-2 hover:border-line-strong"
                    : "border-diff-remove-ink text-diff-remove-ink"
                }`}
              >
                ⟳
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onOpenProject}
            disabled={busy}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors duration-150 ease-void hover:border-line-strong hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-ide-panel disabled:opacity-40"
          >
            {tree === undefined ? "Open…" : "Change"}
          </button>
        </div>
      </IdeBar>

      {/*
        The open file's path, in the panel that is about the project.

        It used to sit in a 36px toolbar above the editor whose only other content was a
        comment explaining what had moved out of it — so with no file open the workbench drew
        an empty stripe across its full width. Here it costs 24px in one column and only when
        there is something to say.

        A second row rather than a second item in `IdeBar`: that bar is `h-9`, that height is
        load-bearing, and it already carries three buttons and the project name.
      */}
      {activePath !== undefined && (
        <div className="flex h-6 shrink-0 items-center border-b border-line bg-ide-bar/40 px-3">
          <Breadcrumbs path={activePath} />
        </div>
      )}

      {tree?.truncated === true && (
        <p className="border-b border-line px-3 py-2 text-[11px] text-ink-3">
          Large project — only the first 10,000 entries are listed.
        </p>
      )}

      {tree !== undefined && !watching && watchReason !== null && (
        // Said once, plainly. The alternative is a sidebar that looks current and is not.
        <p className="border-b border-line px-3 py-2 text-[11px] text-diff-remove-ink">{watchReason}</p>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {tree === undefined ? (
          // Deliberately quiet: the editor column owns the call to action, and two adjacent
          // columns each telling you to open a folder is the same instruction twice.
          <EmptyState size="sm" title="No folder open" className="py-10" />
        ) : (
          <ul role="tree">
            {edit?.parent === "" && edit.mode !== "rename" && (
              <NameInput initial={edit.initial} depth={0} onCommit={commitEdit} onCancel={() => setEdit(undefined)} />
            )}
            {tree.entries.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onContextMenu={setMenu}
                edit={edit}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEdit(undefined)}
              />
            ))}
          </ul>
        )}
      </div>

      {menu !== undefined && (
        <div
          role="menu"
          // Fixed, at the pointer. Positioning it inside the scrolling list would clip it at
          // the panel edge — the same stacking trap the notification bell hit.
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 min-w-40 rounded-md border border-line bg-ide-panel py-1 text-sm shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "directory" && (
            <>
              <MenuItem label="New File…" onClick={() => beginCreate(menu.path, "file")} />
              <MenuItem label="New Folder…" onClick={() => beginCreate(menu.path, "directory")} />
              <div className="my-1 h-px bg-line" />
            </>
          )}
          <MenuItem
            label="Rename…"
            onClick={() => {
              setMenu(undefined);
              setEdit({
                parent: menu.path,
                mode: "rename",
                initial: menu.path.split("/").pop() ?? menu.path,
              });
            }}
          />
          <MenuItem
            label="Delete"
            // No confirmation dialog: main moves it to the OS trash, so the undo is where the
            // user already knows to look. A prompt for a recoverable action is the kind of
            // friction people learn to click through.
            onClick={() => {
              setMenu(undefined);
              onDelete(menu.path);
            }}
          />
        </div>
      )}
    </IdePanel>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1 text-left text-ink-2 transition-colors hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:bg-ide-raised"
    >
      {label}
    </button>
  );
}

/**
 * The row that is briefly a text field.
 *
 * Inline rather than a modal because the name only means anything next to its siblings —
 * you are choosing something that does not collide, and a dialog hides exactly that.
 */
function NameInput({
  initial,
  depth,
  onCommit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <li>
      <input
        ref={ref}
        defaultValue={initial}
        style={{ marginLeft: `${depth * 12 + 24}px` }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value);
          if (e.key === "Escape") onCancel();
          // The tree's own keyboard handling must not see these.
          e.stopPropagation();
        }}
        // Blur commits rather than cancels: clicking away from a name you have just typed
        // reads as "yes, that one", and losing it would be the surprising outcome.
        onBlur={(e) => onCommit(e.currentTarget.value)}
        className="my-0.5 w-[calc(100%-2rem)] rounded border border-line bg-ide-code px-1.5 py-0.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
      />
    </li>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  onOpenFile,
  onContextMenu,
  edit,
  onCommitEdit,
  onCancelEdit,
}: {
  node: BuildTreeNode;
  depth: number;
  activePath: string | undefined;
  onOpenFile: (path: string) => void;
  onContextMenu: (target: MenuTarget) => void;
  edit: EditTarget | undefined;
  onCommitEdit: (name: string) => void;
  onCancelEdit: () => void;
}) {
  // Top level starts open; anything deeper stays collapsed, or opening a repo dumps the
  // entire tree on screen at once.
  const [open, setOpen] = useState(depth === 0);
  const isDirectory = node.kind === "directory";
  const isActive = node.path === activePath;
  const renaming = edit?.mode === "rename" && edit.parent === node.path;
  const creatingHere = edit !== undefined && edit.mode !== "rename" && edit.parent === node.path;

  if (renaming) {
    return <NameInput initial={edit.initial} depth={depth} onCommit={onCommitEdit} onCancel={onCancelEdit} />;
  }

  return (
    <li role="treeitem" aria-expanded={isDirectory ? open : undefined}>
      <button
        type="button"
        /**
         * Draggable straight into the assistant's composer.
         *
         * The exact project-relative path travels with it, under our own MIME type — which is
         * the whole reason an internal drag beats dropping the same file from the desktop.
         * Electron 32 removed `File.path`, so an OS drop arrives as bytes with a filename and no
         * location at all; this one knows precisely what it is.
         */
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(
            REF_MIME,
            encodeRefDrag({ kind: isDirectory ? "folder" : "file", path: node.path })
          );
          // Also as plain text, so dragging into any other editor produces the path rather than
          // nothing at all.
          event.dataTransfer.setData("text/plain", node.path);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => (isDirectory ? setOpen((v) => !v) : onOpenFile(node.path))}
        onContextMenu={(e) => {
          e.preventDefault();
          // Opening a folder's menu expands it, so a "New File…" lands somewhere visible
          // rather than inside a collapsed row.
          if (isDirectory) setOpen(true);
          onContextMenu({ path: node.path, kind: node.kind, x: e.clientX, y: e.clientY });
        }}
        // Indent via padding rather than nested margins so the hover and selection
        // highlight still spans the full sidebar width.
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        className={`flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors ${
          isActive ? "bg-ide-raised text-ink" : "text-ink-2 hover:bg-ide-bar"
        }`}
      >
        <span aria-hidden className="w-3 shrink-0 text-xs text-ink-3">
          {isDirectory ? (open ? "▾" : "▸") : ""}
        </span>
        {/*
          The icon is between the disclosure triangle and the name, not replacing the triangle.
          They say different things — the triangle is "this expands", the icon is "this is a
          stylesheet" — and folding them together loses the first, which is the one a tree
          cannot be ambiguous about.
        */}
        <span className="shrink-0">
          {isDirectory ? <FolderIcon open={open} /> : <FileIcon name={node.name} />}
        </span>
        <span className="truncate">{node.name}</span>
      </button>

      {isDirectory && open && (
        <ul role="group">
          {creatingHere && (
            <NameInput
              initial={edit.initial}
              depth={depth + 1}
              onCommit={onCommitEdit}
              onCancel={onCancelEdit}
            />
          )}
          {node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              edit={edit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
