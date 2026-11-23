import { createHash } from "node:crypto";
import {
  extractableDocumentFormat,
  type ExtractableDocumentFormat,
  type FileMetadata,
} from "@platypus/schemas";
import { logger } from "../logger.ts";
import { sliceWhole } from "../utils/storable.ts";

export type ExtractedText = {
  status: "ok";
  text: string;
  truncated: boolean;
  totalChars: number;
};

export type ExtractionResult =
  ExtractedText | { status: "unextractable" } | { status: "too-large" };

export const MAX_EXTRACTION_INPUT_BYTES = 25 * 1024 * 1024;

// why: dynamic import keeps unpdf (pdf.js) and mammoth off the startup path
const extractPdf = async (bytes: Uint8Array): Promise<string> => {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(bytes, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : text;
};

const extractDocx = async (bytes: Uint8Array): Promise<string> => {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes),
  });
  return value;
};

const EXTRACTORS: Record<
  ExtractableDocumentFormat,
  (bytes: Uint8Array) => Promise<string>
> = {
  pdf: extractPdf,
  docx: extractDocx,
};

const normalizeExtractedWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// why: process-global is safe: key is the file's SHA-256, so a hit returns only bytes held
const CACHE_LIMIT = 16;
const cache = new Map<string, string | null>();

export const resetExtractedTextCache = (): void => {
  cache.clear();
};

const cacheKey = (
  format: ExtractableDocumentFormat,
  bytes: Uint8Array,
): string => `${format}:${createHash("sha256").update(bytes).digest("hex")}`;

const remember = (key: string, value: string | null): void => {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
};

export const extractDocumentText = async (
  bytes: Uint8Array,
  file: FileMetadata,
  options: { maxChars: number },
): Promise<ExtractionResult> => {
  const format = extractableDocumentFormat(file);
  if (!format) return { status: "unextractable" };

  if (bytes.length > MAX_EXTRACTION_INPUT_BYTES) {
    logger.warn(
      { format, filename: file.filename, bytes: bytes.length },
      "Document too large to extract; announcing instead of parsing",
    );
    return { status: "too-large" };
  }

  const key = cacheKey(format, bytes);
  let text: string | null;

  if (cache.has(key)) {
    text = cache.get(key) ?? null;
  } else {
    try {
      text =
        normalizeExtractedWhitespace(await EXTRACTORS[format](bytes)) || null;
    } catch (error) {
      logger.warn(
        { error, format, filename: file.filename },
        "Document text extraction failed",
      );
      text = null;
    }
    remember(key, text);
  }

  if (text === null) return { status: "unextractable" };

  const maxChars = options.maxChars;
  return {
    status: "ok",
    text: text.length > maxChars ? sliceWhole(text, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length,
  };
};
