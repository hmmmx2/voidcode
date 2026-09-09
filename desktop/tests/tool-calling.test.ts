/**
 * Reassembling streamed tool calls.
 *
 * The fragment sequences here are the shape a real OpenAI-compatible server produces, written
 * out longhand rather than generated, because the whole point is that the pieces are wrong
 * individually: `id` and `name` appear once, `arguments` is partial JSON that is invalid at
 * every intermediate step, and parallel calls interleave under an `index`.
 *
 * Getting this wrong does not throw. It produces a turn where the model asked for a tool and
 * nothing ran — "the agent occasionally does nothing", which is the hardest bug shape to chase
 * because there is no error and no log line, only an absence.
 */
import { describe, it, expect } from "vitest";
import {
  ToolCallAccumulator,
  fromOllamaToolCalls,
  toWireTools,
} from "../src/main/inference/tools.js";

/** How a server actually streams `read_file({"path": "a.py"})`. */
const ONE_CALL = [
  { index: 0, id: "call_abc", function: { name: "read_file", arguments: "" } },
  { index: 0, function: { arguments: '{"pa' } },
  { index: 0, function: { arguments: 'th": "' } },
  { index: 0, function: { arguments: 'a.py"}' } },
];

describe("reassembling one call", () => {
  it("joins the fragments into a complete call", () => {
    const acc = new ToolCallAccumulator();
    for (const delta of ONE_CALL) acc.push(delta);

    expect(acc.flush()).toEqual([
      { id: "call_abc", name: "read_file", argumentsJson: '{"path": "a.py"}' },
    ]);
  });

  it("keeps the id and name that only ever arrive once", () => {
    // Every fragment after the first omits both. A naive last-wins merge loses them.
    const acc = new ToolCallAccumulator();
    for (const delta of ONE_CALL) acc.push(delta);

    const [call] = acc.flush();
    expect(call?.id).toBe("call_abc");
    expect(call?.name).toBe("read_file");
  });

  it("emits nothing before the turn ends", () => {
    // Every intermediate state is invalid JSON by construction, so there is nothing that
    // could be emitted early that a dispatcher could use.
    const acc = new ToolCallAccumulator();
    acc.push(ONE_CALL[0]!);
    acc.push(ONE_CALL[1]!);

    expect(acc.pending).toBe(true);
    expect(acc.flush()[0]?.argumentsJson).toBe('{"pa');
  });
});

describe("parallel calls", () => {
  it("keeps interleaved fragments apart by index", () => {
    // Two tools requested at once, arriving mixed. Merging them produces one call with
    // garbage arguments and silently drops the other.
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p' } });
    acc.push({ index: 1, id: "b", function: { name: "search", arguments: '{"q' } });
    acc.push({ index: 0, function: { arguments: '":1}' } });
    acc.push({ index: 1, function: { arguments: '":2}' } });

    expect(acc.flush()).toEqual([
      { id: "a", name: "read_file", argumentsJson: '{"p":1}' },
      { id: "b", name: "search", argumentsJson: '{"q":2}' },
    ]);
  });

  it("returns them in index order regardless of arrival order", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 2, id: "c", function: { name: "third" } });
    acc.push({ index: 0, id: "a", function: { name: "first" } });
    acc.push({ index: 1, id: "b", function: { name: "second" } });

    expect(acc.flush().map((c) => c.name)).toEqual(["first", "second", "third"]);
  });
});

describe("shapes servers actually send", () => {
  it("handles a call with no index at all", () => {
    // Some servers omit it for a single call. Dropping the fragment is the difference
    // between working and doing nothing.
    const acc = new ToolCallAccumulator();
    acc.push({ id: "x", function: { name: "read_file", arguments: "{}" } });

    expect(acc.flush()).toHaveLength(1);
  });

  it("mints an id when the server does not supply one", () => {
    // The id is what a `tool` turn quotes back; an OpenAI-compatible server rejects the
    // follow-up request outright without it.
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, function: { name: "read_file", arguments: "{}" } });

    expect(acc.flush()[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("substitutes empty arguments rather than an empty string", () => {
    // `{}` parses and then fails schema validation, which the dispatcher turns into a
    // message the model can correct. An empty string fails to parse, which is a worse error
    // to hand back.
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "x", function: { name: "list_files" } });

    expect(acc.flush()[0]?.argumentsJson).toBe("{}");
  });

  it("drops a fragment set that never got a name", () => {
    // It cannot be dispatched, and inventing a name would turn a provider glitch into the
    // wrong tool being run.
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, function: { arguments: '{"path":"a"}' } });

    expect(acc.flush()).toEqual([]);
  });

  it("is empty and quiet for a turn with no tools", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.pending).toBe(false);
    expect(acc.flush()).toEqual([]);
  });

  it("resets after a flush", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "x", function: { name: "a", arguments: "{}" } });
    acc.flush();

    expect(acc.pending).toBe(false);
    expect(acc.flush()).toEqual([]);
  });
});

describe("Ollama's shape", () => {
  it("normalises an object-valued arguments field to the same result", () => {
    // The one difference that matters: Ollama sends `arguments` as an object, the OpenAI
    // path as a string. Both have to reach the dispatcher as raw text it parses itself.
    const calls = fromOllamaToolCalls([
      { function: { name: "read_file", arguments: { path: "a.py" } } },
    ]);

    expect(calls[0]?.name).toBe("read_file");
    expect(JSON.parse(calls[0]!.argumentsJson)).toEqual({ path: "a.py" });
  });

  it("mints an id, because Ollama does not send one", () => {
    const [call] = fromOllamaToolCalls([{ function: { name: "x", arguments: {} } }]);
    expect(call?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes a string through unchanged", () => {
    const [call] = fromOllamaToolCalls([{ function: { name: "x", arguments: '{"a":1}' } }]);
    expect(call?.argumentsJson).toBe('{"a":1}');
  });

  it("drops a nameless call", () => {
    expect(fromOllamaToolCalls([{ function: { arguments: {} } }])).toEqual([]);
  });

  it("treats missing arguments as an empty object", () => {
    const [call] = fromOllamaToolCalls([{ function: { name: "x" } }]);
    expect(call?.argumentsJson).toBe("{}");
  });
});

describe("declaring tools", () => {
  it("wraps them in the envelope both providers agree on", () => {
    const wire = toWireTools([
      { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    ]);

    expect(wire).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
      },
    ]);
  });
});
