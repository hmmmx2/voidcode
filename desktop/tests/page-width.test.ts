/**
 * Pages fitting the monitor they are shown on.
 *
 * Twelve routes had each chosen their own max-width — 3xl, 4xl, 5xl, 6xl and a bare 92rem —
 * and every one of them stopped at laptop widths. On a 32" 4K a catalogue used 23% of the
 * screen and the rest was margin.
 *
 * Two things can regress here and neither shows up in a render test. The ladder in
 * `globals.css` can be edited into something that doesn't grow, or shrinks, or puts the kinds
 * out of order — a two-pane workspace narrower than a single-column form, or a row list given
 * grid-sized room it has nothing to fill with. And a page can quietly reintroduce its own
 * `max-w-`, which is how the five different widths happened the first time. Both are checked
 * here against the source, because neither shows up in a render test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CSS = join(__dirname, "../renderer/src/app/globals.css");
const SRC = join(__dirname, "../renderer/src");

type Kind = "document" | "content" | "list" | "grid" | "workspace";
const KINDS: Kind[] = ["document", "content", "list", "grid", "workspace"];

/** Every `(min-viewport, max-width)` pair declared for each class, in source order. */
function readLadder(): Record<Kind, Array<{ from: number; rem: number }>> {
  const css = readFileSync(CSS, "utf8");
  const ladder = { document: [], content: [], list: [], grid: [], workspace: [] } as ReturnType<
    typeof readLadder
  >;

  // Track which `@media (width >= Npx)` block each declaration sits in. Depth counting rather
  // than a regex over the whole file: a rule's breakpoint is decided by nesting, and a flat
  // match would attribute every declaration to the last `@media` seen above it in the file.
  let mediaFrom = 0;
  let depth = 0;
  let mediaDepth = -1;

  for (const line of css.split("\n")) {
    const media = /@media\s*\(width\s*>=\s*(\d+)px\)/.exec(line);
    if (media !== undefined && media !== null) {
      mediaFrom = Number(media[1]);
      mediaDepth = depth;
    }

    const decl = /\.page-(document|content|list|grid|workspace)\s*\{\s*max-width:\s*([\d.]+)rem/.exec(
      line,
    );
    if (decl !== null) {
      ladder[decl[1] as Kind].push({ from: mediaFrom, rem: Number(decl[2]) });
    }

    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth <= mediaDepth) {
      mediaFrom = 0;
      mediaDepth = -1;
    }
  }

  return ladder;
}

/** The max-width a page kind resolves to on a viewport this wide, in rem. */
function widthAt(ladder: ReturnType<typeof readLadder>, kind: Kind, viewport: number): number {
  const applicable = ladder[kind].filter((step) => viewport >= step.from);
  expect(applicable.length, `${kind} has no rule at ${viewport}px`).toBeGreaterThan(0);
  // Last one wins, as the cascade does.
  return applicable[applicable.length - 1]!.rem;
}

/** The monitors this was asked to cover, plus a laptop as the floor. */
const SCREENS = [
  { px: 1512, name: '14" laptop' },
  { px: 1920, name: '24" 1080p' },
  { px: 2560, name: '27"/32" QHD' },
  { px: 3440, name: '34" ultrawide' },
  { px: 3840, name: '32" 4K' },
];

describe("the page width ladder", () => {
  const ladder = readLadder();

  it("declares all five page kinds", () => {
    for (const kind of KINDS) {
      expect(ladder[kind].length, `.page-${kind} is not declared`).toBeGreaterThan(0);
    }
  });

  it("grows every kind but document across the four monitor sizes", () => {
    for (const kind of ["content", "list", "grid", "workspace"] as Kind[]) {
      const widths = SCREENS.map((s) => widthAt(ladder, kind, s.px));

      // Never narrower on a bigger screen.
      for (let i = 1; i < widths.length; i += 1) {
        expect(
          widths[i]!,
          `.page-${kind} shrinks from ${SCREENS[i - 1]!.name} to ${SCREENS[i]!.name}`,
        ).toBeGreaterThanOrEqual(widths[i - 1]!);
      }

      // And actually bigger by the end, or the ladder is decorative.
      expect(
        widths[widths.length - 1]!,
        `.page-${kind} is the same width on a 32" 4K as on a laptop`,
      ).toBeGreaterThan(widths[0]!);
    }
  });

  it("holds document at one width, because line length is the limit", () => {
    const widths = SCREENS.map((s) => widthAt(ladder, "document", s.px));
    expect(new Set(widths).size, `.page-document grows: ${widths.join(", ")}rem`).toBe(1);
  });

  it("orders the kinds by how much width their content can actually use", () => {
    // A form is one column of fields; a row list uses more but strands a badge past a point;
    // only a reflowing card grid answers extra width with more content; and a two-pane split
    // needs the most, because each pane gets half of whatever the page has.
    for (const screen of SCREENS) {
      const at = (k: Kind) => widthAt(ladder, k, screen.px);
      expect(at("list"), `list is narrower than content at ${screen.name}`).toBeGreaterThanOrEqual(
        at("content"),
      );
      expect(at("grid"), `grid is narrower than list at ${screen.name}`).toBeGreaterThanOrEqual(
        at("list"),
      );
      expect(
        at("workspace"),
        `workspace is not wider than grid at ${screen.name}`,
      ).toBeGreaterThan(at("grid"));
    }
  });

  it("stops a row list well short of where a badge strands from its title", () => {
    // At 2000px the problem list put each title on the far left and its difficulty badge
    // 1200px away. Screenshotted, not guessed. 1600px is the ceiling that avoids it.
    expect(widthAt(ladder, "list", 3840) * 16).toBeLessThanOrEqual(1600);
  });

  it("stops before full-bleed on an ultrawide", () => {
    // The cap is eye travel from a row's first column to its last, not available pixels. A
    // table filling 3440px puts a Download button most of a screen from the model name.
    for (const kind of ["content", "list", "grid", "workspace"] as Kind[]) {
      const rem = widthAt(ladder, kind, 3440);
      expect(rem * 16, `.page-${kind} fills a 3440px ultrawide`).toBeLessThan(3440);
    }
  });
});

/** Every `className="…"` / `className={`…`}` literal in the renderer, with its file and line. */
function* classNames(): Generator<{ file: string; line: number; value: string }> {
  const stack = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name.endsWith(".tsx")) {
        // A plain loop, not `forEach`: `yield` cannot cross a callback boundary.
        const lines = readFileSync(path, "utf8").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          for (const m of lines[i]!.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)) {
            yield { file: path.slice(SRC.length + 1), line: i + 1, value: m[1]! };
          }
        }
      }
    }
  }
}

describe("no page pins its own width", () => {
  it("leaves centred containers to the five page classes", () => {
    const offenders: string[] = [];

    for (const { file, line, value } of classNames()) {
      if (!/\bmx-auto\b/.test(value)) continue;

      // A `ch` measure is a reading limit on a line of text, not a page width, and correctly
      // does not grow with the screen — the centred subtitles under each page heading.
      const maxes = [...value.matchAll(/\bmax-w-(\S+)/g)]
        .map((m) => m[1]!)
        .filter((token) => !/^\[\d+(\.\d+)?ch\]$/.test(token));

      if (maxes.length > 0) {
        offenders.push(`${file}:${line} — mx-auto with max-w-${maxes.join(", max-w-")}`);
      }
    }

    expect(
      offenders,
      `these centre content at their own width instead of a page class:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("still has the page classes in use, so the guard above is not vacuous", () => {
    // Without this, deleting every page container would pass the offender check.
    const used = new Set<string>();
    for (const { value } of classNames()) {
      for (const kind of KINDS) {
        if (new RegExp(`\\bpage-${kind}\\b`).test(value)) used.add(kind);
      }
    }
    expect([...used].sort()).toEqual([...KINDS].sort());
  });
});
