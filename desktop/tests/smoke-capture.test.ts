/**
 * The smoke's camera, which used to fail the run it was only supposed to photograph.
 *
 * `capturePage` asks Chromium's viz service for a copy of the composited surface, and that ask
 * fails by itself — a GPU hiccup, a frame not yet produced, a surface the OS stopped
 * compositing. Electron rejects with `content::CopyFromSurfaceError` stringified and nothing
 * else, so the smoke reported `signed-in smoke threw: UnknownVizError`: a string that appears
 * nowhere in this repository, naming no route and no cause.
 *
 * ONE RUN IN FOUR IS NOT A TEST. The fault is real and intermittent, so running the smoke again
 * and seeing green proves nothing about the retry. The rejection is injected here instead, which
 * is the only way to state what the retry does and — the half that matters — what it still
 * refuses to do.
 */
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CAPTURE_ATTEMPTS,
  captureShot,
  type CapturableWindow,
  type CapturedImage,
} from "../src/main/smoke-capture.js";

/** A PNG-shaped payload; the bytes are never decoded, only written. */
const PIXELS = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const image = (empty = false): CapturedImage => ({
  isEmpty: () => empty,
  toPNG: () => PIXELS,
});

/** A window whose camera behaves as scripted, one entry per attempt. */
function windowThat(outcomes: Array<CapturedImage | Error>): CapturableWindow & { calls: number } {
  const fake = {
    calls: 0,
    webContents: {
      capturePage: async (): Promise<CapturedImage> => {
        const outcome = outcomes[fake.calls] ?? outcomes.at(-1);
        fake.calls += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome as CapturedImage;
      },
    },
  };
  return fake;
}

const viz = () => new Error("UnknownVizError");

const scratch = async (): Promise<string> => await mkdtemp(path.join(tmpdir(), "voidcode-shot-"));

describe("a screenshot the compositor fumbles", () => {
  it("is taken again, and the file lands", async () => {
    const directory = await scratch();
    const window = windowThat([viz(), viz(), image()]);

    await captureShot(window, directory, "credits");

    expect(window.calls).toBe(3);
    expect(new Uint8Array(await readFile(path.join(directory, "credits.png")))).toEqual(PIXELS);
  });

  it("still fails when it never succeeds, and says whose fault it is", async () => {
    const directory = await scratch();
    const window = windowThat([viz()]);

    /*
      THE ASSERTION THIS FILE EXISTS TO PROTECT. Retrying a flaky camera must not become
      tolerating a broken one: a window that can never be captured is still a failed smoke.
      The message is asserted too, because the original bug was not the failure — it was a
      failure that named nothing.
    */
    await expect(captureShot(window, directory, "paper")).rejects.toThrow(
      /screenshot "paper" failed 5x, last reason "UnknownVizError" — this is Chromium's surface copy, not the page/
    );
    expect(window.calls).toBe(CAPTURE_ATTEMPTS);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not count an empty image as a picture", async () => {
    /**
     * An empty image RESOLVES — Electron returns `gfx::Image()` when the view has no bounds —
     * so a capture that photographed nothing would otherwise write a 0x0 PNG and report
     * success. That is the same lie as photographing an empty workbench, which this smoke has
     * already shipped twice.
     */
    const directory = await scratch();
    const window = windowThat([image(true), image(true), image()]);

    await captureShot(window, directory, "research");

    expect(window.calls).toBe(3);
    expect(await readdir(directory)).toEqual(["research.png"]);
  });

  it("reports an unbroken run of empty images as such, not as a viz error", async () => {
    const directory = await scratch();

    await expect(captureShot(windowThat([image(true)]), directory, "account")).rejects.toThrow(
      /last reason "capturePage resolved with an empty image"/
    );
  });

  it("does not retry a disk error as though the compositor had blinked", async () => {
    /*
      A capture that succeeded and a write that failed are different faults, and only the first
      is worth trying again. Retrying the second would spend five captures on a path that is
      never going to become writable and then blame viz for it — the exact misattribution this
      file exists to end, pointed the other way.
    */
    const directory = await scratch();
    // The destination is a directory, so the capture succeeds and only the write fails.
    await mkdir(path.join(directory, "credits.png"));
    const window = windowThat([image()]);

    await expect(captureShot(window, directory, "credits")).rejects.toThrow(
      // The disk's own error, verbatim, rather than this module's five-attempts message.
      /EISDIR|EPERM|EACCES/
    );
    expect(window.calls).toBe(1);
  });

  it("creates the directory, so a missing one is not a puzzling throw mid-assertion", async () => {
    /**
     * `VOIDCODE_SMOKE_SHOTS` is a path a developer types. A missing directory used to surface as
     * an ENOENT thrown from the middle of the signed-in page assertions, where it read as a
     * product failure rather than as a typo in an environment variable.
     */
    const directory = path.join(await scratch(), "does", "not", "exist");

    await captureShot(windowThat([image()]), directory, "paper");

    expect(await readdir(directory)).toEqual(["paper.png"]);
  });
});
