import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";
import {
  extractDocumentText,
  resetExtractedTextCache,
  MAX_EXTRACTION_INPUT_BYTES,
  type ExtractedText,
  type ExtractionResult,
} from "./file-extraction.ts";
import {
  buildTestDocx,
  buildTestPdf,
} from "./file-extraction.test-fixtures.ts";

const bytes = (buffer: Buffer) => new Uint8Array(buffer);

/** Narrow to the success case, failing the test with the real status if not. */
const ok = (result: ExtractionResult): ExtractedText => {
  expect(result.status).toBe("ok");
  return result as ExtractedText;
};

/** The cap production passes for a model that declares none. */
const cap = { maxChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS };

describe("extractDocumentText", () => {
  beforeEach(() => {
    resetExtractedTextCache();
  });

  it("extracts text from a text-based PDF", async () => {
    const result = await extractDocumentText(
      bytes(buildTestPdf(["Quarterly revenue rose", "Costs held flat"])),
      { mediaType: "application/pdf", filename: "report.pdf" },
      cap,
    );
    expect(result.status).toBe("ok");
    expect(ok(result).text).toContain("Quarterly revenue rose");
    expect(ok(result).text).toContain("Costs held flat");
    expect(ok(result).truncated).toBe(false);
  });

  it("extracts text from a DOCX", async () => {
    const result = await extractDocumentText(
      bytes(buildTestDocx(["First paragraph.", "Second paragraph."])),
      {
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "spec.docx",
      },
      cap,
    );
    expect(ok(result).text).toContain("First paragraph.");
    expect(ok(result).text).toContain("Second paragraph.");
  });

  it("picks the extractor from the media type when the filename has no extension", async () => {
    const result = await extractDocumentText(
      bytes(buildTestPdf(["No extension here"])),
      { mediaType: "application/pdf" },
      cap,
    );
    expect(ok(result).text).toContain("No extension here");
  });

  it("picks the extractor from the extension when the media type is generic", async () => {
    const result = await extractDocumentText(
      bytes(buildTestPdf(["Octet stream lottery"])),
      { mediaType: "application/octet-stream", filename: "report.pdf" },
      cap,
    );
    expect(ok(result).text).toContain("Octet stream lottery");
  });

  it("reports a format it cannot extract as unextractable", async () => {
    const result = await extractDocumentText(
      new Uint8Array([1, 2, 3]),
      {
        mediaType: "application/zip",
        filename: "bundle.zip",
      },
      cap,
    );
    expect(result.status).toBe("unextractable");
  });

  it("reports bytes that are not really the declared format as unextractable", async () => {
    const result = await extractDocumentText(
      new Uint8Array([1, 2, 3, 4, 5]),
      {
        mediaType: "application/pdf",
        filename: "broken.pdf",
      },
      cap,
    );
    expect(result.status).toBe("unextractable");
  });

  it("reports a PDF with no text layer (the scanned-document case) as unextractable", async () => {
    const result = await extractDocumentText(
      bytes(buildTestPdf([])),
      {
        mediaType: "application/pdf",
        filename: "scan.pdf",
      },
      cap,
    );
    expect(result.status).toBe("unextractable");
  });

  it("refuses to parse a document past the input ceiling", async () => {
    const oversized = new Uint8Array(MAX_EXTRACTION_INPUT_BYTES + 1);
    const result = await extractDocumentText(
      oversized,
      {
        mediaType: "application/pdf",
        filename: "huge.pdf",
      },
      cap,
    );
    expect(result.status).toBe("too-large");
  });

  it("truncates past the cap and reports the full length", async () => {
    const line = "word ".repeat(40).trim();
    const result = await extractDocumentText(
      bytes(buildTestPdf(Array.from({ length: 20 }, () => line))),
      { mediaType: "application/pdf", filename: "long.pdf" },
      { maxChars: 100 },
    );
    expect(ok(result).text.length).toBe(100);
    expect(ok(result).truncated).toBe(true);
    expect(ok(result).totalChars).toBeGreaterThan(100);
  });

  it("collapses runs of blank lines so a sparse document stays compact", async () => {
    const result = await extractDocumentText(
      bytes(buildTestDocx(["Alpha", "", "", "", "Beta"])),
      { filename: "sparse.docx" },
      cap,
    );
    expect(ok(result).text).not.toMatch(/\n{3}/);
    expect(ok(result).text).toContain("Alpha");
    expect(ok(result).text).toContain("Beta");
  });
});
