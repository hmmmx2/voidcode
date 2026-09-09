/**
 * The assistant's header, which used to be able to show two drawers at once.
 *
 * `showSessions` and `showHistory` were independent booleans. Both drawers are `max-h-48` and
 * both sit above the transcript, so opening both cost 24rem of a panel that is often 300px
 * wide and left the conversation in a slot. Nothing prevented it.
 *
 * The code already knew it was wrong: `openSession` and `openRun` each called
 * `setShowHistory(false)` on their way out — exclusivity hand-written at two of the several
 * places that needed it, which is the shape a missing state machine leaves behind.
 *
 * The reducer is tested directly rather than through the panel: `AssistantPanel.tsx` is 1200
 * lines of streaming, attachments and diff review, and mounting it to assert which drawer is
 * open would test everything except the thing in question.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  canShow,
  selectView,
  selectViewSafely,
  type AssistantView,
} from "../renderer/src/lib/build/assistant-view.js";

const VIEWS: AssistantView[] = ["chat", "sessions", "history"];

describe("one view at a time", () => {
  it("never leaves both drawers showing, down every three-click path", () => {
    /**
     * THE property — asserted on the derived booleans the panel actually renders from, not on
     * the union member, because `expect(VIEWS).toContain(view)` is true of any function with
     * this return type and would pass against anything.
     *
     * What makes it hold is the type rather than the reducer: one value cannot equal two
     * things. So this is the statement of intent, and the source assertion below — that the
     * panel derives both booleans from `view` — is what actually catches a regression.
     */
    for (const a of VIEWS) {
      for (const b of VIEWS) {
        for (const c of VIEWS) {
          let view: AssistantView = "chat";
          for (const click of [a, b, c]) view = selectViewSafely(view, click, true);

          const showSessions = view === "sessions";
          const showHistory = view === "history";
          expect(
            showSessions && showHistory,
            `both drawers open after ${a} → ${b} → ${c}`
          ).toBe(false);
        }
      }
    }
  });

  it("selects the view you clicked", () => {
    expect(selectView("chat", "sessions")).toBe("sessions");
    expect(selectView("chat", "history")).toBe("history");
    expect(selectView("sessions", "history")).toBe("history");
  });

  it("returns to the conversation when you click the view you are on", () => {
    // What "Hide chats" used to promise. Without it the only way out of a drawer would be to
    // open the other one.
    expect(selectView("sessions", "sessions")).toBe("chat");
    expect(selectView("history", "history")).toBe("chat");
  });

  it("switching drawers replaces rather than adds", () => {
    // The old behaviour: clicking History while Chats was open left both showing.
    expect(selectView("sessions", "history")).toBe("history");
    expect(selectView("history", "sessions")).toBe("sessions");
  });
});

describe("history needs an agent", () => {
  it("is unreachable without one", () => {
    // The button is already hidden behind `host.agent !== undefined`. Encoding it in the state
    // too means no other path — a restore, a keyboard route — can open a drawer whose trigger
    // is not on screen and therefore cannot be closed.
    expect(canShow("history", false)).toBe(false);
    expect(selectViewSafely("chat", "history", false)).toBe("chat");
  });

  it("leaves the other views alone", () => {
    expect(canShow("chat", false)).toBe(true);
    expect(canShow("sessions", false)).toBe(true);
    expect(selectViewSafely("chat", "sessions", false)).toBe("sessions");
  });

  it("still toggles back out of sessions with no agent", () => {
    expect(selectViewSafely("sessions", "sessions", false)).toBe("chat");
  });
});

/**
 * The panel half, source-read: 1200 lines with an IPC host, a stream and a Monaco-adjacent
 * editor make mounting it a poor way to ask what its header says.
 */
describe("the header the panel renders", () => {
  const panel = readFileSync(
    new URL("../renderer/src/components/Build/AssistantPanel.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("says AI Assistant", () => {
    expect(panel).toContain("AI Assistant");
  });

  it("derives both drawers from one value", () => {
    // The mutation: reinstating `useState(false)` for either one restores the both-open state.
    expect(panel).toMatch(/const showSessions = view === "sessions"/);
    expect(panel).toMatch(/const showHistory = view === "history"/);

    /**
     * The setters must not exist at all.
     *
     * This used to look for `useState(false)` *before* `setShowSessions`, which is the wrong way
     * round: the regression is written `const [showSessions, setShowSessions] = useState(false)`,
     * where the setter comes first. The guard could not fire, and a mutation reinstating the
     * boolean sailed through a green suite. Banning the identifiers cannot be written backwards.
     */
    expect(panel).not.toMatch(/setShowSessions/);
    expect(panel).not.toMatch(/setShowHistory/);
  });

  it("uses aria-pressed rather than aria-expanded for the nav", () => {
    // They select a surface now; they do not expand a region that stays put.
    expect(panel).toContain("aria-pressed={active}");
    expect(panel).not.toMatch(/aria-expanded=\{showSessions\}/);
    expect(panel).not.toMatch(/aria-expanded=\{showHistory\}/);
  });

  it("routes the model to the manager instead of opening a third drawer", () => {
    expect(panel).toMatch(/onClick=\{\(\) => router\.push\("\/models"\)\}/);
  });

  it("keeps the substitution explanation on the model control", () => {
    // When main swaps in a tool-capable model, this sentence is the only account of it the
    // user ever sees. It survived the button becoming a link.
    expect(panel).toContain("cannot call tools, so ");
  });

  it("gives the nav items icons", () => {
    expect(panel).toContain("<IconChat");
    expect(panel).toContain("<IconHistory");
    expect(panel).toContain("<IconModel");
  });
});
