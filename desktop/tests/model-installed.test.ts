/**
 * Matching what Ollama has against what the catalogue offers.
 *
 * The two name the same weights differently. Ollama reported `qwen2.5-coder:7b`; the catalogue
 * lists `qwen2.5-coder:7b-q4_K_M`. Same file — an unsuffixed Ollama tag is that model's
 * default, and the default is Q4_K_M — but string equality calls them different, and the page
 * offered a 4.7 GB download for a model already on disk.
 *
 * Found by reading the running app against a real Ollama install, not by reading the diff:
 * the exact-match version was correct for every catalogue id and wrong for every installed one.
 */
import { describe, it, expect } from "vitest";
import {
  aliasesFor,
  installedTagFor,
  isInstalled,
  registerCatalogue,
  unambiguousBareTags,
} from "../renderer/src/lib/models/installed.js";
import { CATALOGUE } from "../src/main/hardware/catalogue.js";

describe("aliases", () => {
  it("treats the bare tag as the Q4_K_M variant", () => {
    expect(aliasesFor("qwen2.5-coder:7b-q4_K_M")).toEqual([
      "qwen2.5-coder:7b-q4_K_M",
      "qwen2.5-coder:7b",
    ]);
  });

  it("gives no alias to other quantisations", () => {
    // Only the default is written without a suffix. A Q8 install is always tagged `-q8_0`,
    // so claiming `qwen2.5-coder:7b` also means Q8 would mark the wrong row installed.
    expect(aliasesFor("qwen2.5-coder:7b-q8_0")).toEqual(["qwen2.5-coder:7b-q8_0"]);
    expect(aliasesFor("qwen2.5-coder:7b-q6_K")).toEqual(["qwen2.5-coder:7b-q6_K"]);
  });

  it("leaves an already-bare id alone", () => {
    expect(aliasesFor("qwen2.5vl:7b")).toEqual(["qwen2.5vl:7b"]);
  });
});

registerCatalogue(CATALOGUE);

describe("is it installed", () => {
  it("matches the real Ollama tag for the default quantisation", () => {
    /**
     * THE case. This is verbatim what `providers.list()` returned on the machine where the
     * bug was found, against the catalogue id for the same weights.
     */
    const installed = new Set(["qwen3:8b", "llama3.1:8b", "qwen2.5-coder:7b"]);
    expect(isInstalled("qwen2.5-coder:7b-q4_K_M", installed)).toBe(true);
  });

  it("still matches an exact tag", () => {
    const installed = new Set(["qwen2.5-coder:7b-q8_0"]);
    expect(isInstalled("qwen2.5-coder:7b-q8_0", installed)).toBe(true);
  });

  it("does not mark a different quantisation installed", () => {
    // Having the default does not mean having Q8 — offering "Remove" for weights that are
    // not there would 404 at the provider, and hiding the download would strand the user.
    const installed = new Set(["qwen2.5-coder:7b"]);
    expect(isInstalled("qwen2.5-coder:7b-q8_0", installed)).toBe(false);
    expect(isInstalled("qwen2.5-coder:7b-q6_K", installed)).toBe(false);
  });

  it("does not mark a different size installed", () => {
    const installed = new Set(["qwen2.5-coder:7b"]);
    expect(isInstalled("qwen2.5-coder:14b-q4_K_M", installed)).toBe(false);
    expect(isInstalled("qwen2.5-coder:1.5b-q4_K_M", installed)).toBe(false);
  });

  it("ignores case, because Ollama preserves whatever it was given", () => {
    expect(isInstalled("qwen2.5-coder:7b-q4_K_M", new Set(["QWEN2.5-CODER:7B"]))).toBe(true);
    expect(isInstalled("qwen2.5-coder:7b-q8_0", new Set(["qwen2.5-coder:7b-Q8_0"]))).toBe(true);
  });

  it("says no for an empty machine", () => {
    for (const model of CATALOGUE) {
      expect(isInstalled(model.id, new Set())).toBe(false);
    }
  });

  it("never matches two catalogue entries to one installed tag", () => {
    /**
     * The failure the alias rule could plausibly introduce. If a bare tag matched every
     * quantisation, one installed model would light up four rows and offer four Remove
     * buttons for one file on disk.
     */
    const installed = new Set(["qwen2.5-coder:7b"]);
    const matched = CATALOGUE.filter((m) => isInstalled(m.id, installed));
    expect(matched.map((m) => m.id)).toEqual(["qwen2.5-coder:7b-instruct-q4_K_M"]);
  });
});

describe("which tag to delete", () => {
  it("names what Ollama actually holds, not what the catalogue calls it", () => {
    // `DELETE /api/delete` answers 404 for a tag that is not installed, which the provider
    // reports as "not installed, so there was nothing to remove" — a confusing error for a
    // button drawn from a list that said it was there.
    const installed = new Set(["qwen2.5-coder:7b"]);
    expect(installedTagFor("qwen2.5-coder:7b-q4_K_M", installed)).toBe("qwen2.5-coder:7b");
  });

  it("preserves the case Ollama used", () => {
    expect(installedTagFor("qwen2.5-coder:7b-q4_K_M", new Set(["Qwen2.5-Coder:7B"]))).toBe(
      "Qwen2.5-Coder:7B"
    );
  });

  it("falls back to the catalogue id when nothing matches", () => {
    // So the call still happens and fails visibly, rather than silently doing nothing.
    expect(installedTagFor("qwen2.5-coder:7b-q8_0", new Set())).toBe("qwen2.5-coder:7b-q8_0");
  });
});

/**
 * Which bare tags may be claimed, and by whom.
 *
 * `qwen2.5-coder:7b` is the instruct build at Q4_K_M — verified by digest, both manifests point
 * at blob 60e05f210007 — so the catalogue entry should answer to it. But `olmo-3:7b` is not the
 * Instruct build, and Olmo ships Instruct *and* Think at Q4_K_M, so letting either claim the
 * bare tag would light up two Remove buttons for one file on disk.
 *
 * The rule is therefore computed from the catalogue rather than listed: a bare tag is claimed
 * only when exactly one entry could claim it.
 */
describe("bare tags", () => {
  it("gives the tag to a family with one Q4 build", () => {
    const map = unambiguousBareTags([
      { id: "qwen2.5-coder:7b-instruct-q4_K_M" },
      { id: "qwen2.5-coder:7b-instruct-q8_0" },
    ]);
    expect(map.get("qwen2.5-coder:7b-instruct-q4_K_M")).toBe("qwen2.5-coder:7b");
  });

  it("gives it to neither when two builds compete", () => {
    // Olmo 3's real shape. Both are Q4_K_M under `olmo-3:7b`, so neither is the answer.
    const map = unambiguousBareTags([
      { id: "olmo-3:7b-instruct-q4_K_M" },
      { id: "olmo-3:7b-think-q4_K_M" },
    ]);
    expect(map.size).toBe(0);
  });

  it("holds on the real catalogue", () => {
    // The invariant that matters in production: no bare tag is claimed twice, or one installed
    // model lights up two rows.
    const map = unambiguousBareTags(CATALOGUE);
    const bare = [...map.values()];
    expect(new Set(bare).size).toBe(bare.length);
    expect(map.get("qwen2.5-coder:7b-instruct-q4_K_M")).toBe("qwen2.5-coder:7b");
  });
});
