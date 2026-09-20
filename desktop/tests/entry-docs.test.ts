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

describe("the website, which is no longer in this repository", () => {
  /**
   * WHAT STOOD HERE, AND WHY IT COULD NOT STAY.
   *
   * A route walker over `apps/web/src/app`, and four assertions built on it: that the walk found at
   * least five pages, that CLAUDE.md's "Seven pages" sentence agreed with the count, that every
   * route it built was named in CLAUDE.md by path, and that nothing under `apps/web` reached our own
   * API. All of them read a directory that is now a different repository.
   *
   * THE ASSERTIONS DID NOT MOVE HERE — THEY MOVED THERE. `voidcode-web` carries
   * `scripts/check-pages.mjs`, which does the same work against its own tree and rather more of it:
   * every internal link resolves, the nav offers exactly three pages, the Stripe return pages stay
   * out of search results, and no component advertises an unshipped feature. That last one is
   * WIDER than what this file checked — the monorepo's version read only the page files under `app/` and nothing they import, and a
   * mutant showed that adding a claim to a section component changed nothing.
   *
   * WHAT REPLACES IT HERE IS THE OPPOSITE ASSERTION. The entry documents must stop enumerating a
   * tree this repository does not contain. A CLAUDE.md that says "Seven pages, all prerendered" and
   * lists them by path is describing something a reader cannot find, and nothing would fail — which
   * is the failure mode this file exists to prevent in the first place.
   */
  it("is not enumerated by the entry documents any more", () => {
    for (const [name, doc] of [["README.md", README], ["CLAUDE.md", CLAUDE]] as const) {
      expect(doc, `${name} still counts the website's pages`).not.toMatch(
        /(Four|Five|Six|Seven|Eight|Nine) pages/
      );
      // The Stripe return routes are the giveaway: they exist only on the website, so naming one is
      // this repository describing the internals of another.
      for (const route of ["/purchase/success", "/purchase/cancelled"]) {
        expect(doc, `${name} still names the website route ${route}`).not.toContain(route);
      }
    }
  });

  it("is named as a separate repository, so a reader can find it", () => {
    // The other direction. Deleting the description entirely would leave no trail from here to the
    // thing that publishes this product's download page and legal documents.
    for (const [name, doc] of [["README.md", README], ["CLAUDE.md", CLAUDE]] as const) {
      expect(doc, `${name} does not name the website's repository`).toContain("voidcode-web");
    }
  });

  it("no longer has a tree here for anything to read", () => {
    // A guard against a half-finished revert: if `apps/web/src` comes back, the checks that used to
    // cover it are in another repository and would not run against it.
    expect(
      fs.existsSync(path.join(repo, "apps/web/src")),
      "apps/web/src exists again — its checks live in voidcode-web and would not cover it"
    ).toBe(false);
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
