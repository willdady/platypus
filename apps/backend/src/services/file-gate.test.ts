import { describe, it, expect } from "vitest";
import type { PlatypusUIMessage } from "../types.ts";
import {
  FileValidationError,
  messagesHaveFileParts,
  assertFilePartsSupported,
  normalizeFileParts,
} from "./file-gate.ts";

const textDataUrl = (text: string, mediaType = "application/octet-stream") =>
  `data:${mediaType};base64,${Buffer.from(text, "utf8").toString("base64")}`;

const binaryDataUrl = (bytes: number[], mediaType = "application/pdf") =>
  `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

const msg = (parts: unknown[]): PlatypusUIMessage =>
  ({ id: "m1", role: "user", parts }) as unknown as PlatypusUIMessage;

describe("messagesHaveFileParts", () => {
  it("detects a file part anywhere in the list", () => {
    expect(
      messagesHaveFileParts([
        msg([{ type: "text", text: "hi" }]),
        msg([{ type: "file", mediaType: "image/png", url: "data:..." }]),
      ]),
    ).toBe(true);
  });

  it("is false when there are no file parts", () => {
    expect(messagesHaveFileParts([msg([{ type: "text", text: "hi" }])])).toBe(
      false,
    );
  });
});

describe("assertFilePartsSupported", () => {
  const chatPassthrough = ["image/*"];

  it("passes when every file is native or text-like", () => {
    expect(() =>
      assertFilePartsSupported(
        [
          msg([{ type: "file", mediaType: "image/png", filename: "a.png" }]),
          msg([
            {
              type: "file",
              mediaType: "application/octet-stream",
              filename: "notes.md",
            },
          ]),
        ],
        chatPassthrough,
      ),
    ).not.toThrow();
  });

  it("throws FileValidationError naming an unsupported binary file", () => {
    let error: unknown;
    try {
      assertFilePartsSupported(
        [
          msg([
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "report.pdf",
            },
          ]),
        ],
        chatPassthrough,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FileValidationError);
    expect((error as FileValidationError).files).toEqual(["report.pdf"]);
    expect((error as FileValidationError).message).toContain("report.pdf");
  });

  it("collects every offending file across the history", () => {
    let error: unknown;
    try {
      assertFilePartsSupported(
        [
          msg([
            { type: "file", mediaType: "application/pdf", filename: "a.pdf" },
          ]),
          msg([{ type: "text", text: "hello" }]),
          msg([
            {
              type: "file",
              mediaType: "application/vnd.ms-powerpoint",
              filename: "b.pptx",
            },
          ]),
        ],
        chatPassthrough,
      );
    } catch (e) {
      error = e;
    }
    expect((error as FileValidationError).files).toEqual(["a.pdf", "b.pptx"]);
  });
});

describe("normalizeFileParts", () => {
  const chatPassthrough = ["image/*"];

  it("leaves natively-supported files untouched", () => {
    const input = [
      msg([
        { type: "file", mediaType: "image/png", filename: "a.png", url: "u" },
      ]),
    ];
    const out = normalizeFileParts(input, chatPassthrough);
    expect(out[0].parts[0]).toEqual(input[0].parts[0]);
  });

  it("inlines a text-like file as an annotated text part", () => {
    const out = normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "application/octet-stream",
            filename: "notes.md",
            url: textDataUrl("# Hello\nbody"),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("notes.md");
    expect(part.text).toContain("# Hello");
  });

  it("replaces a slipped-through binary with a placeholder rather than throwing", () => {
    const out = normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "report.pdf",
            url: binaryDataUrl([0, 1, 2, 3]),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("report.pdf");
  });

  it("announces a text-like file that never got inlined (storage:// survivor) as unavailable", () => {
    const out = normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "application/octet-stream",
            filename: "notes.md",
            url: "storage://abc123",
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("notes.md");
    expect(part.text).toContain("unavailable");
  });

  it("announces a native file with an un-inlined storage:// URL as unavailable instead of forwarding it raw", () => {
    const out = normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "image/png",
            filename: "a.png",
            url: "storage://abc123",
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("a.png");
    expect(part.text).toContain("unavailable");
  });

  it("leaves a native file with an external http(s) URL untouched (the model may fetch it)", () => {
    const input = [
      msg([
        {
          type: "file",
          mediaType: "image/png",
          filename: "a.png",
          url: "https://example.com/a.png",
        },
      ]),
    ];
    const out = normalizeFileParts(input, chatPassthrough);
    expect(out[0].parts[0]).toEqual(input[0].parts[0]);
  });
});
