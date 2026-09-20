/**
 * What happens to an API key.
 *
 * The feature under test is persistence, and the reason it needed a test file of its own is that
 * persistence is what makes four previously-unreachable states reachable. While the key lived in a
 * module variable, "the ciphertext outlives the keychain entry that unlocks it" could not happen, and
 * neither could "the backend is too weak to write this to disk". Both can now.
 *
 * So the assertions are deliberately not "the key round-trips". They are:
 *
 *   - what reaches SQLite is the encryptor's output rather than the value it was handed (which is a
 *     different and weaker claim than "the key cannot be recovered from the row" — that one depends
 *     on the OS cipher, not on this code, and a test here could only ever assert it against a stub)
 *   - a restart finds the key (the whole point)
 *   - a stored row that will not decrypt is reported absent **and deleted**, rather than reported
 *     as a configured key the user cannot fix and cannot see
 *   - a weak backend is not persisted at all, and a stale durable row from a stronger one is dropped
 *   - no credential store means a named refusal, not a generic failure
 *
 * There is no real cipher here (see `stubs/electron.ts`), which is correct: not one of those
 * properties is a claim about cryptographic strength, and a real one would need a keychain in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// No `vi.mock("electron")`: `vitest.config.ts` already aliases it to `stubs/electron.ts`, and that
// stub is where `safeStorage` is steered from. `__useInMemory()` never asks for `app.getPath`.
const { __useInMemory, openDatabase } = await import("../src/main/store/db.js");
const { __safeStorage, safeStorage } = await import("./stubs/electron.js");
const { readSecret } = await import("../src/main/store/secrets.js");
const {
  setSecret,
  hasSecret,
  secretValue,
  clearSecret,
  EncryptionUnavailableError,
  __resetSessionSecrets,
} = await import("../src/main/inference/vault.js");

const KEY = "sk-or-v1-not-a-real-key";

/**
 * What a relaunch looks like from this module's side: the process-lifetime map is gone, the database
 * is not.
 *
 * This is the seam the whole feature rests on, so it gets a name. A test that called
 * `__resetSessionSecrets` inline would read as bookkeeping rather than as the event it represents.
 */
const restart = (): void => __resetSessionSecrets();

/** Rows as they actually sit on disk, for asserting about bytes rather than about the API. */
function storedRow(): { ciphertext: Uint8Array } | undefined {
  return openDatabase().prepare(`SELECT ciphertext FROM secrets WHERE name = 'openrouter'`).get() as
    | { ciphertext: Uint8Array }
    | undefined;
}

/** Pretend to be a Linux desktop with the given safeStorage backend. */
function onLinuxWith(backend: typeof __safeStorage.backend): void {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  __safeStorage.backend = backend;
}

const realPlatform = process.platform;

beforeEach(() => {
  __useInMemory();
  __resetSessionSecrets();
  __safeStorage.reset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("a key on a machine with a real credential store", () => {
  it("survives a restart", () => {
    setSecret("openrouter", KEY);
    restart();

    // The assertion the feature exists for. Before this, `has` was a module variable and the answer
    // after a relaunch was always false.
    expect(hasSecret("openrouter")).toBe(true);
    expect(secretValue("openrouter")).toBe(KEY);
  });

  it("reports that it was stored durably, so the UI can say so", () => {
    expect(setSecret("openrouter", KEY)).toEqual({ storedDurably: true });
  });

  it("writes what the encryptor returned, not the value it was given", () => {
    setSecret("openrouter", KEY);

    const row = storedRow();
    expect(row).toBeDefined();

    /**
     * The assertion is byte-equality with `encryptString`'s output — not "the key does not appear in
     * these bytes", which was the first thing written here and was untestable in both directions: the
     * stub's transform is reversible on purpose, so the plaintext is always present in it, and
     * against a real cipher the check would pass without the code doing anything right.
     *
     * What *is* worth pinning is that the value goes through the encryptor at all. The refactor this
     * catches is a TEXT column holding the key directly, which every other test here would survive.
     */
    expect(Buffer.from(row!.ciphertext)).toEqual(safeStorage.encryptString(KEY));
    expect(Buffer.from(row!.ciphertext)).not.toEqual(Buffer.from(KEY, "utf8"));
    expect(readSecret("openrouter")).toBeDefined();
  });

  it("replaces rather than accumulating", () => {
    setSecret("openrouter", "first");
    setSecret("openrouter", "second");

    const rows = openDatabase().prepare(`SELECT COUNT(*) AS n FROM secrets`).get() as { n: number };
    expect(rows.n).toBe(1);
    expect(secretValue("openrouter")).toBe("second");
  });
});

describe("removing a key", () => {
  it("clears it from disk, so a restart does not bring it back", () => {
    setSecret("openrouter", KEY);
    expect(clearSecret("openrouter")).toBe(true);

    expect(hasSecret("openrouter")).toBe(false);
    expect(storedRow()).toBeUndefined();

    restart();
    expect(hasSecret("openrouter")).toBe(false);
  });

  it("says so when there was nothing to clear", () => {
    // Not an error. The UI shows Remove only when a key is stored, but `vault:clear` is a channel and
    // a channel is reachable by anything — reporting `false` beats inventing a success.
    expect(clearSecret("openrouter")).toBe(false);
  });
});

describe("a stored key that can no longer be decrypted", () => {
  /**
   * The failure mode persistence introduces. The row outlives the keychain entry that unlocks it, so
   * a keychain reset, an OS reinstall, or a copied profile all land here.
   */
  it("is reported absent rather than as a configured key", () => {
    setSecret("openrouter", KEY);
    restart();
    __safeStorage.decryptFails = true;

    expect(hasSecret("openrouter")).toBe(false);
    expect(secretValue("openrouter")).toBeUndefined();
  });

  it("is deleted, so it stops being asked about", () => {
    setSecret("openrouter", KEY);
    restart();
    __safeStorage.decryptFails = true;

    hasSecret("openrouter");

    // Deleted rather than merely ignored: an ignored row leaves `has` false with no way for the user
    // to reach a working state except guessing that saving again is what fixes it. Once it is gone,
    // the panel says no key is stored, which is both true and actionable.
    expect(storedRow()).toBeUndefined();

    // And the recovery actually works, which is the point of deleting it.
    __safeStorage.decryptFails = false;
    setSecret("openrouter", "a-fresh-key");
    expect(secretValue("openrouter")).toBe("a-fresh-key");
  });

  it("is not confused with bytes this store never produced", () => {
    // A row copied from another machine decrypts to an error, not to garbage — the same path, and
    // worth pinning separately because it arrives without any keychain having changed.
    openDatabase()
      .prepare(`INSERT INTO secrets (name, ciphertext) VALUES ('openrouter', ?)`)
      .run(Buffer.from("someone else's bytes", "utf8"));

    expect(hasSecret("openrouter")).toBe(false);
    expect(storedRow()).toBeUndefined();
  });
});

describe("a Linux desktop with no keyring the app can use", () => {
  /**
   * `basic_text` encrypts with a hardcoded key, by Electron's own documentation. In memory that was
   * harmless; writing it to disk would be a recoverable credential at rest, which is a risk this
   * feature would have *introduced*.
   */
  it("keeps the key for the session and writes nothing", () => {
    onLinuxWith("basic_text");

    expect(setSecret("openrouter", KEY)).toEqual({ storedDurably: false });
    expect(storedRow()).toBeUndefined();

    // Still usable now — refusing to store it must not mean refusing to use it.
    expect(secretValue("openrouter")).toBe(KEY);
  });

  it("loses it on restart, which is what the copy promises", () => {
    onLinuxWith("basic_text");
    setSecret("openrouter", KEY);

    restart();
    expect(hasSecret("openrouter")).toBe(false);
  });

  it("drops a durable row left by a stronger backend", () => {
    // Reachable: the backend depends on the desktop session and on --password-store, so it can
    // differ between two launches on one machine. Leaving the old row would let a stale key win.
    setSecret("openrouter", "saved-under-libsecret");
    onLinuxWith("basic_text");
    setSecret("openrouter", "session-only");

    expect(storedRow()).toBeUndefined();
    expect(secretValue("openrouter")).toBe("session-only");
  });

  it("treats a backend it cannot name as one it cannot vouch for", () => {
    // `unknown` means `app` was not ready. Assuming the good case would persist under a backend we
    // have not identified.
    onLinuxWith("unknown");
    expect(setSecret("openrouter", KEY)).toEqual({ storedDurably: false });
    expect(storedRow()).toBeUndefined();
  });

  it("does not let a session-only key outlive the durable one that replaced it", () => {
    /**
     * Both of these were mutation-test survivors, and the same line kills them: `setSecret` deleting
     * its session copy once a durable write succeeds.
     *
     * Reachable because the backend is a property of the *session*, not the machine — it depends on
     * the desktop environment and on --password-store. Save under `basic_text`, restart into a
     * session with libsecret, save a new key: without the delete, `secretValue` checks the session
     * map first and hands back the key the user just replaced. Silently, and for as long as the
     * window stays open.
     */
    onLinuxWith("basic_text");
    setSecret("openrouter", "old-session-key");

    onLinuxWith("gnome_libsecret");
    setSecret("openrouter", "new-durable-key");

    expect(secretValue("openrouter")).toBe("new-durable-key");
    restart();
    expect(secretValue("openrouter")).toBe("new-durable-key");
  });

  it("is cleared by Remove even though nothing was written to disk", () => {
    // The other survivor: `clearSecret` has two copies to forget and there is exactly one situation
    // where only the session one exists. Reporting `true` while leaving the key usable would make
    // Remove look like it worked.
    onLinuxWith("basic_text");
    setSecret("openrouter", KEY);

    expect(clearSecret("openrouter")).toBe(true);
    expect(hasSecret("openrouter")).toBe(false);
    expect(secretValue("openrouter")).toBeUndefined();
  });

  it("still persists under libsecret and kwallet", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"] as const) {
      __useInMemory();
      __resetSessionSecrets();
      onLinuxWith(backend);

      expect(setSecret("openrouter", KEY), backend).toEqual({ storedDurably: true });
      expect(storedRow(), backend).toBeDefined();
    }
  });

  /*
   * A GUARD, NOT AN ASSERTION, and the difference is why this failed the first time CI ever ran.
   *
   * It read `expect(process.platform).not.toBe("linux")` — meaning "this case only applies off
   * Linux", written as a check. On a Linux runner that is a FAILING TEST rather than a skipped one:
   * `expected 'linux' not to be 'linux'`. It passed for a year because every run was on Windows,
   * and the repository had no git remote, so no workflow had ever executed.
   *
   * `skipIf` says the same thing in the place that can act on it, and the reason stays in the name.
   */
  it.skipIf(process.platform === "linux")(
    "does not consult the Linux-only backend on Windows or macOS",
    () => {
    // `getSelectedStorageBackend()` is documented Linux-only. Reading it elsewhere would gate
    // persistence on a value the platform does not define.
    __safeStorage.backend = "basic_text";

    expect(setSecret("openrouter", KEY)).toEqual({ storedDurably: true });
    expect(storedRow()).toBeDefined();
    }
  );
});

describe("a machine with no credential store at all", () => {
  it("refuses by name instead of failing generically", () => {
    __safeStorage.available = false;

    // A named error so the handler can turn it into `E_UNAVAILABLE` with a message about keyrings.
    // Letting `encryptString` throw gave the user "vault:set failed" and nothing to act on.
    expect(() => setSecret("openrouter", KEY)).toThrow(EncryptionUnavailableError);
  });

  it("stores nothing when it refuses", () => {
    __safeStorage.available = false;

    expect(() => setSecret("openrouter", KEY)).toThrow();
    expect(storedRow()).toBeUndefined();
    expect(hasSecret("openrouter")).toBe(false);
  });
});
