import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import { classifyFilePart } from "./file-classification.ts";
import {
  extractDocumentText,
  type ExtractedText,
  type ExtractionResult,
} from "./file-extraction.ts";
import {
  decodeDataUrl,
  isUnresolvedReference,
} from "../storage/file-reference.ts";

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

type FileRejectionReason =
  "unsupported" | Exclude<ExtractionResult["status"], "ok">;

export type FileRejection = { file: string; reason: FileRejectionReason };

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

export class FileValidationError extends Error {
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

export const messagesHaveFileParts = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (message) => Array.isArray(message.parts) && message.parts.some(isFilePart),
  );

export const assertFilePartsSupported = async (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
): Promise<void> => {
  const rejections: FileRejection[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isFilePart(part)) continue;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty filename is labelled too
      const label = part.filename || "attachment";
      const outcome = classifyFilePart(part, passthroughFileTypes);

      if (outcome === "reject") {
        rejections.push({ file: label, reason: "unsupported" });
        continue;
      }
      if (outcome !== "extract") continue;

      const url = typeof part.url === "string" ? part.url : "";
      const bytes = decodeDataUrl(url)?.bytes;
      if (!bytes) continue;

      const extracted = await extractDocumentText(bytes, part, {
        maxChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
      });
      if (extracted.status !== "ok") {
        rejections.push({ file: label, reason: extracted.status });
      }
    }
  }
  if (rejections.length > 0) {
    throw new FileValidationError(rejections);
  }
};

const fence = (content: string): string => {
  const longestRun = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}\n${content}\n${ticks}`;
};

const annotateInlinedText = (
  filename: string | undefined,
  content: string,
): string => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty filename is labelled too
  const label = filename || "attachment";
  return `[file: ${label}]\n\n${fence(content)}`;
};

const annotateExtractedText = (
  filename: string | undefined,
  extracted: ExtractedText,
): string => {
  const notice = extracted.truncated
    ? `\n\n[extracted text truncated: first ${extracted.text.length} of ${extracted.totalChars} characters]`
    : "";
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty filename is labelled too
  return `[extracted text from ${filename || "attachment"}]\n\n${fence(
    extracted.text,
  )}${notice}`;
};

const omittedFilePlaceholder = (
  filename: string | undefined,
  reason: "unavailable" | FileRejectionReason,
) => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty filename is labelled too
  const label = filename || "attachment";
  const text = {
    unavailable: `[file unavailable: ${label}]`,
    unextractable: `[no readable text could be extracted from ${label} — it may be a scanned or image-only document]`,
    "too-large": `[document too large to extract text from: ${label}]`,
    unsupported: `[unsupported file omitted: ${label}]`,
  }[reason];
  return { type: "text" as const, text };
};

export const fileTextForModel = async (
  bytes: Uint8Array,
  file: { mediaType?: string; filename?: string },
  outcome: "text" | "extract",
  options: { maxExtractedTextChars: number },
): Promise<string> => {
  if (outcome === "text") {
    return annotateInlinedText(file.filename, new TextDecoder().decode(bytes));
  }
  const extracted = await extractDocumentText(bytes, file, {
    maxChars: options.maxExtractedTextChars,
  });
  return extracted.status === "ok"
    ? annotateExtractedText(file.filename, extracted)
    : omittedFilePlaceholder(file.filename, extracted.status).text;
};

export const normalizeFileParts = async (
  messages: PlatypusUIMessage[],
  passthroughFileTypes: string[],
  options: { maxExtractedTextChars: number },
): Promise<PlatypusUIMessage[]> =>
  Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.parts)) return message;
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (!isFilePart(part)) return part;

          const url = typeof part.url === "string" ? part.url : "";
          const bytes = decodeDataUrl(url)?.bytes;
          const unfetchable = isUnresolvedReference(url);

          const outcome = classifyFilePart(part, passthroughFileTypes, bytes);

          if (outcome === "passthrough") {
            return unfetchable
              ? omittedFilePlaceholder(part.filename, "unavailable")
              : part;
          }

          if (outcome === "text" || outcome === "extract") {
            if (!bytes)
              return omittedFilePlaceholder(part.filename, "unavailable");
            return {
              type: "text" as const,
              text: await fileTextForModel(bytes, part, outcome, options),
            };
          }

          return omittedFilePlaceholder(part.filename, "unsupported");
        }),
      );
      return { ...message, parts };
    }),
  );
