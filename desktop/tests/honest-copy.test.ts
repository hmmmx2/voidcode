/**
 * The app must not tell a user to do something it has made impossible.
 *
 * Four pages and the tutor panel each said "The API didn't respond. If you're running this locally,
 * check that the API server is up on port 8000." There is no API server: `lib/api/client.ts`
 * intercepts every `app://api` request and answers it over IPC from the main process, and its header
 * records bundling FastAPI as considered and rejected — roughly a 3 GB installer plus two database
 * servers to run an offline IDE.
 *
 * Five copies, wrong together, is what a shared constant is for. But the deeper point is that a
 * message naming a remedy the user does not have is worse than a vague one: it sends them looking for
 * a process that was never there, and it quietly claims the product is a different shape than it is.
 *
 * These checks are structural because the failure is not a crash — the page renders perfectly and
 * lies. Nothing else would notice.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read a source file with its line endings normalised to LF.
 *
 * Signature-compatible with `readSource(file, "utf8")` so every call site here reads the same;
 * the encoding argument is accepted and ignored, because there is only one right answer for source.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Every assertion in this file matches a regex against source text, and several of those patterns
 * contain a literal newline. That made them depend on **the checkout's line endings**, which is not a
 * property of any code under test — and it was live, not theoretical. The Phase 10 rehearsal in a
 * `git archive` tree failed `NO_MODEL_INSTALLED.body must name ollama.com` on the same commit that
 * passed in the working tree: the archive came out CRLF, the working tree was LF, and a pattern ending
 * `,
\s*` cannot match CRLF because the character after the comma is a carriage return.
 *
 * `verify` runs on windows-latest as well as ubuntu-22.04, so this would have failed one leg of a CI
 * run that has never executed. Normalising once at the read is the fix that does not require every
 * future regex in this file to remember.
 */
function readSource(file: string, _encoding?: string): string {
  return fs.readFileSync(file, "utf8").split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10));
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every renderer source file, so a new component cannot quietly reintroduce the claim. */
function rendererSources(dir = path.join(root, "renderer/src"), found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rendererSources(full, found);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const sources = rendererSources().map((file) => ({
  file: path.relative(root, file).replace(/\\/g, "/"),
  text: readSource(file, "utf8"),
}));

/**
 * Strip block and line comments.
 *
 * The distinction that makes this test usable rather than a nuisance: `client.ts` *must* be able to
 * explain in prose why FastAPI was rejected, and `interviews.ts` refers to FastAPI's `exclude_unset`
 * to explain a wire shape. What is banned is telling a *user* to go and start one.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("nothing instructs the user to start a server", () => {
  it("names no port 8000 outside a comment", () => {
    /**
     * `client.ts` used to be exempted here, for the non-desktop branch of `API_BASE`. The exemption
     * is gone because the branch is: `API_BASE` is now `"app://api"` unconditionally, since this
     * renderer only ever runs inside Electron and the fallback named the retired repo's server.
     *
     * The exemption was also hiding something. Because `API_BASE` is evaluated at module load and
     * `window` is undefined during the prerender, `http://localhost:8000` was being **compiled into
     * a shipped chunk** — a test that skipped the file could not have found that.
     */
    const offenders = sources
      .filter(({ text }) => /port 8000|localhost:8000/.test(code(text)))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("ships no chunk carrying the retired server's address", () => {
    /**
     * The source check above is necessary and was not sufficient. What reaches the user is the
     * bundle, and the string got there through a branch that source-level reading called dead.
     *
     * Skipped when there is no build to inspect, because `npm test` runs before `build:renderer` in
     * CI and a test that fails on a clean checkout teaches people to ignore it. The build is
     * exercised in the same CI run regardless, so this is a check that arrives rather than one that
     * can be avoided.
     */
    const out = path.join(root, "renderer/out/_next/static/chunks");
    if (!fs.existsSync(out)) return;

    const carriers = fs
      .readdirSync(out)
      .filter((name) => name.endsWith(".js"))
      .filter((name) => readSource(path.join(out, name), "utf8").includes("localhost:8000"));

    expect(carriers).toEqual([]);
  });

  it("claims no serving stack the app does not have", () => {
    /**
     * The footer rendered "Qwen2.5-7B · SGLang · AWQ" on /privacy and /terms, to match a marketing
     * footer in the web repository. That made it the one cross-repo invariant a *user* could read,
     * and every part of it was false: no SGLang provider, nothing serving AWQ, and no shipped model.
     *
     * SGLang is the durable half of this check — there is no such provider and adding one would be a
     * registry change, which is where the assertion below points.
     */
    const offenders = sources
      .filter(({ text }) => /SGLang/i.test(code(text)))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("names only backends the registry actually declares", () => {
    /**
     * Ties the rendered claim to the code that would have to change for it to become true, rather
     * than to a list in this test that would rot in the same way the footer did.
     */
    // The whole inference layer, not just `registry.ts`: it composes the providers but each one
    // carries its own label, so `Ollama` is declared in `ollama.ts` and only reachable from here.
    const inference = path.join(root, "src/main/inference");
    const registry = fs
      .readdirSync(inference)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readSource(path.join(inference, name), "utf8"))
      .join("\n");

    const footer = readSource(
      path.join(root, "renderer/src/components/Layout/AppFooter.tsx"),
      "utf8"
    );

    const stack = /Local models · ([^<\n]+)/.exec(code(footer))?.[1];
    expect(stack, "the footer's stack line").toBeDefined();

    for (const backend of stack!.split(" or ").map((s) => s.trim())) {
      expect(registry, `footer names "${backend}"`).toContain(`"${backend}"`);
    }
  });

  it("tells no user about FastAPI", () => {
    /**
     * Comments may discuss it — the rejection is a real decision worth recording. A rendered string
     * may not, because FastAPI is not a thing anyone using this app has or can get.
     */
    const offenders = sources
      .filter(({ text }) => /FastAPI/.test(code(text)))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("keeps the shared copy honest about what can be done", () => {
    const copy = readSource(path.join(root, "renderer/src/lib/copy.ts"), "utf8");

    // The local-failure message must not name a remedy, because there is none to name.
    expect(copy).toContain("Nothing here needs a server");
    expect(copy).not.toMatch(/start the (server|API)/i);

    // The tutor message must name one, because there is a real one.
    expect(copy).toContain("Ollama");
    expect(copy).toContain("OpenRouter");
  });

  it("is used by every surface that had its own copy", () => {
    /**
     * Five files carried the port-8000 message. A sixth *reimplementing* it locally is the
     * regression this counts.
     *
     * Now six, because `ModelsPage` imports `NO_MODEL_INSTALLED`. The count failing on that was the
     * friction working as designed — it forced this comment rather than letting an importer appear
     * unremarked — but note what the number does and does not mean: it is a floor on adoption, not a
     * ceiling. A seventh legitimate importer should raise it again.
     */
    const users = sources.filter(({ text }) => text.includes('from "@/lib/copy"')).map((s) => s.file);
    expect(users).toHaveLength(6);
  });

  it("says where to get a model, not just which one", () => {
    /**
     * The one onboarding gap this app had, and it was narrow. Everything else about a fresh install
     * degrades honestly — the status bar separates "no backend" from "backend, no models", the model
     * manager works with Ollama down, `TUTOR_UNREACHABLE` names Ollama when a send fails. What
     * nothing said is that **Ollama is a separate download**: `ollama.com` appeared nowhere in
     * `src/` or `renderer/src/` at all. The app named the thing it needs and never said where it
     * comes from.
     *
     * Both halves are asserted. Naming the URL without saying grading works anyway would read as a
     * prerequisite standing between a new user and the exercises — and it would be false, because
     * spec §4.4 promises the app is useful with no model.
     */
    /**
     * Concatenation joined before matching, which is not cosmetic.
     *
     * Both of these messages are written as `"…need nothing " + "installed — …"` to stay inside the
     * print margin, so a phrase spanning the join does not appear contiguously in the source. The
     * first version of this assertion failed for exactly that reason — the copy was right and the
     * test was reading the file rather than the sentence.
     */
    const sentences = (source: string) => source.replace(/"\s*\+\s*"/g, "");

    const copy = sentences(readSource(path.join(root, "renderer/src/lib/copy.ts"), "utf8"));

    /**
     * The **body**, not the module.
     *
     * Checking the whole file was a mutation survivor: removing ollama.com from the sentence still
     * passed, because the `url` field holds the same string. The URL is what the link points at; the
     * body is the sentence someone reads, and it is the sentence that has to say where a model comes
     * from.
     */
    const body = /body:\s*([\s\S]*?),\n\s*\/\*\*/.exec(copy)?.[1] ?? "";
    expect(body, "NO_MODEL_INSTALLED.body must name ollama.com").toContain("ollama.com");
    expect(copy).toMatch(/without one|need(s)? nothing installed/i);

    // The main-side welcome notification is the only first-run artefact, so it carries the same two.
    const notifications = sentences(
      readSource(path.join(root, "src/main/store/notifications.ts"), "utf8")
    );
    const welcome = /seedWelcomeNotification[\s\S]*?^}/m.exec(notifications)?.[0] ?? "";
    expect(welcome, "the welcome notification must name ollama.com").toContain("ollama.com");
    expect(welcome, "and must not imply a model is required first").toMatch(
      /need nothing installed|without one/i
    );
  });

  it("names ollama.com wherever it tells someone to install a model", () => {
    /**
     * The property rather than the three instances: any surface that raises installing a model has to
     * say where one comes from, or defer to `copy.ts` which does. Otherwise the next such message is
     * written from scratch and reintroduces exactly the gap above.
     */
    /**
     * NO IMPORT-BASED EXEMPTION, and that is the correction.
     *
     * The first version excused any file importing `@/lib/copy`, on the grounds that it defers to the
     * shared constant. Mutation testing showed the hole immediately: `VoidCodeAIPanel` imports from
     * `copy.ts` *and* could still write its own "Install a model to continue." — the exemption
     * excused the file rather than the sentence. Same shape as the `MAIN_OWNED` exemption in
     * `menu.test.ts`, which had the same defect.
     *
     * So the rule is now unconditional: if a file's own source tells someone to install a model, that
     * file has to name where one comes from. Rendering `NO_MODEL_INSTALLED` does not trip it, because
     * the shared body says "need a language model … Install Ollama from ollama.com" rather than
     * "install a model".
     */
    const offenders = sources
      .filter(({ text }) => /install(ing)? (a |an )?(language )?model/i.test(code(text)))
      .filter(({ text }) => !text.includes("ollama.com"))
      .map(({ file }) => file);

    expect(offenders, "tells the user to install a model without saying where from").toEqual([]);
  });
});

/**
 * The privacy policy has to describe this application.
 *
 * It described a hosted platform: OAuth sign-in, session and CSRF cookies, IP addresses and
 * geolocation, analytics kept 90 days, authentication logs kept 12 months, staff reviewing
 * conversations, disclosure to cloud vendors, and TLS/AES/MFA protecting a server nobody runs. None
 * of it existed.
 *
 * Two kinds of check here, and the second is the one worth having:
 *
 *   **The retired claims stay gone.** Plain text assertions. Cheap, and they catch a revert or a
 *   copy-paste from the old document.
 *
 *   **The claims are pinned to the code they depend on.** The policy asserts things about the
 *   software — no email is stored, no cookies are set, one provider can receive your conversation,
 *   the assistant reaches a fixed list of hosts. Each of those is true because of a specific piece of
 *   code, so each is asserted against that code. If the application gains the capability, the test
 *   fails and the document has to be revisited. A prose-only test would let the code drift away from
 *   the promise silently, which is how the document got into this state.
 */
/**
 * BOTH legal documents, checked together.
 *
 * This was one file's list, and the Terms of Use quietly said the opposite: the Policy states nothing
 * is collected and nothing trains a model, while the Terms said conversations "may be logged and used
 * to improve the Platform". Two shipped legal documents disagreeing about data retention, and each
 * one internally consistent, so no single-file test could see it.
 *
 * Running the banned phrases over the union is what makes that class impossible rather than merely
 * fixed: a claim retired from one document cannot be reintroduced in the other.
 */
const LEGAL_SOURCES = ["PrivacyClient.tsx", "TermsClient.tsx"] as const;

/** Rendered text of a legal component, comments stripped and whitespace flattened. */
function legalText(file: string): string {
  const source = readSource(path.join(root, "renderer/src/components/Legal", file), "utf8");
  // Comments go because both module headers discuss every removed claim at length, by design.
  // Whitespace collapses because JSX wraps prose, so a sentence is almost always split across lines.
  return code(source).replace(/\s+/g, " ");
}

describe("the privacy policy describes this application", () => {
  const policy = readSource(
    path.join(root, "renderer/src/components/Legal/PrivacyClient.tsx"),
    "utf8"
  );
  /**
   * Rendered text only, with whitespace flattened.
   *
   * Comments are stripped because the module header discusses every removed claim at length, by
   * design. Whitespace is collapsed because JSX wraps prose at the print margin, so a sentence this
   * test looks for is almost always split across two lines and two levels of indentation.
   */
  const rendered = code(policy).replace(/\s+/g, " ");

  it("no longer claims practices that never existed", () => {
    /**
     * Whole phrases from the old document, not keywords.
     *
     * Keywords were the first attempt and they were wrong in a way worth keeping a note about: they
     * flagged section 3's *denial* that IP addresses are collected. A test that cannot tell "we
     * collect your IP" from "no IP addresses are collected" pushes the document towards saying less,
     * when an explicit negative is the more useful thing for a reader.
     */
    for (const claim of [
      "OAuth",
      "Azure AD",
      "IP address and approximate geographic location",
      "CSRF tokens",
      "TLS 1.2",
      "AES-256",
      "Multi-factor authentication",
      "quality assurance",
      // Not "cloud hosting" — section 6 denies there is any, and that denial is the useful sentence.
      // This is the old bullet's own wording, which only a positive claim can carry.
      "assist in operating the Platform",
      "registered email address",
      "deleted within",
      "retained for up to",
      "retained indefinitely",

      // From the retired Terms of Use, and banned in *both* documents from here on. The first is the
      // one that mattered: it is the sentence that contradicted the Policy on the same build.
      "used to improve the Platform",
      "suspend or terminate",
      "reverse-engineer",
      "derivative works",
      "property of VoidCode AI",
      "courts located in Victoria",
      "registered VoidCode AI account",
      "16 years of age",
      "as available",
      "you have paid to VoidCode",
      "assist in operating",

      // Retracted when the optional account shipped. Each was true of a build with no sign-in form
      // and became false the moment the Models page had one — see "an account is optional" below.
      "no account to create",
      "no sign-in",
      "no VoidCode server",
      "There is no service here",
      "we hold no address for you",
      "Because we hold none",
    ]) {
      for (const file of LEGAL_SOURCES) {
        expect(legalText(file), `${file} still claims: ${claim}`).not.toContain(claim);
      }
    }
  });

  it("states the fact the rest of it depends on", () => {
    /**
     * If these go, every "we hold nothing" claim below them loses its justification.
     *
     * It was "no account to create", which stopped being true when a sign-in form shipped. The claim
     * that replaced it is narrower and kept honest by code rather than by wording: signed out, main
     * makes no request to our server (`platform/http.ts` answers an authenticated call without a
     * session with a synthetic 401, and `account-session.test.ts` spies on `fetch` to prove it).
     */
    expect(rendered).toMatch(/an account is optional/i);
    expect(rendered).toMatch(/runs entirely on your machine/i);

    const http = code(readSource(path.join(root, "src/main/platform/http.ts"), "utf8"));
    expect(http, "http.ts no longer refuses to send an authenticated call without a session").toContain(
      "Not signed in."
    );
    expect(fs.existsSync(path.join(root, "tests/account-session.test.ts"))).toBe(true);
  });

  it("is right that no email address is stored", () => {
    const schema = readSource(path.join(root, "src/main/store/db.ts"), "utf8");
    const profile = /CREATE TABLE IF NOT EXISTS profile \(([\s\S]*?)\n\);/.exec(schema)?.[1];

    expect(profile, "the profile table").toBeDefined();
    expect(profile, "profile gained an email column — section 2 says there is none").not.toMatch(
      /^\s*email/m
    );
    expect(rendered).toMatch(/local profile has no email address field/i);

    /**
     * Wider than the profile now that an account exists: section 2.4 says the account's email is held
     * in memory only. A copy in ANY local table would outlive signing out, so no table may declare one,
     * and nothing in `account/` may reach the store at all.
     */
    const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)];
    expect(tables.length, "found no tables — the pattern is broken").toBeGreaterThan(3);
    const withEmail = tables.filter((m) => /^\s*\w*email\w*\s/im.test(m[2] as string)).map((m) => m[1]);
    expect(withEmail, "a local table stores an email address").toEqual([]);

    const accountDir = path.join(root, "src/main/account");
    const reachesStore = fs
      .readdirSync(accountDir)
      .filter((name) => /from\s+["'][./]*store\//.test(readSource(path.join(accountDir, name), "utf8")))
      ;
    expect(reachesStore, "account code imports the local store").toEqual([]);
  });

  it("is right that the application sets no cookies", () => {
    const setters = sources
      .filter(({ text }) => /document\s*\.\s*cookie\s*=/.test(code(text)))
      .map(({ file }) => file);

    expect(setters, "something sets a cookie — section 2.3 says nothing does").toEqual([]);
    expect(rendered).toMatch(/sets no cookies/i);
  });

  it("names every host the assistant can reach, and no others", () => {
    /**
     * Section 3 lists the documentation sites by name. The list it paraphrases is
     * `net/allowlist.ts`, so the names are checked against it rather than against a copy here —
     * and a new domain in the allowlist is a change to what the policy promises.
     */
    const allowlist = readSource(path.join(root, "src/main/net/allowlist.ts"), "utf8");
    const domains = [...allowlist.matchAll(/^\s*"([a-z0-9.-]+)",$/gm)].map((m) => m[1] as string);

    /**
     * An exact count, and it is the assertion that matters more than the two loops below.
     *
     * Those check that what the policy names is reachable — the direction that fails when a host is
     * *removed*. Adding one is the direction with consequences: it widens what leaves the user's
     * machine while section 3's list still reads as complete, and nothing about the prose looks
     * wrong. This was a mutation-test survivor until the count was pinned.
     *
     * If this fails because a domain was added, the fix is to decide whether section 3 should name
     * it, not to bump the number.
     */
    expect(domains, "a domain changed — revisit section 3 of the privacy policy").toHaveLength(17);

    // Every site the policy names must actually be reachable.
    for (const named of ["MDN", "npm", "PyPI", "crates.io", "GitHub"]) {
      expect(rendered, `policy names ${named}`).toContain(named);
    }
    for (const needed of ["developer.mozilla.org", "pypi.org", "crates.io", "github.com"]) {
      expect(domains, `policy implies ${needed} is allowed`).toContain(needed);
    }
  });

  it("is right about which providers can receive a conversation", () => {
    /**
     * Section 3 enumerates what leaves the machine, and the count is the thing that rots: a new
     * provider declaring `remote: true` makes the section incomplete without changing a word of
     * it. That is exactly the drift this catches, and it caught it — the hosted VoidCode backend
     * was added and this failed, because the policy still said a conversation could only reach
     * OpenRouter.
     *
     * Two now: OpenRouter, and our own hosted model. The second is the one that matters, because
     * it is the only path where the text reaches US rather than a company the learner chose, and
     * the policy has to say so in those words.
     *
     * Raising this number is not the fix when it fails again. Updating the policy is; the number
     * follows.
     */
    const inference = path.join(root, "src/main/inference");
    const remote = fs
      .readdirSync(inference)
      .filter((name) => name.endsWith(".ts"))
      // `code()`, because `openai.ts` explains in a comment what `remote: true` drives — and a
      // comment about the flag is not a second provider carrying it.
      .flatMap((name) => [
        ...code(readSource(path.join(inference, name), "utf8")).matchAll(/remote:\s*true/g),
      ]);

    expect(
      remote,
      "a provider declaring `remote: true` has been added or removed — section 3 of the privacy "
        + "policy enumerates what leaves the machine, and it is now wrong. Update the policy, then "
        + "this count.",
    ).toHaveLength(2);
    expect(rendered).toContain("OpenRouter");
    // The hosted path in the learner's own words, not ours: the policy must say the text reaches
    // us, because that is the fact a local-first user would most want to know had changed.
    expect(rendered).toContain("to us");
  });
});

/**
 * What the documents say about an account is what the account code does.
 *
 * The retired copy's failure was never a typo; it was a true sentence that the code moved out from
 * under. So each account claim with a number or a name in it is pinned to the file that makes it
 * true, and changing that file breaks this test before it breaks the promise.
 */
describe("the legal documents agree with the account code", () => {
  const privacy = legalText("PrivacyClient.tsx");
  const api = (rel: string): string => code(readSource(path.join(root, "..", "apps/api", rel), "utf8"));

  it("dates both documents with the version registration records", () => {
    const legal = readSource(path.join(root, "src/shared/legal.ts"), "utf8");
    const version = /TERMS_VERSION = "(\d{4})-(\d{2})-(\d{2})"/.exec(legal);
    const display = /TERMS_DISPLAY_DATE = "([^"]+)"/.exec(legal)?.[1];
    expect(version, "TERMS_VERSION is not an ISO date").not.toBeNull();
    expect(display).toBeDefined();

    const [, y, m, d] = version as RegExpExecArray;
    const month = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toLocaleString("en-AU", {
      month: "long",
      timeZone: "UTC",
    });
    expect(display, "TERMS_DISPLAY_DATE is not TERMS_VERSION").toBe(`${Number(d)} ${month} ${y}`);

    for (const file of LEGAL_SOURCES) {
      const shown = /Last updated<\/span>[\s{}]*<span[^>]*>([^<]+)<\/span>/.exec(legalText(file))?.[1];
      expect(shown, `${file} shows no "Last updated" date`).toBeDefined();
      expect(shown?.trim(), `${file} is dated differently from the terms version recorded at sign-up`).toBe(
        display
      );
    }
  });

  it("is right about where the sign-in is kept", () => {
    const session = code(readSource(path.join(root, "src/main/account/session.ts"), "utf8"));
    expect(session).toContain('setSecret("voidcode"');
    expect(privacy).toMatch(/session token\. It is encrypted with your operating system&apos;s credential store/);
  });

  it("is right about the durations and limits it names", () => {
    const config = api("src/config.py");
    const setting = (name: string): string | undefined =>
      new RegExp(`${name} = int\\(os\\.getenv\\("${name}", "(\\d+)"\\)\\)`).exec(config)?.[1];

    expect(setting("DESKTOP_SESSION_TTL_DAYS")).toBe("90");
    expect(privacy).toContain("A sign-in session lasts 90 days");
    expect(setting("PASSWORD_RESET_CODE_TTL_MINUTES")).toBe("15");
    expect(privacy).toContain("expires after 15 minutes");
    expect(setting("PASSWORD_RESET_CODE_MAX_ATTEMPTS")).toBe("5");
    expect(privacy).toContain("after five wrong guesses");

    // "each count lapses after at most an hour": the longest window any limit uses.
    const windows = [...api("src/ratelimit.py").matchAll(/window_seconds=(\d+)/g)].map((w) => Number(w[1]));
    expect(windows.length).toBeGreaterThan(3);
    expect(Math.max(...windows), "a rate-limit window outlasts the hour the policy names").toBeLessThanOrEqual(3600);
    expect(privacy).toContain("lapses after at most an hour");
  });

  it("names how passwords are stored, and who sends email and takes payment", () => {
    expect(api("src/services/password_service.py")).toContain("from argon2 import PasswordHasher");
    expect(privacy).toContain("Argon2id");

    expect(api("src/services/email_service.py")).toContain('provider == "resend"');
    expect(privacy).toContain("Resend");

    const hosted = code(readSource(path.join(root, "src/main/inference/hosted.ts"), "utf8"));
    expect(hosted).toContain("/credits/checkout");
    expect(api("src/services/payments.py")).toMatch(/checkout\.stripe\.com|api\.stripe\.com/);
    for (const file of LEGAL_SOURCES) expect(legalText(file), `${file} names the payment processor`).toContain("Stripe");
  });

  it("discloses the research library exactly while the application has one", () => {
    /**
     * A two-way pin, like the provider hosts above it. The library is a NETWORK FEATURE in a
     * local-first application: opening the Research page asks our servers for the papers, and
     * marking a section read writes a row against an account. Before this shipped the Policy said
     * nothing about either, and that was correct — the desktop app had no such page.
     *
     * So the direction that matters is this one: the code exists, therefore the sentences must.
     * And each sentence is pinned to the thing that makes it true rather than to itself.
     */
    const reading = path.join(root, "src/main/research");
    expect(fs.existsSync(reading), "src/main/research is gone; this test is now guarding nothing").toBe(
      true
    );
    const papers = code(readSource(path.join(reading, "papers.ts"), "utf8"));

    // "Nothing is fetched until you open that page": nothing in main calls these at startup, so the
    // claim rests on the renderer asking — which is what the channels are for.
    expect(papers).toContain("/papers");
    expect(privacy).toContain("Nothing is fetched until you open that page");

    // "if you are signed in, your session": the optional-session read, which is unusual enough in
    // this application to be worth saying out loud in both places.
    expect(papers, "the library read no longer sends a session when there is one").toContain(
      "sessionToken() !== undefined"
    );
    expect(privacy).toContain("if you are signed in, your session");

    // "Marking a section read needs an account": refused client-side, and refused server-side.
    expect(papers).toContain('code: "signed_out"');
    expect(api("src/routers/papers.py")).toContain("Depends(identity.require_user)");
    expect(privacy).toContain("Marking a section read needs an account");

    // "the PDF itself is opened in your own browser": `shell.openExternal`, not a frame.
    expect(papers).toContain("shell.openExternal");
    expect(privacy).toContain("opened in your own browser");

    // What section 6.1 says the account holds, pinned to the columns that hold it.
    const progress = code(
      readSource(path.join(root, "..", "apps/api/src/models/catalogue.py"), "utf8")
    );
    expect(progress).toContain("sections_read");
    expect(progress).toContain("completed_at");
    expect(privacy).toContain("Which sections of which research papers you have opened");
    expect(privacy).toContain("when you first finished");

    // And the claim the library page itself makes, which the Policy repeats.
    const library = code(
      readSource(path.join(root, "renderer/src/components/Research/PaperLibraryClient.tsx"), "utf8")
    );
    expect(library).toContain("sections opened, not sections understood");
    expect(privacy).toContain("sections opened rather than sections understood");
  });

  it("is backed by a test when it says conversations are not logged", () => {
    // The only claim here about a log rather than a table, and a log line is invisible to a schema
    // check: two of them kept 60 characters of every question until this sentence was written.
    expect(privacy).toContain("do not write its text to their database or to their logs");
    expect(fs.existsSync(path.join(root, "..", "apps/api/tests/test_prompts_are_not_logged.py"))).toBe(true);
  });

  it("says provider sign-in is not offered, and no code offers it", () => {
    /**
     * THIS ASSERTION HAS NOW RUN BOTH WAYS TWICE, and the history is the point rather than trivia.
     *
     * It began as this: no file under `src/main/account` names either provider's host, and the
     * Policy says so. Adding Google and Microsoft failed it, which is what forced the Policy to be
     * rewritten rather than left behind saying the opposite of what shipped. It was then inverted —
     * the hosts MUST be there, the description MUST be there — so neither could be deleted alone.
     *
     * Removing the providers failed it in that direction, which is the pair working. It is back to
     * its original form, and it is still a two-way pin: the sentence cannot be deleted while no
     * code offers provider sign-in, and no code can offer it again while the sentence stands.
     */
    const accountDir = path.join(root, "src/main/account");
    const hosts = fs
      .readdirSync(accountDir)
      .map((name) => readSource(path.join(accountDir, name), "utf8"))
      .join(" ");

    expect(hosts, "a file under src/main/account opens Google's authorize endpoint").not.toContain(
      "accounts.google.com"
    );
    expect(hosts, "a file under src/main/account opens Microsoft's authorize endpoint").not.toContain(
      "login.microsoftonline.com"
    );

    /*
     * The deleted modules, by name. `readdirSync` above only sees what is there, so it cannot
     * notice a file coming back that has been renamed or that reaches its endpoint another way.
     */
    for (const gone of ["oauth.ts", "loopback.ts", "providers.ts"]) {
      expect(fs.existsSync(path.join(accountDir, gone)), `src/main/account/${gone} is back`).toBe(
        false
      );
    }
    expect(
      fs.existsSync(path.join(root, "..", "apps/api/src/models/user_identity.py")),
      "the user_identities model is back"
    ).toBe(false);

    /*
     * The sentence, spelled to survive the phrase ban above. "no sign-in" is banned as a substring,
     * so "there is no sign-in with Google" would trip it and this wording does not.
     */
    expect(privacy, "the Policy does not say provider sign-in is gone").toContain(
      "does not offer sign-in with Google or Microsoft"
    );

    // And the migration path, named rather than left to be inferred: these accounts have no
    // password, and this is the only route back in for them.
    expect(privacy, "the Policy does not name the route back in for a password-less account").toContain(
      "never had one"
    );
    expect(privacy).toContain("six-digit code");
  });
});

/**
 * The Terms of Use describes software you run, not a service you access.
 *
 * It was a hosted-service agreement: accounts, an age warranty, suspension, a liability cap against
 * fees paid, uptime language, notification by posting to a server, and exclusive jurisdiction over a
 * contract nobody forms. The banned-phrase list above now covers both documents, which is what stops
 * any of that returning to either one. These are the claims specific to this document.
 */
describe("the terms of use describes this application", () => {
  const terms = legalText("TermsClient.tsx");

  it("does not call this a Platform", () => {
    /**
     * One token, and it was the whole defect in miniature: the retired document used "Platform"
     * forty-three times, always as a hosted service the reader accesses. There is no service, so every
     * one of those sentences was about something that does not exist.
     *
     * Asserted at zero rather than under a threshold, because there is no legitimate use. If this ever
     * becomes a platform, that is a product change, and this line should be what makes someone notice.
     */
    for (const file of LEGAL_SOURCES) {
      const hits = [...legalText(file).matchAll(/\bPlatform\b/g)].length;
      expect(hits, `${file} calls this a Platform`).toBe(0);
    }
  });

  it("names the licences it actually ships under", () => {
    /**
     * Pinned to the licence files rather than to a string in this test, so changing what the project
     * is licensed under breaks the document that describes it — which is the direction that matters,
     * since the retired version was *narrower* than Apache-2.0 and so misstated the reader's rights.
     */
    /**
     * Asserted against the **licence section**, not the whole document.
     *
     * Checking the document was a mutation-test survivor: replacing section 2's "Apache License 2.0"
     * with "a permissive licence" still passed, because the header banner also names it. The document
     * stayed true and the section that exists to tell you your rights stopped naming them, which is
     * the degradation worth catching.
     */
    const section = (id: string): string => {
      const from = terms.indexOf(`id: "${id}"`);
      expect(from, `no section with id ${id}`).toBeGreaterThan(-1);
      const next = terms.indexOf('id: "', from + 8);
      return terms.slice(from, next === -1 ? undefined : next);
    };

    const manifest = JSON.parse(readSource(path.join(root, "package.json"), "utf8")) as {
      license: string;
    };
    expect(manifest.license).toBe("Apache-2.0");
    expect(readSource(path.join(root, "..", "LICENSE"), "utf8")).toContain("Apache License");
    expect(section("licence"), "the licence section must name the licence").toContain(
      "Apache License 2.0"
    );

    // The exercise content's own licence, read from its file rather than repeated here.
    const contentLicence = readSource(path.join(root, "..", "content/LICENSE"), "utf8");
    const spdx = /\b(CC-BY-SA-4\.0)\b/.exec(contentLicence)?.[1];
    expect(spdx, "content/LICENSE no longer names an SPDX id").toBeDefined();
    expect(section("content"), `the content section must name ${String(spdx)}`).toContain(
      String(spdx)
    );
  });

  it("keeps the account optional and in its own section", () => {
    // The `profile`-table reasoning the privacy block uses, from the other direction: the local
    // profile has no email and no password, so account obligations can only belong to the separate,
    // optional account — and they live in one section, so the rest of the document stays about
    // software you run.
    const schema = readSource(path.join(root, "src/main/store/db.ts"), "utf8");
    const profile = /CREATE TABLE IF NOT EXISTS profile \(([\s\S]*?)\n\);/.exec(schema)?.[1];
    expect(profile).toBeDefined();
    expect(profile).not.toMatch(/^\s*(email|password)/m);

    expect(terms).toMatch(/an account is optional/i);
    expect(terms).toContain('id: "account"');
  });

  it("gives one contact address across both documents", () => {
    /**
     * The retired Terms named `digitallearning@swin.edu.au` and the Policy `privacy@swin.edu.au` — two
     * mailboxes for one product, a defect independent of whether either is the right one. *Which*
     * address belongs here is a decision for a human; that there is exactly one is not.
     */
    const addresses = new Set(
      LEGAL_SOURCES.flatMap((file) => [...legalText(file).matchAll(/mailto:([^"']+)/g)]).map(
        (m) => m[1] as string
      )
    );

    expect(addresses.size, `distinct addresses: ${[...addresses].join(", ")}`).toBe(1);
  });

  it("links only to routes that exist", () => {
    /**
     * Not specific to the legal pages, and the widest-reaching assertion in this file.
     *
     * `/login` was the only internal href in the whole renderer naming a route with no `page.tsx`.
     * It sat behind a literal `true` in `(legal)/layout.tsx`, so it did not render — but a hardcoded
     * `true` standing where a session check used to be is one edit from shipping a Sign in button to
     * a build with no auth, and the surrounding comment described a `middleware.ts` and auth forms
     * that do not exist.
     *
     * Checking every href rather than that one string is the point: a link to nowhere is a promise
     * the app cannot honour, which is what this file is for.
     */
    const appDir = path.join(root, "renderer/src/app");

    /** Route paths that have a page, with group segments `(x)` and dynamic ones normalised out. */
    const routes = new Set<string>();
    const walk = (dir: string, url: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // `(group)` segments do not appear in the URL; `[param]` matches anything.
          const segment = /^\(.*\)$/.test(entry.name) ? "" : `/${entry.name}`;
          walk(full, url + segment);
        } else if (entry.name === "page.tsx") {
          routes.add(url === "" ? "/" : url);
        }
      }
    };
    walk(appDir, "");

    expect(routes.size, "found no routes — the walk is broken").toBeGreaterThan(8);

    /** Does a literal href match some route, allowing `[param]` segments to match anything? */
    const resolves = (href: string): boolean => {
      const parts = href.split("/").filter(Boolean);
      for (const route of routes) {
        const target = route.split("/").filter(Boolean);
        if (target.length !== parts.length) continue;
        if (target.every((seg, i) => /^\[.*\]$/.test(seg) || seg === parts[i])) return true;
      }
      return false;
    };

    /**
     * Both forms, and the second was a mutation-test survivor.
     *
     * The first version matched only the JSX attribute `href="/x"`, which is how the original `/login`
     * happened to be written. But most links in this app are declared in *data* — `FOOTER_LINKS`,
     * `NAV_ITEMS` — as `href: "/x"`, and adding a broken one there passed cleanly. The regex was
     * checking the shape of one bug rather than the property.
     *
     * Still literals only: a template literal or a variable is not statically checkable, and
     * pretending otherwise means either false failures or a pattern nobody trusts.
     */
    const HREF = /href[:=]\s*"(\/[A-Za-z0-9\-_/]*)"/g;

    const broken = sources
      .flatMap(({ file, text }) =>
        [...code(text).matchAll(HREF)].map((m) => ({ file, href: m[1] as string }))
      )
      .filter(({ href }) => !resolves(href))
      .map(({ file, href }) => `${href} (${file})`);

    expect([...new Set(broken)], "internal links to routes with no page").toEqual([]);
  });

  it("says the one liability sentence this product needs", () => {
    // Apache-2.0 §§7–8 cover the general case. What it does not name is an agent that writes to the
    // user's files, which is the specific risk this application carries and the reason section 6
    // exists at all. A warranty section that omitted it would be boilerplate.
    expect(terms).toMatch(/writes to your files/i);
    expect(terms).toMatch(/version control/i);
  });
});
