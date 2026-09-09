/**
 * Which glyph a filename gets.
 *
 * Only the classifier is tested — the SVG paths are drawing, and a test asserting on path data
 * pins the artwork rather than the behaviour. What can actually be wrong here is the lookup:
 * dotfiles have no extension by the usual `split(".").pop()`, and several names mean something
 * their suffix does not.
 */
import { describe, it, expect } from "vitest";
import { kindFor } from "../renderer/src/components/Build/FileIcon.js";

describe("by extension", () => {
  it("groups sources regardless of language", () => {
    for (const name of ["a.ts", "a.tsx", "b.py", "c.rs", "d.go", "e.java"]) {
      expect(kindFor(name)).toBe("code");
    }
  });

  it("separates the families a tree is scanned for", () => {
    expect(kindFor("index.html")).toBe("markup");
    expect(kindFor("app.css")).toBe("style");
    expect(kindFor("data.csv")).toBe("data");
    expect(kindFor("notes.md")).toBe("doc");
    expect(kindFor("logo.png")).toBe("image");
    expect(kindFor("build.sh")).toBe("shell");
  });

  it("is case-insensitive, because Windows filenames are", () => {
    expect(kindFor("README.MD")).toBe("doc");
    expect(kindFor("Main.PY")).toBe("code");
  });

  it("falls back rather than guessing", () => {
    expect(kindFor("mystery.qqq")).toBe("file");
    expect(kindFor("noextension")).toBe("file");
  });
});

describe("by whole name", () => {
  it("reads package.json as config, not data", () => {
    // The suffix says JSON; what the reader is looking for is the project's config.
    expect(kindFor("package.json")).toBe("config");
    expect(kindFor("tsconfig.json")).toBe("config");
    // And a plain data file with the same suffix still reads as data.
    expect(kindFor("results.json")).toBe("data");
  });

  it("handles the suffix-less files every repository root has", () => {
    // An extension-only table renders these as blank pages, which is what makes a file tree
    // look unfinished on the very first screen someone sees.
    expect(kindFor("Dockerfile")).toBe("config");
    expect(kindFor("Makefile")).toBe("config");
    expect(kindFor("LICENSE")).toBe("doc");
  });

  it("handles dotfiles, which have no extension by the usual split", () => {
    /**
     * `".gitignore".split(".").pop()` is `"gitignore"`, so a naive lookup would need an entry
     * for every dotfile's *whole name* under the extension table. Anchoring on the last dot at
     * index > 0 is what makes this work.
     */
    expect(kindFor(".gitignore")).toBe("config");
    expect(kindFor(".env")).toBe("config");
  });

  it("marks lockfiles distinctly, since nobody opens one on purpose", () => {
    for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock"]) {
      expect(kindFor(name)).toBe("lock");
    }
  });
});
