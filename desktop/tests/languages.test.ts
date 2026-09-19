/**
 * Every language id we name is one Monaco actually has.
 *
 * WHY THIS IS WORTH A TEST. A wrong language id does not throw. `monaco.editor.tokenize(code,
 * "typescirpt")` returns one token per line covering the whole line, so the file renders in a
 * single colour — which is indistinguishable from the theme having failed to apply, or from
 * Monaco not having loaded, and both of those have happened in this repository. The failure is
 * invisible at the call site and looks like something else entirely.
 *
 * ASSERTED AGAINST THE INSTALLED PACKAGE, in `renderer/node_modules` rather than
 * `renderer/out`. `out/vs` only exists after a build, and a test that silently passes on a clean
 * checkout is not a test. `tests/packaging.test.ts` is what covers the copy reaching the export.
 *
 * THREE PLACES AN ID CAN BE REGISTERED, which is the detail that makes this non-trivial:
 *   - `min/vs/basic-languages/<id>/` — a Monarch tokenizer, one directory per language.
 *   - `min/vs/language/<service>/` — a full language service with a worker. JSON lives *only*
 *     here; there is no `basic-languages/json`, so a directory-only check would reject it.
 *   - a directory whose name differs from the id it registers, which is why
 *     `ID_IS_REGISTERED_BY` exists rather than a list of ids the test skips. A skip list is the
 *     shape that goes stale and then hides a real typo.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FILENAME_LANGUAGES,
  ID_IS_REGISTERED_BY,
  LANGUAGE_BY_EXTENSION,
  MONACO_WORKER_LANGUAGES,
  MONACO_WORKER_SERVICE,
  hasLanguageService,
  monacoLanguageFor,
} from "@shared/languages";

const MONACO = path.resolve(
  __dirname,
  "..",
  "renderer",
  "node_modules",
  "monaco-editor",
  "min",
  "vs"
);

const basicLanguages = new Set(readdirSync(path.join(MONACO, "basic-languages")));
const services = new Set(readdirSync(path.join(MONACO, "language")));

const declaredIds = (): string[] => [
  ...new Set([...Object.values(LANGUAGE_BY_EXTENSION), ...Object.values(FILENAME_LANGUAGES)]),
];

describe("the ids we name", () => {
  it("are all registered by the installed monaco", () => {
    const unknown = declaredIds().filter((id) => {
      const directory = ID_IS_REGISTERED_BY[id] ?? id;
      return !basicLanguages.has(directory) && !services.has(directory);
    });

    expect(
      unknown,
      "these language ids are not in the installed monaco-editor. A wrong id renders the whole " +
        "file in one colour rather than failing, so it reads as a broken theme."
    ).toEqual([]);
  });

  it("does not carry an exception for an id that no longer needs one", () => {
    /**
     * `ID_IS_REGISTERED_BY` exists to make the check above exact. An entry for an id that is now
     * a directory of its own, or that nothing maps to any more, is the check quietly loosening.
     */
    const ids = new Set(declaredIds());
    for (const [id, directory] of Object.entries(ID_IS_REGISTERED_BY)) {
      expect(ids, `nothing maps to ${id}, so its exception is dead`).toContain(id);
      expect(
        basicLanguages.has(directory),
        `${id} is said to be registered by ${directory}, which is not a monaco directory`
      ).toBe(true);
      expect(
        basicLanguages.has(id),
        `${id} has its own directory now; drop the exception rather than keeping both`
      ).toBe(false);
    }
  });

  it("claims a language service only where one ships", () => {
    /**
     * THE ASSERTION THAT STOPS SOMEBODY PROMISING PYTHON HOVERS. `MONACO_WORKER_SERVICE` is what
     * the UI reads to decide whether to say "Monaco's TypeScript service is reporting" or "ruff
     * ran over the last save". An id added here without a worker behind it would make the app
     * claim diagnostics it cannot produce, and the symptom is an empty Problems pane that reads
     * as a clean file.
     */
    for (const [id, service] of Object.entries(MONACO_WORKER_SERVICE)) {
      expect(services, `${id} claims the ${service} service, which does not ship`).toContain(
        service
      );
    }
    expect([...MONACO_WORKER_LANGUAGES].sort()).toEqual(
      Object.keys(MONACO_WORKER_SERVICE).sort()
    );
    // Python is the case everyone assumes. Its absence here is the whole point of the table.
    expect(MONACO_WORKER_LANGUAGES).not.toContain("python");
    expect(hasLanguageService("train.py")).toBe(false);
    expect(hasLanguageService("train.ts")).toBe(true);
  });

  it("names a service for every id it maps that has one, and no others", () => {
    /**
     * The other direction: a language whose worker ships but which is missing from the table
     * would be told "no linter is wired up for .css files" while Monaco was quietly reporting
     * CSS errors — two sources disagreeing in the same pane.
     */
    const servedDirectories = new Set(Object.values(MONACO_WORKER_SERVICE));
    for (const id of declaredIds()) {
      const directory = ID_IS_REGISTERED_BY[id] ?? id;
      if (!services.has(directory)) continue;
      expect(
        MONACO_WORKER_SERVICE[id],
        `${id} is served by vs/language/${directory} and is not in MONACO_WORKER_SERVICE`
      ).toBe(directory);
    }
    expect([...servedDirectories].every((d) => services.has(d))).toBe(true);
  });
});

describe("looking a path up", () => {
  it("reads the extension, not the first dot", () => {
    expect(monacoLanguageFor("src/model.test.ts")).toBe("typescript");
    expect(monacoLanguageFor("a.b.c.py")).toBe("python");
  });

  it("handles both separators, because Windows paths reach this", () => {
    expect(monacoLanguageFor("C:\\repo\\src\\main.rs")).toBe("rust");
    expect(monacoLanguageFor("repo/src/main.rs")).toBe("rust");
  });

  it("is case-insensitive", () => {
    expect(monacoLanguageFor("README.MD")).toBe("markdown");
    expect(monacoLanguageFor("Main.PY")).toBe("python");
  });

  it("reads a dotfile as a name rather than as an extension", () => {
    /**
     * `.gitignore` has `lastIndexOf(".") === 0`. Treating that as an extension looks up
     * `gitignore`, which is exactly the kind of near-miss that would then be "fixed" by adding a
     * bogus extension entry.
     */
    expect(monacoLanguageFor(".gitignore")).toBe("ini");
    expect(monacoLanguageFor("repo/.dockerignore")).toBe("ini");
    expect(monacoLanguageFor("Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageFor("repo/dockerfile")).toBe("dockerfile");

    /**
     * AND THE CASE THAT ACTUALLY EXERCISES THE RULE, which the four above do not.
     *
     * Every dotfile named there is in `FILENAME_LANGUAGES`, so it is answered before the
     * extension lookup is reached — a mutation loosening `dot <= 0` to `dot < 0` left all four
     * passing. The rule is only observable for a bare dotfile whose name happens to match a
     * mapped extension, and then it says the right thing: a leading dot is a name, so a file
     * called `.py` is a dotfile called "py" and not a Python file.
     */
    expect(monacoLanguageFor(".py")).toBeNull();
    expect(monacoLanguageFor("repo/.json")).toBeNull();
    // A dotfile WITH a real suffix still resolves on the suffix.
    expect(monacoLanguageFor(".eslintrc.json")).toBe("json");
  });

  it("returns null rather than guessing", () => {
    /**
     * `null`, not `"plaintext"`. The caller has to tell "this is text" from "we do not know",
     * because the second decides whether a linter is offered and what the Problems pane says.
     */
    for (const unknown of ["notes", "archive.tar.gz", "photo.png", "yarn.lock", "", "."]) {
      expect(monacoLanguageFor(unknown), `guessed a language for ${unknown}`).toBeNull();
    }
  });

  it("is not fooled by prototype keys", () => {
    /**
     * `__proto__.ts` is a legal filename, and `RECORD["__proto__"]` returns `Object.prototype`
     * rather than missing. Both tables go through a `Map` for this reason — the same hazard
     * `lib/build/dock.ts` and `problems.test.ts` already record.
     */
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(monacoLanguageFor(`a.${hostile}`), `${hostile} resolved`).toBeNull();
      expect(monacoLanguageFor(hostile), `${hostile} as a filename resolved`).toBeNull();
    }
    // And the extension still wins when the basename is hostile but the suffix is real.
    expect(monacoLanguageFor("__proto__.ts")).toBe("typescript");
  });
});

describe("against the fence table it is deliberately separate from", () => {
  /**
   * `markdown/CodeBlock.tsx`'s `LANGUAGE_ALIASES` is keyed by what a model writes after three
   * backticks. That is not a file extension: `markdown`, `shell`, `typescript` and `python` are
   * all fence tokens and none is a suffix anybody types. The tables are not merged for that
   * reason — one table answering both questions would have to accept `markdown` as an extension.
   *
   * What must hold is that they do not contradict each other where the keyspaces meet, because a
   * fence labelled `py` and a file called `.py` rendering in different colours is a bug nobody
   * would think to look for.
   */
  const fenceAliases = (): Record<string, string> => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "renderer", "src", "components", "markdown", "CodeBlock.tsx"),
      "utf8"
    );
    const table = /const LANGUAGE_ALIASES: Record<string, string> = \{([\s\S]*?)\n\};/.exec(
      source
    );
    expect(table, "LANGUAGE_ALIASES is gone from CodeBlock.tsx").not.toBeNull();
    return Object.fromEntries(
      [...(table?.[1] ?? "").matchAll(/^\s*([A-Za-z0-9]+):\s*"([^"]+)",/gm)].map((m) => [
        m[1] as string,
        m[2] as string,
      ])
    );
  };

  it("agrees wherever the two keyspaces overlap", () => {
    const aliases = fenceAliases();
    expect(Object.keys(aliases).length).toBeGreaterThan(10);

    const disagreements = Object.entries(aliases)
      .filter(([key, id]) => {
        const ours = LANGUAGE_BY_EXTENSION[key];
        return ours !== undefined && ours !== id;
      })
      .map(([key, id]) => `${key}: fence says ${id}, files say ${LANGUAGE_BY_EXTENSION[key]}`);

    expect(disagreements).toEqual([]);
  });

  it("overlaps at all, so the agreement above is not vacuous", () => {
    const shared = Object.keys(fenceAliases()).filter(
      (key) => LANGUAGE_BY_EXTENSION[key] !== undefined
    );
    expect(shared.length, "the tables no longer share a single key").toBeGreaterThan(8);
    expect(shared).toContain("py");
    expect(shared).toContain("ts");
  });
});
