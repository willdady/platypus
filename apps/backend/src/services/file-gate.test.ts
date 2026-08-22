import { describe, it, expect, beforeEach } from "vitest";
import type { PlatypusUIMessage } from "../types.ts";
import {
  FileValidationError,
  messagesHaveFileParts,
  assertFilePartsSupported,
  normalizeFileParts,
} from "./file-gate.ts";
import {
  resetExtractedTextCache,
  MAX_EXTRACTION_INPUT_BYTES,
} from "./file-extraction.ts";
import {
  buildTestDocx,
  buildTestPdf,
} from "./file-extraction.test-fixtures.ts";

const textDataUrl = (text: string, mediaType = "application/octet-stream") =>
  `data:${mediaType};base64,${Buffer.from(text, "utf8").toString("base64")}`;

const bytesDataUrl = (buffer: Buffer, mediaType: string) =>
  `data:${mediaType};base64,${buffer.toString("base64")}`;

const binaryDataUrl = (bytes: number[], mediaType = "application/zip") =>
  `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

const PDF_TYPE = "application/pdf";
const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

  /** Run the gate and return the error it threw, or null. */
  const gateError = async (
    messages: PlatypusUIMessage[],
  ): Promise<FileValidationError | null> => {
    try {
      await assertFilePartsSupported(messages, chatPassthrough);
      return null;
    } catch (e) {
      return e as FileValidationError;
    }
  };

  beforeEach(() => {
    resetExtractedTextCache();
  });

  it("passes when every file is native or text-like", async () => {
    expect(
      await gateError([
        msg([{ type: "file", mediaType: "image/png", filename: "a.png" }]),
        msg([
          {
            type: "file",
            mediaType: "application/octet-stream",
            filename: "notes.md",
          },
        ]),
      ]),
    ).toBeNull();
  });

  it("lets a document in history through without re-fetching its bytes", async () => {
    // Storage-backed history parts carry no bytes here; they were verified the
    // turn they were attached.
    expect(
      await gateError([
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "report.pdf",
            url: "storage://abc",
          },
          { type: "file", mediaType: DOCX_TYPE, filename: "spec.docx" },
        ]),
      ]),
    ).toBeNull();
  });

  // Builds 2 distinct byte payloads in one test (buildTestDocx, buildTestPdf, bytesDataUrl) -- cold-import cost can push this past the default 5000ms vitest timeout under load.
  it("lets a freshly uploaded, text-based document through", async () => {
    expect(
      await gateError([
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "report.pdf",
            url: bytesDataUrl(buildTestPdf(["Readable"]), PDF_TYPE),
          },
          {
            type: "file",
            mediaType: DOCX_TYPE,
            filename: "spec.docx",
            url: bytesDataUrl(buildTestDocx(["Readable"]), DOCX_TYPE),
          },
        ]),
      ]),
    ).toBeNull();
  }, 15000);

  it("rejects a freshly uploaded scanned PDF before it can be persisted", async () => {
    const error = await gateError([
      msg([
        {
          type: "file",
          mediaType: PDF_TYPE,
          filename: "scan.pdf",
          url: bytesDataUrl(buildTestPdf([]), PDF_TYPE),
        },
      ]),
    ]);
    expect(error).toBeInstanceOf(FileValidationError);
    expect(error!.files).toEqual(["scan.pdf"]);
    expect(error!.rejections[0].reason).toBe("unextractable");
    expect(error!.message).toContain("scan.pdf");
    expect(error!.message).toContain("scanned or image-only");
  });

  it("rejects a freshly uploaded document that is too large to extract", async () => {
    const error = await gateError([
      msg([
        {
          type: "file",
          mediaType: PDF_TYPE,
          filename: "huge.pdf",
          url: bytesDataUrl(
            Buffer.alloc(MAX_EXTRACTION_INPUT_BYTES + 1),
            PDF_TYPE,
          ),
        },
      ]),
    ]);
    expect(error!.rejections[0].reason).toBe("too-large");
    expect(error!.message).toContain("too large");
  });

  it("throws FileValidationError naming an unsupported binary file", async () => {
    const error = await gateError([
      msg([
        {
          type: "file",
          mediaType: "application/zip",
          filename: "bundle.zip",
        },
      ]),
    ]);
    expect(error).toBeInstanceOf(FileValidationError);
    expect(error!.files).toEqual(["bundle.zip"]);
    expect(error!.message).toContain("bundle.zip");
  });

  it("collects every offending file across the history", async () => {
    const error = await gateError([
      msg([{ type: "file", mediaType: "application/zip", filename: "a.zip" }]),
      msg([{ type: "text", text: "hello" }]),
      msg([
        {
          type: "file",
          mediaType: "application/vnd.ms-powerpoint",
          filename: "b.pptx",
        },
      ]),
    ]);
    expect(error!.files).toEqual(["a.zip", "b.pptx"]);
  });

  it("groups mixed rejection reasons into one message", async () => {
    const error = await gateError([
      msg([
        { type: "file", mediaType: "application/zip", filename: "a.zip" },
        {
          type: "file",
          mediaType: PDF_TYPE,
          filename: "scan.pdf",
          url: bytesDataUrl(buildTestPdf([]), PDF_TYPE),
        },
      ]),
    ]);
    expect(error!.files).toEqual(["a.zip", "scan.pdf"]);
    expect(error!.message).toContain("a.zip");
    expect(error!.message).toContain("scan.pdf");
  });
});

describe("normalizeFileParts", () => {
  const chatPassthrough = ["image/*"];
  const nativePdfPassthrough = ["image/*", PDF_TYPE];

  beforeEach(() => {
    resetExtractedTextCache();
  });

  it("leaves natively-supported files untouched", async () => {
    const input = [
      msg([
        { type: "file", mediaType: "image/png", filename: "a.png", url: "u" },
      ]),
    ];
    const out = await normalizeFileParts(input, chatPassthrough);
    expect(out[0].parts[0]).toEqual(input[0].parts[0]);
  });

  it("inlines a text-like file as an annotated text part", async () => {
    const out = await normalizeFileParts(
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

  it("fences an inlined file so its own backticks can't break out", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "application/octet-stream",
            filename: "readme.md",
            url: textDataUrl("intro\n```js\ncode()\n```\nend"),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    // The wrapper fence must be longer than the longest run inside it.
    expect(part.text).toContain("````\nintro");
    expect(part.text.trimEnd().endsWith("````")).toBe(true);
  });

  it("extracts a non-native PDF into an annotated text part", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "report.pdf",
            url: bytesDataUrl(buildTestPdf(["Revenue is up"]), PDF_TYPE),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("[extracted text from report.pdf]");
    expect(part.text).toContain("Revenue is up");
  });

  it("extracts a non-native DOCX into an annotated text part", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: DOCX_TYPE,
            filename: "spec.docx",
            url: bytesDataUrl(buildTestDocx(["Design goals"]), DOCX_TYPE),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.text).toContain("[extracted text from spec.docx]");
    expect(part.text).toContain("Design goals");
  });

  it("keeps the native path intact: a PDF the model accepts is not extracted", async () => {
    const input = [
      msg([
        {
          type: "file",
          mediaType: PDF_TYPE,
          filename: "report.pdf",
          url: bytesDataUrl(buildTestPdf(["Revenue is up"]), PDF_TYPE),
        },
      ]),
    ];
    const out = await normalizeFileParts(input, nativePdfPassthrough);
    expect(out[0].parts[0]).toEqual(input[0].parts[0]);
  });

  it("truncates an over-cap extraction and says so", async () => {
    const line = "lorem ipsum dolor sit amet";
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "long.pdf",
            url: bytesDataUrl(
              buildTestPdf(Array.from({ length: 30 }, () => line)),
              PDF_TYPE,
            ),
          },
        ]),
      ],
      chatPassthrough,
      { maxExtractedTextChars: 120 },
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.text).toContain("[extracted text from long.pdf]");
    expect(part.text).toMatch(
      /\[extracted text truncated: first 120 of \d+ characters\]/,
    );
  });

  it("announces a document with no extractable text rather than failing the turn", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "scan.pdf",
            url: bytesDataUrl(buildTestPdf([]), PDF_TYPE),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("scan.pdf");
    expect(part.text).toContain("no readable text");
  });

  it("announces an over-sized document instead of parsing it", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "huge.pdf",
            url: bytesDataUrl(
              Buffer.alloc(MAX_EXTRACTION_INPUT_BYTES + 1),
              PDF_TYPE,
            ),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.text).toContain("too large");
    expect(part.text).toContain("huge.pdf");
  });

  it("replaces a slipped-through binary with a placeholder rather than throwing", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: "application/zip",
            filename: "bundle.zip",
            url: binaryDataUrl([0, 1, 2, 3]),
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("bundle.zip");
    expect(part.text).toContain("unsupported");
  });

  it("announces a text-like file that never got inlined (storage:// survivor) as unavailable", async () => {
    const out = await normalizeFileParts(
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

  it("announces a document that never got inlined as unavailable", async () => {
    const out = await normalizeFileParts(
      [
        msg([
          {
            type: "file",
            mediaType: PDF_TYPE,
            filename: "report.pdf",
            url: "storage://abc123",
          },
        ]),
      ],
      chatPassthrough,
    );
    const part = out[0].parts[0] as { type: string; text: string };
    expect(part.text).toContain("report.pdf");
    expect(part.text).toContain("unavailable");
  });

  it("announces a native file with an un-inlined storage:// URL as unavailable instead of forwarding it raw", async () => {
    const out = await normalizeFileParts(
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

  it("leaves a native file with an external http(s) URL untouched (the model may fetch it)", async () => {
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
    const out = await normalizeFileParts(input, chatPassthrough);
    expect(out[0].parts[0]).toEqual(input[0].parts[0]);
  });
});
