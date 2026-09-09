/**
 * Asking before an image leaves the machine.
 *
 * This is the one action in the app that moves the contents of the user's screen to a third
 * party. A screenshot of a bug is also a screenshot of whatever else was on screen — an email,
 * a token in a terminal, a customer's name in another window — and the person pasting it is
 * thinking about the bug.
 *
 * Three decisions, each of which the obvious implementation gets wrong:
 *
 *   **In main, not the renderer.** A prompt the renderer shows is a prompt a compromised
 *   renderer skips. `chat:open` refuses to proceed without this, so there is no code path that
 *   sends an image to a remote provider without it having returned true.
 *
 *   **Native, not a React modal.** For the same reason `fs:confirmDiscard` is native: it
 *   cannot be styled into invisibility, cannot be scrolled off, and still works when the
 *   renderer is in a bad state.
 *
 *   **Per request, never remembered.** A "don't ask again" checkbox would defeat the entire
 *   control — the whole value is that the decision is made while looking at *this* image. It
 *   is deliberately not offered, and this file has no storage of any kind.
 *
 * Local providers do not prompt. Nothing leaves the machine, so there is nothing to consent
 * to, and prompting anyway would train people to click through it.
 */
import { BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import type { ChatMessage } from "./types.js";

/** How many image blocks a request carries. Zero means there is nothing to ask about. */
export function countImages(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    total += message.content.filter((block) => block.type === "image").length;
  }
  return total;
}

/**
 * The host a base URL points at, for the prompt.
 *
 * The user is being asked to send data to a *place*, and "a remote provider" is not a place.
 * Naming the host is the difference between an informed decision and a reflex.
 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export interface UploadConsentRequest {
  sender: WebContents;
  /** Where the images are going, e.g. `openrouter.ai`. */
  destination: string;
  imageCount: number;
  modelLabel: string;
}

/**
 * Test seam.
 *
 * The smoke drives the real transport, and a real modal would block it forever with nobody to
 * click. Scripting the answer is also what lets it assert the *refusal* path, which is the one
 * that matters and which a human tester would have to remember to try.
 *
 * Records every request so the smoke can check what the user would have been shown — the
 * destination and the count are the two facts the decision rests on.
 */
let scriptedAnswer: ((request: UploadConsentRequest) => boolean) | undefined;
const asked: UploadConsentRequest[] = [];

export function __scriptUploadConsent(
  answer: ((request: UploadConsentRequest) => boolean) | undefined
): void {
  scriptedAnswer = answer;
  asked.length = 0;
}

export function __consentRequests(): readonly UploadConsentRequest[] {
  return asked;
}

/**
 * Ask. Returns whether the user agreed.
 *
 * Defaults to the refusing button and maps Escape to it, so dismissing the dialog without
 * reading it never sends anything — the safe answer is the one you get by not deciding.
 */
export async function confirmImageUpload(request: UploadConsentRequest): Promise<boolean> {
  asked.push(request);
  if (scriptedAnswer !== undefined) return scriptedAnswer(request);

  const window = BrowserWindow.fromWebContents(request.sender);
  const plural = request.imageCount === 1 ? "image" : "images";

  const choice = await dialog.showMessageBox(window ?? undefined!, {
    type: "warning",
    buttons: ["Cancel", `Send ${request.imageCount} ${plural}`],
    // Cancel, and Escape maps to it. Not sending is always recoverable; sending is not.
    defaultId: 0,
    cancelId: 0,
    message: `Send ${request.imageCount} ${plural} to ${request.destination}?`,
    detail:
      `${request.modelLabel} runs on ${request.destination}, so the ${plural} will leave this ` +
      `machine. Anything visible in a screenshot goes with it — check for tokens, customer ` +
      `names, or other windows before sending.\n\n` +
      `A local vision model keeps everything on this machine.`,
  });

  return choice.response === 1;
}
