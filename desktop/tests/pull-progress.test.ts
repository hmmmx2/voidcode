/**
 * Knowing when a download has actually finished.
 *
 * The plan named this test and it was never written, so the rule it protects — completion is an
 * explicit `success` frame, not a fraction reaching 1 — shipped with nothing holding it in place.
 *
 * The rule matters because Ollama's layer downloads finish before the manifest write does. The
 * fraction hits 1 and then several more frames arrive: "verifying sha256", "writing manifest".
 * A bar that finishes on the fraction sits at 100% looking hung for the last few seconds of
 * every pull, which is exactly the moment a user starts wondering whether to click again.
 */
import { describe, it, expect } from "vitest";
import {
  applyFrame,
  beginPull,
  completePull,
  dismissPull,
  failPull,
  type Pulls,
} from "../renderer/src/lib/models/pull-progress.js";

const MINE = new Set(["qwen3:8b"]);
const started = (): Pulls => beginPull(new Map(), "qwen3:8b");
const frame = (over: Record<string, unknown> = {}) => ({
  id: "qwen3:8b",
  status: "pulling manifest",
  ...over,
});

describe("starting a pull", () => {
  it("names the row before any frame arrives", () => {
    // A second or two of silence otherwise, which is long enough for a second click.
    const pull = started().get("qwen3:8b")!;
    expect(pull.phase).toBe("pulling");
    expect(pull.status).toBe("starting");
    expect(pull.fraction).toBeNull();
    expect(pull.error).toBeNull();
  });
});

describe("completion", () => {
  it("does not finish on a full fraction", () => {
    /**
     * THE RULE. Every layer is downloaded, the bar is at 100%, and Ollama is still writing the
     * manifest. Finishing here is what makes a pull look hung at the end.
     */
    const pulls = applyFrame(started(), frame({ status: "verifying sha256", fraction: 1 }), MINE);
    expect(pulls.get("qwen3:8b")!.phase).toBe("pulling");
    expect(pulls.get("qwen3:8b")!.fraction).toBe(1);
  });

  it("finishes only on the success frame", () => {
    const pulls = applyFrame(started(), frame({ status: "success", fraction: 1 }), MINE);
    expect(pulls.get("qwen3:8b")!.phase).toBe("done");
  });

  it("finishes on success even when no fraction was ever reported", () => {
    // A cached model emits `success` with no byte counts at all.
    const pulls = applyFrame(started(), frame({ status: "success" }), MINE);
    expect(pulls.get("qwen3:8b")!.phase).toBe("done");
    expect(pulls.get("qwen3:8b")!.fraction).toBeNull();
  });

  it("stays done when a late frame arrives after it", () => {
    // `done` is sticky, or a trailing "verifying" frame reopens a finished row.
    const done = applyFrame(started(), frame({ status: "success" }), MINE);
    const after = applyFrame(done, frame({ status: "verifying sha256", fraction: 0.4 }), MINE);
    expect(after.get("qwen3:8b")!.phase).toBe("done");
    expect(after).toBe(done);
  });

  it("treats the promise resolving as authoritative", () => {
    // Main will not resolve `models:pull` without a success frame, so a resolution is a success
    // frame this window did not happen to see.
    const pulls = completePull(started(), "qwen3:8b");
    expect(pulls.get("qwen3:8b")!.phase).toBe("done");
    expect(pulls.get("qwen3:8b")!.fraction).toBe(1);
  });

  it("does not invent a row for a pull that was never started", () => {
    expect(completePull(new Map(), "ghost").size).toBe(0);
  });
});

describe("frames from elsewhere", () => {
  it("ignores an id this page did not start", () => {
    // Another window pulling the same model would otherwise draw a bar here.
    const pulls = applyFrame(started(), frame({ id: "gemma4:12b", status: "success" }), MINE);
    expect(pulls.has("gemma4:12b")).toBe(false);
    expect(pulls.size).toBe(1);
  });

  it("returns the same map when nothing changed, so a stale frame cannot re-render", () => {
    const before = started();
    expect(applyFrame(before, frame({ id: "gemma4:12b" }), MINE)).toBe(before);
  });

  it("survives a malformed frame", () => {
    // It crosses the IPC boundary; that this window subscribed is not a claim about the shape.
    const before = started();
    for (const junk of [null, undefined, 42, "success", {}, { id: 7 }, { id: "qwen3:8b" }]) {
      expect(applyFrame(before, junk, MINE), JSON.stringify(junk)).toBe(before);
    }
  });

  it("reads only finite numbers as progress", () => {
    const pulls = applyFrame(
      started(),
      frame({ fraction: Number.NaN, completedBytes: Infinity, totalBytes: "lots" }),
      MINE
    );
    const pull = pulls.get("qwen3:8b")!;
    expect(pull.fraction).toBeNull();
    expect(pull.completedBytes).toBeNull();
    expect(pull.totalBytes).toBeNull();
  });
});

describe("failure", () => {
  it("keeps main's own words", () => {
    // "Only Ollama can download models" is the whole explanation; "Download failed" throws away
    // the only part worth reading.
    const pulls = failPull(started(), "qwen3:8b", new Error("Only Ollama can download models"));
    expect(pulls.get("qwen3:8b")!.phase).toBe("failed");
    expect(pulls.get("qwen3:8b")!.error).toBe("Only Ollama can download models");
  });

  it("copes with a rejection that is not an Error", () => {
    expect(failPull(started(), "qwen3:8b", "disk full").get("qwen3:8b")!.error).toBe("disk full");
  });

  it("records a failure even for a pull with no row yet", () => {
    const pulls = failPull(new Map(), "qwen3:8b", new Error("nope"));
    expect(pulls.get("qwen3:8b")!.phase).toBe("failed");
  });
});

describe("dismissing", () => {
  it("forgets the row", () => {
    expect(dismissPull(started(), "qwen3:8b").size).toBe(0);
  });

  it("is a no-op for a row that is not there", () => {
    const before = started();
    expect(dismissPull(before, "ghost")).toBe(before);
  });
});
