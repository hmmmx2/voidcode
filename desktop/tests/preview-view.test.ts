/**
 * What the preview view will load, and where it will go.
 *
 * The preview shows whatever the user's project serves — including whatever an agent just wrote
 * into it, and whatever an npm dependency injected. "It came from localhost" is a claim about
 * the network path, not about the code. So the two questions with security weight are which URL
 * is ever loaded, and where the page is allowed to navigate afterwards.
 */
import { describe, it, expect, vi } from "vitest";

// Only the pure helpers are exercised here; the module imports Electron at the top level.
vi.mock("electron", () => ({
  WebContentsView: class {},
  BrowserWindow: class {},
  shell: { openExternal: () => {} },
}));

const { originOf, mayNavigateTo, clampBounds } = await import("../src/main/preview/view.js");

describe("originOf", () => {
  it("accepts the loopback origins a dev server lands on", () => {
    expect(originOf("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(originOf("http://127.0.0.1:3000/some/path")).toBe("http://127.0.0.1:3000");
    expect(originOf("http://localhost:8080/")).toBe("http://localhost:8080");
  });

  it("refuses anything that is not loopback", () => {
    // The last check before a page is actually loaded. `url.ts` filtered already; this is the
    // one that runs against whatever reached this function by any route.
    expect(originOf("http://192.168.1.14:5173")).toBeNull();
    expect(originOf("https://example.com")).toBeNull();
    expect(originOf("http://127.0.0.1.evil.com:3000")).toBeNull();
    expect(originOf("http://localhost.evil.com:3000")).toBeNull();
  });

  it("refuses schemes that are not http", () => {
    // `file://` would read the disk with the view's own privileges, and `app://` is the app's
    // own origin — the one thing a preview must never be pointed at.
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("app://bundle/build/")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("refuses a non-http scheme that carries a loopback host", () => {
    /**
     * What the protocol check is actually for.
     *
     * The cases above are caught by the hostname check on their own — `file:///etc/passwd`,
     * `javascript:` and `data:` all parse to an empty hostname. These do not: `file://localhost/`
     * has a hostname of exactly `localhost`, and `ws://127.0.0.1:3000` is loopback by any
     * reading. Without the scheme check they are accepted, and `file://localhost/` reads the
     * disk with the view's own privileges.
     */
    expect(originOf("file://localhost/etc/passwd")).toBeNull();
    expect(originOf("file://127.0.0.1/C:/Windows/System32/config/SAM")).toBeNull();
    expect(originOf("ws://127.0.0.1:3000")).toBeNull();
    expect(originOf("ftp://localhost:21")).toBeNull();
  });

  it("refuses what is not a URL at all", () => {
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf("://///")).toBeNull();
  });
});

describe("mayNavigateTo", () => {
  const origin = "http://127.0.0.1:3000";

  it("lets the page move within its own origin", () => {
    // What clicking a link in your own app does. Refusing this would make the preview useless.
    expect(mayNavigateTo(origin, origin)).toBe(true);
    expect(mayNavigateTo(origin, `${origin}/`)).toBe(true);
    expect(mayNavigateTo(origin, `${origin}/about`)).toBe(true);
    expect(mayNavigateTo(origin, `${origin}/a?b=c#d`)).toBe(true);
  });

  it("refuses a different port on the same host", () => {
    /**
     * The subtlety the trailing slash exists for.
     *
     * A bare `startsWith(origin)` accepts `http://127.0.0.1:30000` for an origin of
     * `http://127.0.0.1:3000` — a different port, and on a developer machine quite possibly a
     * different person's service.
     */
    expect(mayNavigateTo(origin, "http://127.0.0.1:30000")).toBe(false);
    expect(mayNavigateTo(origin, "http://127.0.0.1:30000/admin")).toBe(false);
    expect(mayNavigateTo(origin, "http://127.0.0.1:3001")).toBe(false);
  });

  it("refuses a host that merely starts with the origin", () => {
    expect(mayNavigateTo(origin, "http://127.0.0.1:3000.evil.com/")).toBe(false);
    expect(mayNavigateTo(origin, "http://127.0.0.1:3000evil/")).toBe(false);
  });

  it("refuses the app's own origin above all", () => {
    // Nothing in a dev server has any business asking for this, so a request for it is not a
    // mistake to be handled gracefully.
    expect(mayNavigateTo(origin, "app://bundle/build/")).toBe(false);
    expect(mayNavigateTo(origin, "file:///etc/passwd")).toBe(false);
    expect(mayNavigateTo(origin, "https://example.com")).toBe(false);
  });
});

describe("clampBounds", () => {
  const content = { width: 1200, height: 800 };

  it("passes a rectangle that is already inside", () => {
    expect(clampBounds(content, { x: 700, y: 40, width: 480, height: 700 })).toEqual({
      x: 700,
      y: 40,
      width: 480,
      height: 700,
    });
  });

  it("keeps a rectangle from spilling past the window", () => {
    // A preview drawn over the app's chrome is indistinguishable from the app's own UI to the
    // person looking at it, which is why a rectangle is clamped rather than trusted.
    expect(clampBounds(content, { x: 1000, y: 700, width: 5000, height: 5000 })).toEqual({
      x: 1000,
      y: 700,
      width: 200,
      height: 100,
    });
  });

  it("refuses to place it off the top or left", () => {
    expect(clampBounds(content, { x: -500, y: -500, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("collapses to nothing rather than inverting", () => {
    // A negative width would be an error at the platform layer, or a rectangle drawn the other
    // way; zero is the honest reading of "there is no room".
    expect(clampBounds(content, { x: 100, y: 100, width: -50, height: -50 })).toEqual({
      x: 100,
      y: 100,
      width: 0,
      height: 0,
    });
    // A window with no content area — mid-resize, or minimised — clamps everything away.
    expect(clampBounds({ width: 0, height: 0 }, { x: 10, y: 10, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("rounds, because the renderer measures in fractional CSS pixels", () => {
    // `getBoundingClientRect` returns fractions on a scaled display, and a fractional bound is
    // rejected by the platform layer on some of them.
    const result = clampBounds(content, { x: 10.4, y: 20.6, width: 100.5, height: 200.5 });
    for (const value of Object.values(result)) expect(Number.isInteger(value)).toBe(true);
    expect(result.x).toBe(10);
    expect(result.y).toBe(21);
  });
});
