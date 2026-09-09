/**
 * What may be attached to a message.
 *
 * These bounds duplicate the contract's, and that duplication is deliberate: main is the
 * authority, but failing there produces "Invalid payload for chat:open", which tells the user
 * nothing about *which* image was rejected or what to do instead. Checking in the renderer is
 * how the message becomes actionable; checking in main is how it becomes true.
 *
 * So the tests here are about the *reasons*, not just the refusals.
 */
import { describe, it, expect } from "vitest";
import {
  rejectionFor,
  bareBase64,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  imageFilesFrom,
  canSend,
  visionNoticeFor,
} from "../renderer/src/lib/attachments.js";

describe("what is accepted", () => {
  it("takes the three types a vision model reads", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(rejectionFor({ type, size: 1024 }, 0)).toBeNull();
    }
  });

  it("names the accepted types when refusing", () => {
    // "Unsupported file" leaves the user guessing which of the three it wanted.
    const reason = rejectionFor({ type: "image/gif", size: 1024 }, 0);
    expect(reason).toContain("PNG");
    expect(reason).toContain("image/gif");
  });

  it("handles a file whose type the OS did not report", () => {
    // Dragging from some applications yields an empty type. "unknown" beats an empty gap in
    // the sentence.
    expect(rejectionFor({ type: "", size: 1024 }, 0)).toContain("unknown");
  });
});

describe("size", () => {
  it("accepts a screenshot-sized image", () => {
    expect(rejectionFor({ type: "image/png", size: 900_000 }, 0)).toBeNull();
  });

  it("refuses one over the cap, and says how big it was", () => {
    // A photograph from a phone is the case worth rejecting early: it would otherwise be
    // base64-encoded to ~11 MB and pushed through the broker before anything complained.
    const reason = rejectionFor({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }, 0);
    expect(reason).toContain("MB");
    expect(reason).toContain("4");
  });
});

describe("how many", () => {
  it("allows up to the cap", () => {
    expect(rejectionFor({ type: "image/png", size: 1024 }, MAX_ATTACHMENTS - 1)).toBeNull();
  });

  it("refuses past it with the number, not a vague limit", () => {
    const reason = rejectionFor({ type: "image/png", size: 1024 }, MAX_ATTACHMENTS);
    expect(reason).toContain(String(MAX_ATTACHMENTS));
  });

  it("checks the type before the count", () => {
    // Told the more specific thing first: "that is a GIF" is more useful than "you already
    // have four" when both are true.
    expect(rejectionFor({ type: "image/gif", size: 1024 }, MAX_ATTACHMENTS)).toContain("PNG");
  });
});

describe("stripping the data URL prefix", () => {
  it("keeps only the base64", () => {
    // Bare base64 is what main and Ollama both want; the prefix is added back per provider.
    expect(bareBase64("data:image/png;base64,iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
  });

  it("passes through something that was never prefixed", () => {
    expect(bareBase64("iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
  });
});

describe("reading a clipboard or drop payload", () => {
  /**
   * `DataTransferItemList` is defined as array-like; its iterator is a Chromium extra.
   *
   * These fixtures are deliberately array-like and NOT iterable, so the reader is exercised
   * against the interface as specified rather than against what one engine happens to add.
   * A spread would pass in Chromium and throw elsewhere — and a throw inside a paste handler
   * means the paste silently does nothing, with nothing logged anywhere.
   */
  function itemList(items: Array<{ kind: string; type: string; file: File | null }>) {
    const list: Record<number, unknown> & { length: number } = { length: items.length };
    items.forEach((item, index) => {
      list[index] = { kind: item.kind, type: item.type, getAsFile: () => item.file };
    });
    return list as unknown as DataTransferItemList;
  }

  const png = { name: "a.png", type: "image/png" } as unknown as File;

  it("reads a list that is array-like and not iterable", () => {
    const files = imageFilesFrom(itemList([{ kind: "file", type: "image/png", file: png }]));
    expect(files).toEqual([png]);
  });

  it("ignores the text item every paste also carries", () => {
    expect(
      imageFilesFrom(
        itemList([
          { kind: "string", type: "text/plain", file: null },
          { kind: "file", type: "image/png", file: png },
        ])
      )
    ).toEqual([png]);
  });

  it("ignores a dropped file that is not an accepted image", () => {
    const pdf = { name: "a.pdf", type: "application/pdf" } as unknown as File;
    expect(imageFilesFrom(itemList([{ kind: "file", type: "application/pdf", file: pdf }]))).toEqual(
      []
    );
  });

  it("survives a null or absent list", () => {
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom(undefined)).toEqual([]);
  });
});

describe("canSend", () => {
  /**
   * One predicate for two callers — the button's `disabled` and the handler's early return.
   * The bug it replaced was those two disagreeing: the button lit up for an image with no
   * caption and clicking it did nothing, silently, because the handler still required text.
   */
  it("sends text on its own", () => {
    expect(canSend("why is this wrong?", 0)).toBe(true);
  });

  it("sends an image on its own", () => {
    // The case the tutor did not have. A loss curve is frequently the entire question.
    expect(canSend("", 1)).toBe(true);
  });

  it("sends both together", () => {
    expect(canSend("look at this", 2)).toBe(true);
  });

  it("refuses an empty turn", () => {
    expect(canSend("", 0)).toBe(false);
  });

  it("refuses whitespace as if it were empty", () => {
    // Enter on an untouched box, or a stray space. Sending it costs a model call and a turn of
    // history to say nothing.
    expect(canSend("   \n\t ", 0)).toBe(false);
  });

  it("still sends when whitespace accompanies an image", () => {
    // The two clauses are independent: blank text must not veto an attached image.
    expect(canSend("  ", 1)).toBe(true);
  });
});

describe("visionNoticeFor", () => {
  /**
   * Found by driving the real app, twice, and the second time mattered more than the first.
   *
   * First: attaching a diagram while Qwen3 8B was installed produced "I currently cannot view or
   * access attached images." The whole path worked and the learner still got nothing.
   *
   * Then the notice built to prevent that never appeared — because the catalogue lists
   * `qwen3:8b-q4_K_M` and what was installed is `qwen3:8b`. Correct, and silent in the only case
   * it existed for. Matching by family is the fix, and this is why these fixtures use both id
   * shapes rather than the tidy one.
   */
  const CATALOGUE = [
    { id: "qwen3:8b-q4_K_M" },
    { id: "qwen3:8b-q8_0" },
    { id: "qwen3-vl:4b-instruct-q8_0", vision: true },
    { id: "qwen2.5vl:7b-q4_K_M", vision: true },
  ];

  it("warns about the plain tag someone actually has installed", () => {
    // The whole point. `qwen3:8b` is in no catalogue entry; its family is in four.
    const notice = visionNoticeFor("qwen3:8b", CATALOGUE);
    expect(notice).toContain("qwen3:8b");
    expect(notice).toContain("cannot see images");
  });

  it("warns about the fully-qualified tag too", () => {
    expect(visionNoticeFor("qwen3:8b-q4_K_M", CATALOGUE)).toContain("cannot see images");
  });

  it("says nothing about a model that can see", () => {
    expect(visionNoticeFor("qwen3-vl:4b-instruct-q8_0", CATALOGUE)).toBeNull();
    expect(visionNoticeFor("qwen3-vl:8b", CATALOGUE)).toBeNull();
  });

  it("does not confuse a vision family with the text family it is named after", () => {
    /**
     * The risk family matching introduces, and the reason it is safe here: `qwen3-vl` is a
     * different family from `qwen3`, not a variant of it. A prefix match rather than an exact
     * family match would call every VL model blind.
     */
    expect(visionNoticeFor("qwen3-vl:4b-instruct-q8_0", CATALOGUE)).toBeNull();
    expect(visionNoticeFor("qwen3:8b", CATALOGUE)).not.toBeNull();
  });

  it("says nothing about a family it has never heard of", () => {
    /**
     * The judgement call. OpenRouter ids and custom Ollama tags are not in the catalogue, and
     * warning that an unlisted model is blind would be a confident false claim on exactly the
     * models most likely to have vision. Absence of evidence is not evidence of blindness.
     */
    expect(visionNoticeFor("anthropic/claude-opus-5", CATALOGUE)).toBeNull();
    expect(visionNoticeFor("some-local-tag:latest", CATALOGUE)).toBeNull();
  });

  it("says nothing before a model is known", () => {
    // The lookup is async; the first render after an attach has no answer yet.
    expect(visionNoticeFor(null, CATALOGUE)).toBeNull();
    expect(visionNoticeFor(undefined, CATALOGUE)).toBeNull();
    expect(visionNoticeFor("", CATALOGUE)).toBeNull();
  });

  it("says nothing when there is no catalogue to check against", () => {
    expect(visionNoticeFor("qwen3:8b", [])).toBeNull();
  });

  it("tells the user what to do about it", () => {
    // A notice that names a problem and no remedy is just an apology.
    expect(visionNoticeFor("qwen3:8b", CATALOGUE)).toContain("model manager");
  });

  it("stays quiet about a family that disagrees with itself", () => {
    /**
     * Cannot happen today — `tutor-images.test.ts` asserts no shipped family is split — but the
     * direction is a decision, not an accident: if one entry in a family claims vision, the
     * notice keeps quiet rather than telling someone their model is blind on a coin flip. A
     * missing warning costs one confusing answer; a wrong one sends them to download 6 GB they
     * did not need.
     */
    expect(visionNoticeFor("newfam:7b", [{ id: "newfam:7b-a" }, { id: "newfam:7b-b", vision: true }]))
      .toBeNull();
  });
});
