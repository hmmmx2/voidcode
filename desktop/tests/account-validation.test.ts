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

describe("the email length cap is one number in three places", () => {
  /**
   * IT USED TO BE THREE DIFFERENT NUMBERS: 255 in the renderer's `validateEmail`, 320 in the IPC
   * contract, and 254 at the API. Each was defensible alone, and together they made two ways to be
   * refused by something other than the thing that decides. A 255-character address passed the
   * form, passed the channel's schema, reached the API, and came back as a validation error with no
   * field attached — which the dialog shows as a banner rather than under the Email field.
   *
   * 254 is the one that is not arbitrary: RFC 5321 caps an SMTP forward-path at 256 octets
   * including the angle brackets. `apps/api/tests/test_email_length_cap.py` pins the API's end of
   * it — it asserts all four request models accept 254 and refuse 255, AND reads the constant below
   * to check the two numbers are the same. Either half alone would let them drift: this file cannot
   * run Python, and a Python-only boundary test says nothing about what the app sends.
   */
  const shared = read(path.join(root, "src/shared/legal.ts"));
  const contract = read(path.join(root, "src/main/ipc/contract.ts"));
  const validation = read(path.join(root, "renderer/src/lib/account/validation.ts"));

  it("is 254, and says why in the place it is declared", () => {
    expect(shared).toMatch(/export const EMAIL_MAX_LENGTH = 254;/);
    expect(shared, "the constant does not cite the rule it comes from").toContain("RFC 5321");
  });

  it("is read by both the schema and the form, not restated", () => {
    expect(contract).toContain("EMAIL_MAX_LENGTH");
    expect(validation).toContain("EMAIL_MAX_LENGTH");

    // The old literals, banned in the two files that used to carry them. Scoped to `.max(` and to
    // the length comparison so an unrelated 255 or 320 elsewhere is not swept up.
    expect(contract, "the contract still hard-codes an email cap").not.toMatch(
      /email:\s*z\.string\(\)\.min\(3\)\.max\(\d+\)/
    );
    expect(validation, "the form still hard-codes an email cap").not.toMatch(
      /trimmed\.length > \d+\) return "That email address is too long/
    );
  });

  it("caps every channel that takes an address, not just the first", () => {
    // Four channels take an email: signInPassword, register, requestPasswordCode, resetPassword.
    // A constant applied to three of them is the same bug in a smaller size.
    const capped = contract.match(/z\.string\(\)\.min\(3\)\.max\(EMAIL_MAX_LENGTH\)/g) ?? [];
    expect(capped.length).toBe(4);
  });
});
