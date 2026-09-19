/**
 * Every field Build publishes to the shell is compared before it is stored.
 *
 * THE BUG THIS CATCHES IS PERMANENT AND QUIET. `BuildActionsProvider.publish` field-compares the
 * incoming object and keeps the previous one when nothing changed, because the workspace
 * publishes from an effect over changing state and storing every object would loop. A field left
 * out of that comparison is therefore *never seen to change*: whatever reads it is pinned to the
 * value it happened to have the last time some **other** field moved.
 *
 * What that looks like: Save stays greyed after you type, or stays enabled after you save. Both
 * read as the menu being broken rather than as a stale object, and neither produces an error.
 *
 * `clearTerminal` was missing from that list for as long as it has existed — which is what turned
 * this from a hypothetical into a test. It is asserted against the interface rather than against
 * a hand-kept list, so a new field cannot be added without either comparing it or saying here why
 * it is exempt.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = path.resolve(
  __dirname,
  "..",
  "renderer",
  "src",
  "lib",
  "shell",
  "build-actions.tsx"
);

function source(): string {
  return readFileSync(SOURCE, "utf8");
}

/** Comments out: this file's own prose names most of the fields it checks. */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The field names declared on `BuildActions`. */
function declaredFields(): string[] {
  const body = /export interface BuildActions \{([\s\S]*?)\n\}/.exec(code());
  expect(body, "BuildActions is gone or no longer a top-level interface").not.toBeNull();
  return [...(body?.[1] ?? "").matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
}

/** The field names `publish` actually compares. */
function comparedFields(): string[] {
  const body = /const same =([\s\S]*?);/.exec(code());
  expect(body, "the field comparison is gone from publish").not.toBeNull();
  return [...new Set([...(body?.[1] ?? "").matchAll(/prev\.(\w+) === next\.\1/g)].map(
    (m) => m[1] as string
  ))];
}

describe("the published actions", () => {
  it("declares the fields this test thinks it does", () => {
    // A positive control. If either regex stops matching, the comparison below becomes vacuous
    // in the dangerous direction — an empty list is a subset of everything.
    const declared = declaredFields();
    expect(declared.length).toBeGreaterThan(10);
    expect(declared).toContain("openProject");
    expect(declared).toContain("saveActive");
    expect(comparedFields().length).toBeGreaterThan(10);
  });

  it("compares every one of them", () => {
    const missing = declaredFields().filter((field) => !comparedFields().includes(field));
    expect(
      missing,
      "these fields are published but never compared, so a change to one alone is never stored — " +
        "the menu item reading it stays at whatever value it had when another field last moved"
    ).toEqual([]);
  });

  it("compares nothing it does not declare", () => {
    // The other direction: a comparison on a field that no longer exists is dead weight that
    // reads as coverage.
    const extra = comparedFields().filter((field) => !declaredFields().includes(field));
    expect(extra, "the comparison names fields BuildActions does not have").toEqual([]);
  });

  it("offers the save family the File menu binds", () => {
    /**
     * `menu.test.ts` asserts every command in the menu is bound by *something*; this asserts the
     * something exists here. The two together are what make a greyed-out Save a statement about
     * the buffer rather than about a missing binding.
     */
    for (const field of [
      "saveActive",
      "saveAll",
      "saveActiveAs",
      "closeActiveEditor",
      "activeDirty",
      "hasDirty",
      "flushAll",
    ]) {
      expect(declaredFields(), `BuildActions does not offer ${field}`).toContain(field);
    }
  });
});
