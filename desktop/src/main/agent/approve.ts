/**
 * The second party.
 *
 * `diffs.ts` explains why this exists: the propose/commit split enforces two *steps* in main,
 * not two *parties*, so a compromised renderer can propose and commit without a human. That
 * was tolerable while every proposer was a person. It is not, now that an agent reading web
 * pages and file contents is one.
 *
 * A native dialog is the only surface in this app a compromised renderer can neither fake nor
 * suppress, which makes it the only genuine second party available. Same argument as
 * `inference/consent.ts` and `fs:confirmDiscard`, applied to the write path.
 *
 * **Batched per turn, not per file.** Six dialogs in a row is a thing people dismiss without
 * reading, and a control that is reflexively clicked through has been removed by its own
 * design. One dialog naming every file is a decision someone can actually make.
 *
 * **`DiffView` stays where you read the change; this is where you authorise it.** The two are
 * deliberately different surfaces — the renderer can render a diff however it likes, and none
 * of that rendering is what the write depends on.
 */
import { BrowserWindow } from "electron";
import type { WebContents } from "electron";
import type { AgentDiffBatch } from "../build/diffs.js";
import { askApproval } from "./approval-window.js";

export interface ApprovalRequest {
  sender: WebContents;
  batch: AgentDiffBatch;
}

/**
 * Test seam, mirroring `__scriptUploadConsent`.
 *
 * A real modal blocks the smoke forever with nobody to click it, and scripting the answer is
 * also the only way to exercise the *refusal* path — the one that matters, and the one a human
 * tester would forget.
 */
let scriptedAnswer: ((request: ApprovalRequest) => boolean) | undefined;
const asked: ApprovalRequest[] = [];

export function __scriptAgentApproval(
  answer: ((request: ApprovalRequest) => boolean) | undefined
): void {
  scriptedAnswer = answer;
  asked.length = 0;
}

export function __approvalRequests(): readonly ApprovalRequest[] {
  return asked;
}

/**
 * ── THE FILE-LIST SUMMARY LIVES IN `approval-window.ts` ───────────────────────────────────────
 *
 * `describeBatch` was here, with `MAX_LISTED = 10`, rendering a bullet list of paths — and a comment
 * claiming it was "exported so a test can assert on it directly". No test did, and no caller did:
 * one reference in the whole repository, its own definition.
 *
 * It was not unfinished work, which is the thing worth checking before deleting rather than after.
 * `approval-window.ts` builds the list the dialog actually shows and does strictly more with it: an
 * escaped `<li>` per path, a pluralised count in both the heading and the confirm button, a blurb,
 * `…and N more`, a row count that sizes the window, and `MAX_LISTED = 12`. So this was a superseded
 * earlier version that read as an authoritative helper, and wiring it would have made the dialog
 * worse.
 */

/**
 * Ask before agent-proposed changes reach the disk.
 *
 * Defaults to the refusing button, with Escape mapped to it: dismissing this without reading
 * writes nothing. Not applying is always recoverable; applying is not.
 */
export async function confirmAgentWrite(request: ApprovalRequest): Promise<boolean> {
  asked.push(request);
  if (scriptedAnswer !== undefined) return scriptedAnswer(request);

  /**
   * A window main creates, not a native dialog.
   *
   * The native one could not be dark — Windows never themed its task dialogs — so the prompt
   * that most needs reading arrived as a white box against a dark IDE, which is how a control
   * becomes something people dismiss on sight.
   *
   * The property that mattered was never nativeness. It was that the approving party is not
   * the renderer that asked for the write, and `approval-window.ts` keeps that: main owns the
   * window, the project renderer has no handle to it, and the decision is checked against both
   * the sender and a per-request token.
   */
  return await askApproval({
    parent: BrowserWindow.fromWebContents(request.sender),
    subject: { kind: "diffs", displayPaths: request.batch.displayPaths },
  });
}
