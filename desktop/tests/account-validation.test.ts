/**
 * The sign-up form's password rules are the server's rules.
 *
 * `renderer/src/lib/account/validation.ts` mirrors `apps/api/src/services/password_service.py` so a
 * person learns their password is too short before it goes anywhere. A mirror that drifts is worse
 * than none in one direction: a client rule STRICTER than the server's refuses passwords the account
 * would accept, and the person has no way to find out why. Looser only costs a round trip, but it
 * still means the strength meter and hint describe a policy that does not exist.
 *
 * The bounds and the blocklist are read out of both sources and compared as data, so adding a word on
 * one side fails here. The behavioural table then checks the rules that are code rather than data.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const tsSource = read(path.join(root, "renderer/src/lib/account/validation.ts"));
const pySource = read(path.join(root, "..", "apps/api/src/services/password_service.py"));

const { validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = await import(
  "../renderer/src/lib/account/validation.js"
);

const words = (block: string | undefined): string[] =>
  [...(block ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).sort();

describe("the client mirrors the server's password policy", () => {
  it("has the same length bounds", () => {
    const py = (name: string) => Number(new RegExp(`^${name} = (\\d+)$`, "m").exec(pySource)?.[1]);
    expect(py("MIN_PASSWORD_LENGTH")).toBe(MIN_PASSWORD_LENGTH);
    expect(py("MAX_PASSWORD_LENGTH")).toBe(MAX_PASSWORD_LENGTH);
  });

  it("blocks the same words", () => {
    const server = words(/_BLOCKED = frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(pySource)?.[1]);
    const client = words(/const BLOCKED = new Set\(\[([\s\S]*?)\]\)/.exec(tsSource)?.[1]);
    expect(server.length, "could not read the server blocklist").toBeGreaterThan(10);
    expect(client).toEqual(server);
  });

  it.each([
    // [password, context, accepted by the server's rules]
    ["correct horse battery", {}, true],
    ["short", {}, false],
    ["x".repeat(129), {}, false],
    ["password1234", {}, false], // blocked outright
    ["password2024000", {}, false], // blocked after the digit suffix is removed
    ["aaaaaaaaaaaabbbb", {}, false], // fewer than 5 distinct characters
    ["learner-rides-bikes", { email: "learner@example.com" }, false], // contains the email's local part
    ["ab-quiet-river-stones", { email: "ab@example.com" }, true], // a local part under 3 characters is not checked
    ["my name is Ada Lovelace!", { name: "ada lovelace" }, false], // contains the name, case-insensitively
  ] as const)("%s", (pw, context, accepted) => {
    expect(validatePassword(pw, context) === null).toBe(accepted);
  });
});
