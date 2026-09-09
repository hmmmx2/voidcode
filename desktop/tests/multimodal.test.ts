/**
 * Content blocks, and the two provider shapes they become.
 *
 * The most important test in this file is the least interesting one: **a bare string passes
 * through unchanged**. That is what makes the union a migration lever rather than a breaking
 * change wearing a compatible-looking type, and it is why `tests/inference.test.ts` needed no
 * edits at all.
 *
 * The rest is about the two providers disagreeing in ways that are easy to get right once and
 * then fix in only one place later — which is exactly why the conversion lives in one file
 * rather than inline in each.
 */
import { describe, it, expect } from "vitest";
import { toOllamaMessages, toOpenAIMessages, flattenText } from "../src/main/inference/normalise.js";
import { matchesMediaType, assertImagesMatch, ImageMismatchError } from "../src/main/inference/images.js";
import type { ChatMessage } from "../src/main/inference/types.js";

/** Real signatures, so the checks are exercised rather than mocked around. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString("base64");
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]).toString("base64");

describe("the string path is untouched", () => {
  it("passes a plain string straight to Ollama", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    expect(toOllamaMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("passes a plain string straight to an OpenAI-compatible server", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    expect(toOpenAIMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("adds no images key when there are none", () => {
    // An empty `images: []` is not the same as absent to every server, and sending one on
    // every text turn would be a change to requests that used to work.
    const [message] = toOllamaMessages([{ role: "user", content: "hi" }]);
    expect("images" in (message as object)).toBe(false);
  });
});

describe("images, Ollama's way", () => {
  it("hoists them to the message level as bare base64", () => {
    // Ollama has no content parts: images go beside `content`, not inside it.
    const [message] = toOllamaMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is wrong here?" },
          { type: "image", data: PNG, mediaType: "image/png" },
        ],
      },
    ]);

    expect(message).toEqual({
      role: "user",
      content: "what is wrong here?",
      images: [PNG],
    });
  });

  it("sends no data: prefix", () => {
    // Bare base64 is what Ollama wants, and it is the shorter form to store — the OpenAI
    // path builds its URL from this rather than the other way round.
    const [message] = toOllamaMessages([
      { role: "user", content: [{ type: "image", data: PNG, mediaType: "image/png" }] },
    ]);
    expect(message?.images?.[0]).not.toContain("data:");
  });
});

describe("images, the OpenAI-compatible way", () => {
  it("becomes content parts with a data: URL", () => {
    const [message] = toOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: PNG, mediaType: "image/png" },
        ],
      },
    ]);

    expect(message?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
  });

  it("ALWAYS flattens a system turn to a plain string", () => {
    // Several servers that accept content parts on a user turn reject them on a system turn,
    // and the failure is a 400 on the whole request rather than a degraded reply.
    const [message] = toOpenAIMessages([
      { role: "system", content: [{ type: "text", text: "you are a tutor" }] },
    ]);

    expect(message?.content).toBe("you are a tutor");
  });

  it("always flattens a tool turn too", () => {
    const [message] = toOpenAIMessages([
      { role: "tool", toolCallId: "call_1", name: "read_file", content: [{ type: "text", text: "x = 1" }] },
    ]);

    expect(message).toEqual({
      role: "tool",
      content: "x = 1",
      tool_call_id: "call_1",
      name: "read_file",
    });
  });
});

describe("tool turns", () => {
  it("carries the arguments as the raw string the model produced", () => {
    const [message] = toOpenAIMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.py"}' }],
      },
    ]);

    expect(message?.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.py"}' } },
    ]);
  });

  it("converts back to an object for Ollama, which expects one", () => {
    const [message] = toOllamaMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.py"}' }],
      },
    ]);

    expect(message?.tool_calls).toEqual([
      { function: { name: "read_file", arguments: { path: "a.py" } } },
    ]);
  });

  it("survives arguments the model malformed", () => {
    // The model's own bad output must not fail the request that carries it back.
    const [message] = toOllamaMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "x", argumentsJson: "{oops" }] },
    ]);

    expect(message?.tool_calls?.[0]?.function.arguments).toEqual({});
  });
});

describe("flattening", () => {
  it("joins multiple text blocks and drops images", () => {
    expect(
      flattenText([
        { type: "text", text: "one" },
        { type: "image", data: PNG, mediaType: "image/png" },
        { type: "text", text: "two" },
      ])
    ).toBe("one\ntwo");
  });
});

describe("the declared type has to match the bytes", () => {
  it("accepts each real signature", () => {
    expect(matchesMediaType(PNG, "image/png")).toBe(true);
    expect(matchesMediaType(JPEG, "image/jpeg")).toBe(true);
    expect(matchesMediaType(WEBP, "image/webp")).toBe(true);
  });

  it("rejects a lie about the type", () => {
    // Without this a renderer can label anything `image/png` and every layer downstream
    // believes the label.
    expect(matchesMediaType(JPEG, "image/png")).toBe(false);
    expect(matchesMediaType(PNG, "image/webp")).toBe(false);
  });

  it("rejects something that is not an image at all", () => {
    expect(matchesMediaType(Buffer.from("#!/bin/sh\nrm -rf /").toString("base64"), "image/png")).toBe(
      false
    );
  });

  it("rejects data too short to have a signature", () => {
    expect(matchesMediaType(Buffer.from([0x89, 0x50]).toString("base64"), "image/png")).toBe(false);
  });

  it("checks WEBP's fourcc, not just the RIFF header", () => {
    // A RIFF container can hold a WAV just as easily.
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]).toString(
      "base64"
    );
    expect(matchesMediaType(wav, "image/webp")).toBe(false);
  });

  it("throws on a mismatched block and passes a good one", () => {
    expect(() =>
      assertImagesMatch([{ type: "image", data: JPEG, mediaType: "image/png" }])
    ).toThrow(ImageMismatchError);

    expect(() =>
      assertImagesMatch([
        { type: "text", text: "fine" },
        { type: "image", data: PNG, mediaType: "image/png" },
      ])
    ).not.toThrow();
  });

  it("ignores a plain string, which has no images to check", () => {
    expect(() => assertImagesMatch("hello")).not.toThrow();
  });
});
