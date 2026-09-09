/**
 * The npm scripts, against the files they name.
 *
 * A script is the one kind of code nothing typechecks, nothing lints, and no test runs unless
 * someone types it. `"harness": "vite --config vite.harness.config.ts"` sat in `package.json`
 * pointing at a config whose `root` was `src/renderer` — a directory that stopped existing when
 * the renderer became a Next app. It failed only for whoever ran it, and only they would know.
 *
 * The config also dragged `@vitejs/plugin-react` along as its sole user, so a dependency was being
 * installed for a command that could not run.
 *
 * These checks are deliberately shallow — a script names a file, that file is there. That is the
 * whole class of rot they catch, and it is the class that actually happened.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const scripts = pkg.scripts ?? {};

/**
 * `//name` keys are this repo's way of writing a comment in JSON, and several scripts have one.
 * They are prose, so they are not commands and must not be scanned for paths.
 */
const commands = Object.entries(scripts).filter(([name]) => !name.startsWith("//"));

/**
 * Anything in a command that looks like a repo-relative file.
 *
 * The extensions are ordered longest-first and the match is anchored at the end, because
 * alternation is first-match-wins: with `js` ahead of `json`, `tsconfig.json` matched as
 * `tsconfig.js` and this test failed on a file that was perfectly present. A guard that cries
 * wolf gets deleted, so it has to be right about the boring cases.
 */
function referencedPaths(command: string): string[] {
  const pattern = /(?:^|\s)((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:json|yaml|yml|mts|mjs|cjs|ts|js))(?=\s|$)/g;
  return (command.match(pattern) ?? [])
    .map((token) => token.trim())
    // `out/main/index.js` is a build artefact, named by `smoke` and produced by the step before
    // it. Checking for it would fail on a clean tree, which is the opposite of useful.
    .filter((token) => !token.startsWith("out/"));
}

describe("every script points at something that exists", () => {
  it("has scripts to check", () => {
    // Guards the walk itself: a rename that emptied this list would make the suite pass by
    // checking nothing.
    expect(commands.length).toBeGreaterThan(5);
  });

  for (const [name, command] of commands) {
    const paths = referencedPaths(command);
    if (paths.length === 0) continue;

    it(`${name} names files that are present`, () => {
      for (const relative of paths) {
        expect(
          fs.existsSync(path.join(root, relative)),
          `\`npm run ${name}\` names ${relative}, which does not exist`
        ).toBe(true);
      }
    });
  }
});

describe("scripts that delegate to a workspace", () => {
  it("name a directory that has the script they call", () => {
    /**
     * `npm --prefix renderer run dev` fails at the same depth as the dead harness did — a
     * command that reads fine and cannot run — and the prefix hides it from the path check
     * above, because `renderer` has no file extension.
     */
    for (const [name, command] of commands) {
      const match = /npm --prefix (\S+) run (\S+)/.exec(command);
      if (match === null) continue;

      const [, prefix = "", script = ""] = match;
      const manifest = path.join(root, prefix, "package.json");
      expect(fs.existsSync(manifest), `\`npm run ${name}\` delegates to ${prefix}`).toBe(true);

      const delegate = JSON.parse(fs.readFileSync(manifest, "utf8")) as PackageJson;
      expect(
        Object.keys(delegate.scripts ?? {}),
        `\`npm run ${name}\` calls "${script}" in ${prefix}`
      ).toContain(script);
    }
  });
});

describe("the dead harness is gone, not just unreferenced", () => {
  it("leaves no config behind", () => {
    // Deleting the script and keeping the file would leave the same trap for the next person to
    // find it and wonder why it does not work.
    expect(fs.existsSync(path.join(root, "vite.harness.config.ts"))).toBe(false);
    expect(scripts.harness).toBeUndefined();
  });

  it("stops installing the plugin only it used", () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@vitejs/plugin-react"]).toBeUndefined();
  });

  it("still offers a way to open the renderer in a browser", () => {
    // The harness's stated purpose was design work in a normal browser. That capability should
    // survive its removal — Next's dev server already did the job better.
    expect(scripts["dev:renderer"]).toBeDefined();
  });
});
