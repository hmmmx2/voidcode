/**
 * Minimal `electron` stand-in for unit tests.
 *
 * Only the members the modules under test import at runtime. Anything not needed
 * is deliberately absent rather than stubbed to `undefined`, so a test that
 * accidentally starts depending on real Electron behaviour fails with a clear
 * "not a function" instead of silently passing against a no-op.
 */

export const ipcMain = {
  handle(): void {
    throw new Error("ipcMain.handle is not available under test; call dispatch() directly");
  },
};

export const dialog = {
  showOpenDialog(): never {
    throw new Error("dialog.showOpenDialog is not available under test");
  },
};

/**
 * A `safeStorage` a test can steer, because every branch in `inference/vault.ts` is a branch on what
 * this returns and none of them are reachable otherwise.
 *
 * The encryption is a reversible transform, not encryption, and that is the right call: the property
 * under test is never "are these bytes strong". It is that the ciphertext is what reaches SQLite,
 * that the plaintext is not stored, that an unavailable store is refused by name, that a weak
 * backend is not persisted, and that an undecryptable row is forgotten. A real cipher would prove
 * none of those and would need a real keychain in CI.
 *
 * `__safeStorage` is the control surface. Defaults match a healthy Windows or macOS machine, since
 * that is what most tests want without saying so.
 */
export const __safeStorage = {
  available: true,
  /** Linux-only in the real API; the platform gate in `vault.ts` decides whether it is consulted. */
  backend: "gnome_libsecret" as
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown",
  /** Set to make `decryptString` throw, standing in for a keychain that no longer has the key. */
  decryptFails: false,
  reset(): void {
    this.available = true;
    this.backend = "gnome_libsecret";
    this.decryptFails = false;
  },
};

const CIPHER_PREFIX = "enc:";

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return __safeStorage.available;
  },
  encryptString(plaintext: string): Buffer {
    if (!__safeStorage.available) throw new Error("encryption is not available");
    return Buffer.from(CIPHER_PREFIX + plaintext, "utf8");
  },
  decryptString(encrypted: Buffer): string {
    if (__safeStorage.decryptFails) throw new Error("failed to decrypt");
    const text = encrypted.toString("utf8");
    // Mirrors the real API, which throws on bytes it did not produce — the case a row written by
    // another machine's keychain lands in.
    if (!text.startsWith(CIPHER_PREFIX)) throw new Error("not encrypted by this store");
    return text.slice(CIPHER_PREFIX.length);
  },
  getSelectedStorageBackend(): string {
    return __safeStorage.backend;
  },
};

/**
 * Shape-compatible enough for the registry and the broker, which read `id` and subscribe to
 * `destroyed`. `off` is optional because only the OAuth handler unsubscribes, and it does so
 * defensively for exactly that reason.
 */
export interface WebContents {
  id: number;
  once(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
}

/**
 * `shell`, recorded rather than performed.
 *
 * The property under test is almost always *whether* a URL was opened and which one — "no browser
 * was opened for a provider this build has no client id for" is an assertion about a call that must
 * NOT happen, and a stub that threw could not tell that apart from one that was never reached.
 *
 * `__shell.fail` covers the other direction: on a machine with no registered browser, or a Linux
 * box with no `xdg-open`, `openExternal` rejects — and a sign-in that cannot open a browser has to
 * say so rather than wait five minutes for a redirect that can never arrive.
 */
export const __shell = {
  opened: [] as string[],
  fail: false,
  reset(): void {
    this.opened = [];
    this.fail = false;
  },
  /** The last URL opened, parsed. Saves every caller writing `new URL(...)`. */
  lastUrl(): URL | undefined {
    const last = this.opened.at(-1);
    return last === undefined ? undefined : new URL(last);
  },
};

export const shell = {
  async openExternal(url: string): Promise<void> {
    if (__shell.fail) throw new Error("no application is registered to open that URL");
    __shell.opened.push(url);
  },
};
