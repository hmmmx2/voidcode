/**
 * Packaging.
 *
 * Every other test in this directory runs against source. None of them can see the one thing
 * that has to be true for a release to work at all: that the files the app reads at runtime
 * are files packaging actually copies.
 *
 * This existed as a real defect. `electron-builder.yml` never copied `renderer/out`, so a
 * packaged build launched, opened a window, and served 404 for every route — while `npm run
 * dev`, `npm run smoke` and all 333 tests passed, because in a source tree the renderer is
 * simply there. Nothing in any log said "the renderer is missing"; you got a blank window.
 *
 * Parsing the YAML rather than substring-matching it is the point. A test that greps for
 * "renderer" passes on a comment mentioning renderers.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { PACKAGED_RENDERER_DIR, PACKAGED_LICENSES_DIR, PACKAGED_ICON } from "../src/main/protocol.js";
import { ARTEFACTS } from "../scripts/collect-licences.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

interface ResourceEntry {
  from: string;
  to: string;
  /** Present only where the entry narrows what it copies. */
  filter: string[];
}

/**
 * Read the `extraResources:` list out of electron-builder.yml.
 *
 * Deliberately strict and deliberately narrow: it understands exactly the shape this file
 * uses, and throws on anything else. That is the safe direction — if the config is
 * restructured, the tests below fail loudly instead of quietly asserting nothing, which is how
 * a config test rots into decoration.
 *
 * (A real YAML parser would be better. `js-yaml` is present only as a transitive dependency of
 * electron-builder, and depending on another package's dependency is its own kind of rot.)
 */
function extraResources(): ResourceEntry[] {
  const lines = read("electron-builder.yml").split(/\r?\n/);
  const start = lines.findIndex((line) => line === "extraResources:");
  if (start === -1) throw new Error("electron-builder.yml has no extraResources block");

  const entries: ResourceEntry[] = [];
  let current: Partial<ResourceEntry> | undefined;

  const commit = (): void => {
    if (current === undefined) return;
    if (current.from === undefined || current.to === undefined) {
      throw new Error(`extraResources entry is missing from/to: ${JSON.stringify(current)}`);
    }
    entries.push({ ...current, filter: current.filter ?? [] } as ResourceEntry);
    current = undefined;
  };

  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-blank line ends the block — the next top-level key.
    if (line.trim() !== "" && !line.startsWith(" ")) break;
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    const item = /^\s*-\s+from:\s*(\S+)\s*$/.exec(line);
    if (item?.[1] !== undefined) {
      commit();
      current = { from: item[1] };
      continue;
    }
    const to = /^\s*to:\s*(\S+)\s*$/.exec(line);
    if (to?.[1] !== undefined && current !== undefined) {
      current.to = to[1];
      continue;
    }
    // Both shapes electron-builder accepts: `filter: ["*.whl"]` and a nested list.
    const inline = /^\s*filter:\s*\[(.+)\]\s*$/.exec(line);
    if (inline?.[1] !== undefined && current !== undefined) {
      current.filter = inline[1].split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (/^\s*filter:\s*$/.test(line) && current !== undefined) {
      current.filter = [];
      continue;
    }
    const pattern = /^\s+-\s+["']([^"']+)["']\s*$/.exec(line);
    if (pattern?.[1] !== undefined && current?.filter !== undefined) {
      current.filter.push(pattern[1]);
    }
  }
  commit();

  if (entries.length === 0) throw new Error("extraResources parsed to nothing — shape changed?");
  return entries;
}

describe("the renderer reaches a packaged build", () => {
  it("copies the static export to the directory main reads", () => {
    // The whole defect, in one assertion. `from` is where Next writes; `to` is what
    // `process.resourcesPath` is joined with at startup. Either one alone proves nothing.
    expect(extraResources()).toContainEqual(
      expect.objectContaining({ from: "renderer/out", to: PACKAGED_RENDERER_DIR })
    );
  });

  /**
   * Source maps stay on the build machine.
   *
   * `productionBrowserSourceMaps` is on, so `renderer/out` carries 6.8MB of `.js.map` that
   * reconstruct the original TypeScript. Shipping them would put the source inside every
   * installer; `npm run resolve-log` reads them from the build output instead.
   *
   * The include-everything half is the part that matters. electron-builder reads a filter list
   * as the complete description of what to copy, so a list holding only the negation copies
   * nothing — and that is this file's original defect exactly: a packaged app that opens a
   * window and 404s every route. Asserting both lines, and their order, is what keeps the fix
   * from turning into that bug.
   */
  it("excludes source maps from the packaged renderer, without excluding everything", () => {
    const renderer = extraResources().find((entry) => entry.from === "renderer/out");
    expect(renderer?.filter).toContain("!**/*.map");
    expect(renderer?.filter).toContain("**/*");
    expect(renderer?.filter.indexOf("**/*")).toBeLessThan(renderer!.filter.indexOf("!**/*.map"));
  });

  it("still ships the vendored wheels alongside it", () => {
    // Adding the renderer entry must not have displaced the offline-first-run resources.
    expect(extraResources().map((entry) => entry.to)).toContain("vendor/pyodide-packages");
  });

  it("builds the renderer before packaging it", () => {
    // The copy is only as good as what is on disk when it runs. `electron-vite build` does
    // not produce `renderer/out`, so without this the package step would happily ship
    // whatever stale export happened to be lying around — or nothing, on a clean checkout.
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.package).toContain("build:renderer");
    expect(scripts["build:renderer"]).toBeDefined();
  });

  it("does not try to put the renderer in the asar file list", () => {
    // `files` is electron-vite's output. A `renderer/**` entry there would look like a fix
    // and silently do nothing, because the export lives outside that build.
    expect(read("electron-builder.yml")).not.toMatch(/^\s+- renderer/m);
  });
});

/**
 * The installer carries its own licence text and its own icon.
 *
 * Both were absent, and both are the kind of absence that surfaces on the worst possible day.
 *
 * **Licences.** `files:` is `out/**` plus `package.json` and the app root is `desktop/`, so the
 * repository-root `LICENSE` and `NOTICE` were outside it and never copied; Monaco's notices were not
 * copied either, because `copy-monaco.mjs` takes only `min/vs`. That is an obligation rather than
 * tidiness — Apache-2.0 §4(d), MPL-2.0 §3.1 — and `NOTICE` claimed it was already met.
 *
 * **Icon.** `buildResources: build` was set and `build/` held only the mac entitlements file, so a
 * build shipped the default Electron logo. Nothing fails, nothing logs, and it is visible only once
 * someone installs the artifact.
 */
describe("the installer carries its licences and its icon", () => {
  const manifest = ARTEFACTS.map((artefact) => artefact.to).sort();

  it("ships every licence the manifest names", () => {
    // The manifest is what `collect-licences.mjs` exports, so this asserts against the script's own
    // declaration rather than a second list that could drift from it. A comment naming which licences
    // ship cannot be checked; a table can.
    expect(manifest).toEqual([
      "CONTENT-LICENSE",
      "LICENSE",
      "NOTICE",
      "monaco/LICENSE",
      "monaco/ThirdPartyNotices.txt",
      "pyodide/MPL-2.0.txt",
    ]);
  });

  it("has the licence text that cannot be gathered at build time", () => {
    /**
     * Pyodide is MPL-2.0 and its npm package contains **no licence file at all** — a README, a
     * package.json, the wasm and stdlib, `pyodide-lock.json`, nothing else. So there is nothing for
     * the collector to copy and the text has to be committed, which is the one artefact here whose
     * absence the collector cannot detect for itself on a machine where it already ran.
     */
    const mpl = read("build/licences-static/MPL-2.0.txt");
    expect(mpl).toContain("Mozilla Public License Version 2.0");
    // All ten sections plus Exhibit A, so a truncated copy fails rather than a plausible-looking one.
    for (const section of [
      "1. Definitions",
      "5. Termination",
      "10. Versions of the License",
      "Exhibit A - Source Code Form License Notice",
    ]) {
      expect(mpl, section).toContain(section);
    }
  });

  it("copies the gathered licences to the directory main reads", () => {
    const entry = extraResources().find((r) => r.to === PACKAGED_LICENSES_DIR);
    expect(entry, `no extraResources entry copying to ${PACKAGED_LICENSES_DIR}`).toBeDefined();
    expect(entry?.from).toBe("build/licenses");
  });

  it("gathers them before electron-builder runs", () => {
    // Order, not just presence: collecting after the installer is built writes into a directory
    // electron-builder has already finished reading.
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    const packageScript = scripts.package ?? "";
    expect(packageScript).toContain("collect:licences");
    expect(packageScript.indexOf("collect:licences")).toBeLessThan(
      packageScript.indexOf("electron-builder")
    );
  });

  it("shows a licence in the installer, and it is the real one", () => {
    // Committed rather than generated so it exists with no build having run — the same reason the mac
    // entitlements assertion below works.
    const declared = /^\s*license:\s*(\S+)\s*$/m.exec(read("electron-builder.yml"))?.[1];
    expect(declared).toBe("build/eula.txt");
    expect(fs.existsSync(path.join(root, declared as string))).toBe(true);

    // A preamble is fine; a paraphrase in place of the licence is not. The duplication with the
    // root LICENSE is deliberate and this is what stops it drifting into a summary.
    const eula = read("build/eula.txt");
    expect(eula).toContain(fs.readFileSync(path.join(root, "..", "LICENSE"), "utf8"));

    /**
     * And the preamble must not misrepresent what follows.
     *
     * Verbatim-inclusion alone was not enough, which mutation testing showed: rewriting the preamble
     * to call itself a summary left the appended licence intact and every assertion passing. The
     * installer shows this page as *the licence*, so a preamble claiming to be an abridgement of one
     * is the misleading half — and the half a reader actually reads.
     */
    const preamble = eula.split(/^-{20,}$/m)[0] as string;
    expect(preamble).toMatch(/Apache License 2\.0/);
    expect(preamble, "the preamble must not present itself as a summary").not.toMatch(
      /summar|abridg|excerpt|paraphras/i
    );
  });

  it("declares an icon for every platform, and the files exist", () => {
    const icons = [...read("electron-builder.yml").matchAll(/^\s*icon:\s*(\S+)\s*$/gm)].map(
      (m) => m[1] as string
    );

    // win, mac, linux. Explicit per platform rather than trusting auto-detection, because an
    // explicit path is one this test can check.
    expect(icons).toHaveLength(3);
    for (const icon of icons) {
      expect(icon).toBe("build/icon.png");
      expect(fs.existsSync(path.join(root, icon)), icon).toBe(true);
    }
  });

  it("has an icon big enough for the sets derived from it", () => {
    /**
     * The assertion that catches the real regression. electron-builder derives `.ico`, `.icns` and
     * the Linux PNG set from this one file, and wants 1024 for macOS — so a 64px placeholder
     * committed in a hurry produces a blurry `.icns` or a hard failure on release day, and every
     * other assertion in this file passes.
     *
     * Read from the PNG header directly: signature, then IHDR width and height at byte offsets 16
     * and 20. No dependency, and it cannot be fooled by a renamed file.
     */
    const png = fs.readFileSync(path.join(root, "build/icon.png"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(1024);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(1024);
  });

  it("copies the icon to the path main resolves", () => {
    // `windows.ts` passes this to BrowserWindow, so main reads a file packaging must copy — the
    // exact defect this file was written for, one resource along.
    const entry = extraResources().find((r) => r.to === PACKAGED_ICON);
    expect(entry, `no extraResources entry copying to ${PACKAGED_ICON}`).toBeDefined();
    expect(entry?.from).toBe("build/icon.png");
  });

  it("declares no publish provider while there is no updater to feed", () => {
    /**
     * A two-sided pin, and the reason it is here rather than in a release phase: the `publish:` block
     * **broke packaging entirely.** `npm run package` died in `computeChannelNames` with "Cannot read
     * properties of null (reading 'channel')" — even under `--publish never`, declaring a provider
     * makes electron-builder build update-info metadata, and it cannot resolve a repository because
     * there is no git remote and no `repository` field. Deleting the block is what produced the first
     * installer this project has ever had.
     *
     * Both sides matter. Asserting only the absence of `publish:` would quietly allow an updater with
     * no feed; asserting only the absence of `electron-updater` would allow a feed with no updater.
     * Together they fail on the day someone adds the updater, which is the day to design a release
     * channel deliberately instead of inheriting a broken one.
     */
    const config = parse(read("electron-builder.yml")) as Record<string, unknown>;
    expect(config.publish, "a publish provider is declared").toBeUndefined();

    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(deps)).not.toContain("electron-updater");
  });

  it("keeps the vector and the raster from disagreeing", () => {
    // Both are generated from one set of constants, which is the only reason committing a raster
    // beside a vector is safe. If the generator is gone, they are two files nobody reconciles.
    expect(fs.existsSync(path.join(root, "scripts/render-icon.mjs"))).toBe(true);
    expect(read("build/icon.svg")).toContain("GENERATED by scripts/render-icon.mjs");
  });
});

/**
 * The unsigned build tells the user what to expect.
 *
 * ── WHY A TEST FOR A PARAGRAPH ────────────────────────────────────────────────────────────────
 *
 * Both the packaging config and the workflow *claimed* the README documented the SmartScreen prompt.
 * It did not — the word appeared nowhere in it. So the config was answering "why is this unsigned?"
 * by pointing at a document that did not answer it, and the only reader who could discover that was a
 * user hitting the dialog with nothing to look up.
 *
 * That is the same shape as the `NOTICE` claiming licences were in the build, and it recurs because a
 * cross-file claim has nothing holding the two files together. This is the something.
 *
 * Deliberately derived from the config rather than pinned: the assertion is *"if you are unsigned,
 * say so where users read"*, so re-signing the app is what removes the requirement, not editing a
 * list. Both dialogs are covered because the mac half is the one nobody here can test by launching it.
 */
describe("the build documents its signing state", () => {
  const readme = fs.readFileSync(path.join(root, "..", "README.md"), "utf8");
  const config = parse(read("electron-builder.yml")) as {
    win?: { signAndEditExecutable?: boolean };
    mac?: { notarize?: unknown };
  };

  it("leaves Windows signing to SignPath and macOS unnotarised", () => {
    /**
     * The premise, asserted so the tests below cannot become vacuous. `signAndEditExecutable: false`
     * means electron-builder does not sign — SignPath signs the NSIS installer post-build in
     * release.yml — and it must stay false (electron-builder has no certificate on the runner and
     * would fail). `mac.notarize` undefined means macOS is still unnotarised; if it is ever set, the
     * macOS copy below must be revisited in the same commit.
     */
    expect(config.win?.signAndEditExecutable).toBe(false);
    expect(config.mac?.notarize, "notarisation is configured — revisit the README section").toBeUndefined();
  });

  it("names both prompts, and what to click", () => {
    expect(readme).toContain("SmartScreen");
    expect(readme).toContain("Gatekeeper");
    /**
     * The actionable half. "You will see a warning" is not documentation — on Windows the button is
     * hidden behind **More info**, and on macOS 15 the Control-click shortcut no longer works, which
     * are exactly the two things a user cannot guess.
     */
    expect(readme).toContain("More info");
    expect(readme).toContain("Privacy & Security");
  });

  it("says macOS is unsigned and unnotarised", () => {
    /**
     * Stated as a positive rather than as "does not claim to be signed". The first attempt at this
     * assertion tried a negative lookahead — `/\bcode-signed\b(?!.*not)/` — and failed on the README's
     * own sentence, because the negation is *before* the word: "not code-signed". A regex cannot
     * reliably tell an assertion from its denial, so require the denial. Scoped to macOS now that
     * Windows is signed.
     */
    expect(readme).toMatch(/not code-signed/i);
    expect(readme).toMatch(/unsigned and unnotarised/i);
  });

  it("says the Windows installer is signed via SignPath", () => {
    /**
     * The Windows half is Authenticode-signed post-build by SignPath (release.yml), so the README must
     * say so — the old blanket "not code-signed on any platform" was scoped down to macOS. A signed
     * installer described as unsigned would send people to build from source they did not need to.
     */
    expect(readme).toContain("SignPath");
    expect(readme, "the README does not describe the Windows Authenticode signature").toContain(
      "Authenticode"
    );
  });

  it("keeps the config's cross-reference honest in both files", () => {
    /**
     * The original defect, exactly. Either file may point at the README, but only while the README
     * answers the question — and the phrase they both point at is the section heading, so a rename
     * that orphans the reference fails here.
     */
    const referrers = [read("electron-builder.yml"), read("../.github/workflows/desktop.yml")];
    for (const source of referrers) {
      if (/README/.test(source)) {
        expect(readme, "a config points at the README for this and the section is gone").toContain(
          "## Installing a build"
        );
      }
    }
  });
});

/**
 * The release workflow, which has never run.
 *
 * There is no git remote, so every assertion here is static analysis of YAML — the same standing this
 * file's workflow guards have had since Phase 1, and the reason they exist. What could be rehearsed was
 * rehearsed by hand instead of asserted: the checksum pipeline was run over real installers and
 * verified with `sha256sum --check`, and the source-map archive was created, extracted elsewhere, and
 * used to resolve a genuine stack from a running build.
 *
 * These cover what a rehearsal cannot: the cross-file claims. A workflow that says it reuses the gate,
 * a NOTICE that says the SBOM is attached, and a config that keeps publishing separable are all claims
 * about *other files*, which is the shape of defect this repository keeps producing.
 */
describe("the release workflow", () => {
  interface Step {
    uses?: string;
    run?: string;
    name?: string;
    with?: Record<string, unknown>;
  }
  interface Job {
    uses?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps?: Step[];
  }
  const load = (relative: string): { jobs: Record<string, Job> } =>
    parse(read(relative)) as { jobs: Record<string, Job> };

  const release = load("../.github/workflows/release.yml");
  const desktop = load("../.github/workflows/desktop.yml");
  const releaseSource = read("../.github/workflows/release.yml");
  const desktopSource = read("../.github/workflows/desktop.yml");

  /** Every `uses:` in a workflow, jobs and steps alike. */
  const allUses = (wf: { jobs: Record<string, Job> }): string[] =>
    Object.values(wf.jobs).flatMap((job) => [
      ...(job.uses === undefined ? [] : [job.uses]),
      ...(job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    ]);

  it("finds the jobs, so nothing below is vacuous", () => {
    // `distribute` was removed when the release collapsed to one repository. `sign-windows` was added
    // to Authenticode-sign the installers with SignPath in an UNPRIVILEGED job, so the publishing job
    // (`release`) runs no third-party code. Spelled out rather than loosened to a length: this list is
    // what makes the assertions below non-vacuous, and "at least two jobs" would pass against the
    // wrong ones.
    expect(Object.keys(release.jobs).sort()).toEqual(["gate", "release", "sign-windows"]);
    expect(release.jobs.release?.needs).toContain("gate");
  });

  it("runs the same gate as a pull request rather than a copy of it", () => {
    /**
     * The property, and the reason `workflow_call` was added to desktop.yml.
     *
     * The original CI bug was two jobs each independently remembering to install the renderer and one
     * forgetting. Copying three jobs into a release workflow is that bug at workflow scale, and it
     * would be *worse* here: a release built by a laxer gate than a pull request is the one build where
     * nobody notices. Both halves are asserted, because the `uses:` alone would silently 404.
     */
    expect(release.jobs.gate?.uses).toBe("./.github/workflows/desktop.yml");
    // `on:` is the YAML 1.1 boolean `true` under some parsers; check the source for the trigger.
    expect(desktopSource, "desktop.yml is not callable, so the gate reference is dead").toMatch(
      /^\s*workflow_call:/m
    );
  });

  it("keeps write permission out of the workflow that runs on every pull request", () => {
    /**
     * The whole reason these are two files. `desktop.yml` runs on `pull_request`, which on a public
     * repository means it runs code from forks; it must not be able to publish anything.
     */
    expect(release.jobs.release?.permissions?.contents).toBe("write");
    expect(desktopSource).not.toMatch(/contents:\s*write/);
  });

  it("uses no third-party action in the job that can publish", () => {
    /**
     * `gh` instead of a release action, deliberately: it is preinstalled on every runner, so the one
     * job holding `contents: write` and an OIDC token runs no code from outside GitHub. It also
     * removes the question of how to pin a third-party action, which cannot be answered honestly
     * offline — a SHA nobody verified is worse than a tag.
     */
    const inRelease = (release.jobs.release?.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : []));
    expect(inRelease.length).toBeGreaterThan(0);
    for (const action of inRelease) {
      expect(action, `${action} is not a first-party action`).toMatch(/^actions\//);
    }
  });

  it("pins every action it uses", () => {
    for (const action of [...allUses(release), ...allUses(desktop)]) {
      // A local reusable workflow is a path, not a registry reference, and has nothing to pin.
      if (action.startsWith("./")) continue;
      expect(action, `${action} has no version`).toMatch(/@[\w.-]+$/);
    }
  });

  it("refuses to cut a release from something that is not a version tag", () => {
    /**
     * `workflow_dispatch` can name any ref, and `gh release create` will happily create a release
     * *and a tag* from a branch name. Undoing that on a public repository is unpleasant, so the guard
     * is in the workflow and pinned here.
     */
    expect(releaseSource).toMatch(/grep -Eq .\^v\[0-9\]/);
  });

  /**
   * Steps by name, and their `run` body rather than the file.
   *
   * The first version of the two tests below matched against `releaseSource`, and both survived
   * mutation: deleting `--draft` from the command left the word in the comment that explains why
   * `--draft` matters, and renaming the checksum output left `SHA256SUMS.txt` in the release notes.
   * A guard that reads a file containing its own rationale is checking that the rationale is still
   * written down. Same shape as `copy.ts`'s `url` field satisfying an assertion about the body.
   */
  const releaseStep = (name: string): string => {
    const step = (release.jobs.release?.steps ?? []).find((s) => s.name === name);
    expect(step, `no step named ${name}`).toBeDefined();
    return step?.run ?? "";
  };

  it("produces one checksum file over everything", () => {
    // The substitute for a code signature, on installers the README says outright are unsigned.
    // Rehearsed for real: run over three installers, an archive and two SBOMs, then verified with
    // `sha256sum --check --ignore-missing`, which reported OK for all six.
    const run = releaseStep("Checksums");
    /**
     * The redirect, not the mention. Renaming only the output left `SHA256SUMS.txt` in the `mv` on the
     * next line, so "the step names the file" passed while the step wrote somewhere else — and the
     * release would then attach a checksum file that documented nothing.
     */
    expect(run).toMatch(/sha256sum\s*>\s*\.\.\/SHA256SUMS\.txt/);
    // Sorted, so two runs over the same set produce byte-identical output — the same reason
    // `artifactName` carries no timestamp.
    expect(run).toContain("sort");
  });

  it("creates a draft, not a release", () => {
    // A human writes the notes and can delete a bad build before anyone can download it. The step is
    // idempotent — it refreshes an existing draft rather than failing on a re-cut tag — so the
    // create path lives in the `else` branch, and `--draft`/`assets/*` are asserted there.
    const run = releaseStep("Create or refresh the draft release");
    expect(run).toMatch(/gh release create/);
    expect(run).toMatch(/--draft/);
    expect(run).toMatch(/assets\/\*/);
  });

  it("keeps packaging and publishing separable at both ends", () => {
    /**
     * Two-sided, and the second side is what a release workflow erodes. `--publish never` means
     * electron-builder never uploads, so publishing is `gh`'s job alone and a local `npm run package`
     * cannot reach the internet by accident. Removing it would make packaging publish as a side
     * effect, which is exactly what `--draft` exists to prevent.
     */
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.package).toContain("--publish never");
  });

  describe("the source-map archive", () => {
    const step = (desktop.jobs.package?.steps ?? []).find((s) => /tar -czf/.test(s.run ?? ""));

    it("archives the chunks and not only the maps", () => {
      /**
       * The correction this whole asset exists around, and it is measured rather than assumed: a
       * maps-only directory — 43 `.js.map` files, every one of them present — resolved **nothing**,
       * because `resolve-log.mjs` reads each chunk's own trailing `sourceMappingURL` to find its map.
       * Next hashes the two names independently, so `1f9c7c08.js` is described by `0284649254.js.map`
       * and there is no other link between them. A `*.map` glob here would look completely reasonable
       * and produce an archive that resolves nothing at all.
       */
      expect(step, "no tar step in the package job").toBeDefined();
      const run = step?.run ?? "";
      expect(run).toContain("-C renderer/out/_next/static");
      expect(run).toMatch(/\bchunks\b/);
      expect(run, "a maps-only glob would resolve nothing").not.toMatch(/\*\.map/);
    });

    it("records the commit that built it", () => {
      /**
       * Because a resolved position is meaningless without the source it was compiled from. Rehearsing
       * this cost real time: the archive resolved to a line that is a different function in the working
       * tree, and the map was right — the build runs the React Compiler and the maps resolve to *its*
       * output. Without the commit there is no way to distinguish that from a stale archive.
       */
      expect(step?.run ?? "").toContain("BUILD-COMMIT.txt");
      expect(desktopSource).toContain("github.sha");
    });

    it("is uploaded from every platform that builds one", () => {
      const uploads = (desktop.jobs.package?.steps ?? []).filter((s) =>
        s.uses?.startsWith("actions/upload-artifact")
      );
      const maps = uploads.find((s) => String(s.with?.name).includes("sourcemaps"));
      expect(maps, "the archive is created and never uploaded").toBeDefined();
      // Losing this is how a release quietly ships no archive at all.
      expect(maps?.with?.["if-no-files-found"]).toBe("error");
    });
  });

  it("makes the NOTICE's SBOM claim true", () => {
    /**
     * `NOTICE` said third-party licences "are reproduced in the distributed build and enumerated in
     * the SBOM attached to each release". Both halves were false when it was written — Phase 2 made
     * the first true and this makes the second. Asserted rather than trusted, because the sentence
     * carries an Apache-2.0 §4(d) obligation and nothing else connects it to a workflow.
     */
    const notice = read("../NOTICE");
    if (!/SBOM/.test(notice)) return;

    /**
     * **Two** of them, because the NOTICE says "one per dependency tree" and the app has two. One SBOM
     * covering only `desktop/` would describe half the application while reading as if it described all
     * of it — the same blind spot the licence gate had before the renderer was added to it.
     *
     * Counted rather than matched. `expect(desktopSource).toContain("cyclonedx-npm")` was the first
     * version and it survived deleting one of the two generators, because the other one still said the
     * word.
     */
    const generators = (desktop.jobs.licences?.steps ?? []).filter((s) =>
      /cyclonedx-npm/.test(s.run ?? "")
    );
    expect(generators, "the NOTICE promises an SBOM per dependency tree").toHaveLength(2);
    const outputs = generators.map((s) => /--output-file\s+(\S+)/.exec(s.run ?? "")?.[1]);
    expect(new Set(outputs).size, "both SBOMs write to the same file").toBe(2);

    const sbomUpload = (desktop.jobs.licences?.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/upload-artifact")
    );
    expect(sbomUpload?.with?.name).toBe("sbom");
    // Both files, or the release attaches one and the NOTICE still claims two.
    expect(String(sbomUpload?.with?.path)).toContain("sbom-main.json");
    expect(String(sbomUpload?.with?.path)).toContain("sbom-renderer.json");
    // …and attached by the release. `merge-multiple` flattens every artifact into one directory,
    // which is what makes `assets/*` cover the SBOMs without naming them.
    const download = (release.jobs.release?.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/download-artifact")
    );
    expect(download?.with?.["merge-multiple"]).toBe(true);
    expect(releaseSource).toMatch(/assets\/\*/);
  });
});

describe("resources the config points at exist", () => {
  it("has the mac entitlements file it declares", () => {
    // Declared before it existed. Only read during signing, so an unsigned build never
    // noticed — this fails on the day someone configures an identity, which is the worst
    // day to discover it.
    const declared = /^\s*entitlements:\s*(\S+)\s*$/m.exec(read("electron-builder.yml"))?.[1];
    expect(declared).toBeDefined();
    expect(fs.existsSync(path.join(root, declared as string))).toBe(true);
  });

  it("builds the approval window's preload as well as the main one", () => {
    /**
     * Two preload entries, and the second one is a security control.
     *
     * The approval window loads `../preload/approval.js`. If the build config regressed to a
     * single input, that file would be missing, `window.approval` would be undefined, and the
     * buttons would throw — so nothing could ever be approved. It fails closed, which is the
     * right direction and still a broken product, discoverable only by running the agent in a
     * packaged build and trying to apply something.
     */
    const config = read("electron.vite.config.ts");
    expect(config).toMatch(/src\/preload\/index\.ts/);
    expect(config).toMatch(/src\/preload\/approval\.ts/);
    // `[name].js`, not a fixed `index.js` — with a fixed name the second entry would collide
    // with the first and one of them would silently win.
    expect(config).toMatch(/entryFileNames:\s*"\[name\]\.js"/);
  });

  it("unpacks the native modules that cannot be loaded from inside an archive", () => {
    // Pyodide reads .wasm as real files; a .node addon is loaded by the OS loader. Both fail
    // at runtime only, and only in a packaged build.
    const yaml = read("electron-builder.yml");
    expect(yaml).toMatch(/^\s+- node_modules\/pyodide\/\*\*$/m);
    expect(yaml).toMatch(/^\s+- node_modules\/@lydell\/node-pty\*\/\*\*$/m);
  });
});

/**
 * The workflow installs what its steps read.
 *
 * Same property as the block above, one level out. That one says the files the app reads at
 * runtime must be files packaging copies; this one says the files the *build* reads must be
 * files the job installs. Same invisibility, too: every test in this directory passed while
 * two of the three CI jobs could not have completed a single run.
 *
 * WHAT WAS BROKEN. `desktop/` and `desktop/renderer/` are separate installs — no npm
 * workspaces, no `postinstall`. `verify` and `package` both ran `npm ci` in `desktop` only,
 * and then:
 *
 *   - `npm run typecheck` failed. Main's tsconfig covers `tests/`, and several tests import
 *     renderer components through the `@` alias, so tsc reaches renderer sources. Measured in
 *     a clean tree: 6 errors, every one of them a renderer path.
 *   - `npm --prefix renderer run typecheck` failed outright — dozens of TS2307.
 *   - `npm run smoke` and `npm run package` failed inside `build:renderer` with
 *     "'next' is not recognized".
 *
 * It survived because there is no git remote, so the workflow had never executed. That is the
 * reason these assertions are derived over *every* job rather than naming the two that were
 * wrong: the next job someone adds is covered without anyone remembering this file exists.
 */
describe("the workflow installs what its steps read", () => {
  interface Step {
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
    "working-directory"?: string;
  }
  interface Job {
    steps?: Step[];
  }

  /** Parsed, not grepped — the nesting is the whole point and a regex cannot see job scope. */
  function workflow(): { jobs: Record<string, Job> } {
    return parse(read("../.github/workflows/desktop.yml")) as { jobs: Record<string, Job> };
  }

  const jobs = Object.entries(workflow().jobs);

  /**
   * Commands that cannot run without `desktop/renderer/node_modules`.
   *
   * `npm run typecheck` is in this list and it is the least obvious member — main's own
   * typecheck, which sounds like it has nothing to do with the renderer. It does, through the
   * tests, and leaving it out would have let the original bug half-survive.
   */
  const NEEDS_RENDERER = /--prefix renderer|build:renderer|run smoke|run package|run typecheck/;

  /** The renderer's install step, if the job has one. */
  function rendererInstall(job: Job): Step | undefined {
    return job.steps?.find(
      (step) => step.run?.trim().startsWith("npm ci") && step["working-directory"] === "desktop/renderer"
    );
  }

  it("finds the jobs to check", () => {
    // If the workflow is restructured and this stops finding jobs, every assertion below
    // becomes vacuously true — which is exactly the failure mode this whole file exists for.
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(jobs.flatMap(([, job]) => job.steps ?? []).length).toBeGreaterThan(10);
  });

  it("installs the renderer in every job whose steps read it", () => {
    const missing = jobs
      .filter(([, job]) => (job.steps ?? []).some((step) => NEEDS_RENDERER.test(step.run ?? "")))
      .filter(([, job]) => rendererInstall(job) === undefined)
      .map(([name]) => name);

    expect(missing, "jobs that read the renderer tree without installing it").toEqual([]);
  });

  it("points that install at the renderer, not at a path relative to the default", () => {
    /**
     * A real trap rather than a hypothetical one. The workflow sets
     * `defaults.run.working-directory: desktop`, but a step-level `working-directory` is
     * resolved against the workspace root — so `renderer` would look right, read right, and
     * fail with "no such directory". `desktop/renderer` is correct, and `rendererInstall`
     * above only matches that spelling, so this asserts the *count* is what we expect rather
     * than trusting the finder.
     */
    const installs = jobs.map(([name, job]) => [name, rendererInstall(job)] as const);
    const withInstall = installs.filter(([, step]) => step !== undefined).map(([name]) => name);

    // `verify-accounts` joined this list when the end-to-end account job was added. It installs
    // both trees because it builds the renderer and launches the real app.
    expect(withInstall.sort()).toEqual(["licences", "package", "verify", "verify-accounts"]);
  });

  it("keys the npm cache on both lockfiles wherever both trees are installed", () => {
    const wrong = jobs
      .filter(([, job]) => rendererInstall(job) !== undefined)
      .filter(([, job]) => {
        const setup = job.steps?.find((step) => step.uses?.startsWith("actions/setup-node"));
        const key = String(setup?.with?.["cache-dependency-path"] ?? "");
        // Keying on one lockfile leaves the renderer's install uncached and, worse, fails to
        // invalidate when only the renderer's dependencies moved.
        return !key.includes("desktop/package-lock.json") || !key.includes("desktop/renderer/package-lock.json");
      })
      .map(([name]) => name);

    expect(wrong, "jobs installing both trees but caching one").toEqual([]);
  });

  it("vendors Pyodide as part of packaging, not only in CI", () => {
    /**
     * `desktop/vendor/` is gitignored and `electron-builder.yml` copies it as an
     * extraResource. A human packaging a clean clone therefore either hits a missing directory
     * or ships an app that reaches for a CDN the first time a learner runs Python — breaking
     * spec §4.4's offline promise in the build a user installs, where nobody is watching.
     *
     * The workflow doing it is not sufficient, which is the point of asserting the script.
     */
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    const packageScript = scripts.package ?? "";

    expect(packageScript).toContain("vendor:pyodide");
    // Order matters, not just presence: vendoring after the installer is built copies the wheels
    // into a directory electron-builder has already finished reading.
    expect(packageScript.indexOf("vendor:pyodide")).toBeLessThan(packageScript.indexOf("electron-builder"));
  });

  it("pins the same Node version in .nvmrc as the workflow uses", () => {
    // Spec §4.3 asks for an .nvmrc. Two sources of truth for a toolchain version is the kind
    // of drift that produces a failure only one contributor can reproduce.
    const nvmrc = read("../.nvmrc").trim();
    expect(nvmrc).toBe("22");

    const versions = jobs
      .flatMap(([, job]) => job.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/setup-node"))
      .map((step) => String(step.with?.["node-version"] ?? ""));

    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (const version of versions) expect(version).toBe(nvmrc);
  });
});
