/**
 * Reading a project directory into a tree the renderer can display.
 *
 * Bounded on purpose. A repo is not a fixture: `node_modules` alone can be a quarter of a
 * million files, and walking it eagerly would stall the main process before the window ever
 * paints. So this skips the usual generated directories, caps depth and total entries, and
 * reports `truncated` when it stopped early.
 *
 * That flag has to reach the UI. A tree that silently stops reads as "your project has no
 * `src/`", which sends the user looking for a bug in their own repo.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface TreeNode {
  name: string;
  /** Project-relative, forward slashes — the same form `fs:read` expects back. */
  path: string;
  kind: "file" | "directory";
  children?: TreeNode[];
}

export interface ProjectTree {
  root: string;
  name: string;
  entries: TreeNode[];
  truncated: boolean;
}

/**
 * Directories that are generated, vendored, or enormous, and that nobody opens a file tree
 * to browse. Not a security control — `paths.ts` is that. This is about not walking 200k
 * files to show a sidebar.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "target",
  ".idea",
  ".DS_Store",
]);

const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 12;

/**
 * Walk `root` into a bounded tree.
 *
 * Symlinked directories are listed but never followed. Following them would let a link
 * inside the project enumerate the whole filesystem into the sidebar, and would also make
 * a cycle (`ln -s . loop`) hang the walk. Reading through such a link still goes via
 * `readWorkspaceFile`, which realpaths and rejects anything landing outside the root — so
 * a listed symlink is not a way in, just a name on screen.
 */
export async function readProjectTree(root: string): Promise<ProjectTree> {
  let budget = MAX_ENTRIES;

  async function walk(directory: string, relative: string, depth: number): Promise<TreeNode[]> {
    if (depth > MAX_DEPTH || budget <= 0) return [];

    let dirents;
    try {
      dirents = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory — a permissions-restricted folder, or one deleted between the
      // parent listing and now. An empty branch is the honest rendering; failing the whole
      // walk because one subdirectory is off-limits would be worse.
      return [];
    }

    const nodes: TreeNode[] = [];
    for (const dirent of dirents) {
      if (budget <= 0) break;
      if (dirent.name.startsWith(".") && SKIP_DIRECTORIES.has(dirent.name)) continue;
      if (dirent.isDirectory() && SKIP_DIRECTORIES.has(dirent.name)) continue;

      budget--;
      const childRelative = relative === "" ? dirent.name : `${relative}/${dirent.name}`;

      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        nodes.push({
          name: dirent.name,
          path: childRelative,
          kind: "directory",
          children: await walk(path.join(directory, dirent.name), childRelative, depth + 1),
        });
      } else {
        nodes.push({
          name: dirent.name,
          path: childRelative,
          kind: dirent.isDirectory() ? "directory" : "file",
        });
      }
    }

    // Directories first, then alphabetical — the ordering every file tree uses, and the one
    // people scan by. `readdir` order is filesystem-dependent and effectively arbitrary.
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  const entries = await walk(root, "", 0);

  return {
    root,
    name: path.basename(root) || root,
    entries,
    truncated: budget <= 0,
  };
}
