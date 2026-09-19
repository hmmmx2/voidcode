/**
 * Every paper's content, through the components that will draw it.
 *
 * WHY THE PYTHON SIDE CANNOT ANSWER THIS. `seed_papers.py` validates that four sections exist and
 * that none is a stub, which is the right check for the shape of the data. It says nothing about
 * whether the text RENDERS: the markdown goes through this application's own parser, and the
 * equations go through KaTeX. A section is markdown written by hand, and an equation is LaTeX
 * written by hand — both are exactly the kind of content that is valid to a schema and broken on
 * screen.
 *
 * KATEX DOES NOT THROW, WHICH IS THE POINT. `Math` is configured with `throwOnError: false` and
 * `errorColor: "currentColor"`, deliberately, so a malformed expression renders as visibly wrong
 * text rather than taking the whole page down. That is the right behaviour for content and it
 * means a test asserting "it did not throw" would pass on every broken equation in the library.
 * So this asserts on KaTeX's own error markup instead.
 *
 * The content is read from the YAML rather than from the database, because the YAML is the source
 * of truth (`content/problems/*.yaml`, `source_kind: paper`) and because a test that needed
 * Postgres would not run in this suite at all.
 *
 * JSX is avoided so this stays a `.ts` file matching the runner's `include` pattern.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "yaml";
import Markdown from "@/components/markdown/Markdown";
// From its own module, not the `@/components/app` barrel. The barrel pulls in the whole overlay
// system, and this file is compiled in the DESKTOP program, which sets
// `exactOptionalPropertyTypes: true` while the renderer's own tsconfig does not — so importing the
// barrel here fails the typecheck on a pre-existing looseness in `Overlay.tsx` that has nothing to
// do with paper content. `markdown-render.test.ts` imports narrowly for the same reason.
import { Math as Equation } from "@/components/app/Math";
import { SECTION_ORDER } from "@shared/research";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTENT = path.join(repo, "content/problems");

interface KeyEquation {
  label: string;
  latex: string;
  note?: string;
}

interface PaperFile {
  slug: string;
  title: string;
  source_kind?: string;
  arxiv_id?: unknown;
  pdf_url?: string;
  sections?: Record<string, string>;
  key_equations?: KeyEquation[];
  related_problem_slugs?: string[];
}

function papers(): PaperFile[] {
  return fs
    .readdirSync(CONTENT)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => parse(fs.readFileSync(path.join(CONTENT, name), "utf8")) as PaperFile)
    .filter((item) => item.source_kind === "paper");
}

const all = papers();

describe("the paper library's content", () => {
  it("finds the papers to check", () => {
    // Vacuity guard: a changed directory or a renamed `source_kind` would make every assertion
    // below pass over an empty list.
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("names the four sections the application renders, and no others", () => {
    for (const paper of all) {
      expect(Object.keys(paper.sections ?? {}).sort(), paper.slug).toEqual([...SECTION_ORDER].sort());
    }
  });

  it("quotes every arXiv identifier, so it stays a string", () => {
    /**
     * `arxiv_id: 1502.03167` is a FLOAT in YAML. The column is a `String(40)`, so an unquoted id
     * validated cleanly in `seed_papers.py` and then failed at the INSERT with `expected str, got
     * float` and forty lines of SQL. Three of the papers quoted it and two did not.
     *
     * The seeder checks this now as well, which is where it belongs — but that check runs only
     * when somebody has a database, and this one runs in the ordinary suite.
     */
    for (const paper of all) {
      if (paper.arxiv_id === undefined || paper.arxiv_id === null) continue;
      expect(typeof paper.arxiv_id, `${paper.slug}: quote the arxiv_id in the YAML`).toBe("string");
      expect(String(paper.arxiv_id), paper.slug).toMatch(/^\d{4}\.\d{4,5}(v\d+)?$/);
    }
  });

  it("builds its PDF link from the identifier it publishes", () => {
    // The two are shown side by side in the reader — the header prints `arXiv:{id}` and the button
    // opens `pdf_url` — so a mismatch is a link to a different paper from the one named above it.
    for (const paper of all) {
      if (typeof paper.arxiv_id !== "string") continue;
      expect(paper.pdf_url, paper.slug).toBe(`https://arxiv.org/pdf/${paper.arxiv_id}`);
    }
  });
});

describe("every section renders", () => {
  for (const paper of all) {
    for (const key of SECTION_ORDER) {
      it(`${paper.slug} / ${key}`, () => {
        const source = paper.sections?.[key] ?? "";
        const html = renderToStaticMarkup(createElement(Markdown, { source }));

        // Rendered, not merely non-empty: a parser that dropped every block would return the
        // wrapper div and satisfy a length check.
        expect(html, "no paragraph was emitted").toContain("<p");
        expect(html.length).toBeGreaterThan(source.length / 2);

        /**
         * THE EQUATIONS INSIDE THE PROSE, which the `key_equations` checks below do not reach.
         * `Markdown` hands a ```math fence to `Math`, and `Math` renders a malformed expression as
         * `.katex-error` rather than throwing — so a broken formula in the middle of a section is
         * invisible to every other assertion in this file.
         */
        expect(html, "an equation in the body does not typeset").not.toContain("katex-error");

        /**
         * THE HOUSE STRUCTURE, and the reason it is asserted rather than trusted: the two papers
         * added most recently were written with no headings and with formulas as backtick code,
         * while the three before them used `##` subheadings throughout and ```math blocks in the
         * mathematics tab. Both versions validated, seeded and rendered. The library just looked
         * like two libraries.
         *
         * Three is the floor the existing sections already meet; the mathematics tab is checked
         * separately below, because it is the only one that carries equations.
         */
        const headings = [...source.matchAll(/^## /gm)].length;
        expect(headings, `${paper.slug}/${key} has ${String(headings)} subheadings`).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("the mathematics tab carries the mathematics", () => {
  for (const paper of all) {
    it(paper.slug, () => {
      /**
       * Display equations belong in fenced ```math blocks, which `Markdown` hands to `Math` and
       * KaTeX typesets. The alternative — a formula as a backtick code span — renders as
       * monospace source on the one tab whose whole purpose is "why the maths works".
       *
       * Asserted for `mathematics` ONLY. The other three tabs in every existing paper carry no
       * equations at all, and requiring them would push algebra into prose that reads better
       * without it.
       */
      const maths = paper.sections?.mathematics ?? "";
      const blocks = [...maths.matchAll(/^```math$/gm)].length;
      expect(blocks, "the mathematics tab has no typeset equations").toBeGreaterThanOrEqual(3);

      for (const [other, body] of Object.entries(paper.sections ?? {})) {
        if (other === "mathematics") continue;
        expect([...body.matchAll(/^```math$/gm)].length, `${other} carries equations`).toBe(0);
      }
    });
  }
});

describe("every equation typesets", () => {
  for (const paper of all) {
    for (const equation of paper.key_equations ?? []) {
      it(`${paper.slug} / ${equation.label}`, () => {
        const html = renderToStaticMarkup(createElement(Equation, { latex: equation.latex }));

        /**
         * KATEX'S OWN ERROR MARKUP IS THE ASSERTION. With `throwOnError: false` a malformed
         * expression renders as the source text wrapped in `.katex-error` with a `title`
         * describing the parse failure — visibly wrong on screen and completely silent to a test
         * that only checked for an exception.
         */
        expect(html, `${equation.latex} does not typeset`).not.toContain("katex-error");
        expect(html).toContain("katex");
        // MathML as well as HTML, which is what `output: "htmlAndMathml"` is for: the HTML is for
        // sighted readers and the MathML is what a screen reader announces.
        expect(html, "no MathML was emitted").toContain("<math");
      });
    }
  }

  it("checks enough equations to be worth running", () => {
    const count = all.reduce((total, paper) => total + (paper.key_equations ?? []).length, 0);
    expect(count).toBeGreaterThanOrEqual(8);
  });
});
