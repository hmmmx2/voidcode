/**
 * The approval window's page.
 *
 * It replaced a native dialog, which means it has to earn back the thing nativeness gave for
 * free: it must be impossible for the content it displays to become the content it *runs*. The
 * paths in it come from `diffs.ts` — resolved inside the project root — but a filename is still
 * attacker-influenced in the sense that matters here, because an agent acting on a fetched web
 * page can propose creating one.
 *
 * So: escaping, a policy strict enough that an escape failure still could not execute, and a
 * default that refuses.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { on: () => {}, removeListener: () => {} },
}));

const { __pageHtml } = await import("../src/main/agent/approval-window.js");

const NONCE = "abc123";

describe("what the page says", () => {
  it("names every file and counts them", () => {
    const html = __pageHtml({ kind: "diffs", displayPaths: ["src/a.ts", "README.md"] }, NONCE);
    expect(html).toContain("src/a.ts");
    expect(html).toContain("README.md");
    expect(html).toContain("Apply 2 changes");
  });

  it("uses the singular for one file", () => {
    // "Apply 1 changes" is the kind of thing that makes a security prompt look unconsidered.
    expect(__pageHtml({ kind: "diffs", displayPaths: ["only.ts"] }, NONCE)).toContain("Apply 1 change<");
  });

  it("summarises the tail rather than growing without limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/f${String(i)}.ts`);
    const html = __pageHtml({ kind: "diffs", displayPaths: many }, NONCE);
    expect(html).toContain("and 28 more");
    // The count in the button is still the true one — summarising the list must not
    // understate what is about to be written.
    expect(html).toContain("Apply 40 changes");
  });
});

describe("the content cannot become script", () => {
  it("escapes a filename containing markup", () => {
    /**
     * An agent can propose creating a file, and a filename is legal input to that. This is the
     * one place where a proposed name is rendered rather than written.
     */
    const html = __pageHtml({ kind: "diffs", displayPaths: ['evil<script>alert(1)</script>.ts'] }, NONCE);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes quotes and ampersands", () => {
    const html = __pageHtml({ kind: "diffs", displayPaths: ['a&b".ts'] }, NONCE);
    expect(html).toContain("a&amp;b&quot;.ts");
  });

  it("carries a nonce-based policy rather than unsafe-inline", () => {
    /**
     * The strictest window in the app must not have the loosest policy. Everything it needs is
     * inline and nothing is fetched, so `default-src 'none'` with a per-window nonce is
     * achievable — and an injected `<script>` that somehow survived escaping still would not
     * run, because it would not carry the nonce.
     */
    const html = __pageHtml({ kind: "diffs", displayPaths: ["a.ts"] }, NONCE);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
    expect(html).not.toContain("unsafe-inline");
  });

  it("loads nothing from anywhere", () => {
    // No fonts, images or stylesheets — the policy above only holds if nothing needs fetching.
    const html = __pageHtml({ kind: "diffs", displayPaths: ["a.ts"] }, NONCE);
    expect(html).not.toMatch(/src="http|href="http|@import/);
  });
});

describe("defaults", () => {
  it("focuses Cancel, not Apply", () => {
    // Enter on a prompt nobody read must not be a write.
    expect(__pageHtml({ kind: "diffs", displayPaths: ["a.ts"] }, NONCE)).toContain('getElementById("cancel").focus()');
  });

  it("maps Escape to refusing", () => {
    // The rule the native dialog had, where Escape was the cancel button.
    const html = __pageHtml({ kind: "diffs", displayPaths: ["a.ts"] }, NONCE);
    expect(html).toMatch(/Escape[\s\S]*decide\(false\)/);
  });
});
