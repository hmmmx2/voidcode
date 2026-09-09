/**
 * Collapsing the section list, and getting it back.
 *
 * The first version hid the list and kept the panel, which left a 240px empty column between
 * the rail and the editor — the space the gesture was asking for was still being held. So the
 * header now hides the whole panel, and that moves the "how do I undo this" problem somewhere
 * else: the control that collapsed it is gone with it.
 *
 * The answer is the rail icon for the destination you are already in. Which means two claims
 * have to hold together, and neither is worth much alone:
 *
 * - the header removes the panel rather than emptying it, and
 * - the rail toggles rather than re-navigating, but *only* where there is a list to toggle
 *   and only when you are already there.
 *
 * Rendered rather than source-matched. These are presentational components, so the markup is
 * observable, and an assertion about markup cannot pass because a comment mentions a prop.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown> & { href: string }) =>
    createElement("a", { href, ...rest }, children as never),
}));

const ActivityBar = (await import("../renderer/src/components/Shell/ActivityBar.js")).default;
const SectionSidebar = (await import("../renderer/src/components/Shell/SectionSidebar.js")).default;
const { DESTINATIONS } = await import("../renderer/src/lib/shell/destinations.js");

const prep = DESTINATIONS.find((d) => d.id === "prep")!;
const code = DESTINATIONS.find((d) => d.id === "code")!;

describe("the section header collapses the panel, not just the list", () => {
  const render = (onCollapse: () => void) =>
    renderToStaticMarkup(
      createElement(SectionSidebar, {
        destination: prep,
        pathname: "/problems",
        counts: { problems: 14 },
        onCollapse,
      })
    );

  it("calls back to the shell, which is what owns the width", () => {
    const collapse = vi.fn();
    render(collapse);
    // Rendering must not fire it; only a click may.
    expect(collapse).not.toHaveBeenCalled();
  });

  it("still renders the sections it is collapsing", () => {
    const html = render(() => {});
    for (const section of prep.sections) expect(html).toContain(section.label);
    expect(html).toContain("Interview Prep");
  });

  it("does not hide the list in place, which is the bug this replaced", () => {
    const html = render(() => {});
    // `hidden` on the nav was the old behaviour: list gone, 240px column still there. There
    // is no collapsed rendering any more — the panel is either shown or not mounted.
    expect(html).not.toMatch(/<nav[^>]*\shidden/);
  });

  it("claims no `aria-expanded`, because nothing is left to expand", () => {
    // A disclosure whose collapsed state removes the disclosure is not a disclosure. Saying
    // `aria-expanded="false"` would promise a control that is no longer on the page.
    expect(render(() => {})).not.toContain("aria-expanded");
  });

  it("says what the button does before it is pressed", () => {
    expect(render(() => {})).toContain("Hide Interview Prep");
  });
});

describe("the rail is the way back", () => {
  const render = (active: "prep" | "code" | null, sidebarOpen: boolean, onModelsRoute = false) =>
    renderToStaticMarkup(
      createElement(ActivityBar, {
        active,
        sidebarOpen,
        onSelect: () => {},
        onOpenSettings: () => {},
        onOpenModels: () => {},
        onModelsRoute,
      })
    );

  it("offers to show the sidebar when you are in the destination and it is hidden", () => {
    expect(render("prep", false)).toContain("Interview Prep — Show sidebar");
  });

  it("offers to hide it when it is showing", () => {
    expect(render("prep", true)).toContain("Interview Prep — Hide sidebar");
  });

  it("promises nothing for a destination you are not in", () => {
    // Clicking it navigates. A "Show sidebar" label there would describe the wrong action.
    const html = render("code", false);
    expect(html).toContain('title="Interview Prep"');
    expect(html).not.toContain("Interview Prep — ");
  });

  it("promises nothing for the IDE, which has no section list to toggle", () => {
    // Its left panel is the file tree, which the destination owns.
    expect(code.sections).toHaveLength(0);
    const html = render("code", true);
    expect(html).toContain('title="Code"');
    expect(html).not.toContain("Code — ");
  });

  it("promises nothing on an account route, where no destination is active", () => {
    const html = render(null, true);
    expect(html).not.toContain(" — Hide sidebar");
    expect(html).not.toContain(" — Show sidebar");
  });
});

/**
 * The shell half: which handler the rail is wired to.
 *
 * Source-read because it is a `useCallback` inside a component that mounts Monaco, the panel
 * provider and the command registry. Comments are stripped — the prose above these lines
 * names both handlers, and matching that would pass against the wrong wiring.
 */
describe("the rail and the Go menu are wired to different handlers", () => {
  const workbench = readFileSync(
    new URL("../renderer/src/components/Shell/Workbench.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("gives the rail the handler that can toggle", () => {
    expect(workbench).toMatch(/onSelect=\{selectFromRail\}/);
  });

  it("toggles only when you are already there and there is a list", () => {
    // Was `!onAccountRoute`. The guard generalised when `/models` arrived: `destination`
    // falls back to the IDE on any platform route, so without it clicking Code from either
    // /profile or /models would toggle a panel instead of navigating to the editor. The
    // claim is unchanged — it now covers both platform pages rather than one.
    expect(workbench).toMatch(/const alreadyHere = id === destination\.id && !onPlatformRoute/);
    expect(workbench).toMatch(/if \(alreadyHere && target\.sections\.length > 0\)/);
    expect(workbench).toMatch(/toggle\("left"\)/);
  });

  it("leaves the Go commands navigating only", () => {
    // `go.prep` hiding a panel because you were already there would be doing something its
    // label does not say.
    expect(workbench).toMatch(/\{ id: "go\.prep", run: \(\) => goToDestination\("prep"\) \}/);
    expect(workbench).toMatch(/\{ id: "go\.code", run: \(\) => goToDestination\("code"\) \}/);
  });

  it("hands the sidebar a collapse that closes the panel", () => {
    expect(workbench).toMatch(/onCollapse=\{\(\) => setPanel\("left", false\)\}/);
  });
});

/**
 * The platform buttons at the foot of the rail.
 *
 * Models is the second of its kind, after the settings gear. Neither is a `DestinationId` —
 * that union is closed at two members and `PanelsProvider`, `ActivityBar` and
 * `destinationForPath` are all built on it — so they are passed as their own handlers rather
 * than joining `DESTINATIONS`.
 */
describe("the rail's platform buttons", () => {
  const render = (onModelsRoute: boolean) =>
    renderToStaticMarkup(
      createElement(ActivityBar, {
        active: "code" as const,
        sidebarOpen: true,
        onSelect: () => {},
        onOpenSettings: () => {},
        onOpenModels: () => {},
        onModelsRoute,
      })
    );

  it("offers Models and Settings", () => {
    const html = render(false);
    expect(html).toContain('title="Models"');
    expect(html).toContain('title="Settings"');
  });

  /** The markup for the Models button alone, so a sibling's attributes cannot satisfy a check. */
  const modelsButton = (html: string): string => {
    const at = html.indexOf('title="Models"');
    expect(at, "Models button missing").toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
  };

  it("marks Models as current when you are on it", () => {
    // Unlike the gear, this rail item has a route you can be on — so it takes the same 2px
    // rule the destinations use rather than being permanently unlit.
    expect(modelsButton(render(true))).toContain('aria-current="page"');
  });

  it("leaves it unmarked elsewhere", () => {
    expect(modelsButton(render(false))).not.toContain('aria-current="page"');
  });

  it("does not make Models a destination", () => {
    // The whole reason it is a separate prop. A third DestinationId would give it panel state,
    // a section sidebar and a place in the Go menu's destination group, none of which it wants.
    expect(DESTINATIONS.map((d) => d.id)).toEqual(["code", "prep"]);
  });
});
