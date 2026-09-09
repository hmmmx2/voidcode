/**
 * Saving an editor buffer to disk.
 *
 * Build mode could open a project, read a file into Monaco and let you type — and then had
 * nowhere to put it. `host.fs` was `read`, `writeWithDiff` and `commitDiff`, and the only
 * caller of the write pair was the assistant. `closeFile` did not even prompt. Every edit
 * made in the editor was lost on close.
 *
 * WHY THIS DOES NOT WEAKEN THE ASSISTANT'S REVIEW GATE, since the obvious reading is that it
 * does:
 *
 * `writeWithDiff`/`commitDiff` enforce two *steps* in main. They do not enforce two
 * *parties*: nothing in `diffs.ts` requires a human to have seen the diff before
 * `commitDiff` is called. The review is enforced by `AssistantPanel`'s UI, in the renderer —
 * the component we already assume can be compromised. So a compromised renderer can already
 * write arbitrary confined content today, in two calls instead of one. `fs:save` grants it no
 * capability it does not have.
 *
 * What actually bounds the damage in both paths is the same thing: `writeWorkspacePath`, and
 * the fact that `projectRoot` can only be set by the user picking a folder in a native dialog.
 *
 * The gate stays for the assistant because its value is the *affordance for human review of
 * model-authored text* — content the user has not read. `fs:save` writes the buffer they are
 * looking at, character for character. There is nothing in the payload they have not seen
 * rendered in Monaco. Different problems, different mechanisms.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import { currentProjectRoot, writeWorkspacePath } from "../workspace.js";
import { isWithin } from "../paths.js";

export class SaveConflictError extends Error {
  constructor(readonly displayPath: string) {
    super(`${displayPath} changed on disk since you opened it; nothing was written`);
    this.name = "SaveConflictError";
  }
}

export interface SaveResult {
  path: string;
  bytes: number;
}

/**
 * Write a buffer, refusing if the file moved under it.
 *
 * `baseline` is what the buffer was opened or last saved against; `null` means the buffer is
 * for a file that did not exist. The check is the same one `commitDiff` makes, for the same
 * reason: between opening and saving, another tool — or the assistant — may have written the
 * file, and overwriting silently would discard work the user never saw.
 */
export async function saveWorkspaceFile(
  sender: WebContents,
  candidate: string,
  contents: string,
  baseline: string | null
): Promise<SaveResult> {
  // The same confinement `proposeWrite` uses. `resolveWithinAllowingNew` permits a file that
  // does not exist yet while realpath-checking every ancestor, so a symlinked directory
  // cannot be used to escape the project root.
  //
  // `sender` decides *which* root, so a second window cannot write through the first
  // window's grant.
  const absolute = await writeWorkspacePath(sender, candidate);

  let current: string | undefined;
  try {
    current = await fs.readFile(absolute, "utf8");
  } catch {
    current = undefined;
  }

  if (current !== (baseline ?? undefined)) {
    throw new SaveConflictError(displayPathFor(sender, absolute));
  }

  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");

  return {
    path: displayPathFor(sender, absolute),
    bytes: Buffer.byteLength(contents, "utf8"),
  };
}

/** Project-relative, with forward slashes, for display. Falls back to the basename. */
function displayPathFor(sender: WebContents, absolute: string): string {
  const root = currentProjectRoot(sender);
  if (root === undefined) return path.basename(absolute);
  const relative = path.relative(root, absolute);
  return relative === "" ? path.basename(absolute) : relative.split(path.sep).join("/");
}

/**
 * Where a Save As landed, and whether the buffer should follow it.
 *
 * `rebind: false` means the file was written once, outside the project, and the tab stays
 * pointed at where it was. See `saveWorkspaceFileAs` for why that asymmetry exists.
 */
export interface SaveAsResult {
  path: string;
  bytes: number;
  rebind: boolean;
}

/**
 * Save As, through a native dialog.
 *
 * TAKES NO PATH, exactly like `openProjectViaDialog`. The dialog *is* the authorisation: a
 * channel that accepted a destination from the renderer would be an arbitrary-file-write with
 * a friendly name, reachable by anything that could reach the renderer.
 *
 * A destination outside the project is allowed — the user picked it, in an OS dialog, for this
 * one write. What it must **not** do is widen `projectRoot` or rebind the buffer to an
 * out-of-root path: every subsequent `fs:save` would then have to accept an absolute path
 * outside the root, which reopens precisely the hole `workspace.ts` exists to close. So the
 * rule is:
 *
 *   - inside the root  → written, and the buffer rebinds to the new project-relative path
 *   - outside the root → written once, and the buffer stays bound to where it was
 *
 * The second case is a genuine "export a copy", which is what Save As to another folder means
 * to most people anyway.
 */
export async function saveWorkspaceFileAs(
  sender: WebContents,
  contents: string,
  suggestedName: string
): Promise<SaveAsResult | undefined> {
  const root = currentProjectRoot(sender);
  const window = BrowserWindow.fromWebContents(sender);

  const result = await dialog.showSaveDialog(window ?? undefined!, {
    title: "Save As",
    // Inside the project by default, because that is where the next save almost always goes,
    // and it puts the rebinding case one keystroke away rather than behind navigation.
    defaultPath: root === undefined ? suggestedName : path.join(root, suggestedName),
  });

  if (result.canceled || result.filePath === undefined) return undefined;

  const target = result.filePath;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");

  // `isWithin` on canonical paths, not a string compare: a symlinked folder inside the project
  // and an 8.3 short name on Windows both defeat the naive version, and getting this wrong in
  // the permissive direction is what would let the buffer rebind outside the root.
  let inside = false;
  if (root !== undefined) {
    try {
      inside = isWithin(await fs.realpath(root), await fs.realpath(target));
    } catch {
      inside = false;
    }
  }

  return {
    path: inside && root !== undefined ? displayPathFor(sender, target) : target,
    bytes: Buffer.byteLength(contents, "utf8"),
    rebind: inside,
  };
}
