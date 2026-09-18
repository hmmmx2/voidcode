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

/** The four build-time settings, and what each one decides. */
const BUILD_VARS = {
  VOIDCODE_BUILD_API_URL: "where the app sends a session; null disables every account feature",
  VOIDCODE_BUILD_SITE_URL: "the public site, for the legal links and the payment return pages",
  VOIDCODE_BUILD_GOOGLE_CLIENT_ID: "identifies the app to Google; absent hides the button",
  VOIDCODE_BUILD_MICROSOFT_CLIENT_ID: "identifies the app to Microsoft; absent hides the button",
} as const;

interface Step {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
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
