/**
 * Asking whether to apply the agent's changes, in a window main owns.
 *
 * This replaced `dialog.showMessageBox`, and the reason is worth stating precisely because it
 * sounds cosmetic and is not. A Win32 task dialog cannot be dark — Windows never themed it — so
 * the one prompt in this app that most needs to be read arrived as a bright white box against a
 * dark IDE. A control that trains people to dismiss it on sight is worth less than its
 * appearance suggests.
 *
 * **The security property is unchanged, and it does not come from the dialog being native.** It
 * comes from the approval being a *different party* from the renderer that asked for the write:
 *
 *   - Main creates this window. The project renderer never receives a handle, has no channel
 *     that reaches it, and cannot script, resize, move or close it.
 *   - The decision arrives on `approval:decide` from *this* WebContents, carrying a token minted
 *     for this request. A message from anywhere else is dropped.
 *   - Closing it without answering is a refusal. The safe answer is the one you get by not
 *     deciding — the same rule the native dialog had, where Escape mapped to Cancel.
 *
 * What a compromised renderer could do before is what it can do now: nothing. It cannot fake
 * this window, because it cannot make main create one; and it cannot suppress it, because the
 * write path waits on this promise and nothing else resolves it.
 */
import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** How the list is rendered when it is long enough to need scrolling rather than growing. */
const MAX_LISTED = 12;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The page, generated here so the CSP can carry a per-window nonce.
 *
 * Everything is inline and nothing is fetched — no fonts, no images, no stylesheets — so the
 * policy can be `default-src 'none'` with a nonce for the one script and style block this file
 * just wrote. An `'unsafe-inline'` would have been easier and would have meant the strictest
 * window in the app had the loosest policy.
 *
 * The colours are the IDE's, hard-coded rather than imported: this page cannot reach the
 * renderer's stylesheet, and a build step to share tokens with a window that has six of them
 * would be more machinery than the problem.
 */
export type ApprovalSubject =
  /** Files the agent wants to write. The batch is named in full. */
  | { kind: "diffs"; displayPaths: readonly string[] }
  /**
   * Turning Auto mode on for one project in one window.
   *
   * A different question from the one above and it must read like one. Approving a batch of
   * diffs authorises those files; arming authorises every write and every command this window
   * makes until it is turned off. Reusing the window is right -- it is the only surface in the
   * app that main owns end to end, which is what makes it a genuine second party -- but
   * reusing the *copy* would be telling the user they were approving a list of files.
   */
  | { kind: "armAuto"; projectRoot: string };

/** The body of the page, per subject. Kept beside the union so neither can gain a case alone. */
function pageBody(subject: ApprovalSubject): {
  title: string;
  heading: string;
  blurb: string;
  listHtml: string;
  confirmLabel: string;
  rows: number;
} {
  if (subject.kind === "armAuto") {
    /**
     * Says what is being granted, to what, and for how long -- in that order, because those
     * are the three questions someone has to answer before they can consent to anything.
     *
     * No backticks anywhere in this copy. It is interpolated into a template literal, and a
     * backtick would close it. That has happened five times in this codebase.
     */
    return {
      title: "Turn on Auto mode",
      heading: "Let the assistant change this project without asking?",
      blurb:
        "In Auto mode the assistant writes its edits straight to disk and can run any command " +
        "in this folder, with no review step and no prompt. You can undo a run's file changes " +
        "afterwards, but not what its commands did.",
      listHtml:
        `<li>${escapeHtml(subject.projectRoot)}</li>` +
        `<li class="more">This window only, until you turn it off or close it.</li>`,
      confirmLabel: "Turn on Auto mode",
      rows: 2,
    };
  }

  const listed = subject.displayPaths.slice(0, MAX_LISTED);
  const remainder = subject.displayPaths.length - listed.length;
  const more = remainder > 0 ? `<li class="more">…and ${String(remainder)} more</li>` : "";
  const count = subject.displayPaths.length;
  const plural = count === 1 ? "change" : "changes";

  return {
    title: "Apply changes",
    heading: `Apply ${String(count)} ${plural} proposed by the assistant?`,
    blurb:
      "These files will be modified on disk. The assistant may have read web pages and files " +
      "while working — review the diffs first if you have not already.",
    listHtml: listed.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("") + more,
    confirmLabel: `Apply ${String(count)} ${plural}`,
    rows: Math.min(count, MAX_LISTED),
  };
}

function pageHtml(subject: ApprovalSubject, nonce: string): string {
  const body = pageBody(subject);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>${body.title}</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px 20px 16px;
    background: #0d0d0f; color: #e7e7ea;
    font: 13px/1.5 "Segoe UI", system-ui, sans-serif;
    display: flex; flex-direction: column; height: 100vh;
  }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 12px; color: #a0a0a8; }
  ul {
    margin: 0 0 14px; padding: 8px 10px; list-style: none;
    background: #151518; border: 1px solid #2a2a30; border-radius: 6px;
    overflow-y: auto; flex: 1; min-height: 0;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px;
  }
  li { padding: 1px 0; }
  li.more { color: #a0a0a8; font-style: italic; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  button {
    font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #2a2a30; background: #1b1b1f; color: #e7e7ea;
  }
  button:hover { background: #26262c; }
  button.primary { background: #e7e7ea; color: #0d0d0f; border-color: #e7e7ea; }
  button.primary:hover { opacity: .9; }
  button:focus-visible { outline: 2px solid #7aa2f7; outline-offset: 2px; }
</style>
</head>
<body>
  <h1>${body.heading}</h1>
  <p>${body.blurb}</p>
  <ul>${body.listHtml}</ul>
  <div class="row">
    <button id="cancel" type="button">Cancel</button>
    <button id="apply" type="button" class="primary">${body.confirmLabel}</button>
  </div>
<script nonce="${nonce}">
  const decide = (ok) => window.approval.decide(ok);
  document.getElementById("cancel").addEventListener("click", () => decide(false));
  document.getElementById("apply").addEventListener("click", () => decide(true));
  // Escape refuses, matching the dialog this replaced: the safe answer is the one you get by
  // not deciding.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") decide(false); });
  // Focus Cancel, not Apply. Enter on an unread prompt must not be a write.
  document.getElementById("cancel").focus();
</script>
</body>
</html>`;
}

export interface ApprovalWindowRequest {
  parent: Electron.BrowserWindow | null;
  subject: ApprovalSubject;
}

/**
 * Show the window and wait.
 *
 * Resolves false on close, on an unparented request, and on anything unexpected. There is no
 * path through this function that resolves true without a click on this window.
 */
export async function askApproval(request: ApprovalWindowRequest): Promise<boolean> {
  const { subject } = request;
  // Nothing to approve is not an approval. Only the diff subject can be empty.
  if (subject.kind === "diffs" && subject.displayPaths.length === 0) return false;

  const body = pageBody(subject);

  const token = randomUUID();
  const nonce = randomUUID().replace(/-/g, "");

  const window = new BrowserWindow({
    width: 520,
    height: Math.min(560, 220 + body.rows * 20),
    // `exactOptionalPropertyTypes` is on, so an absent parent has to be an absent *key* rather
    // than an explicit undefined. A parentless approval is still modal to nothing but still
    // has to be answered — the write waits on it either way.
    ...(request.parent !== null ? { parent: request.parent, modal: true } : {}),
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Frameless would look tidier and would also remove the only affordance for dismissing
    // this without answering. A titled window is what a prompt should look like.
    title: body.title,
    autoHideMenuBar: true,
    backgroundColor: "#0d0d0f",
    webPreferences: {
      preload: path.join(__dirname, "../preload/approval.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The payload rides in argv, the same way the main preload receives its mode and channel
      // list. Fixed by main before the process starts, and unalterable from the page.
      additionalArguments: [
        // The preload exposes this to the page purely so it could render the list itself if
        // it ever needed to; the markup is already built here. Kept a string array so the
        // bridge's shape does not change per subject.
        `--voidcode-approval=${encodeURIComponent(
          JSON.stringify(subject.kind === "diffs" ? [...subject.displayPaths] : [subject.projectRoot])
        )}`,
        `--voidcode-approval-token=${token}`,
      ],
    },
  });

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (approved: boolean): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("approval:decide", onDecide);
      if (!window.isDestroyed()) window.destroy();
      resolve(approved);
    };

    const onDecide = (
      event: Electron.IpcMainEvent,
      payload: { token?: unknown; approved?: unknown }
    ): void => {
      // Both checks matter. The sender check stops any other window answering; the token stops
      // a stale approval window answering for a batch that is not the one it displayed.
      if (event.sender !== window.webContents) return;
      if (payload?.token !== token) return;
      finish(payload.approved === true);
    };

    ipcMain.on("approval:decide", onDecide);
    // Closing without answering is a refusal.
    window.on("closed", () => finish(false));

    window.once("ready-to-show", () => window.show());
    void window
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(subject, nonce))}`
      )
      .catch(() => finish(false));
  });
}

/** For tests: the markup, without needing Electron to render it. */
export const __pageHtml = pageHtml;
