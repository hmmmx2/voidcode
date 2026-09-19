/**
 * Screenshots for the smoke, with Chromium's compositor allowed to miss.
 *
 * `capturePage` DOES NOT READ THE WINDOW'S PIXELS. It asks viz for a copy of the composited
 * surface, and that request fails on its own from time to time — a GPU hiccup, a frame not yet
 * produced after a navigation, a surface the OS has stopped compositing. Electron rejects with
 * `content::CopyFromSurfaceError` stringified and nothing else, so the smoke reported a bare
 * `UnknownVizError`: a message that appears nowhere in this repository, names no route, and
 * gives no hint that it came from the camera rather than from the page.
 *
 * It read as a screenshot-mode product bug because it only ever happened under
 * `VOIDCODE_SMOKE_SHOTS` — for the uninteresting reason that nothing else in the smoke takes a
 * picture. Every assertion about the page had already passed when it fired.
 *
 * RETRIED, NOT TOLERATED. A capture that never succeeds still fails the smoke, now with a
 * message that names the camera and the route. Nothing asserted about the page is relaxed: a
 * picture is an artefact of the run, never the thing under test.
 *
 * Its own module rather than another helper in `index.ts` so the retry is testable. A fault that
 * shows up in one run out of four cannot be verified by running the smoke again and seeing green;
 * `tests/smoke-capture.test.ts` injects the rejection instead.
 */

/** The part of `NativeImage` this needs, so a test can hand it a fake. */
export interface CapturedImage {
  isEmpty(): boolean;
  toPNG(): Uint8Array;
}

/** The part of `BrowserWindow` this needs, for the same reason. */
export interface CapturableWindow {
  webContents: { capturePage(): Promise<CapturedImage> };
}

/**
 * How hard to try for one screenshot before calling it a failure.
 *
 * Five at 300ms is a second and a half against a fault that clears in a frame: long enough to
 * outlast a GPU hiccup, short enough that a genuinely uncapturable window is not waited on.
 */
export const CAPTURE_ATTEMPTS = 5;
export const CAPTURE_RETRY_MS = 300;

export async function captureShot(
  window: CapturableWindow,
  directory: string,
  name: string
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  // `VOIDCODE_SMOKE_SHOTS` is a path a developer types, not one the build owns, and a missing
  // directory used to surface as its own puzzling throw from the middle of a page assertion.
  await mkdir(directory, { recursive: true });

  let reason = "never attempted";
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
    let image: CapturedImage | undefined;
    try {
      image = await window.webContents.capturePage();
    } catch (err) {
      reason = (err as Error).message;
    }

    if (image !== undefined) {
      /*
        AN EMPTY IMAGE RESOLVES rather than rejecting: Electron hands back `gfx::Image()` when the
        view is gone or has no bounds. Writing it leaves a 0x0 PNG on disk and calls the capture a
        success — the same shape of lie as photographing an empty workbench, which the smoke
        already carries two comments about.
      */
      if (image.isEmpty()) reason = "capturePage resolved with an empty image";
      else {
        // Outside the `catch` above on purpose: a disk error is a real error and must not be
        // retried as though the compositor had blinked.
        await writeFile(`${directory}/${name}.png`, image.toPNG());
        return;
      }
    }

    if (attempt < CAPTURE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS));
    }
  }

  throw new Error(
    `screenshot "${name}" failed ${CAPTURE_ATTEMPTS}x, last reason ${JSON.stringify(reason)} — `
      + `this is Chromium's surface copy, not the page`
  );
}
