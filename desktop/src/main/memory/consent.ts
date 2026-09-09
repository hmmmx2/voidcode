/**
 * Permission to write into the user's project.
 *
 * `.voidcode/` goes inside the folder they opened, which makes indexing the only feature in
 * this app that creates files the user did not ask for in a directory they care about. That
 * needs asking, once, per project.
 *
 * THE ANSWER IS STORED OUTSIDE THE REPO, in main's SQLite keyed by root path. Storing it in
 * `.voidcode/` would mean the repository could grant its own permission — clone a project with
 * a `consented: true` file in it and the index builds without a prompt. Nothing inside a
 * project may decide what the app is allowed to do to that project.
 *
 * Native, per the same argument as every other prompt here: it cannot be styled away, and it
 * works when the renderer does not.
 */
import { BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import { openDatabase } from "../store/db.js";

export type MemoryConsent = "granted" | "declined" | "unasked";

export function consentFor(projectRoot: string): MemoryConsent {
  const row = openDatabase()
    .prepare("SELECT granted FROM memory_consent WHERE project_root = ?")
    .get(projectRoot) as { granted?: number } | undefined;

  if (row === undefined) return "unasked";
  return row.granted === 1 ? "granted" : "declined";
}

export function recordConsent(projectRoot: string, granted: boolean): void {
  openDatabase()
    .prepare(
      `INSERT INTO memory_consent (project_root, granted, decided_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (project_root) DO UPDATE SET
         granted = excluded.granted, decided_at = datetime('now')`
    )
    .run(projectRoot, granted ? 1 : 0);
}

export interface ConsentPrompt {
  sender: WebContents;
  projectRoot: string;
  /** Files that would be read, so the size of what is being agreed to is visible. */
  fileCount: number;
  /** Rough megabytes the index will occupy. */
  estimatedMB: number;
}

/**
 * Ask, and remember the answer.
 *
 * Remembered — unlike the image-upload prompt, which deliberately is not. The difference is
 * what the decision is about: an upload sends *this* screenshot, so it has to be judged each
 * time; this grants a directory, and re-asking on every index would be the kind of prompt
 * people learn to dismiss without reading.
 *
 * Declining is recorded rather than left unasked, so a "no" stays a no instead of becoming a
 * prompt again on the next launch.
 */
export async function requestMemoryConsent(prompt: ConsentPrompt): Promise<boolean> {
  if (scriptedAnswer !== undefined) {
    asked.push(prompt);
    const answer = scriptedAnswer(prompt);
    recordConsent(prompt.projectRoot, answer);
    return answer;
  }

  const window = BrowserWindow.fromWebContents(prompt.sender);
  const choice = await dialog.showMessageBox(window ?? undefined!, {
    type: "question",
    buttons: ["Not now", "Index this project"],
    defaultId: 0,
    cancelId: 0,
    message: "Let VoidCode index this project?",
    detail:
      `It will read about ${prompt.fileCount} files and write roughly ${prompt.estimatedMB} MB ` +
      `to .voidcode/index inside the project folder.\n\n` +
      `Everything stays on this machine — the embedding model runs locally and nothing is ` +
      `uploaded. You can add .voidcode/index to .gitignore afterwards.`,
  });

  const granted = choice.response === 1;
  recordConsent(prompt.projectRoot, granted);
  return granted;
}

/** Test seam, matching `inference/consent.ts`. */
let scriptedAnswer: ((prompt: ConsentPrompt) => boolean) | undefined;
const asked: ConsentPrompt[] = [];

export function __scriptMemoryConsent(
  answer: ((prompt: ConsentPrompt) => boolean) | undefined
): void {
  scriptedAnswer = answer;
  asked.length = 0;
}
