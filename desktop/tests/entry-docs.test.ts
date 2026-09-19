/**
 * The two documents a newcomer reads first, held to the tree they describe.
 *
 * `README.md` and `CLAUDE.md` are where every question starts, so a wrong sentence in either costs
 * more than the same sentence buried in a spec — and both had gone wrong in the same way after the
 * website's logged-in UI was deleted. `CLAUDE.md` described "five static pages: the landing page
 * with the download section on it", written before that page was split into an overview, a pricing
 * page and a download page; the count was still five because two pages had been added and two of
 * the five were the Stripe returns, which is the sort of arithmetic nobody re-checks.
 *
 * WHAT IS CHECKED, AND WHAT DELIBERATELY IS NOT. Prose cannot be verified, and this does not try:
 * `doc-links.test.ts` already says why a resolving link is the floor rather than the ceiling. What
 * is checked here is the small set of facts in these two files that are *countable or greppable* —
 * the website's routes, the ports, the account's routes — because those are the claims that rot
 * first and the ones a reader acts on immediately.
 *
 * The port pair is the clearest example. `platform/config.ts` falls back to 8020 and
 * `docker-compose.gpu.yml` publishes 8000; nothing reconciles them, so both documents now say so
 * outright. If somebody settles that, this test fails and asks them to fix the sentence rather than
 * leaving a paragraph explaining a contradiction that no longer exists.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "..");

const read = (relative: string): string =>
  fs.readFileSync(path.join(repo, relative), "utf8").replace(/\r\n/g, "\n");

const README = read("README.md");
const CLAUDE = read("CLAUDE.md");

/** Every route the website actually builds, from its own `app` directory. */
function websiteRoutes(): string[] {
  const appDir = path.join(repo, "apps/web/src/app");
  const routes: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // `(marketing)` and `(legal)` are route groups: they organise files and contribute no
      // segment to the URL, which is exactly the kind of thing a hand-written list gets wrong.
      const segment = /^\(.*\)$/.test(entry.name) ? prefix : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "page.tsx"))) routes.push(segment === "" ? "/" : segment);
      walk(full, segment);
    }
  };
  walk(appDir, "");
  if (fs.existsSync(path.join(appDir, "page.tsx"))) routes.push("/");
  return [...new Set(routes)].sort();
}

describe("the website, as the entry documents describe it", () => {
  const routes = websiteRoutes();

  it("finds the routes to check", () => {
    // Vacuity: a walk that stopped finding pages would make every assertion below pass for the
    // wrong reason — the failure mode of any test that reads a directory tree.
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  it("is described with the right number of pages", () => {
    /**
     * Read out of the sentence rather than asserted against a literal, so the test fails when the
     * document and the tree disagree rather than when the tree changes.
     */
    const claimed = /^(Seven|Six|Five|Four|Eight|Nine) pages\b/m.exec(CLAUDE);
    expect(claimed, "CLAUDE.md no longer counts the website's pages in a sentence this can read")
      .not.toBeNull();
    const words: Record<string, number> = { Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };

    expect(
      words[(claimed as RegExpExecArray)[1] ?? ""],
      `CLAUDE.md says ${String((claimed as RegExpExecArray)[1])} pages; apps/web builds ${String(routes.length)}: ${routes.join(", ")}`
    ).toBe(routes.length);
  });

  it("names every route it builds, where it names routes at all", () => {
    /**
     * CLAUDE.md lists the website's pages BY PATH, so every route has to appear there — `/pricing`
     * and `/download` were missing for a while, because they were split out of the overview after
     * the sentence was written. That is what makes adding a page a documentation change rather than
     * an undocumented one.
     *
     * The README describes them in prose instead ("the two legal documents"), which is the right
     * register for a README and cannot be checked path by path. What it IS held to is naming the
     * two pages that were added, since a prose list is exactly where an addition goes missing.
     */
    for (const route of routes) {
      if (route === "/") continue; // named as "the overview" rather than as a path
      expect(CLAUDE, `CLAUDE.md does not mention ${route}`).toContain(route);
    }
    for (const page of ["pricing", "download"]) {
      expect(README.toLowerCase(), `README.md does not mention the ${page} page`).toContain(page);
    }
  });

  it("is still true that it holds no session and calls no API of ours", () => {
    // The claim both documents make, and the reason it is safe to describe the site as static
    // pages: nothing under `apps/web` reaches our own API. `api.github.com` is the one exception,
    // for the download page's release assets, and both documents say so.
    const web = path.join(repo, "apps/web/src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, "utf8");
        // The proxy and the session that used to live here.
        for (const banned of ["NEXT_PUBLIC_API_URL", "/api/proxy", "next-auth"]) {
          if (source.includes(banned)) offenders.push(`${path.relative(repo, full)}: ${banned}`);
        }
      }
    };
    walk(web);

    expect(offenders, "the website talks to our API again; both entry documents say it does not")
      .toEqual([]);
    expect(CLAUDE).toContain("api.github.com");
  });
});

describe("the API's port, as the entry documents describe it", () => {
  it("still disagrees with itself in the two places they name", () => {
    /**
     * Both documents carry a paragraph explaining that the port is not settled. That paragraph is
     * only worth its space while the contradiction exists — so this test fails when somebody fixes
     * it, and the fix includes deleting the explanation.
     */
    const config = fs.readFileSync(
      path.join(root, "src/main/platform/config.ts"),
      "utf8"
    );
    const fromSource = /DEVELOPMENT_API = "http:\/\/127\.0\.0\.1:(\d+)\/v1"/.exec(config);
    expect(fromSource, "the development API address moved").not.toBeNull();
    const appPort = (fromSource as RegExpExecArray)[1] ?? "";

    const compose = read("docker-compose.gpu.yml");
    const published = /- "(\d+):8000"/.exec(compose);
    expect(published, "the GPU compose no longer publishes the API on a host port").not.toBeNull();
    const containerPort = (published as RegExpExecArray)[1] ?? "";

    expect(appPort).toBe("8020");
    expect(containerPort).toBe("8000");
    expect(
      appPort === containerPort,
      "the ports agree now — delete the paragraph in README.md and CLAUDE.md that explains why they do not"
    ).toBe(false);

    for (const [name, doc] of [["README.md", README], ["CLAUDE.md", CLAUDE]] as const) {
      expect(doc, `${name} does not name the app's port`).toContain(appPort);
      expect(doc, `${name} does not name the container's port`).toContain(containerPort);
      expect(doc, `${name} does not say the two are unreconciled`).toContain("not settled");
    }
  });

  it("points at the override that resolves it", () => {
    // The actual remedy, which is worth more than the explanation: the variable, and the fact that
    // a packaged build ignores it.
    for (const doc of [README, CLAUDE]) {
      expect(doc).toContain("VOIDCODE_API_URL");
    }
    const config = fs.readFileSync(path.join(root, "src/main/platform/config.ts"), "utf8");
    expect(config, "the override the documents describe is gone").toContain(
      "process.env.VOIDCODE_API_URL"
    );
  });
});

describe("the account surfaces the entry documents point at", () => {
  it("are routes that exist", () => {
    /**
     * `CLAUDE.md` lists where the optional account lives. Each has to be a real route in the
     * renderer, because the list is what somebody reads instead of exploring the tree — and two of
     * these three did not exist when the account was first described.
     */
    for (const route of ["/account", "/account/credits", "/research"]) {
      expect(CLAUDE, `CLAUDE.md does not mention ${route}`).toContain(route);
      const page = path.join(root, "renderer/src/app", "(profile)", route.slice(1), "page.tsx");
      const alternative = path.join(root, "renderer/src/app", "(homepage)", route.slice(1), "page.tsx");
      expect(
        fs.existsSync(page) || fs.existsSync(alternative),
        `${route} is described but has no page.tsx`
      ).toBe(true);
    }
  });
});
