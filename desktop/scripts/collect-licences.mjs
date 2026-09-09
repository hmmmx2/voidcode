/**
 * Assemble `build/licenses/`, which electron-builder copies into the installed app as
 * `resources/licenses/`.
 *
 * THE APP SHIPPED NO LICENCE TEXT AT ALL. `electron-builder.yml`'s `files:` list is `out/**` plus
 * `package.json`, and the app root is `desktop/` — so the repository-root `LICENSE` and `NOTICE` were
 * outside it and never copied. Monaco's `LICENSE` and `ThirdPartyNotices.txt` were not copied either,
 * because `copy-monaco.mjs` takes only `min/vs`.
 *
 * That is a licensing obligation rather than a tidiness problem. Apache-2.0 §4(d) requires the NOTICE
 * to accompany distribution; MPL-2.0 §3.1 requires recipients be informed of the terms and given the
 * text. And `NOTICE` itself claimed the licences "are reproduced in the distributed build", which was
 * false — the kind of claim D9 existed to remove, and this repository's own standard says a document
 * that asserts something the build contradicts is worse than one that says nothing.
 *
 * WHY A MANIFEST IS EXPORTED. `ARTEFACTS` below is the list `tests/packaging.test.ts` asserts against.
 * A comment saying which licences ship cannot be checked; a table can. It also lets the script fail
 * loudly on a missing *required* input rather than quietly producing a short directory — the failure
 * mode here is a build that looks fine and is missing an obligation.
 *
 * `--files` on license-checker is the right tool for the third-party trees: it copies each package's
 * own licence file, which is literally what "reproduced in the distributed build" means. Generating a
 * summary table instead would be a list of licence *names*, which is not the same obligation.
 *
 *   node scripts/collect-licences.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "..");
const out = path.join(root, "build/licenses");

/**
 * The checker's CLI entry, resolved rather than shelled out to.
 *
 * `npx license-checker-rseidelsohn` is what CI runs and what the first version of this did, and
 * spawning it here failed on Windows with `pid: 0` — `execFileSync` does not go through a shell, so
 * `npx.cmd` never resolved. Running the entry point with `process.execPath` avoids the shell entirely,
 * works the same on all three platforms, and pins the version to the one in this lockfile instead of
 * whatever `npx` would decide to fetch.
 */
const CHECKER = (() => {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("license-checker-rseidelsohn/package.json");
  const { bin } = require("license-checker-rseidelsohn/package.json");
  const entry = typeof bin === "string" ? bin : Object.values(bin)[0];
  return path.join(path.dirname(manifest), entry);
})();

/**
 * What ships, where it comes from, and whether its absence is a build failure.
 *
 * `required: false` is only for text a package might legitimately stop shipping. Everything the
 * project itself owns is required, because a missing one is a mistake rather than an upstream change.
 */
export const ARTEFACTS = [
  { to: "LICENSE", from: path.join(repo, "LICENSE"), required: true },
  { to: "NOTICE", from: path.join(repo, "NOTICE"), required: true },
  { to: "CONTENT-LICENSE", from: path.join(repo, "content/LICENSE"), required: true },
  {
    to: "pyodide/MPL-2.0.txt",
    // Committed, because the npm package ships no licence file — see build/licences-static/README.md.
    from: path.join(root, "build/licences-static/MPL-2.0.txt"),
    required: true,
  },
  {
    to: "monaco/LICENSE",
    from: path.join(root, "renderer/node_modules/monaco-editor/LICENSE"),
    required: true,
  },
  {
    to: "monaco/ThirdPartyNotices.txt",
    from: path.join(root, "renderer/node_modules/monaco-editor/ThirdPartyNotices.txt"),
    required: true,
  },
];

/** The two dependency trees, each collected into its own directory by license-checker. */
export const TREES = [
  { to: "third-party", cwd: root },
  { to: "third-party-renderer", cwd: path.join(root, "renderer") },
];

function copyArtefacts() {
  const missing = [];
  for (const artefact of ARTEFACTS) {
    if (!fs.existsSync(artefact.from)) {
      if (artefact.required) missing.push(path.relative(repo, artefact.from));
      else console.log(`  skipped (absent): ${artefact.to}`);
      continue;
    }
    const destination = path.join(out, artefact.to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(artefact.from, destination);
    console.log(`  ${artefact.to}`);
  }

  // Loudly, and before the expensive step. A short licences directory is an obligation quietly
  // unmet, which is exactly what this script exists to stop.
  if (missing.length > 0) {
    throw new Error(`required licence text missing:\n  ${missing.join("\n  ")}`);
  }
}

function copyTrees() {
  for (const tree of TREES) {
    const destination = path.join(out, tree.to);
    fs.mkdirSync(destination, { recursive: true });

    // Same flags as the CI licence gate, so the set of packages whose text ships is the same set the
    // allowlist was checked against. `--production` matters twice over: devDependencies are not
    // distributed, and shipping their notices would overstate what is in the installer.
    execFileSync(process.execPath, [CHECKER, "--production", "--files", destination], {
      cwd: tree.cwd,
      stdio: ["ignore", "ignore", "inherit"],
    });

    const count = fs.readdirSync(destination).length;
    if (count === 0) throw new Error(`${tree.to}: license-checker copied nothing`);
    console.log(`  ${tree.to}/  (${count} files)`);
  }
}

export function collect() {
  // Rebuilt from scratch every run. Otherwise a package removed from the tree leaves its licence
  // behind and the installer keeps claiming a dependency it no longer has.
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  console.log("licences → build/licenses/");
  copyArtefacts();
  copyTrees();
}

/**
 * Only when run as a script — `tests/packaging.test.ts` imports `ARTEFACTS` to assert against, and
 * that import must not gather licences.
 *
 * It did on the first version of this file, because the work sat at the top level. The test passed
 * and quietly spent thirty seconds shelling out to license-checker twice and deleting and rebuilding
 * `build/licenses/` on every run. A module whose import has side effects is a module you cannot read
 * anything from.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect();
}
