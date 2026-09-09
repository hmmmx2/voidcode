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

/** Shape-compatible enough for the registry, which only reads `id` and `once`. */
export interface WebContents {
  id: number;
  once(event: string, listener: () => void): void;
}
