/**
 * The centre pane renders both of its children, always.
 *
 * THE PROPERTY, AND WHY IT IS WORTH A SOURCE TEST. The pane is a tab strip over `AssistantPanel`
 * and `EditorPane`, switched with `hidden`. Writing it as a ternary instead — which is what
 * anyone would reach for, and what Radix `TabsContent` does for you — unmounts the child you are
 * not looking at, and both children are expensive to unmount in a way that is invisible until it
 * happens to you:
 *
 *   - `AssistantPanel` holds the transcript, the streaming cancel handle and the session id in
 *     component state. Unmounting mid-answer loses the answer.
 *   - `EditorPane` holds the Monaco instance. Unmounting disposes it and every buffer's undo
 *     stack, so switching to Chat and back forgets everything you did.
 *
 * `BottomDock` documents the same rule for terminals — there, unmounting a pane kills a shell —
 * and this is that rule one level up, so it is asserted rather than left to a comment.
 *
 * A SOURCE SCAN, because the alternative is a DOM. This suite has no jsdom and
 * `renderToStaticMarkup` runs no effects, so "is the assistant still mounted after a tab click"
 * is not observable here. What is observable is the shape of the JSX, and the shape is the bug:
 * a ternary is the mistake, `hidden` is the fix.
 *
 * COMMENTS ARE STRIPPED FIRST AND THE SCAN IS SCOPED. This repository has been caught more than
 * once by a guard matching the prose that explains it — including twice in this plan's own
 * commits. The comments in `BuildWorkspace` discuss both `hidden` and the ternary it rules out.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const BUILD_WORKSPACE = path.resolve(
  __dirname,
  "..",
  "renderer",
  "src",
  "components",
  "Build",
  "BuildWorkspace.tsx"
);

/** Block and line comments out; JSX braces and strings left alone. */
function code(): string {
  return readFileSync(BUILD_WORKSPACE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Just the `pane === "chat"` arm.
 *
 * Scoped by bracket counting from the arm's own condition to the start of the next arm, so the
 * assertions cannot be satisfied — or broken — by the left pane, the dock or the workspace
 * surface, all of which are rendered from the same `renderPane` callback.
 */
function chatArm(): string {
  const source = code();
  const start = source.indexOf('pane === "chat" ? (');
  expect(start, "the chat arm is gone from renderPane").toBeGreaterThan(-1);
  const end = source.indexOf('pane === "dock" ? (', start);
  expect(end, "the dock arm no longer follows the chat arm").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the chat pane", () => {
  it("renders the assistant and the editor together, switched by `hidden`", () => {
    const arm = chatArm();

    expect(arm, "AssistantPanel is not rendered in the chat pane").toContain("<AssistantPanel");
    expect(arm, "EditorPane is not rendered in the chat pane").toContain("<EditorPane");

    /**
     * Two `hidden` attributes, one per child. Counted rather than merely found: one `hidden` and
     * one conditional would pass a "contains hidden" check while still unmounting a child.
     */
    const hidden = arm.match(/hidden=\{/g) ?? [];
    expect(
      hidden.length,
      "each of the two children needs its own `hidden`; a child rendered conditionally is a " +
        "child that gets unmounted, losing the transcript or the undo stack"
    ).toBeGreaterThanOrEqual(2);

    /**
     * And neither child is behind a condition. `{x ? <AssistantPanel .../> : <EditorPane .../>}`
     * is the exact mutation this test exists for, and it contains both tags — so the check has to
     * be that no `?` or `&&` stands between the arm's opening and either tag.
     */
    for (const tag of ["<AssistantPanel", "<EditorPane"]) {
      const before = arm.slice(0, arm.indexOf(tag));
      const guard = /(\?|&&)\s*(\(\s*)?<\s*$/.test(before);
      expect(guard, `${tag} is rendered conditionally rather than hidden`).toBe(false);
    }
  });

  it("still passes no onClose, because the centre can never be collapsed", () => {
    /**
     * `applyVisibility` in `workspace-layout.ts` never collapses the chat pane, and `IdePanel`'s
     * close button renders only when `onClose` is passed. A close button that cannot close
     * anything is worse than none, and its accelerator would toggle a flag nothing reads.
     */
    expect(chatArm()).not.toContain("onClose={() => setPanel(");
  });

  it("gives the editor a `visible` prop, so monaco can be told to measure itself", () => {
    /**
     * Monaco measures on mount, and a mount inside a `display:none` subtree measures zero.
     * `automaticLayout` recovers via a ResizeObserver, but only after the browser delivers a
     * resize — so the first frame after a tab switch can be a blank editor. `TerminalPanel` takes
     * an `active` prop for the same reason.
     */
    expect(chatArm()).toMatch(/visible=\{/);
  });
});

describe("the strip itself", () => {
  it("is driven by the open buffers rather than a second list of paths", () => {
    /**
     * `files` is the tab strip. `renameEntry` and `reconcile` already rewrite paths there, and a
     * parallel array of open paths would be a second place to remember to do that — which is how
     * a tab ends up pointing at a name that no longer exists.
     */
    const source = code();
    expect(source).toMatch(/const openPaths = useMemo\(\(\) => files\.map/);
    expect(chatArm()).toContain("paths={openPaths}");
  });
});
