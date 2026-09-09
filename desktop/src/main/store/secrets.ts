/**
 * Durable storage for safeStorage ciphertext.
 *
 * Deliberately dumb: it reads and writes opaque bytes and knows nothing about encryption,
 * providers, or which backend produced them. Every policy question — is encryption available, is
 * this backend one whose output is safe to keep on disk, what happens when a row will not decrypt —
 * lives in `inference/vault.ts`, so that this module cannot answer it differently.
 *
 * In SQLite beside everything else the user owns, for the reason `recents.ts` gives: the database
 * is already the answer to "where does this app keep my things", and a second durable store for a
 * single row would be a second thing to back up, migrate and explain.
 *
 * The bytes are not a secret this file is protecting. They are a handle to one the operating system
 * is holding — see the `secrets` table comment in `db.ts`.
 */
import { openDatabase } from "./db.js";

/**
 * Names a secret may have, matching the contract's `key` enum.
 *
 * A type rather than a free string because the enum and the table have to agree: the channel
 * validates against `z.enum(["openrouter"])`, and a handler that passed something else would write
 * a row nothing ever reads again.
 */
export type SecretName = "openrouter";

export function putSecret(name: SecretName, ciphertext: Buffer): void {
  openDatabase()
    .prepare(
      `INSERT INTO secrets (name, ciphertext, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (name) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at`
    )
    // A Buffer *is* a Uint8Array, which is what node:sqlite binds to a BLOB. Passing it through
    // without conversion is the point of the column being BLOB rather than TEXT.
    .run(name, ciphertext);
}

/**
 * The stored ciphertext, or `undefined` if there is none.
 *
 * Returns a `Buffer` rather than the `Uint8Array` node:sqlite hands back, because
 * `safeStorage.decryptString` takes a Buffer and the copy belongs here rather than at each caller.
 */
export function readSecret(name: SecretName): Buffer | undefined {
  const row = openDatabase().prepare(`SELECT ciphertext FROM secrets WHERE name = ?`).get(name) as
    | { ciphertext?: Uint8Array }
    | undefined;

  const bytes = row?.ciphertext;
  // No zero-length guard. It was here and it was dead: `putSecret` only ever writes what
  // `encryptString` returned, and a hand-corrupted empty blob reaches `decryptString`, which
  // rejects it — so `vault.ts` already treats it as absent *and deletes the row*, which is the
  // better outcome. Returning undefined here would have left the bad row in place.
  if (bytes === undefined) return undefined;
  return Buffer.from(bytes);
}

/** True when a row was actually removed, so a caller can distinguish "cleared" from "nothing to clear". */
export function deleteSecret(name: SecretName): boolean {
  const result = openDatabase().prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
  return Number(result.changes) > 0;
}
