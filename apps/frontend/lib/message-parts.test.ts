import { describe, it, expect } from "vitest";
import {
  isImageAttachment,
  messageAttachments,
  messageText,
} from "./message-parts";

describe("isImageAttachment", () => {
  it("is true for an image media type with a URL", () => {
    expect(
      isImageAttachment({ mediaType: "image/png", url: "https://x/a.png" }),
    ).toBe(true);
  });

  it("is false for an image media type with no URL", () => {
    expect(isImageAttachment({ mediaType: "image/png", url: "" })).toBe(false);
  });

  it("is false for a non-image media type with a URL", () => {
    expect(
      isImageAttachment({
        mediaType: "application/pdf",
        url: "https://x/a.pdf",
      }),
    ).toBe(false);
  });
});

const pdf = {
  type: "file" as const,
  url: "https://x/a.pdf",
  mediaType: "application/pdf",
  filename: "a.pdf",
};

const png = {
  type: "file" as const,
  url: "https://x/a.png",
  mediaType: "image/png",
  filename: "a.png",
};

describe("messageText", () => {
  it("joins every text part in order", () => {
    expect(
      messageText([
        { type: "text", text: "First. " },
        pdf,
        { type: "text", text: "Second." },
      ]),
    ).toBe("First. Second.");
  });

  it("is empty for a message with no text and for no parts at all", () => {
    expect(messageText([pdf])).toBe("");
    expect(messageText(undefined)).toBe("");
  });
});

describe("messageAttachments", () => {
  it("keeps every file part, images included, in order", () => {
    expect(
      messageAttachments([png, { type: "text", text: "Look" }, pdf]),
    ).toEqual([png, pdf]);
  });

  it("is empty for a message with no files and for no parts at all", () => {
    expect(messageAttachments([{ type: "text", text: "Look" }])).toEqual([]);
    expect(messageAttachments(undefined)).toEqual([]);
  });
});
