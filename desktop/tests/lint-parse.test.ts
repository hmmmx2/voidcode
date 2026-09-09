/**
 * Three tools' output, read into one shape.
 *
 * The fixtures are the shapes these tools actually emit, including the fields they leave out.
 * The omissions are the point: ruff drops `end_location` for some rules, eslint drops `endLine`
 * for others, and a parser that filled those in with `line + 1` would underline the wrong code
 * on exactly the rules that are hardest to notice.
 *
 * **The load-bearing claim in this file is that a parse failure is not an empty list.** An empty
 * list renders as "no problems", so a linter whose output stopped being readable would report
 * every file as clean and nobody would find out until something shipped.
 */
import { describe, it, expect } from "vitest";
import { parseEslint, parseRuff, parseTsc } from "../src/main/lint/parse.js";

const RUFF = JSON.stringify([
  {
    cell: null,
    code: "F401",
    filename: "/proj/app.py",
    location: { column: 8, row: 1 },
    end_location: { column: 17, row: 1 },
    message: "`os` imported but unused",
    noqa_row: 1,
    url: "https://docs.astral.sh/ruff/rules/unused-import",
  },
  {
    // A rule with no end. Real: several of ruff's whole-line rules omit it.
    code: "E712",
    filename: "/proj/app.py",
    location: { column: 4, row: 9 },
    end_location: null,
    message: "Comparison to `True` should be `cond is True`",
  },
]);

const ESLINT = JSON.stringify([
  {
    filePath: "/proj/app.ts",
    messages: [
      {
        ruleId: "no-unused-vars",
        severity: 2,
        message: "'x' is assigned a value but never used.",
        line: 1,
        column: 7,
        endLine: 1,
        endColumn: 8,
      },
      {
        ruleId: "semi",
        severity: 1,
        message: "Missing semicolon.",
        line: 1,
        column: 12,
      },
      {
        // eslint's own parse failure: severity 2, no rule.
        ruleId: null,
        severity: 2,
        message: "Parsing error: Unexpected token }",
        line: 4,
        column: 1,
      },
    ],
    errorCount: 2,
    warningCount: 1,
  },
]);

const TSC = [
  "src/main/lint/index.ts(42,7): error TS2304: Cannot find name 'foo'.",
  "src/main/lint/index.ts(51,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Type 'string' has no properties in common with type 'number'.",
  "renderer/src/other.tsx(9,1): warning TS6133: 'x' is declared but its value is never read.",
].join("\n");

describe("ruff", () => {
  const parsed = parseRuff(RUFF, "app.py")!;

  it("reads its 1-based location", () => {
    expect(parsed[0]).toMatchObject({ line: 1, column: 8, endLine: 1, endColumn: 17 });
  });

  it("leaves a missing end as null rather than guessing one", () => {
    expect(parsed[1]!.endLine).toBeNull();
    expect(parsed[1]!.endColumn).toBeNull();
  });

  it("reports lint findings as warnings, not errors", () => {
    // ruff has no severity axis — everything it emits is a violation. Painting an unused import
    // red would put an error underline under code that compiles and runs.
    expect(parsed.every((d) => d.severity === "warning")).toBe(true);
  });

  it("keeps the rule code and names itself as the source", () => {
    expect(parsed[0]).toMatchObject({ code: "F401", source: "ruff" });
  });

  it("says it could not read malformed output instead of returning nothing", () => {
    // The whole reason this returns `null`. `[]` would render as a clean file.
    expect(parseRuff("not json at all", "app.py")).toBeNull();
    expect(parseRuff('{"not":"an array"}', "app.py")).toBeNull();
  });

  it("tells an empty result apart from an unreadable one", () => {
    expect(parseRuff("[]", "app.py")).toEqual([]);
  });
});

describe("eslint", () => {
  const parsed = parseEslint(ESLINT, "app.ts")!;

  it("maps severity 2 to error and 1 to warning", () => {
    // A numeric code, not a word, and the single field most likely to be got backwards.
    expect(parsed[0]!.severity).toBe("error");
    expect(parsed[1]!.severity).toBe("warning");
  });

  it("leaves a missing endLine as null", () => {
    expect(parsed[1]!.endLine).toBeNull();
    expect(parsed[1]!.endColumn).toBeNull();
  });

  it("keeps a parse error, which has no ruleId", () => {
    const parseError = parsed.find((d) => d.message.startsWith("Parsing error"));
    expect(parseError).toBeDefined();
    expect(parseError!.code).toBeNull();
    expect(parseError!.severity).toBe("error");
  });

  it("says it could not read malformed output", () => {
    expect(parseEslint("<html>proxy error</html>", "app.ts")).toBeNull();
  });

  it("tells an empty result apart from an unreadable one", () => {
    expect(parseEslint('[{"filePath":"/proj/app.ts","messages":[]}]', "app.ts")).toEqual([]);
  });
});

describe("tsc", () => {
  const parsed = parseTsc(TSC)!;

  it("reads the path, line and column out of the text form", () => {
    expect(parsed[0]).toMatchObject({
      rawPath: "src/main/lint/index.ts",
      line: 42,
      column: 7,
      code: "TS2304",
      severity: "error",
    });
  });

  it("attaches an indented continuation to the finding above it", () => {
    // Where the useful half of a type mismatch lives. Dropping it leaves "Type 'string' is not
    // assignable to type 'number'" with none of the detail that says which property.
    expect(parsed[1]!.message).toContain("has no properties in common");
  });

  it("keeps warnings distinct from errors", () => {
    expect(parsed[2]!.severity).toBe("warning");
  });

  it("names no end, because tsc does not", () => {
    expect(parsed.every((d) => d.endLine === null && d.endColumn === null)).toBe(true);
  });

  it("treats no output as a clean program, not as a failure", () => {
    // Unlike the JSON parsers there is nothing here that can fail to parse, so silence is an
    // answer. Returning null would show "could not read tsc" on every clean save.
    expect(parseTsc("")).toEqual([]);
    expect(parseTsc("\n\n")).toEqual([]);
  });

  it("says it could not read output in a shape it does not recognise", () => {
    // What a changed format looks like: lines, none of them findings.
    expect(parseTsc("error: something went very wrong\nand again")).toBeNull();
  });
});
