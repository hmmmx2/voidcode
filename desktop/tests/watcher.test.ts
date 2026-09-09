/**
 * Watching the project.
 *
 * The coalescer is where the edge cases live, and it is pure apart from its timer — it decides
 * *which paths* changed and *when to report*, never *what kind* of change. That split is what
 * makes the burst logic testable with no temp directories and no real `fs.watch`, whose event
 * stream is famously platform-dependent and impossible to provoke reliably.
 *
 * Kind resolution is tested separately, against a real directory, because its whole job is to
 * ask the filesystem a question the watch event cannot answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { ChangeCoalescer, shouldIgnore, resolveChangeKind, toDisplayPath } = await import(
  "../src/main/build/watcher.js"
);

type Flush = { paths: string[]; events: Map<string, ReadonlySet<string>>; overflow: boolean };

/** Collects flushes so a test can assert on the batch rather than on individual pushes. */
function collector(): { flushes: Flush[]; onFlush: ConstructorParameters<typeof ChangeCoalescer>[0] } {
  const flushes: Flush[] = [];
  return {
    flushes,
    onFlush: (events, overflow) => {
      flushes.push({ paths: [...events.keys()], events: new Map(events), overflow });
    },
  };
}

describe("what gets ignored", () => {
  it("skips the generated directories nobody means by 'my project'", () => {
    // Without this, one `npm install` emits more events than every other source of change
    // combined and the debounce never gets a chance to settle.
    expect(shouldIgnore("node_modules/react/index.js")).toBe(true);
    expect(shouldIgnore(".git/HEAD")).toBe(true);
    expect(shouldIgnore("dist/bundle.js")).toBe(true);
    expect(shouldIgnore("a/b/__pycache__/mod.pyc")).toBe(true);
  });

  it("matches a skipped directory at any depth, not just the first segment", () => {
    expect(shouldIgnore("packages/web/node_modules/x/y.js")).toBe(true);
  });

  it("does not skip ordinary source", () => {
    expect(shouldIgnore("src/main.py")).toBe(false);
    expect(shouldIgnore("README.md")).toBe(false);
    // A file whose *name* merely contains a skipped word is not in a skipped directory.
    expect(shouldIgnore("src/build-tools.ts")).toBe(false);
  });

  it("normalises native separators to the form every other channel speaks", () => {
    expect(toDisplayPath(["src", "main.py"].join(path.sep))).toBe("src/main.py");
  });
});

describe("coalescing a burst", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports nothing until the stream goes quiet", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.push("a.py", "change");
    vi.advanceTimersByTime(100);
    c.push("b.py", "change");
    vi.advanceTimersByTime(100);

    // Still mid-burst: the timer is re-armed on every event, so a checkout that takes a second
    // produces one batch, not hundreds.
    expect(flushes).toHaveLength(0);

    vi.advanceTimersByTime(150);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.paths).toEqual(["a.py", "b.py"]);
  });

  it("collapses repeated events for one path into a single entry", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    for (let i = 0; i < 50; i++) c.push("busy.py", "change");
    vi.advanceTimersByTime(150);

    expect(flushes[0]?.paths).toEqual(["busy.py"]);
  });

  it("remembers every event type seen for a path", () => {
    // Kind resolution needs to know a rename was involved even if a change arrived after it,
    // or a newly created file reports as merely modified.
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.push("new.py", "rename");
    c.push("new.py", "change");
    vi.advanceTimersByTime(150);

    expect([...(flushes[0]?.events.get("new.py") ?? [])].sort()).toEqual(["change", "rename"]);
  });

  it("drops ignored paths before they can fill the batch", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.push("node_modules/x/index.js", "change");
    vi.advanceTimersByTime(150);

    // Not an empty batch — no batch at all. An empty one would train the renderer to ignore
    // them.
    expect(flushes).toHaveLength(0);
  });

  it("does not fire at all when nothing happened", () => {
    const { flushes, onFlush } = collector();
    new ChangeCoalescer(onFlush, 150, 200);
    vi.advanceTimersByTime(1000);
    expect(flushes).toHaveLength(0);
  });

  it("starts a fresh batch after a flush", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.push("a.py", "change");
    vi.advanceTimersByTime(150);
    c.push("b.py", "change");
    vi.advanceTimersByTime(150);

    expect(flushes.map((f) => f.paths)).toEqual([["a.py"], ["b.py"]]);
  });
});

describe("bounds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caps the batch and says it did", () => {
    // Growing without bound is how a watcher turns a branch switch into an out-of-memory
    // crash. Silent truncation would leave the sidebar quietly wrong, which is the failure
    // watching exists to prevent — hence the flag rather than just the cap.
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 3);

    for (const name of ["a", "b", "c", "d", "e"]) c.push(`${name}.py`, "change");
    vi.advanceTimersByTime(150);

    expect(flushes[0]?.paths).toEqual(["a.py", "b.py", "c.py"]);
    expect(flushes[0]?.overflow).toBe(true);
  });

  it("keeps accepting events for paths already in a full batch", () => {
    // Otherwise the cap would also lose the event types for paths it already has, and a
    // create could be reported as a modify.
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 1);

    c.push("a.py", "rename");
    c.push("b.py", "change");
    c.push("a.py", "change");
    vi.advanceTimersByTime(150);

    expect([...(flushes[0]?.events.get("a.py") ?? [])].sort()).toEqual(["change", "rename"]);
  });

  it("reports an overflow with no paths when the OS says it lost track", () => {
    // `fs.watch` can deliver a null filename: something changed, but not what. "Refetch" is
    // the truthful reading; dropping it would leave the tree stale with no sign.
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.markOverflow();
    vi.advanceTimersByTime(150);

    expect(flushes[0]).toMatchObject({ paths: [], overflow: true });
  });

  it("clears the overflow flag with the batch", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.markOverflow();
    vi.advanceTimersByTime(150);
    c.push("a.py", "change");
    vi.advanceTimersByTime(150);

    expect(flushes[1]?.overflow).toBe(false);
  });

  it("emits nothing after disposal", () => {
    const { flushes, onFlush } = collector();
    const c = new ChangeCoalescer(onFlush, 150, 200);

    c.push("a.py", "change");
    c.dispose();
    vi.advanceTimersByTime(1000);

    expect(flushes).toHaveLength(0);
  });
});

describe("deciding what actually happened", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-watch-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("calls a path that is gone deleted", async () => {
    expect(await resolveChangeKind(root, "vanished.py", new Set(["rename"]))).toBe("deleted");
  });

  it("calls a present path with a rename event created", async () => {
    await fs.writeFile(path.join(root, "fresh.py"), "x", "utf8");
    expect(await resolveChangeKind(root, "fresh.py", new Set(["rename"]))).toBe("created");
  });

  it("calls a present path with only a change event modified", async () => {
    await fs.writeFile(path.join(root, "edited.py"), "x", "utf8");
    expect(await resolveChangeKind(root, "edited.py", new Set(["change"]))).toBe("changed");
  });

  it("prefers created when both events were seen", async () => {
    // A file written for the first time emits both. Reporting it as merely modified would
    // tell the renderer to reload a buffer that has no baseline yet.
    await fs.writeFile(path.join(root, "both.py"), "x", "utf8");
    expect(await resolveChangeKind(root, "both.py", new Set(["change", "rename"]))).toBe("created");
  });
});
