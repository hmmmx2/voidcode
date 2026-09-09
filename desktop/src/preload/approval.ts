/**
 * The approval window's bridge. Two functions and nothing else.
 *
 * This window replaced a native `dialog.showMessageBox`, and it only remains a real control
 * because of what is *absent* here. The project renderer — the one that asked for the write —
 * has no handle to this window, no way to script it, and no channel that reaches it. Main
 * created it; main owns it; the decision comes back from this WebContents or not at all.
 *
 * So the surface is: read the batch main put in argv, send one boolean back. There is no
 * `ipcRenderer`, no channel name parameter, and no way to name a file — the file list is
 * whatever main already decided to write, not something this page can influence.
 *
 * Native was the safer default and the reason to move was not cosmetic in the end: a Win32
 * TaskDialog cannot be dark, so the one prompt in the app that most wants to be read carefully
 * arrived as a bright white box people learn to dismiss. A control that trains people to click
 * through it is worth less than its appearance suggests.
 */
import { contextBridge, ipcRenderer } from "electron";

const PAYLOAD_PREFIX = "--voidcode-approval=";
const TOKEN_PREFIX = "--voidcode-approval-token=";

function argvValue(prefix: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

/**
 * The batch arrives in argv, exactly as the mode and channel list do for the main preload.
 *
 * argv is fixed by main before this process starts and the page has no API to alter it, so a
 * page that somehow ran hostile script still could not rewrite the list of files it is
 * showing — it could only lie about it visually, and it has nothing to gain by that.
 */
const raw = argvValue(PAYLOAD_PREFIX) ?? "";
const token = argvValue(TOKEN_PREFIX) ?? "";

let paths: string[] = [];
try {
  const parsed: unknown = JSON.parse(decodeURIComponent(raw));
  if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === "string");
} catch {
  // An unreadable payload shows an empty list, and an empty list cannot be approved — the
  // window renders the refusing state rather than a confident "Apply 0 changes".
}

contextBridge.exposeInMainWorld("approval", {
  paths,
  /**
   * Answer, once.
   *
   * The token is minted per request by main and checked there. Without it a second approval
   * window — or a page that outlived its request — could answer for a batch that is not its
   * own, which is the only way this window could be turned into a way to approve something
   * the user never saw.
   */
  decide(approved: boolean): void {
    ipcRenderer.send("approval:decide", { token, approved: approved === true });
  },
});
