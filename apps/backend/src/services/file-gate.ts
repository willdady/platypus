import type { PlatypusUIMessage } from "../types.ts";
import { classifyFilePart } from "./file-classification.ts";

/**
 * The pre-persist validation gate and the send-time normalizer (issue #328).
 *
 * The gate (`assertFilePartsSupported`) runs over the whole outgoing message
 * list — fresh upload and history — BEFORE the chat row is persisted, so a turn
 * carrying a file the model can't handle is rejected upfront and writes nothing
 * (it can never brick the chat). The normalizer (`normalizeFileParts`) runs at
 * send time, after file URLs are inlined, and rewrites non-native text-like
 * files into text the model can read.
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
 * Thrown when an outgoing turn carries a file the target model can neither
 * ingest natively nor have inlined as text. The route maps it to a 400 with a
 * message naming the offending file(s). A standalone error (not a subclass of
 * chat-execution's `ValidationError`) to avoid an import cycle — callers match
 * on it explicitly.
 */
export class FileValidationError extends Error {
  readonly files: string[];

  constructor(files: string[]) {
    const list = files.join(", ");
    super(
      files.length === 1
        ? `This model can't read the attached file "${list}". Remove it, or switch to a model that accepts it.`
        : `This model can't read these attached files: ${list}. Remove them, or switch to a model that accepts them.`,
    );
    this.name = "FileValidationError";
    this.files = files;
  }
}

/** Whether any message carries a file part (cheap short-circuit for the gate). */
export const messagesHaveFileParts = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (message) => Array.isArray(message.parts) && message.parts.some(isFilePart),
  );

/**
 * Reject the turn if any file part is neither natively accepted nor text-like.
 * Classifies on metadata alone (extension + declared media type) — no bytes
 * required — so it can run before persistence. Throws `FileValidationError`
 * listing every offending file.
 */
export const assertFilePartsSupported = (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
): void => {
  const offending: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isFilePart(part)) continue;
      if (classifyFilePart(part, passthroughFileTypes) === "reject") {
        offending.push(part.filename || "attachment");
      }
    }
  }
  if (offending.length > 0) {
    throw new FileValidationError(offending);
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

/** Wrap decoded file text in a labelled fenced block so the model sees its origin. */
const annotateInlinedText = (
  filename: string | undefined,
  content: string,
): string => {
  const label = filename || "attachment";
  return `[file: ${label}]\n\n\`\`\`\n${content}\n\`\`\``;
};

/**
 * Rewrite non-native file parts into content the model can read. Runs at send
 * time, after file URLs are inlined (so `data:` bytes are available):
 *
 * - native passthrough → left byte-for-byte unchanged;
 * - text-like → replaced with an annotated text part;
 * - reject-class → replaced with a short placeholder (defensive: the
 *   pre-persist gate should already have blocked it; never throws here, so a
 *   slipped-through part can't hard-fail conversion and re-brick the chat).
 *
 * A part whose bytes aren't available (e.g. a storage miss left it non-`data:`)
 * is left unchanged.
 */
export const normalizeFileParts = (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
): PlatypusUIMessage[] =>
  messages.map((message) => {
    if (!Array.isArray(message.parts)) return message;
    const parts = message.parts.map((part) => {
      if (!isFilePart(part)) return part;

      const url = typeof part.url === "string" ? part.url : "";
      const decoded = url.startsWith("data:") ? decodeDataUrl(url) : null;
      const bytes = decoded?.bytes;

      const outcome = classifyFilePart(part, passthroughFileTypes, bytes);
      if (outcome === "passthrough") return part;

      if (outcome === "text") {
        if (!bytes) return part;
        const content = new TextDecoder().decode(bytes);
        return {
          type: "text" as const,
          text: annotateInlinedText(part.filename, content),
        };
      }

      return {
        type: "text" as const,
        text: `[unsupported file omitted: ${part.filename || "attachment"}]`,
      };
    });
    return { ...message, parts };
  });
