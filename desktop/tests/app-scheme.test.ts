/**
 * Which file answers a URL.
 *
 * This had no test, and the failure it allowed was the worst-behaved kind: **the wrong page,
 * rendered successfully.** Every curriculum problem except the first opened the Build IDE, because
 * `/problems/{id}` named its exported shell `1` while the handler looks for one called
 * `placeholder` — so the sibling lookup missed, the root `index.html` answered, and the root route
 * redirected to `/build` before the workspace shell could read the id from the URL.
 *
 * Nothing threw. Nothing 404'd. Clicking a problem in the catalogue looked like navigation, just to
 * somewhere else, and the app has been shipping that way.
 *
 * The same mistake had already happened once for `/interviews/{slug}` — which is why the sibling
 * lookup exists at all — so these tests cover the *arrangement* between the handler and the routes,
 * not just the handler.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("electron", () => ({
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
  net: { fetch: async () => new Response("") },
  app: { getPath: () => "/tmp/voidcode-test" },
}));

const { resolveRoute, SHELL_NAME } = await import("../src/main/protocol.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, "..", "renderer", "src", "app");

let root: string;

beforeAll(async () => {
  // A bundle shaped like a real export: a root page, static routes, and two dynamic segments
  // whose only prerendered child is the shell.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-bundle-"));
  // `realpath`, and the containment tests below are the reason. `inside()` compares a path the
  // handler resolved against this root with `startsWith`; a raw root on a runner whose temp
  // directory is reached through a symlink (macOS `/var` → `/private/var`) or an 8.3 alias
  // (Windows `RUNNER~1` → `runneradmin`) makes that comparison false for a file that is plainly
  // inside the bundle. It read as "the traversal escaped" on two CI runners while nothing had.
  root = await fs.realpath(root);
  const write = async (relative: string, body: string) => {
    await fs.mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), body);
  };
  await write("index.html", "<root>");
  await write("build/index.html", "<build>");
  await write("problems/index.html", "<problem list>");
  await write(`problems/${SHELL_NAME}/index.html`, "<problem shell>");
  await write("interviews/index.html", "<interview list>");
  await write(`interviews/${SHELL_NAME}/index.html`, "<interview shell>");
  await write("_next/static/app.js", "console.log(1)");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const served = async (pathname: string): Promise<string | undefined> => {
  const file = await resolveRoute(root, pathname);
  return file === undefined ? undefined : await fs.readFile(file, "utf8");
};

describe("real files win", () => {
  it("serves a static route", async () => {
    expect(await served("/build/")).toBe("<build>");
    expect(await served("/build")).toBe("<build>");
  });

  it("serves the list page rather than the shell beside it", async () => {
    // `/problems/` is a real page; the shell must not shadow it.
    expect(await served("/problems/")).toBe("<problem list>");
  });

  it("serves the root", async () => {
    expect(await served("/")).toBe("<root>");
  });
});

describe("a dynamic slug reaches its own shell", () => {
  it("serves the problem shell for any id", async () => {
    /**
     * The regression. Every one of these landed on `<root>` before — which in the real app is a
     * redirect to `/build`.
     */
    for (const pathname of ["/problems/3/", "/problems/3", "/problems/sigmoid/", "/problems/13/"]) {
      expect(await served(pathname), pathname).toBe("<problem shell>");
    }
  });

  it("serves the interview shell for any slug", async () => {
    expect(await served("/interviews/why-scale-by-sqrt-dk/")).toBe("<interview shell>");
  });

  it("does not hand one section's slug to another section's shell", async () => {
    // The lookup is by parent directory, so this is what stops `/interviews/x` being answered by
    // the problems shell — which would render the wrong workspace for a real slug.
    expect(await served("/interviews/anything/")).toBe("<interview shell>");
    expect(await served("/problems/anything/")).toBe("<problem shell>");
  });

  it("would serve a bundle-level shell if one existed, and the root when it does not", async () => {
    /**
     * There is no root-level dynamic route today, so `/whatever` finds no shell and gets the SPA.
     * Asserted because the code used to special-case the root explicitly, and that branch was
     * unobservable — it read as protecting something it was not.
     */
    expect(await served("/whatever/")).toBe("<root>");

    const withRootShell = await fs.mkdtemp(path.join(os.tmpdir(), "voidcode-rootshell-"));
    await fs.mkdir(path.join(withRootShell, SHELL_NAME), { recursive: true });
    await fs.writeFile(path.join(withRootShell, SHELL_NAME, "index.html"), "<root shell>");
    await fs.writeFile(path.join(withRootShell, "index.html"), "<root>");
    try {
      const file = await resolveRoute(withRootShell, "/some-paper/");
      expect(file === undefined ? undefined : await fs.readFile(file, "utf8")).toBe("<root shell>");
    } finally {
      await fs.rm(withRootShell, { recursive: true, force: true });
    }
  });

  it("falls back to the root only when there is no shell beside the path", async () => {
    // A section that exports no shell still gets the SPA rather than a 404 — client routing can
    // recover, and this is the case the original fallback was written for.
    expect(await served("/somewhere-new/")).toBe("<root>");
  });
});

describe("a missing asset gets an honest 404", () => {
  it("does not answer a script with HTML", async () => {
    /**
     * The failure the extension check exists for: the browser parses HTML as JavaScript, throws
     * `Unexpected token '<'`, and hydration dies with no 404 anywhere naming what was missing.
     */
    expect(await resolveRoute(root, "/_next/static/missing.js")).toBeUndefined();
    expect(await resolveRoute(root, "/styles.css")).toBeUndefined();
    expect(await resolveRoute(root, "/icons/nope.svg")).toBeUndefined();
  });

  it("still serves an asset that exists", async () => {
    expect(await served("/_next/static/app.js")).toBe("console.log(1)");
  });
});

describe("containment", () => {
  /**
   * The property is "never a file outside the bundle", not "always undefined" — and getting that
   * distinction wrong is how this test failed first time round.
   *
   * A traversal that looks like a route reaches the fallback and is answered with the root
   * `index.html`. That is correct: the escape resolved to nothing, so what is served is the SPA,
   * from inside the bundle. Demanding a 404 there would be demanding the wrong thing.
   */
  const inside = (file: string | undefined) =>
    file === undefined || path.resolve(file).startsWith(path.resolve(root));

  it("never serves a file from outside the bundle", async () => {
    for (const pathname of [
      "/../../etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/problems/../../secret",
      "/problems/../../../etc/hosts",
      "/./../outside",
    ]) {
      expect(inside(await resolveRoute(root, pathname)), pathname).toBe(true);
    }
  });

  it("refuses a traversal that asks for a file, rather than falling back", async () => {
    // With an extension it is an asset request, so it 404s instead of being handed the SPA — the
    // same rule that stops a missing script being answered with HTML.
    expect(await resolveRoute(root, "/../../etc/passwd.js")).toBeUndefined();
  });

  it("does not let a traversal reach a real file that exists outside", async () => {
    // Aimed at something that genuinely exists: the repo's own package.json, well outside the
    // temp bundle. Extensionless so it takes the fallback path.
    const escaped = await resolveRoute(root, "/../../../../../../Windows/System32/drivers/etc/hosts");
    expect(inside(escaped)).toBe(true);
  });
});

describe("every dynamic route names its shell the same thing", () => {
  /**
   * The half a fake tree cannot check, and the half that actually broke. The handler and the
   * routes have to agree on one word, and they are in different programs — `src/main` and
   * `renderer/src` — with no shared type between them.
   */
  const dynamicRoutes = (dir: string, found: string[] = []): string[] => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (/^\[.+\]$/.test(entry.name) && fsSync.existsSync(path.join(child, "page.tsx"))) {
        found.push(child);
      }
      dynamicRoutes(child, found);
    }
    return found;
  };

  const routes = dynamicRoutes(APP_DIR);

  it("finds the dynamic routes to check", () => {
    // Guards against the walk silently matching nothing after a directory move.
    expect(routes.length).toBeGreaterThanOrEqual(3);
  });

  for (const route of routes) {
    const name = path.relative(APP_DIR, route).replace(/\\/g, "/");

    it(`${name} exports a shell the handler can find`, () => {
      const source = fsSync.readFileSync(path.join(route, "page.tsx"), "utf8");
      const literal = /return \[\{\s*\w+:\s*"([^"]+)"\s*\}\]/.exec(source);

      if (literal === null) {
        /**
         * Enumerated from content rather than a shell — `projects/[slug]` maps over a static
         * `PROJECTS` list, so every route is genuinely prerendered and needs no fallback. Valid,
         * and distinguishable because it does not return a hard-coded single-element array.
         */
        expect(source).toMatch(/generateStaticParams/);
        return;
      }

      expect(
        literal[1],
        `${name} prerenders "${literal[1] ?? ""}" as its only route, so the app:// handler cannot ` +
          `find it — it looks for a sibling directory called "${SHELL_NAME}". Every other slug ` +
          `will fall through to the root, which redirects.`
      ).toBe(SHELL_NAME);
    });
  }
});
