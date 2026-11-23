import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";

const extractText = vi.fn(() =>
  Promise.resolve({ totalPages: 1, text: "hello body" }),
);
vi.mock("unpdf", () => ({ extractText }));

const { extractDocumentText, resetExtractedTextCache } =
  await import("./file-extraction.ts");

const pdf = { mediaType: "application/pdf", filename: "a.pdf" };

const cap = { maxChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS };

describe("extracted-text cache", () => {
  beforeEach(() => {
    resetExtractedTextCache();
    extractText.mockClear();
  });

  it("parses identical bytes only once (history is re-sent every turn)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const first = await extractDocumentText(bytes, pdf, cap);
    const second = await extractDocumentText(
      new Uint8Array([1, 2, 3]),
      pdf,
      cap,
    );

    expect(first).toMatchObject({ status: "ok", text: "hello body" });
    expect(second).toMatchObject({ status: "ok", text: "hello body" });
    expect(extractText).toHaveBeenCalledTimes(1);
  });

  it("parses different bytes separately", async () => {
    await extractDocumentText(new Uint8Array([1, 2, 3]), pdf, cap);
    await extractDocumentText(new Uint8Array([4, 5, 6]), pdf, cap);
    expect(extractText).toHaveBeenCalledTimes(2);
  });

  it("caches a failed extraction so a scanned document isn't re-parsed", async () => {
    extractText.mockRejectedValueOnce(new Error("no text layer"));
    const bytes = new Uint8Array([7, 8, 9]);
    expect((await extractDocumentText(bytes, pdf, cap)).status).toBe(
      "unextractable",
    );
    expect((await extractDocumentText(bytes, pdf, cap)).status).toBe(
      "unextractable",
    );
    expect(extractText).toHaveBeenCalledTimes(1);
  });

  it("re-parses after the cache is reset", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await extractDocumentText(bytes, pdf, cap);
    resetExtractedTextCache();
    await extractDocumentText(bytes, pdf, cap);
    expect(extractText).toHaveBeenCalledTimes(2);
  });
});
