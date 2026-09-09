/**
 * Asking before an image leaves the machine.
 *
 * The property under test is not "a dialog appears" — it is **which button does nothing**.
 * This prompt guards the one action in the app that moves the contents of the user's screen
 * to a third party, and a screenshot of a bug is also a screenshot of whatever else was open:
 * an email, a token in a terminal, a customer's name.
 *
 * So the safe answer has to be the one you get by not deciding. Escape, dismissal, and the
 * default button all mean "do not send".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const showMessageBox = vi.fn();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/voidcode-test" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
}));

const { countImages, hostOf, confirmImageUpload } = await import(
  "../src/main/inference/consent.js"
);

import type { ChatMessage } from "../src/main/inference/types.js";

const PNG = "iVBORw0KGgo=";
const sender = { id: 1 } as unknown as Electron.WebContents;

beforeEach(() => {
  showMessageBox.mockReset();
  showMessageBox.mockResolvedValue({ response: 1 });
});

describe("counting what would be sent", () => {
  it("finds images across every turn", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "image", data: PNG, mediaType: "image/png" }] },
      { role: "assistant", content: "I see." },
      {
        role: "user",
        content: [
          { type: "text", text: "and this" },
          { type: "image", data: PNG, mediaType: "image/png" },
          { type: "image", data: PNG, mediaType: "image/jpeg" },
        ],
      },
    ];

    expect(countImages(messages)).toBe(3);
  });

  it("counts none for an ordinary conversation", () => {
    // Zero is what keeps the prompt off the text path entirely. A dialog on every message
    // would be trained through within a day.
    expect(countImages([{ role: "user", content: "hello" }])).toBe(0);
  });
});

describe("naming the destination", () => {
  it("reduces a base URL to its host", () => {
    // The user is being asked to send data to a *place*, and "a remote provider" is not one.
    expect(hostOf("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(hostOf("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
  });

  it("falls back to the raw string rather than throwing on the prompt path", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("the prompt itself", () => {
  it("returns true only for the explicit send button", async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    await expect(
      confirmImageUpload({ sender, destination: "openrouter.ai", imageCount: 1, modelLabel: "X" })
    ).resolves.toBe(true);
  });

  it("returns false for cancel", async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    await expect(
      confirmImageUpload({ sender, destination: "openrouter.ai", imageCount: 1, modelLabel: "X" })
    ).resolves.toBe(false);
  });

  it("makes NOT sending the default and the escape route", async () => {
    // The load-bearing detail. Dismissing a dialog you did not read must not upload a
    // screenshot: not sending is recoverable, sending is not.
    await confirmImageUpload({
      sender,
      destination: "openrouter.ai",
      imageCount: 1,
      modelLabel: "X",
    });

    const options = showMessageBox.mock.calls[0]?.[1] as {
      buttons: string[];
      defaultId: number;
      cancelId: number;
    };
    expect(options.buttons[options.defaultId]).toBe("Cancel");
    expect(options.buttons[options.cancelId]).toBe("Cancel");
  });

  it("names the destination and the count in the question itself", async () => {
    // Not buried in the detail text, which people do not read.
    await confirmImageUpload({
      sender,
      destination: "openrouter.ai",
      imageCount: 2,
      modelLabel: "OpenRouter",
    });

    const options = showMessageBox.mock.calls[0]?.[1] as { message: string; detail: string };
    expect(options.message).toContain("openrouter.ai");
    expect(options.message).toContain("2 images");
    // And says what the alternative is, so refusing is actionable rather than a dead end.
    expect(options.detail).toContain("local vision model");
  });

  it("offers no way to stop being asked", async () => {
    // A "don't ask again" checkbox would defeat the entire control: the value is that the
    // decision is made while looking at *this* image.
    await confirmImageUpload({
      sender,
      destination: "openrouter.ai",
      imageCount: 1,
      modelLabel: "X",
    });

    const options = showMessageBox.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.checkboxLabel).toBeUndefined();
  });
});
