import crypto from "node:crypto";
import { buffer } from "node:stream/consumers";
import type { PlatypusUIMessage } from "../types.ts";
import type { FileExtractionContext } from "./types.ts";
import { getStorage } from "./index.ts";
import { logger } from "../logger.ts";
import { ValidationError } from "../errors.ts";
import {
  assertValidStorageKey,
  chatStorageKeyPrefix,
  type ChatKeyScope,
} from "./keys.ts";
import {
  canonicalStorageKeyFromUrl,
  decodeDataUrl,
  resolvableStorageKeyFromUrl,
  servedUrlForKey,
  storageReferenceUrl,
} from "./file-reference.ts";

const STORABLE_MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/octet-stream": "bin",
};

function extensionForMediaType(mimeType: string): string {
  const extension = STORABLE_MEDIA_TYPE_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) {
    throw new ValidationError(`Unsupported file media type: ${mimeType}`);
  }
  return extension;
}

function generateStorageKey(
  context: FileExtractionContext,
  messageId: string,
  partIndex: number,
  contentHash: string,
  extension: string,
): string {
  const hash8 = contentHash.slice(0, 8);
  const key = `${chatStorageKeyPrefix(context)}${messageId}/${partIndex}-${hash8}.${extension}`;
  assertValidStorageKey(key);
  return key;
}

function hashContent(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function extractFiles(
  messages: PlatypusUIMessage[],
  context: FileExtractionContext,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();

  const processedMessages = await Promise.all(
    messages.map(async (message, messageIndex) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stored jsonb is typed, not validated; an older row may lack parts
      if (!message.parts || !Array.isArray(message.parts)) {
        return message;
      }

      const processedParts = await Promise.all(
        message.parts.map(async (part, partIndex) => {
          if (
            part.type !== "file" ||
            !("url" in part) ||
            typeof part.url !== "string"
          ) {
            return part;
          }

          const parsed = decodeDataUrl(part.url);
          if (!parsed) {
            return part;
          }

          try {
            const { mediaType, bytes } = parsed;
            const buffer = Buffer.from(bytes);
            const contentHash = hashContent(buffer);
            const extension = extensionForMediaType(mediaType);
            const key = generateStorageKey(
              context,
              message.id,
              partIndex,
              contentHash,
              extension,
            );

            await storage.put(key, buffer, mediaType);

            return {
              ...part,
              url: storageReferenceUrl(key),
            };
          } catch (error) {
            logger.error(
              { error, messageIndex, partIndex, context },
              "Failed to store file, leaving data URL as-is",
            );
            return part;
          }
        }),
      );

      return {
        ...message,
        parts: processedParts,
      };
    }),
  );

  return processedMessages;
}

export function rewriteStorageUrls(
  messages: PlatypusUIMessage[],
  baseUrl: string,
): PlatypusUIMessage[] {
  return messages.map((message) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stored jsonb is typed, not validated; an older row may lack parts
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    const processedParts = message.parts.map((part) => {
      if (
        part.type !== "file" ||
        !("url" in part) ||
        typeof part.url !== "string"
      ) {
        return part;
      }

      const key = canonicalStorageKeyFromUrl(part.url);
      if (key === undefined) {
        return part;
      }

      return {
        ...part,
        url: servedUrlForKey(key, baseUrl),
      };
    });

    return {
      ...message,
      parts: processedParts,
    };
  });
}

export const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;

// why: a model fetching a /files/ URL has no session cookie, so the bytes are inlined instead
export async function inlineFileUrls(
  messages: PlatypusUIMessage[],
  backendOrigin: string,
  scope: ChatKeyScope,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();

  return Promise.all(
    messages.map(async (message) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stored jsonb is typed, not validated; an older row may lack parts
      if (!message.parts || !Array.isArray(message.parts)) {
        return message;
      }

      const processedParts = await Promise.all(
        message.parts.map(async (part) => {
          if (
            part.type !== "file" ||
            !("url" in part) ||
            typeof part.url !== "string"
          ) {
            return part;
          }

          const url = part.url;

          const candidate = resolvableStorageKeyFromUrl(url, backendOrigin);
          if (!candidate) {
            return part;
          }

          if (!candidate.valid) {
            logger.warn(
              { key: candidate.key },
              "Rejected invalid storage key during inlining",
            );
            return part;
          }

          if (!candidate.key.startsWith(chatStorageKeyPrefix(scope))) {
            logger.warn(
              { key: candidate.key },
              "Rejected storage key outside this Chat during inlining",
            );
            return part;
          }

          const key = candidate.key;

          try {
            const result = await storage.getStream(key);
            if (!result) {
              logger.warn({ key }, "File not found in storage during inlining");
              return part;
            }

            if (result.contentLength > MAX_INLINE_FILE_BYTES) {
              result.stream.destroy();
              logger.warn(
                { key, size: result.contentLength },
                "File too large to inline, leaving as-is",
              );
              return part;
            }

            const data = await buffer(result.stream);
            const dataUrl = `data:${result.contentType};base64,${data.toString("base64")}`;
            return { ...part, url: dataUrl };
          } catch (error) {
            logger.error(
              { error, key },
              "Failed to inline file URL, leaving as-is",
            );
            return part;
          }
        }),
      );

      return { ...message, parts: processedParts };
    }),
  );
}

// why: call only once the rows are gone; a failure then strands an object, never a row
export async function deleteStoredPrefix(prefix: string): Promise<void> {
  try {
    await getStorage().deletePrefix(prefix);
  } catch (error) {
    logger.error({ error, prefix }, "Failed to delete files from storage");
  }
}
