/**
 * The chrome's icons, and the two ways they went wrong before.
 *
 * **Two gears.** `ActivityBar` drew a starburst at 20px on a 22 grid at stroke 1.4;
 * `TopNavigation` drew a Feather cog at 16px on a 24 grid at stroke 1.5. Both meant
 * "settings", both routed to `/profile`, and neither knew about the other — which is what
 * happens when every glyph is a local function. The set in `components/icons` exists so there
 * is one place to change, and these tests exist so a local redefinition is a failure rather
 * than a thing someone notices six months later in a screenshot.
 *
 * **The drag region.** `MenuBar`'s header carries `-webkit-app-region: drag`, so an
 * interactive child without `no-drag` receives the drag instead of the click and the window
 * slides. It is reported as "I can't click the bell", which does not sound like a CSS
 * property.
 *
 * Source-read rather than rendered: these are claims about what the files contain, not about
 * what they paint. Comments are stripped first — the prose above and in the components names
 * `GearIcon` and `no-drag` repeatedly, and matching that would pass against the bug.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(`../renderer/src/${relative}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("one settings glyph, not two", () => {
  const consumers = ["components/Shell/ActivityBar.tsx", "components/Layout/TopNavigation.tsx"];

  it("defines no local gear in either consumer", () => {
    /**
     * Named by shape, not by one identifier.
     *
     * This banned exactly `function GearIcon(` — so re-adding the glyph as `CogIcon`,
     * `SettingsGlyph`, or `const Gear = () =>` walked straight past it, which is precisely how
     * the two divergent gears got there the first time. Any local declaration whose name reads
     * like a settings glyph is the thing to refuse, in either declaration form.
     */
    const gearish = /(?:function|const)\s+\w*(?:Gear|Cog|Settings)\w*\s*[(=]/i;
    for (const file of consumers) {
      const match = gearish.exec(read(file));
      expect(match?.[0] ?? null, `${file} declares its own settings glyph`).toBeNull();
    }
  });

  it("draws the shared one instead", () => {
    for (const file of consumers) {
      const code = read(file);
      expect(code).toContain("<IconSettings");
      expect(code).toMatch(/import \{[^}]*IconSettings[^}]*\} from "@\/components\/icons"/);
    }
  });

  it("sizes it per surface rather than redrawing it", () => {
    // The rail is a 48px column and wants 20px; the top nav sits among 16px controls. Size is
    // a prop precisely so neither has a reason to author its own copy.
    expect(read("components/Shell/ActivityBar.tsx")).toContain("<IconSettings size={20} />");
    expect(read("components/Layout/TopNavigation.tsx")).toContain("<IconSettings size={16} />");
  });
});

describe("the icon set is authored on one grid", () => {
  const icons = read("components/icons/index.tsx");

  it("declares exactly one viewBox, in the shared attribute helper", () => {
    // The whole point of the set. A second viewBox means a second family, which is the state
    // this replaced — 22 and 24 side by side, reading as mismatched because they were.
    const viewBoxes = [...icons.matchAll(/viewBox:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(viewBoxes).toEqual(['0 0 16 16']);
  });

  it("declares exactly one stroke weight", () => {
    const weights = [...icons.matchAll(/strokeWidth:\s*([\d.]+)/g)].map((m) => m[1]);
    expect(weights).toEqual(["1.3"]);
  });

  it("gives no two glyphs the same geometry", () => {
    /**
     * Found in a screenshot, not a diff. `IconModel` was drawn as stacked plates "echoing the
     * Interview Prep layers without being the same glyph", and it was the same glyph — both
     * sat in the activity rail at 20px, four slots apart, indistinguishable.
     *
     * Comparing the `d` attributes catches an exact duplicate. It cannot catch two shapes
     * that merely look alike, which is what happened; that is what looking at the running app
     * is for. It does stop the next one being a copy-paste.
     */
    const paths = [...icons.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(5);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps the model glyph distinct from the destination layers", () => {
    // The specific collision. ActivityBar draws the prep destination as stacked plates; the
    // Models button sits in the same rail and must not.
    const at = icons.indexOf("export function IconModel");
    const model = icons.slice(at, icons.indexOf("export function", at + 10));
    expect(model).toContain("<rect");
    expect(model).not.toMatch(/l8 4 8-4/);
  });

  it("sets no per-glyph width or height, so the size prop is the only lever", () => {
    // The old bell carried width="20" height="20" and ignored every className aimed at it.
    expect(icons).not.toMatch(/<svg[^>]*\swidth=/);
  });
});

describe("the title bar stays clickable", () => {
  const menuBar = read("components/Shell/MenuBar.tsx");

  it("keeps every interactive element out of the drag region", () => {
    // Counted rather than spot-checked: each button either carries `no-drag` itself or sits in
    // a wrapper that does. Fewer no-drag regions than interactive clusters means one of them
    // is now a drag surface.
    /**
     * Each button checked, not the two totals compared.
     *
     * This counted `<button` and counted `no-drag` and then asserted only that each was above
     * zero — so it passed with three of four buttons on a drag surface. Comparing the totals is
     * barely better: there are more regions than buttons because some are wrappers, so removing
     * one still leaves the count satisfied while that button becomes unclickable.
     *
     * A button carries `no-drag` either in its own attributes, just below the tag, or on a
     * wrapper just above it. Both are looked for, per button.
     */
    const lines = menuBar.split("\n");
    const NO_DRAG = /WebkitAppRegion: "no-drag"/;
    const stranded: number[] = [];

    lines.forEach((line, i) => {
      if (!line.includes("<button")) return;
      const own = lines.slice(i, i + 9);
      const wrapper = lines.slice(Math.max(0, i - 4), i);
      if (![...own, ...wrapper].some((l) => NO_DRAG.test(l))) stranded.push(i + 1);
    });

    expect(lines.some((l) => l.includes("<button"))).toBe(true);
    expect(stranded, `buttons on the drag surface at line(s) ${stranded.join(", ")}`).toEqual([]);
    expect(menuBar).toContain('WebkitAppRegion: "drag"');
  });

  it("asks the bell for the small size", () => {
    // Its default is `md` for the marketing header. Without this the title bar gets a 32px
    // bell beside 24px siblings, which is where this started.
    expect(menuBar).toContain('<NotificationBell size="sm" />');
  });

  it("draws the account from the set rather than inline", () => {
    expect(menuBar).toContain("<IconAccount");
    expect(menuBar).not.toMatch(/<svg[^>]*viewBox="0 0 16 16"[^>]*>\s*<circle cx="8" cy="5\.5"/);
  });
});

describe("the bell serves both bars", () => {
  const bell = read("components/Layout/NotificationBell.tsx");

  it("defaults to the large size, so the legal pages are untouched", () => {
    // `(legal)/layout.tsx` mounts TopNavigation, where 32px is correct. A default of `sm`
    // would shrink a surface nobody asked about.
    expect(bell).toMatch(/size = "md"/);
  });

  it("switches hover convention with size, not just box size", () => {
    // 24px with `bg-white/10` beside siblings using `bg-ide-raised` still reads as a foreign
    // control. Both halves have to move together.
    expect(bell).toContain("bg-ide-raised");
    expect(bell).toContain("bg-white/10");
  });

  it("scales the unread badge with the button", () => {
    // Found by zooming a screenshot rather than by reading the diff: the badge was sized for
    // the 32px button, so at 24px it covered most of the 16px glyph and read as an icon
    // rather than a count on one.
    expect(bell).toContain("h-3 min-w-[12px]");
    expect(bell).toContain("h-4 min-w-[16px]");
  });

  it("no longer defines its own bell", () => {
    expect(bell).not.toMatch(/function\s+IconBell\s*\(/);
    expect(bell).toMatch(/import \{[^}]*IconBell[^}]*\} from "@\/components\/icons"/);
  });
});

describe("the path moved out of the editor toolbar", () => {
  it("leaves no header above the editor", () => {
    // It contained the breadcrumbs and a comment about what had already moved out, so with no
    // file open it drew an empty 36px stripe the width of the workbench.
    const workspace = read("components/Build/BuildWorkspace.tsx");
    expect(workspace).not.toContain("<header");
    expect(workspace).not.toContain("Breadcrumbs");
  });

  it("renders it in the Explorer, below the bar rather than inside it", () => {
    const tree = read("components/Build/FileTree.tsx");
    expect(tree).toContain("<Breadcrumbs path={activePath} />");
    // `IdeBar` is h-9 and that height is load-bearing; the path gets its own shorter row.
    expect(tree).toMatch(/<div className="flex h-6[^"]*">\s*<Breadcrumbs/);
  });

  it("collapses the row when no file is open", () => {
    // Otherwise the empty stripe simply moved one column to the left.
    expect(read("components/Build/FileTree.tsx")).toContain("{activePath !== undefined && (");
  });
});
