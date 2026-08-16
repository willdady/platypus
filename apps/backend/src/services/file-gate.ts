import type { PlatypusUIMessage } from "../types.ts";
import { classifyFilePart } from "./file-classification.ts";
import {
  extractDocumentText,
  type ExtractedText,
  type ExtractionResult,
} from "./file-extraction.ts";

/**
 * The pre-persist validation gate and the send-time normalizer (issues #328,
 * #342).
 *
 * The gate (`assertFilePartsSupported`) runs over the whole outgoing message
 * list — fresh upload and history — BEFORE the chat row is persisted, so a turn
 * carrying a file the model can't handle is rejected upfront and writes nothing
 * (it can never brick the chat). The normalizer (`normalizeFileParts`) runs at
 * send time, after file URLs are inlined, and rewrites non-native files into
 * text the model can read: text-like files inline directly, binary documents
 * (PDF/DOCX) are extracted.
 *
 * Kept free of any dependency on chat-execution so it can be imported there
 * without a cycle.
 */

/** A file part in a UI message (the AI SDK's `FileUIPart`). */
type FilePart = {
  type: "file";
  mediaType?: string;
  filename?: string;
  url?: string;
};

const isFilePart = (part: unknown): part is FilePart =>
  typeof part === "object" &&
  part !== null &&
  (part as { type?: unknown }).type === "file";

/**
 * Why a file can't be sent to this model. `unsupported` is a capability verdict
 * (switching model may help); the other two are properties of the file itself
 * (switching model won't), so each gets its own message.
 */
export type FileRejectionReason =
  "unsupported" | Exclude<ExtractionResult["status"], "ok">;

export type FileRejection = { file: string; reason: FileRejectionReason };

/** One sentence naming the files rejected for a single reason. */
const rejectionSentence = (
  reason: FileRejectionReason,
  files: string[],
): string => {
  const list = files.join(", ");
  const one = files.length === 1;
  switch (reason) {
    case "unsupported":
      return one
        ? `This model can't read the attached file "${list}". Remove it, or switch to a model that accepts it.`
        : `This model can't read these attached files: ${list}. Remove them, or switch to a model that accepts them.`;
    case "unextractable":
      return `No readable text could be extracted from ${list} — ${
        one
          ? "it may be a scanned or image-only document"
          : "they may be scanned or image-only documents"
      }. Remove ${one ? "it" : "them"} or attach a text-based version.`;
    case "too-large":
      return `${list} ${one ? "is" : "are"} too large to extract text from. Remove ${
        one ? "it" : "them"
      } or attach a smaller version.`;
  }
};

/**
 * Thrown when an outgoing turn carries a file the target model can't be sent:
 * not ingestible natively, not inlinable as text, and not convertible by
 * extraction. Mapped by the central `onError` (ADR-0010) to a 400 carrying
 * `files`. Defined here rather than in `errors.ts` because its constructor
 * groups `FileRejection`s (a file-domain type) into the message — `errors.ts`
 * imports this class for `mapError`, not the other way around, so there is no
 * cycle to avoid.
 */
export class FileValidationError extends Error {
  /** Offending filenames, in the order they appear in the message list. */
  readonly files: string[];
  readonly rejections: FileRejection[];

  constructor(rejections: FileRejection[]) {
    const byReason = new Map<FileRejectionReason, string[]>();
    for (const { file, reason } of rejections) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), file]);
    }
    super(
      [...byReason]
        .map(([reason, files]) => rejectionSentence(reason, files))
        .join(" "),
    );
    this.name = "FileValidationError";
    this.files = rejections.map((r) => r.file);
    this.rejections = rejections;
  }
}

/** Whether any message carries a file part (cheap short-circuit for the gate). */
export const messagesHaveFileParts = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (message) => Array.isArray(message.parts) && message.parts.some(isFilePart),
  );

/**
 * Reject the turn if any file part can't be turned into something the model can
 * read. Classification itself needs only metadata (extension + declared media
 * type), so it works on history parts that are still just storage references.
 *
 * A document classed `extract` is verified by actually extracting it, but ONLY
 * when the part carries its bytes inline — which is exactly the fresh upload, the
 * one file this turn could newly poison the chat with. A scanned, image-only PDF
 * is therefore rejected here with a 400 and never persisted (issue #342). History
 * parts point at storage, carry no bytes, and were verified the turn they were
 * attached, so they're taken as read rather than re-fetched. Extraction results
 * are content-hash cached, so this parse is the one the send-time normalizer
 * would have done anyway, not an extra one.
 *
 * Throws `FileValidationError` describing every offending file.
 */
export const assertFilePartsSupported = async (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
): Promise<void> => {
  const rejections: FileRejection[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isFilePart(part)) continue;
      const label = part.filename || "attachment";
      const outcome = classifyFilePart(part, passthroughFileTypes);

      if (outcome === "reject") {
        rejections.push({ file: label, reason: "unsupported" });
        continue;
      }
      if (outcome !== "extract") continue;

      const url = typeof part.url === "string" ? part.url : "";
      const bytes = url.startsWith("data:")
        ? decodeDataUrl(url)?.bytes
        : undefined;
      if (!bytes) continue;

      const extracted = await extractDocumentText(bytes, part);
      if (extracted.status !== "ok") {
        rejections.push({ file: label, reason: extracted.status });
      }
    }
  }
  if (rejections.length > 0) {
    throw new FileValidationError(rejections);
  }
};

/** Parse a base64 (or URL-encoded) `data:` URL into its media type and bytes. */
const decodeDataUrl = (
  url: string,
): { mediaType: string; bytes: Uint8Array } | null => {
  const match = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mediaType = match[1] || "application/octet-stream";
  const body = match[3];
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"));
  return { mediaType, bytes };
};

/**
 * Fence `content` so it can't break out of its own block. A file — a Markdown
 * doc especially — may itself contain a run of backticks, so the fence is always
 * one backtick longer than the longest run inside (CommonMark's rule).
 */
const fence = (content: string): string => {
  const longestRun = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}\n${content}\n${ticks}`;
};

/** Wrap decoded file text in a labelled fenced block so the model sees its origin. */
const annotateInlinedText = (
  filename: string | undefined,
  content: string,
): string => `[file: ${filename || "attachment"}]\n\n${fence(content)}`;

/**
 * Wrap text pulled out of a binary document. Annotated distinctly from an
 * inlined text file (issue #342) because the content is lossy — tables, layout
 * and embedded images don't survive — and both the model and the user should be
 * able to tell extracted text from native ingestion. A truncated extraction says
 * so, and how much was dropped, so the model doesn't treat it as the whole
 * document.
 */
const annotateExtractedText = (
  filename: string | undefined,
  extracted: ExtractedText,
): string => {
  const notice = extracted.truncated
    ? `\n\n[extracted text truncated: first ${extracted.text.length} of ${extracted.totalChars} characters]`
    : "";
  return `[extracted text from ${filename || "attachment"}]\n\n${fence(
    extracted.text,
  )}${notice}`;
};

/**
 * A short text stand-in for a file that can't be sent:
 *
 * - `unavailable` — we couldn't load its bytes (a storage miss, or a headless
 *   turn that skipped inlining);
 * - `unextractable` — a document we can normally extract yielded no text (an
 *   image-only scan, or bytes that aren't really that format);
 * - `too-large` — the document exceeded the extractor's input ceiling;
 * - `unsupported` — a binary the model can't ingest slipped past the gate.
 *
 * Either way the part is announced, never forwarded raw.
 */
const omittedFilePlaceholder = (
  filename: string | undefined,
  // The extraction half of this union is derived, so a new `ExtractionResult`
  // status is a type error here instead of a silently missing placeholder.
  reason: "unavailable" | FileRejectionReason,
) => {
  const label = filename || "attachment";
  const text = {
    unavailable: `[file unavailable: ${label}]`,
    unextractable: `[no readable text could be extracted from ${label} — it may be a scanned or image-only document]`,
    "too-large": `[document too large to extract text from: ${label}]`,
    unsupported: `[unsupported file omitted: ${label}]`,
  }[reason];
  return { type: "text" as const, text };
};

/**
 * Rewrite non-native file parts into content the model can read. Runs at send
 * time, after file URLs are inlined (so `data:` bytes are available):
 *
 * - native passthrough → left byte-for-byte unchanged;
 * - text-like → replaced with an annotated text part;
 * - extractable document (PDF/DOCX) → replaced with an annotated, size-capped
 *   extraction (issue #342), or a placeholder when there is no text to pull out;
 * - reject-class → replaced with a short placeholder (defensive: the
 *   pre-persist gate should already have blocked it; never throws here, so a
 *   slipped-through part can't hard-fail conversion and re-brick the chat).
 *
 * Extraction only fires on the non-native branch — a model that lists PDF in its
 * `passthroughFileTypes` still receives the real PDF, never a downgrade.
 *
 * A `storage://` URL (or a missing one) that reaches here never got inlined —
 * a storage miss, or a headless turn with no origin to inline against. The
 * model can't fetch it, so forwarding it raw would hard-fail conversion and
 * re-brick the chat on every history replay (issue #328); it is announced as
 * unavailable instead. External `http(s)` URLs are left alone — a model may
 * still fetch those.
 */
export const normalizeFileParts = async (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
  options: { maxExtractedTextChars?: number } = {},
): Promise<PlatypusUIMessage[]> =>
  Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.parts)) return message;
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (!isFilePart(part)) return part;

          const url = typeof part.url === "string" ? part.url : "";
          const decoded = url.startsWith("data:") ? decodeDataUrl(url) : null;
          const bytes = decoded?.bytes;
          // An internal storage URL that survived inlining is unreachable by
          // the model; a missing URL likewise has nothing to send.
          const unfetchable = url === "" || url.startsWith("storage://");

          const outcome = classifyFilePart(part, passthroughFileTypes, bytes);

          if (outcome === "passthrough") {
            return unfetchable
              ? omittedFilePlaceholder(part.filename, "unavailable")
              : part;
          }

          if (outcome === "text") {
            if (!bytes)
              return omittedFilePlaceholder(part.filename, "unavailable");
            const content = new TextDecoder().decode(bytes);
            return {
              type: "text" as const,
              text: annotateInlinedText(part.filename, content),
            };
          }

          if (outcome === "extract") {
            if (!bytes)
              return omittedFilePlaceholder(part.filename, "unavailable");
            const extracted = await extractDocumentText(bytes, part, {
              maxChars: options.maxExtractedTextChars,
            });
            if (extracted.status !== "ok")
              return omittedFilePlaceholder(part.filename, extracted.status);
            return {
              type: "text" as const,
              text: annotateExtractedText(part.filename, extracted),
            };
          }

          return omittedFilePlaceholder(part.filename, "unsupported");
        }),
      );
      return { ...message, parts };
    }),
  );
