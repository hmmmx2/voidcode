import { DEMO_SCAFFOLD, DEMO_SCAFFOLD_ANCHOR } from "./demo-content";

/**
 * The scripted tutor.
 *
 * Same pattern the reference site uses: an ordered table of beats, each with a
 * regex, resolved by `beats.find(b => b.match.test(input))`. The editor is real
 * and its buffer really is mutated; only the model behind the chat is canned.
 *
 * Two things are deliberate here.
 *
 * The prompt chips are the primary interaction and free typing is the fallback,
 * not the other way round. A regex miss in the hero is expensive, and three
 * chips convert far better than an input box that half-works.
 *
 * The fallback beat sells rather than apologises. "I can't do that" is a dead
 * end; naming what the real tutor reads that this preview cannot is a reason to
 * sign in.
 */

/** Mirrors the union in `VoidCodeAIPanel.tsx` — kept in sync by hand. */
export type TutorMode = "TEACHING" | "DEBUG" | "FOLLOWUP" | "EXPLAIN" | "GENERAL";

export type DemoStep =
  | { kind: "mode"; mode: TutorMode }
  | { kind: "think"; text: string; tokens: number; ms: number }
  | { kind: "say"; text: string; cps?: number }
  | { kind: "editor"; op: "insertAfter"; anchor: string; text: string }
  | { kind: "tests"; ms: number }
  | { kind: "pause"; ms: number };

export type DemoBeat = {
  id: string;
  /** Shown as a clickable chip, and echoed as the user's message. */
  chip: string;
  /** Matches free-typed input against this beat. */
  match: RegExp;
  steps: DemoStep[];
};

export const DEMO_BEATS: DemoBeat[] = [
  {
    id: "refuse",
    chip: "Just give me the answer.",
    match: /answer|solution|just (write|do|show)|solve it|give me the code/i,
    steps: [
      { kind: "mode", mode: "TEACHING" },
      {
        kind: "think",
        tokens: 214,
        ms: 1500,
        text:
          "Direct request for the solution. Handing it over removes the learning event entirely — " +
          "and this is a derivation question, so a pasted answer is worth nothing at a whiteboard. " +
          "Find the sub-goal they are actually stuck on and ask exactly one question about it. " +
          "Start with the scale factor: it has a why, so it is the one that teaches.",
      },
      {
        kind: "say",
        cps: 58,
        text:
          "I'm not writing this one for you. Attention is the thing you get asked to derive at a whiteboard, and a pasted answer is gone by Thursday.\n\nThree questions and you'll have it.\n\nFirst: as `d_k` grows, what happens to the magnitude of the entries in `Q @ K.T`? And what does softmax do when its inputs get large?",
      },
    ],
  },
  {
    id: "scale",
    chip: "The dot products get bigger?",
    match: /big|larg|grow|variance|saturat|d_?k|sqrt|scale|peak|sharp/i,
    steps: [
      { kind: "mode", mode: "TEACHING" },
      {
        kind: "think",
        tokens: 186,
        ms: 1200,
        text:
          "They have the intuition but not the factor. Give them the variance argument — that is the " +
          "part worth remembering — then stop before the division. Scaffold the editor with the " +
          "questions in comment form so the structure is there and the answer is not.",
      },
      {
        kind: "say",
        cps: 60,
        text:
          // One `d_k` per message, deliberately. `ChatMessage`'s hand-rolled
          // markdown renderer treats a second underscore on the same line as a
          // closing italic marker, so two of these collapse into "dk".
          "Right. The dot product is a sum over `d_k` terms, so its variance grows with the key dimension. Softmax saturates, one weight goes to ~1, and the gradient through it goes to ~0.\n\nSo the question is: what do you divide by to hold that variance back at 1?\n\nI've put the scaffold in your editor. I'm not filling it in.",
      },
      {
        kind: "editor",
        op: "insertAfter",
        anchor: DEMO_SCAFFOLD_ANCHOR,
        text: DEMO_SCAFFOLD,
      },
    ],
  },
  {
    id: "debug",
    chip: "My rows don't sum to 1.",
    match: /sum|row|axis|dim|fail|wrong|test|not work|broke|error/i,
    steps: [
      { kind: "mode", mode: "DEBUG" },
      { kind: "tests", ms: 900 },
      {
        kind: "think",
        tokens: 331,
        ms: 1700,
        text:
          "Shape test passes, mask test passes, distribution test fails. So the maths is right and the " +
          "reduction axis is wrong — softmax is on dim=-2 where it should be dim=-1. Do not name the " +
          "axis. Give them a one-line experiment that makes the wrong axis visible, because they will " +
          "hit this exact bug again in multi-head and need to recognise it themselves.",
      },
      {
        kind: "say",
        cps: 60,
        text:
          "Line 11. You're normalising **across queries**, not across keys — so every query's weights are competing with the *other queries*, which isn't what attention means.\n\nFor one query, which axis holds the scores it has to distribute over?\n\nDon't take my word for it. Print both and see which comes back all ones:\n\n```python\nattn.sum(-1)\nattn.sum(-2)\n```",
      },
    ],
  },
];

export const DEMO_FALLBACK: DemoStep[] = [
  { kind: "mode", mode: "GENERAL" },
  { kind: "pause", ms: 600 },
  {
    kind: "say",
    cps: 62,
    text:
      "That one I'd need your actual buffer for.\n\nThis is a scripted preview — three canned exchanges. The real tutor reads your editor as you type, your last submission, and every question you've asked before, then picks a mode from that.\n\nIt still won't give you the answer.",
  },
];

/** Beat lookup for free-typed input, in declaration order. */
export function matchBeat(input: string): DemoBeat | undefined {
  return DEMO_BEATS.find((beat) => beat.match.test(input));
}
