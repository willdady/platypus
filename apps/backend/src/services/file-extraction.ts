import { createHash } from "node:crypto";
import {
  extractableDocumentFormat,
  type ExtractableDocumentFormat,
  type FileMetadata,
} from "@platypus/schemas";
import { logger } from "../logger.ts";

/**
 * Binary document → text extraction (issue #342).
 *
 * Only ever called on the branch that would otherwise hard-fail: a file the
 * target model does NOT list in `passthroughFileTypes`. A model that natively
 * ingests PDFs still receives the real PDF — extraction never downgrades the
 * passthrough path.
 *
 * Extractors are loaded with a dynamic `import()` so `unpdf` (a pdf.js build)
 * and `mammoth` stay off the startup path: a deployment that never attaches a
 * document never pays for them.
 *
 * Nothing here throws: an unknown format, bytes that don't match the declared
 * format, and a scanned PDF with no text layer all resolve to a non-`ok`
 * outcome. The caller turns that into an announced placeholder, so a bad
 * document can never hard-fail conversion and brick a chat.
 */

export type ExtractedText = {
  status: "ok";
  /** The extracted text, already capped to the caller's limit. */
  text: string;
  /** Whether `text` was cut short of the full extraction. */
  truncated: boolean;
  /** Length of the full extraction, before capping. */
  totalChars: number;
};

export type ExtractionResult =
  | ExtractedText
  /** No text came out: a scanned/image-only document, or bytes we can't parse. */
  | { status: "unextractable" }
  /** Refused before parsing — see `MAX_EXTRACTION_INPUT_BYTES`. */
  | { status: "too-large" };

/**
 * Ceiling on the bytes handed to an extractor. Parsing runs in-process and is
 * CPU- and memory-bound, so an unbounded upload would stall the event loop for
 * every other request; past this size the document is announced rather than
 * parsed. Generous for a text document — a 25 MB PDF is already hundreds of
 * pages, far more text than any context window would take.
 */
export const MAX_EXTRACTION_INPUT_BYTES = 25 * 1024 * 1024;

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

/**
 * Squeeze an extraction for a small context window: normalize line endings, drop
 * trailing spaces, and collapse runs of blank lines. PDF extraction in
 * particular emits a lot of vertical whitespace that costs tokens and carries
 * no meaning.
 */
const normalizeExtractedWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Extracted text keyed by content hash, because the whole history is re-sent
 * every turn — and the pre-persist gate parses the same bytes the send-time
 * normalizer will. Without this, every document in a chat is re-parsed on every
 * message. Bounded and FIFO-evicted — a cache miss only costs time, so a small
 * window over the documents in the active chat is enough. Failures are cached
 * too (as `null`), so a scanned PDF isn't re-parsed each turn either.
 *
 * Process-global, and deliberately not scoped per org/workspace: the key is the
 * SHA-256 of the whole file, so a hit can only ever return the text of bytes the
 * caller already holds. Nothing crosses a tenant boundary that the caller
 * doesn't already have in hand.
 */
const CACHE_LIMIT = 16;
const cache = new Map<string, string | null>();

/** Drop every cached extraction. Exported for tests. */
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

/**
 * Convert a binary document to text, capped at `maxChars`. Never throws — see
 * `ExtractionResult` for the ways a document can fail to produce text (OCR for
 * image-only scans is out of scope).
 */
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
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length,
  };
};
