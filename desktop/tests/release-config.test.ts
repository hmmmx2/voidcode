/**
 * What a packaged build is told about the world, and who may publish it.
 *
 * The addresses in a packaged app are BAKED IN. `electron.vite.config.ts` reads four
 * `VOIDCODE_BUILD_*` variables at build time into `__VOIDCODE_BUILD__`, and `platform/config.ts`
 * honours the matching runtime environment variables only when the app is unpackaged. So a wrong
 * value in CI ships inside the binary and the person running it cannot correct it — which is the
 * whole reason these are checked here rather than left to a release rehearsal that has never run.
 *
 * None of the tests below need a remote, a Mac, or a certificate. They check the cross-file claims
 * a rehearsal cannot: that the workflow passes what the build reads, that no client ID is hardcoded
 * anywhere in the source, that the macOS bundle is signed by something and that CI verifies it, and
 * that exactly one workflow owns a `v*` tag.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const desktopRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(desktopRoot, "..");

const read = (relative: string): string =>
  fs.readFileSync(path.join(desktopRoot, relative), "utf8").replace(/\r\n/g, "\n");
const readRepo = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

/**
 * The build-time settings, and what each one decides.
 *
 * THIS TABLE HELD TWO DEAD ENTRIES THROUGH A WHOLE FEATURE REMOVAL, and that is worth recording
 * because the pin worked exactly as designed while protecting nothing. It listed
 * `VOIDCODE_BUILD_GOOGLE_CLIENT_ID` and `VOIDCODE_BUILD_MICROSOFT_CLIENT_ID`, and the assertions
 * below checked that every name here is both baked by `electron.vite.config.ts` and passed by
 * `desktop.yml`. Both were — so nothing failed when provider sign-in was deleted, because the two
 * ends still agreed with each other. They agreed about a value no code could act on:
 * `oauthClientId()`, the only reader of the baked ids, had no callers at all.
 *
 * A pair of settings that agree with each other is not the same as a pair that does something. What
 * catches this now is not a stronger pin here — it is the rule the repository already holds
 * elsewhere, that a knob nothing reads is worse than no knob, applied on removal.
 */
/*
 * AND IT HAPPENED A SECOND TIME, to the entry that was removed from this table alongside this note.
 *
 * `VOIDCODE_BUILD_SITE_URL` sat here described as "the public site, for the legal links and the
 * payment return pages". The workflow passed it, `electron.vite.config.ts` baked it,
 * `platform/config.ts` validated it in `siteUrl()`, and the assertions below confirmed both ends
 * agreed — while `siteUrl()` had no callers at all, and neither purpose in that description was
 * this application's: the legal documents render in-app and credits are bought against the API.
 *
 * The docstring above was already the right warning and the table was already the thing it warned
 * about. What finally caught it was not a test: it was writing down, for a person, the list of
 * variables they had to go and set, and asking of each one what would break if they did not.
 */
const BUILD_VARS = {
  VOIDCODE_BUILD_API_URL: "where the app sends a session; null disables every account feature",
} as const;

interface Step {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
  /** Action steps, which have no `run` at all — how artifacts move between jobs. */
  uses?: string;
  with?: Record<string, string>;
}
interface Job {
  steps?: Step[];
  strategy?: { matrix?: { os?: string[] } };
}

const desktopWorkflow = parse(readRepo(".github/workflows/desktop.yml")) as {
  jobs: Record<string, Job>;
};

/** The step that runs electron-builder, found by what it does rather than by its name. */
function packageStep(): Step {
  const steps = Object.values(desktopWorkflow.jobs).flatMap((job) => job.steps ?? []);
  const step = steps.find((s) => (s.run ?? "").includes("npm run package"));
  expect(step, "no step in desktop.yml runs `npm run package`").toBeDefined();
  return step as Step;
}

describe("the build's addresses come from the workflow", () => {
  it("reads every build variable from the environment, with no default", () => {
    /**
     * A default would be the worst of both: `??` a real URL and every fork's build talks to our
     * server; `??` a placeholder and a misconfigured release ships a binary pointing at nothing
     * while looking configured. `null` is the value `platform/config.ts` is written to handle — it
     * reports "VoidCode isn't set up in this build" rather than calling anything.
     */
    const config = read("electron.vite.config.ts");
    for (const [name, why] of Object.entries(BUILD_VARS)) {
      expect(config, `${name} is not read at build time — ${why}`).toContain(
        `process.env.${name}`
      );
    }
    expect(config, "the build config is not handed to main").toContain("__VOIDCODE_BUILD__");
  });

  it("passes all four to the packaging step", () => {
    const env = packageStep().env ?? {};
    for (const [name, why] of Object.entries(BUILD_VARS)) {
      expect(env[name], `the installer job does not pass ${name} — ${why}`).toBeDefined();
      // Repository variables, never secrets: these are public identifiers the installer hands to
      // every user. A `secrets.` reference here would also silently produce an empty value on a
      // fork's pull request, which looks identical to a missing variable.
      expect(env[name]).toMatch(/^\$\{\{\s*vars\./);
    }
  });

  it("does not let a packaged build be re-pointed by its environment", () => {
    /**
     * `VOIDCODE_BUILD_ALLOW_OVERRIDE=1` makes `overridesAllowed()` true even when packaged, which
     * exists for a staging build. Setting it in the ordinary installer job would mean anything that
     * can set an environment variable on a user's machine could redirect where their password goes.
     */
    expect(packageStep().env ?? {}).not.toHaveProperty("VOIDCODE_BUILD_ALLOW_OVERRIDE");
  });

  it("hardcodes no client ID or secret anywhere in the source", () => {
    /**
     * The failure this catches is a developer pasting their own ID in to test the flow and
     * committing it. A Google client ID is public, so it is not a leak — but it IS the identity
     * every installed copy would present, and it cannot be changed without a new release.
     *
     * `GOCSPX-` is Google's client-secret prefix, and that one would be a real leak.
     */
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
          continue;
        }
        if (!/\.(ts|tsx|cjs|mjs|json)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        // The literal, not a mention: this file and `DECISIONS.md` both discuss the pattern.
        for (const pattern of [/\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/, /GOCSPX-[\w-]{10,}/]) {
          if (pattern.test(text)) offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    walk(path.join(desktopRoot, "src"));
    walk(path.join(desktopRoot, "renderer", "src"));
    expect(offenders, "a provider credential is committed").toEqual([]);
  });
});

describe("the macOS bundle is signed by something", () => {
  const hook = "build/ad-hoc-sign.cjs";

  it("runs a signing hook after packing", () => {
    /**
     * WHY THIS MATTERS MORE THAN A WARNING. arm64 macOS refuses to execute a binary with no
     * signature at all, so a genuinely unsigned build tells an Apple silicon user the app is
     * "damaged" — with no Open Anyway, because the refusal happens before Gatekeeper's policy
     * check. An ad-hoc signature satisfies the kernel and still leaves the Gatekeeper prompt the
     * download page documents.
     */
    expect(read("electron-builder.yml")).toMatch(new RegExp(`^afterPack:\\s*${hook}$`, "m"));
    expect(fs.existsSync(path.join(desktopRoot, hook))).toBe(true);
  });

  it("signs with no identity, and deeply", () => {
    const source = read(hook);
    // `--deep` reaches the Electron framework and the helper apps. Without it the outer bundle is
    // signed and the code that actually runs is not, which fails at launch on arm64 — the exact
    // symptom the hook exists to prevent.
    expect(source).toContain('"--force", "--deep", "--sign", "-"');
    expect(source, "the hook does not check its own work").toContain('"--verify", "--deep", "--strict"');
    expect(source, "signing runs on platforms that have no codesign").toContain(
      'context.electronPlatformName !== "darwin"'
    );
  });

  it("is verified on the runner by something other than itself", () => {
    const steps = Object.values(desktopWorkflow.jobs).flatMap((job) => job.steps ?? []);
    const verify = steps.find((step) => (step.run ?? "").includes("codesign --verify"));
    expect(verify, "desktop.yml never verifies the signature it just made").toBeDefined();
    expect(verify?.if, "the verification would run on Linux and Windows too").toMatch(/macOS/);

    /**
     * THE COMMANDS, WITH THE SHELL COMMENTS STRIPPED.
     *
     * The first version asserted `run` contained "Signature=adhoc" and survived having the `grep`
     * replaced by `true` — because the comment directly above it, explaining why that grep matters,
     * contains the same string. A guard that reads a script containing its own rationale is
     * checking that the rationale is still written down. Same trap as `copy.ts`'s `url` field and
     * the two release-workflow tests above it.
     */
    const commands = (verify?.run ?? "")
      .split(String.fromCharCode(10))
      .filter((line) => !line.trim().startsWith("#"))
      .join(String.fromCharCode(10));

    // "Signature=adhoc" is what `codesign --display` prints for a signature with no identity.
    // Asserted because an identity appearing there would mean a certificate leaked into a public
    // build — and because the grep is what makes that an assertion rather than a log line.
    expect(commands, "nothing asserts the signature has no identity").toMatch(
      /grep -q "Signature=adhoc"/
    );
    expect(commands, "the signature is displayed but never verified").toMatch(
      /codesign --verify --deep --strict/
    );
    // `spctl --assess` asks whether Gatekeeper would ALLOW the app. For an unnotarised build the
    // honest answer is no, so asserting it would assert something this project does not claim.
    expect(verify?.run).not.toContain("spctl");
  });

  it("builds an installer on all three platforms", () => {
    const installer = Object.values(desktopWorkflow.jobs).find((job) =>
      (job.steps ?? []).some((step) => (step.run ?? "").includes("npm run package"))
    );
    expect(installer?.strategy?.matrix?.os).toEqual([
      "ubuntu-22.04",
      "windows-latest",
      "macos-14",
    ]);
  });
});

describe("one workflow owns a version tag", () => {
  it("only the release workflow triggers on v*", () => {
    /**
     * `containers.yml` triggered on `v*` as well, so every desktop release also rebuilt and
     * republished the server images — whose contents that release had not changed — and a failure
     * in either workflow showed up as "the release is red". The API's images have their own series
     * now, `api-v*`, because the two ship on completely different cadences.
     */
     const triggers = (relative: string): string => {
      const source = readRepo(relative);
      // `on:` parses as the YAML 1.1 boolean `true` under some parsers, so read the source.
      const block = source.split(/^on:$/m)[1] ?? "";
      return block.split(/^\w/m)[0] ?? "";
    };

    expect(triggers(".github/workflows/release.yml")).toMatch(/tags:\s*\["v\*"\]/);
    expect(triggers(".github/workflows/containers.yml")).toMatch(/tags:\s*\["api-v\*"\]/);
    expect(
      triggers(".github/workflows/containers.yml"),
      "containers.yml is back on v*, so a desktop release republishes server images"
    ).not.toMatch(/tags:\s*\["v\*"\]/);
    expect(triggers(".github/workflows/desktop.yml")).not.toMatch(/tags:/);
  });

  it("keeps the installers out of git", () => {
    /**
     * `desktop/release/` is 150-400 MB per platform, and on a Mac it contains a .app bundle —
     * thousands of files including a whole Electron framework. One `git add -A` after a local
     * package would be unrecoverable without a history rewrite.
     */
    expect(readRepo(".gitignore")).toMatch(/^desktop\/release\/$/m);
  });
});

describe("the release publishes the installers the download page links", () => {
  /**
   * ONE REPOSITORY NOW. The macOS and Windows installers are published from THIS repository's
   * release, under version-less names `voidcode-web` links directly. The `distribute` job that copied
   * them into `voidcode-mac`/`voidcode-windows` was removed: it needed a fine-grained cross-repo PAT
   * (`DIST_RELEASE_TOKEN`), and `github.token` cannot write to another repository at all, so the
   * whole release turned on one secret being present and correctly scoped — and it was not, so
   * nothing ever reached the download page. Collapsing to one repository removed that dependency.
   *
   * The properties below are what keep the download page working, and each has a way of being removed
   * that leaves the workflow syntactically fine and the outcome wrong.
   */
  const release = parse(readRepo(".github/workflows/release.yml")) as {
    on?: Record<string, unknown>;
    jobs: Record<string, { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] }>;
  };
  /**
   * Indexing a `Record` is `| undefined` under `noUncheckedIndexedAccess`, and a `!` here would be
   * the wrong fix: if the job is genuinely missing, every assertion below should fail with a
   * sentence saying so rather than a `TypeError` from the first property access.
   */
  function job() {
    const found = release.jobs.release;
    if (found === undefined) throw new Error("release.yml has no `release` job");
    return found;
  }
  const script = (name: string): string =>
    String(job().steps.find((step) => step.name === name)?.run ?? "");

  it("has no distribute job and no cross-repo token, because that was the failure removed", () => {
    /*
     * The whole point of the collapse: nothing in this workflow writes to another repository, so
     * there is no `DIST_RELEASE_TOKEN` that must be present, scoped and correct before a release can
     * finish. Reintroducing either is reintroducing the single point of failure.
     */
    expect(Object.keys(release.jobs), "the distribute job is back").not.toContain("distribute");
    // The PARSED jobs, not the raw file: YAML comments are stripped on parse, so the paragraph above
    // this workflow explaining why the token was removed cannot trip a guard against the token being
    // USED. Scanning the source text would fail on the word in its own rationale — the exact trap
    // this repo has hit before.
    expect(
      JSON.stringify(release.jobs),
      "a cross-repo token is back in the release workflow"
    ).not.toContain("DIST_RELEASE_TOKEN");
  });

  it("publishes a version-less copy of every installer, under the names the website links", () => {
    /*
     * `voidcode-web` links `releases/latest/download/<name>`, a redirect with no API limit, which
     * needs a name that does not change between releases — and `artifactName` carries the version. So
     * the release copies each installer to a fixed name. These four strings are a CONTRACT with that
     * page's `stableName` fields and `scripts/resolve-release.mjs`'s `STABLE`.
     *
     * WHAT THIS TEST CAN AND CANNOT DO: it pins THIS side, so the workflow cannot be renamed without
     * the change being deliberate. It CANNOT see the other repository, so the two lists are kept in
     * step by a person — the same shape this repo warns about elsewhere, and the honest remedy if
     * these ever change is a committed contract file the way `contracts/credit-packs.json` already
     * works. Four strings written once did not seem to earn that; a fifth would.
     */
    const copy = script("Copy each installer to a version-less name");
    expect(copy, "no step copies the installers to stable names").toContain("cp ");

    for (const [pattern, stable] of [
      ["*-mac-arm64.dmg", "VoidCode-macOS-AppleSilicon.dmg"],
      ["*-mac-x64.dmg", "VoidCode-macOS-Intel.dmg"],
      ["*-win-x64.exe", "VoidCode-Windows-x64-Setup.exe"],
      ["*-win-arm64.exe", "VoidCode-Windows-ARM64-Setup.exe"],
    ] as const) {
      expect(copy, `nothing copies ${pattern}`).toContain(pattern);
      expect(copy, `${stable} is not the name published`).toContain(stable);
    }

    // And it refuses rather than publishing a name with no file behind it, which would be a button on
    // the website that 404s. `set -euo pipefail` plus the per-pattern count guard is that refusal.
    expect(copy, "a missing artefact does not stop the copy").toContain("exit 1");
  });

  it("names the stable copies before the checksums are computed, so the checksums cover them", () => {
    /*
     * A visitor downloads `VoidCode-macOS-AppleSilicon.dmg` and verifies it against SHA256SUMS.txt.
     * If the copy ran AFTER the checksums step, that fixed name would not be listed, and the verify
     * command the download page prints would find no entry for the file the person actually has.
     */
    const names = job().steps.map((step) => step.name);
    const copyAt = names.indexOf("Copy each installer to a version-less name");
    const sumsAt = names.indexOf("Checksums");
    expect(copyAt, "no copy step").toBeGreaterThanOrEqual(0);
    expect(sumsAt, "no checksums step").toBeGreaterThanOrEqual(0);
    expect(
      copyAt,
      "the version-less names are created after the checksums, so they are unlisted"
    ).toBeLessThan(sumsAt);
  });

  it("attaches every asset, and publishes as a draft", () => {
    /*
     * The create step globs `assets/*`, which holds the versioned installers, the stable copies, the
     * SBOMs, the source maps and the checksums. `--draft` because the download page reads
     * `releases/latest`, which excludes drafts, so a human clicking Publish is what makes a build
     * visible. Dropping it hands out an unreviewed build.
     */
    const create = script("Create or refresh the draft release");
    expect(create, "the release does not attach the run's assets").toContain("assets/*");
    expect(create, "the release is not a draft").toMatch(/--draft/);
  });

  it("is idempotent, so re-cutting a tag does not fail on an existing release", () => {
    /*
     * The first v0.1.0 run created a draft; a re-cut of the same tag must refresh it rather than fail
     * on "release already exists". Without this, a re-run of a fixed pipeline dies at the last step
     * with a message about a release that is, correctly, already there.
     */
    const create = script("Create or refresh the draft release");
    expect(create, "the release step does not check whether the release already exists").toContain(
      "gh release view"
    );
    expect(create, "an existing release is not refreshed").toContain("--clobber");
  });

  it("uses this repository's own token and waits for the gate", () => {
    /*
     * It publishes to THIS repository, so `github.token` with `contents: write` is exactly right and
     * sufficient — there is no secret to configure and nothing to authorize. And it cannot run before
     * the gate that built the assets it attaches.
     */
    const createStep = job().steps.find((s) => s.name === "Create or refresh the draft release");
    expect(
      String(createStep?.env?.GH_TOKEN ?? ""),
      "the release publishes with something other than github.token"
    ).toContain("github.token");
    expect(job().permissions?.contents, "the release job cannot write releases").toBe("write");
    const needs = Array.isArray(job().needs) ? job().needs : [job().needs];
    expect(needs, "the release does not wait for the gate").toContain("gate");
  });

  it("stays in this workflow, because only one may own a `v*` tag", () => {
    expect(release.on).toHaveProperty("push");
    expect(JSON.stringify(release.on)).toContain("v*");
    expect(Object.keys(release.jobs)).toContain("release");
  });
});

describe("Windows installers are code-signed via SignPath before release", () => {
  /**
   * The downloaded NSIS installers trigger SmartScreen while unsigned. A dedicated, UNPRIVILEGED
   * `sign-windows` job signs them with SignPath (free for open source) and re-uploads them as
   * `installer-windows-signed`; the `release` job downloads THAT instead of the unsigned artifact, so
   * the stable names, `SHA256SUMS.txt` and the SLSA attestation all cover the SIGNED bytes. Signing is
   * gated on `vars.SIGNPATH_ORGANIZATION_ID`, and `release` tolerates a skipped signing job, so landing
   * this cannot break a release. This block pins that shape.
   */
  const release = parse(readRepo(".github/workflows/release.yml")) as {
    jobs: Record<
      string,
      { if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps: Step[] }
    >;
  };
  function job(name: string) {
    const found = release.jobs[name];
    if (found === undefined) throw new Error(`release.yml has no \`${name}\` job`);
    return found;
  }

  it("signs in a dedicated job that uses the SignPath action", () => {
    const signs = job("sign-windows").steps.some((s) =>
      String(s.uses ?? "").startsWith("signpath/github-action-submit-signing-request")
    );
    expect(signs, "the sign-windows job does not run the SignPath action").toBe(true);
  });

  it("keeps the third-party signing action OUT of the job that can publish", () => {
    /*
     * The security boundary. `release` holds `contents: write` and an OIDC token, so it must run only
     * first-party actions — SignPath's action therefore lives in `sign-windows`, which holds no write.
     * This is the same property packaging.test.ts asserts from the other direction.
     */
    for (const step of job("release").steps) {
      expect(String(step.uses ?? ""), "a third-party action is in the publishing job").not.toContain(
        "signpath"
      );
    }
    expect(job("sign-windows").permissions?.contents, "the signing job can publish").not.toBe(
      "write"
    );
  });

  it("gates signing on the SignPath org variable, so it is a no-op until configured", () => {
    /*
     * The whole job is conditional on `vars.SIGNPATH_ORGANIZATION_ID`; otherwise a release cut before
     * SignPath is set up would fail instead of shipping unsigned.
     */
    expect(String(job("sign-windows").if ?? ""), "sign-windows is not gated").toContain(
      "SIGNPATH_ORGANIZATION_ID"
    );
  });

  it("release waits for signing, tolerates its skip, and ships the signed artifact", () => {
    const rel = job("release");
    const needs = Array.isArray(rel.needs) ? rel.needs : [rel.needs];
    expect(needs, "release does not depend on sign-windows").toContain("sign-windows");
    // Tolerates a skipped signing job (SignPath not configured) so the release still runs.
    expect(String(rel.if ?? ""), "release does not tolerate a skipped sign-windows").toMatch(
      /always\(\)/
    );
    expect(String(rel.if ?? "")).toContain("sign-windows");
    // Downloads the SIGNED windows artifact when signing succeeded, not the unsigned one.
    expect(
      readRepo(".github/workflows/release.yml"),
      "release never downloads the signed Windows artifact"
    ).toContain("installer-windows-signed");
  });

  it("gives the signing job actions:read, which the SignPath action needs", () => {
    expect(job("sign-windows").permissions?.actions).toBe("read");
  });
});
