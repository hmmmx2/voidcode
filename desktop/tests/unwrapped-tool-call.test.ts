/**
 * A model that tried to call a tool and got the format wrong.
 *
 * Not hypothetical: `qwen2.5-coder:7b`, the Build panel's own default, does exactly this.
 * Ollama's template tells it to wrap calls in `<tool_call></tool_call>` and parses those tags
 * back out; the model emits the JSON without them, so `tool_calls` is never populated and the
 * turn is indistinguishable from one where the model chose to answer in prose.
 *
 * The detector has to be narrow in one specific direction: a model *discussing* a tool must
 * stay prose. Firing on "you could use read_file here" would replace a silent failure with a
 * noisy false one, which is not an improvement.
 */
import { describe, it, expect } from "vitest";
import {
  looksLikeUnwrappedToolCall,
  unwrappedToolCallMessage,
} from "../src/main/agent/unwrapped.js";

const TOOLS = ["read_file", "search_project", "propose_edit"];

describe("detecting an unwrapped call", () => {
  it("catches the exact output qwen2.5-coder produces", () => {
    // Copied from a live run against Ollama 0.17.1.
    const text = '{\n  "name": "read_file",\n  "arguments": {\n    "path": "hello.ts"\n  }\n}';
    expect(looksLikeUnwrappedToolCall(text, TOOLS)).toBe("read_file");
  });

  it("catches the fenced spelling of the same mistake", () => {
    const text = '```json\n{"name": "search_project", "arguments": {"query": "x"}}\n```';
    expect(looksLikeUnwrappedToolCall(text, TOOLS)).toBe("search_project");
  });

  it("catches a fenced call followed by prose, which is what actually happens", () => {
    /**
     * Captured verbatim from a live turn: qwen2.5-coder:7b on Ollama 0.17.1, asked to read a
     * file. It emits the call fenced, and then asks the *user* to go and read the file for it.
     *
     * The first version of this detector required the whole reply to be the object, so it
     * passed its own tests while missing the only shape that had ever actually occurred. The
     * live run is what caught that, not the unit tests.
     */
    const text = [
      "```json",
      "{",
      '  "name": "read_file",',
      '  "arguments": {',
      '    "path": "src/hello.ts"',
      "  }",
      "}",
      "```",
      "",
      "Please read `src/hello.ts` and provide its contents so I can help you.",
    ].join("\n");
    expect(looksLikeUnwrappedToolCall(text, TOOLS)).toBe("read_file");
  });

  it("catches a call announced in prose first, which is what llama3.1 does", () => {
    /**
     * Captured verbatim from a live turn: llama3.1:8b, which emits a *proper* tool call when
     * asked the same question without the assistant persona in front of it. With the persona —
     * which used to instruct a fenced-block convention — it explains itself and then fences the
     * call instead.
     *
     * This is the second widening the detector needed, and like the first it came from a live
     * run rather than from imagining shapes.
     */
    const text = [
      "To answer the question, I will call the `read_file` function with the proper arguments.",
      "",
      "Now, calling the `read_file` function:",
      "",
      "```",
      '{"name": "read_file", "parameters": {"path": "/hello.ts"}}',
      "```",
      "",
      "Once we have the contents, we can inspect them.",
    ].join("\n");
    expect(looksLikeUnwrappedToolCall(text, TOOLS)).toBe("read_file");
  });

  it("finds the call in a later block when the first fence is ordinary code", () => {
    const text = ["```ts", "const x = 1;", "```", "", "```json", '{"name":"read_file","arguments":{"path":"a.ts"}}', "```"].join("\n");
    expect(looksLikeUnwrappedToolCall(text, TOOLS)).toBe("read_file");
  });

  it("accepts `parameters` as well as `arguments`", () => {
    expect(
      looksLikeUnwrappedToolCall('{"name":"read_file","parameters":{"path":"a.ts"}}', TOOLS)
    ).toBe("read_file");
  });
});

describe("staying quiet", () => {
  it("ignores prose that merely mentions a tool", () => {
    // The false positive that would make this worse than the bug it detects.
    expect(
      looksLikeUnwrappedToolCall("You could use read_file here to check the contents.", TOOLS)
    ).toBeNull();
  });

  it("ignores JSON embedded in a sentence", () => {
    expect(
      looksLikeUnwrappedToolCall(
        'Call it like {"name": "read_file", "arguments": {}} when you need to.',
        TOOLS
      )
    ).toBeNull();
  });

  it("ignores a tool name the model was never offered", () => {
    // A model returning structured output is legitimate; only a *declared* tool name is
    // evidence that a call was attempted.
    expect(
      looksLikeUnwrappedToolCall('{"name":"rm_rf","arguments":{"path":"/"}}', TOOLS)
    ).toBeNull();
  });

  it("ignores an ordinary JSON answer with no tool name", () => {
    expect(looksLikeUnwrappedToolCall('{"answer": 42}', TOOLS)).toBeNull();
  });

  it("ignores an object with a name but no arguments at all", () => {
    expect(looksLikeUnwrappedToolCall('{"name":"read_file"}', TOOLS)).toBeNull();
  });

  it("says nothing when no tools were offered", () => {
    // The tutor surface. Nothing was callable, so nothing can have been a botched call.
    expect(
      looksLikeUnwrappedToolCall('{"name":"read_file","arguments":{"path":"a"}}', [])
    ).toBeNull();
  });

  it("survives empty and malformed input", () => {
    expect(looksLikeUnwrappedToolCall("", TOOLS)).toBeNull();
    expect(looksLikeUnwrappedToolCall("{not json", TOOLS)).toBeNull();
    expect(looksLikeUnwrappedToolCall("[1,2,3]", TOOLS)).toBeNull();
  });
});

describe("the message", () => {
  it("names the model and the tool, and says what to do next", () => {
    const message = unwrappedToolCallMessage("qwen2.5-coder:7b", "read_file");
    expect(message).toContain("qwen2.5-coder:7b");
    expect(message).toContain("read_file");
    // "unsupported" with no next step is a dead end; the model is the thing to change.
    expect(message).toMatch(/llama3\.1|qwen3/);
  });
});
