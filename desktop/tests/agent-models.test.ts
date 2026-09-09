/**
 * Choosing a model that can actually call a tool.
 *
 * The case that produced this file: the Build panel hardcoded `qwen2.5-coder:7b`, Ollama
 * reported `tools` for it, and it never emitted a single call — it writes the JSON without the
 * `<tool_call>` tags its own template asks for, so the daemon parses nothing. Neither the
 * provider's capability flag nor the daemon's said anything useful. The model name did.
 *
 * So this mirrors `pickFimModel`, which is an allowlist for exactly the same reason: a model
 * without the training "will happily accept the sentinels and produce prose".
 */
import { describe, it, expect } from "vitest";
import { pickAgentModel, isToolCapable, noToolModelMessage } from "../src/main/agent/models.js";

describe("which models can call tools", () => {
  it("accepts the families that emit the tags", () => {
    for (const id of ["llama3.1:8b", "qwen3:8b", "mistral-nemo:12b", "command-r:35b"]) {
      expect(isToolCapable(id)).toBe(true);
    }
  });

  it("refuses the model that started all this", () => {
    // Verified against a live Ollama 0.17.1: emits the call as content, tool_calls stays null.
    expect(isToolCapable("qwen2.5-coder:7b")).toBe(false);
    expect(isToolCapable("qwen2.5-coder:1.5b")).toBe(false);
  });

  it("refuses completion variants even of families that are otherwise fine", () => {
    /**
     * The guard that matters if the families list is ever widened.
     *
     * A looser rule — "any qwen" — would readmit qwen2.5-coder, the one model known for
     * certain to fail. Excluding completion variants explicitly means a future edit cannot
     * quietly undo this.
     */
    expect(isToolCapable("codellama:13b")).toBe(false);
    expect(isToolCapable("starcoder2:7b")).toBe(false);
    expect(isToolCapable("codegemma:7b")).toBe(false);
  });

  it("refuses a model it has never heard of rather than guessing", () => {
    expect(isToolCapable("some-random-model:4b")).toBe(false);
  });
});

describe("picking one", () => {
  it("honours a preference that can call tools", () => {
    expect(pickAgentModel(["llama3.1:8b", "qwen3:8b"], "qwen3:8b")).toEqual({
      model: "qwen3:8b",
      unverified: false,
    });
  });

  it("overrides a preference that cannot", () => {
    /**
     * The whole difference from `pickFimModel`, which honours any installed preference.
     *
     * Honouring `qwen2.5-coder` here is how the assistant ends up answering in prose and
     * calling nothing — the failure that looks like the model ignoring the user.
     */
    expect(pickAgentModel(["qwen2.5-coder:7b", "llama3.1:8b"], "qwen2.5-coder:7b")).toEqual({
      model: "llama3.1:8b",
      unverified: false,
    });
  });

  it("prefers the larger model", () => {
    // Completion is a latency problem; deciding which tool to call is a reasoning one, and a
    // 3B that picks the wrong tool is not faster in any sense the user cares about.
    expect(pickAgentModel(["llama3.1:8b", "llama3.3:70b"], "nothing")?.model).toBe("llama3.3:70b");
  });

  it("falls back to the preference and says it is unverified", () => {
    // Not a refusal: the families list may simply be incomplete, and refusing to run at all
    // would be worse than running with a caveat that `unwrapped.ts` will confirm or not.
    expect(pickAgentModel(["qwen2.5-coder:7b"], "qwen2.5-coder:7b")).toEqual({
      model: "qwen2.5-coder:7b",
      unverified: true,
    });
  });

  it("falls back to something installed when the preference is not installed either", () => {
    expect(pickAgentModel(["mystery:9b"], "absent:1b")).toEqual({
      model: "mystery:9b",
      unverified: true,
    });
  });

  it("returns nothing when nothing is installed", () => {
    // A distinct outcome from "installed but unverified" — there is no run to have.
    expect(pickAgentModel([], "llama3.1:8b")).toBeUndefined();
  });
});

describe("the warning", () => {
  it("names the model used and what to pull instead", () => {
    const message = noToolModelMessage("qwen2.5-coder:7b");
    expect(message).toContain("qwen2.5-coder:7b");
    expect(message).toMatch(/llama3\.1|qwen3/);
  });
});
