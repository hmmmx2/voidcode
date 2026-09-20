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

describe("the installers reach the two repositories that hand them out", () => {
  /**
   * `release.yml`'s `distribute` job copies the macOS and Windows installers into `voidcode-mac`
   * and `voidcode-windows` — repositories that hold no source, so that downloading VoidCode is one
   * page with one file on it. Five properties of that job are load-bearing, and each has a way of
   * being removed that leaves the workflow syntactically fine and the outcome wrong.
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
    const found = release.jobs.distribute;
    if (found === undefined) throw new Error("release.yml has no `distribute` job");
    return found;
  }
  const script = (name: string): string =>
    String(job().steps.find((step) => step.name === name)?.run ?? "");
  const platforms = ["macOS", "Windows"] as const;

  it("exists at all, so the rest of this block is not vacuous", () => {
    expect(() => job(), "release.yml has no `distribute` job").not.toThrow();
    expect(job().steps.length).toBeGreaterThan(4);
    for (const name of platforms) expect(script(name)).toContain("gh release create");
  });

  it("cannot publish before the checksums exist", () => {
    /*
     * `SHA256SUMS.txt` is written by the `release` job, and each distribution repository's
     * `verify-release.yml` checks its installers against it. Run in parallel, this job would
     * publish installers beside a checksums file that had not been written yet — or an earlier
     * one, which is worse, because it verifies and is wrong.
     */
    const needs = Array.isArray(job().needs) ? job().needs : [job().needs];
    expect(needs, "`distribute` does not wait for the release job").toContain("release");
  });

  it("uses the scoped token, not this repository's", () => {
    /*
     * `github.token` cannot write to another repository at all, so swapping it in would not be a
     * security downgrade — it would be a job that fails at the last step of a release. The real
     * requirement is the other half: a FINE-GRAINED token scoped to exactly two repositories,
     * rather than a classic PAT with `repo`, which grants write to everything the account can reach
     * from a job that needs two.
     */
    for (const name of platforms) {
      const step = job().steps.find((s) => s.name === name);
      const token = String(step?.env?.GH_TOKEN ?? "");
      expect(token, `${name} publishes with the wrong token`).toContain("secrets.DIST_RELEASE_TOKEN");
      expect(token, `${name} publishes with github.token, which cannot write elsewhere`).not.toContain(
        "github.token"
      );
    }

    // And the job refuses to start without it, rather than failing after the main release is made.
    expect(script("Refuse to run without the scoped token")).toContain("DIST_RELEASE_TOKEN");
    expect(job().steps[0]?.name).toBe("Refuse to run without the scoped token");
  });

  it("does not read the draft release it just made, which it has no permission to see", () => {
    /*
     * THIS JOB COULD NOT HAVE WORKED, and nothing here noticed until the permissions and the
     * `--draft` flag were read together.
     *
     * It fetched the release's assets with `gh release download "$TAG"` while holding
     * `contents: read`. GitHub shows DRAFT releases only to tokens with push access, and the
     * release above is created with `--draft` deliberately — so the first real tag would have
     * failed here with "release not found", which reads as "the release was never created" rather
     * than "this token cannot see drafts". A whole release, at the last step, on a message pointing
     * at the wrong thing.
     *
     * The fix was not `contents: write`. This job writes to two OTHER repositories and its own
     * comment says it must hold nothing here — so instead it takes the run's artifacts, which is
     * where the installers came from in the first place, and `release` uploads the checksums file
     * it computes so that it is an artifact too.
     *
     * Both halves are asserted, because either alone leaves it broken: no `gh release download` in
     * this job, and a `checksums` artifact for it to find.
     */
    const readsTheRelease = job().steps.some((step) =>
      String(step.run ?? "").includes("gh release download")
    );
    expect(
      readsTheRelease,
      "`distribute` reads the draft release, which its `contents: read` token cannot see"
    ).toBe(false);

    const downloads = job().steps.some((step) =>
      String(step.uses ?? "").startsWith("actions/download-artifact")
    );
    expect(downloads, "`distribute` does not download the run's artifacts, so it has no installers").toBe(
      true
    );

    const releaseJob = release.jobs.release;
    if (releaseJob === undefined) throw new Error("release.yml has no `release` job");
    const uploads = releaseJob.steps.filter((step) =>
      String(step.uses ?? "").startsWith("actions/upload-artifact")
    );
    expect(
      uploads.some((step) => String(step.with?.path ?? "").includes("SHA256SUMS.txt")),
      "`release` does not upload SHA256SUMS.txt as an artifact, so `distribute` cannot find it"
    ).toBe(true);

    // And the permission it was reading the draft with is still deliberately narrow, because
    // widening it would make the old approach work and this test pass for the wrong reason.
    expect(job().permissions?.contents, "`distribute` now holds write on this repository").toBe("read");
  });

  it("publishes both as drafts", () => {
    // The download page reads `releases/latest`, which excludes drafts, so a human publishing is
    // what makes a build visible to anyone. Dropping this hands out an unreviewed build.
    for (const name of platforms) {
      expect(script(name), `${name} does not pass --draft`).toMatch(/--draft/);
    }
  });

  it("counts the installers before copying them, and the count matches what is built", () => {
    /*
     * `gh release create <tag> *.dmg` with no matching file creates an EMPTY RELEASE and exits 0.
     * The only symptom is a visitor finding a release page with nothing on it.
     *
     * The expected counts are checked against `electron-builder.yml` rather than trusted, so adding
     * or removing an architecture fails here instead of silently shipping one fewer installer than
     * was built.
     */
    const check = script("Check the installers are actually here");
    expect(check, "nothing counts the installers before the copy").toContain("exit 1");

    const builder = parse(readRepo("desktop/electron-builder.yml")) as {
      mac: { target: { target: string; arch: string[] }[] };
      win: { target: { target: string; arch: string[] }[] };
    };
    const built = (config: { target: { arch: string[] }[] }): number =>
      config.target.reduce((n, t) => n + t.arch.length, 0);

    for (const [ext, count] of [
      ["dmg", built(builder.mac)],
      ["exe", built(builder.win)],
    ] as const) {
      expect(check, `the job does not expect ${count} .${ext} file(s), which is what the build makes`)
        .toContain(`"${ext}:${count}"`);
    }
  });

  it("stays in this workflow, because only one may own a `v*` tag", () => {
    /*
     * Asserted here as well as in the block above, from the other direction: that block checks no
     * OTHER workflow claims `v*`, and this checks that `distribute` is inside the one that does.
     * Moving it to a new workflow would be the natural refactor and would put two workflows in a
     * race on one tag, which is how a release ends up half-published.
     */
    expect(release.on).toHaveProperty("push");
    expect(JSON.stringify(release.on)).toContain("v*");
    expect(Object.keys(release.jobs)).toContain("distribute");
  });
});
