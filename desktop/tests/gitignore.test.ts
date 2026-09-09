/**
 * The `.gitignore` subset the indexer reads.
 *
 * Not a complete gitignore implementation, and the module says so. What matters is that the
 * cases people actually write behave the way they expect — and in particular the three that
 * are easy to get backwards: anchoring, directory-only rules, and negation order.
 *
 * The cost of a miss here is waste, not incorrectness: a few extra files get embedded. `.git`
 * itself is skipped structurally by the walker rather than by anything in this file, so no
 * privacy claim rests on it.
 */
import { describe, it, expect } from "vitest";
import { parseGitignore, isIgnored } from "../src/main/memory/gitignore.js";

const ignored = (patterns: string, path: string, isDirectory = false): boolean =>
  isIgnored(parseGitignore(patterns), path, isDirectory);

describe("plain patterns", () => {
  it("matches a bare name at any depth", () => {
    // The rule people are most often surprised by: no slash means "anywhere".
    expect(ignored("node_modules", "node_modules")).toBe(true);
    expect(ignored("node_modules", "packages/web/node_modules")).toBe(true);
    expect(ignored("*.log", "logs/deep/run.log")).toBe(true);
  });

  it("anchors a pattern that contains a slash", () => {
    // `src/generated` must not match `packages/src/generated`.
    expect(ignored("src/generated", "src/generated")).toBe(true);
    expect(ignored("src/generated", "packages/src/generated")).toBe(false);
  });

  it("anchors a leading slash to the root", () => {
    expect(ignored("/build", "build")).toBe(true);
    expect(ignored("/build", "sub/build")).toBe(false);
  });

  it("leaves a merely similar name alone", () => {
    expect(ignored("dist", "dist-tools")).toBe(false);
    expect(ignored("*.py", "script.pyc")).toBe(false);
  });
});

describe("wildcards", () => {
  it("does not let a single star cross a separator", () => {
    expect(ignored("src/*.py", "src/main.py")).toBe(true);
    expect(ignored("src/*.py", "src/pkg/main.py")).toBe(false);
  });

  it("lets ** cross any number of directories", () => {
    expect(ignored("src/**/test.py", "src/a/b/test.py")).toBe(true);
    // Zero directories too — the case a naive `(.*/)+` misses.
    expect(ignored("src/**/test.py", "src/test.py")).toBe(true);
  });

  it("matches one character with ?", () => {
    expect(ignored("a?.py", "ab.py")).toBe(true);
    expect(ignored("a?.py", "abc.py")).toBe(false);
  });

  it("treats a dot as a literal, not a wildcard", () => {
    expect(ignored(".env", "aenv")).toBe(false);
  });

  it("survives a pattern with regex metacharacters in it", () => {
    // `c++/` would be an invalid regex if passed through unescaped.
    expect(() => parseGitignore("c++/\nlib(old)/")).not.toThrow();
    expect(ignored("c++", "c++", true)).toBe(true);
  });
});

describe("directory-only rules", () => {
  it("ignores a directory and everything under it", () => {
    // `dist/` has to catch `dist/a/b.js` without anyone writing `dist/**`.
    expect(ignored("dist/", "dist", true)).toBe(true);
    expect(ignored("dist/", "dist/a/b.js")).toBe(true);
  });

  it("does not match a file of the same name", () => {
    expect(ignored("dist/", "dist")).toBe(false);
  });
});

describe("negation", () => {
  it("re-includes a path a later rule rescues", () => {
    expect(ignored("*.log\n!keep.log", "keep.log")).toBe(false);
    expect(ignored("*.log\n!keep.log", "other.log")).toBe(true);
  });

  it("is order-sensitive, last match winning", () => {
    // Reversed, the negation is overridden again — which is what git does and why the rules
    // are evaluated in order rather than short-circuiting on the first hit.
    expect(ignored("!keep.log\n*.log", "keep.log")).toBe(true);
  });

  it("rescues a subdirectory of an ignored one", () => {
    const patterns = "vendor/\n!vendor/mine/";
    expect(ignored(patterns, "vendor/other/x.js")).toBe(true);
    expect(ignored(patterns, "vendor/mine", true)).toBe(false);
  });
});

describe("the file itself", () => {
  it("skips blanks and comments", () => {
    expect(ignored("\n# a comment\n\n*.log", "x.log")).toBe(true);
    expect(ignored("# *.py", "x.py")).toBe(false);
  });

  it("strips trailing whitespace but keeps leading", () => {
    // A filename may legitimately begin with a space; none end with one by intent.
    expect(ignored("*.log   ", "x.log")).toBe(true);
  });

  it("handles CRLF, which is what a Windows checkout has", () => {
    expect(ignored("*.log\r\n*.tmp", "x.tmp")).toBe(true);
  });

  it("ignores nothing when empty", () => {
    expect(ignored("", "anything.py")).toBe(false);
  });
});
