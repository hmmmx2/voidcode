/**
 * The one place that decides what happens to an API key.
 *
 * Until now the answer was "it is encrypted and held in a module variable", which meant the key had
 * to be pasted again after every launch. `ModelsPage` said so, honestly, and recorded the two
 * questions that had to be answered before it could stop saying it: *where the ciphertext lives*,
 * and *what clears it*. This module is those two answers.
 *
 * **Where it lives.** The `secrets` table in the app's own SQLite file. Not a second file, for the
 * reason `recents.ts` gives; not the plaintext, ever.
 *
 * **What clears it.** `clearSecret`, behind `vault:clear` — and, just as importantly, this module
 * itself when a stored row stops being decryptable. That is not a hypothetical: persisting means the
 * row outlives the OS keychain entry that unlocks it, so a keychain reset, an OS reinstall, or a
 * user copying their profile to another machine all produce bytes that cannot be read. Reporting "a
 * key is stored" for one of those is worse than reporting nothing, because the user cannot act on
 * it — the field they would use to fix it says a key is already there.
 *
 * ── WHY PERSISTENCE IS CONDITIONAL ────────────────────────────────────────────────────────────
 *
 * `safeStorage.isEncryptionAvailable()` returning true is not the same claim as "these bytes are
 * safe on disk". On Linux, when Electron does not recognise the desktop environment, it selects the
 * `basic_text` backend, which its own documentation describes as encrypting with a hardcoded key.
 * Available: yes. Protecting anything: no.
 *
 * In memory that distinction did not matter — the ciphertext died with the process. Writing it to
 * disk is exactly what makes it matter, so this is a risk *introduced* by the feature rather than
 * one it inherited. Under `basic_text` the key stays in memory for the session, which is the old
 * behaviour, and `storedDurably` is false so the UI can say which of the two happened instead of
 * implying the better one.
 *
 * `getSelectedStorageBackend()` is Linux-only and returns `unknown` before `app` is ready, so both
 * are treated as "cannot confirm a real backend" rather than assumed benign.
 */
import { safeStorage } from "electron";
import { deleteSecret, putSecret, readSecret, type SecretName } from "../store/secrets.js";

/**
 * Keys held for this process only, because the backend's output is not safe to persist.
 *
 * Also the reason this module keeps a map at all rather than reading through to SQLite every time:
 * under `basic_text` there is nothing in SQLite to read.
 */
const sessionOnly = new Map<SecretName, Buffer>();

/** Whether the selected backend's ciphertext is safe to write to disk. See the header. */
function backendIsDurable(): boolean {
  if (process.platform !== "linux") return true;

  // Linux-only API. `unknown` means `app` was not ready yet, which is not a backend we can vouch
  // for, and `basic_text` is one we can vouch against.
  const backend = safeStorage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "This system has no credential store for the app to encrypt a key with. On Linux that usually means no keyring is running — install gnome-keyring or kwallet, or run with --password-store to pick one."
    );
    this.name = "EncryptionUnavailableError";
  }
}

/**
 * Encrypt and keep a secret, persisting it when the backend's output is safe on disk.
 *
 * Returns where it went, because the caller has to tell the user the truth about whether it will
 * still be there tomorrow. A boolean the UI ignores would defeat the point of the distinction.
 *
 * Throws `EncryptionUnavailableError` rather than letting `encryptString` fail: the handler turns it
 * into a named `IpcError`, so the user reads why instead of "vault:set failed".
 */
export function setSecret(name: SecretName, plaintext: string): { storedDurably: boolean } {
  if (!safeStorage.isEncryptionAvailable()) throw new EncryptionUnavailableError();

  const ciphertext = safeStorage.encryptString(plaintext);

  if (!backendIsDurable()) {
    sessionOnly.set(name, ciphertext);
    // Any previously persisted row is now stale, and leaving it would let a stale key win on the
    // next launch. This is reachable: the backend can differ between runs, since it depends on the
    // desktop session and on --password-store.
    deleteSecret(name);
    return { storedDurably: false };
  }

  putSecret(name, ciphertext);
  // The durable copy is authoritative from here. Keeping a session copy as well would mean two
  // sources of truth and a stale one after `clearSecret`.
  sessionOnly.delete(name);
  return { storedDurably: true };
}

/**
 * The plaintext, decrypted at the moment of use, or `undefined` if there is usably none.
 *
 * Never cached in plaintext and never returned to the renderer — `openai.ts` calls this per request
 * so that nothing long-lived holds a credential where a log or a crash dump could pick it up.
 *
 * A row that will not decrypt is deleted and reported as absent. Propagating the error instead
 * would surface it as a failed chat, several layers from the thing the user can actually fix.
 */
export function secretValue(name: SecretName): string | undefined {
  const inSession = sessionOnly.get(name);
  if (inSession !== undefined) return decryptOrForget(name, inSession, false);

  const stored = readSecret(name);
  if (stored === undefined) return undefined;
  return decryptOrForget(name, stored, true);
}

function decryptOrForget(name: SecretName, ciphertext: Buffer, persisted: boolean): undefined | string {
  try {
    return safeStorage.decryptString(ciphertext);
  } catch {
    // The keychain entry that unlocks this is gone, or these bytes came from another machine.
    // Either way they will never decrypt again, so holding them only produces a `has` that lies.
    if (persisted) deleteSecret(name);
    else sessionOnly.delete(name);
    return undefined;
  }
}

/**
 * Whether a usable secret exists.
 *
 * Deliberately goes through `secretValue`, which means it *decrypts* to answer. The cheaper check —
 * does a row exist — is the one that produced the failure mode this guards: a stored blob nobody
 * can read, reported as a configured key, with the UI offering no way to notice.
 */
export function hasSecret(name: SecretName): boolean {
  return secretValue(name) !== undefined;
}

/** Forget a secret in both places. `false` means there was nothing to forget. */
export function clearSecret(name: SecretName): boolean {
  const hadSession = sessionOnly.delete(name);
  const hadStored = deleteSecret(name);
  return hadSession || hadStored;
}

/** Test seam: drop session-only state without touching the database. */
export function __resetSessionSecrets(): void {
  sessionOnly.clear();
}
