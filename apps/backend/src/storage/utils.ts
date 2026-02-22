import crypto from "node:crypto";
import type { PlatypusUIMessage } from "../types.ts";
import type { FileExtractionContext } from "./types.ts";
import { getStorage } from "./index.ts";
import { logger } from "../logger.ts";

/**
 * Storage URL prefix used to identify storage references.
 */
export const STORAGE_URL_PREFIX = "storage://";

/**
 * Extract the file extension from a MIME type.
 */
function getExtensionFromMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
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
  };
  return extensions[mimeType] || "bin";
}

/**
 * Generate a storage key for a file.
 * Format: {orgId}/{workspaceId}/{chatId}/{messageId}/{partIndex}-{hash8}.{ext}
 */
function generateStorageKey(
  context: FileExtractionContext,
  partIndex: number,
  contentHash: string,
  extension: string,
): string {
  const hash8 = contentHash.slice(0, 8);
  const messageId = context.messageId || "unknown";
  return `${context.orgId}/${context.workspaceId}/${context.chatId}/${messageId}/${partIndex}-${hash8}.${extension}`;
}

/**
 * Compute SHA-256 hash of binary content and return as hex string.
 */
function hashContent(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Parse a data URL and extract its components.
 * Returns null if not a valid data URL.
 */
function parseDataUrl(
  url: string,
): { mimeType: string; base64Data: string } | null {
  const match = url.match(/^data:([^;,]+)(;base64)?,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, , base64Data] = match;
  if (!match[2]) {
    // Not base64 encoded - we don't support URL-encoded data
    return null;
  }

  return { mimeType, base64Data };
}

/**
 * Extract files from messages, store them via the storage backend,
 * and replace data URLs with storage:// URLs.
 *
 * On storage failure, leaves the data URL as-is and logs the error.
 *
 * @param messages - Array of chat messages with parts
 * @param context - Context for generating storage keys (org, workspace, chat IDs)
 * @returns Modified messages with data URLs replaced by storage:// URLs
 */
export async function extractFiles(
  messages: PlatypusUIMessage[],
  context: FileExtractionContext,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();

  const processedMessages = await Promise.all(
    messages.map(async (message, messageIndex) => {
      if (!message.parts || !Array.isArray(message.parts)) {
        return message;
      }

      const processedParts = await Promise.all(
        message.parts.map(async (part, partIndex) => {
          // Check if this is a file part with a data URL
          if (
            part.type !== "file" ||
            !("url" in part) ||
            typeof part.url !== "string"
          ) {
            return part;
          }

          const url = part.url;
          if (!url.startsWith("data:")) {
            return part;
          }

          const parsed = parseDataUrl(url);
          if (!parsed) {
            return part;
          }

          try {
            const { mimeType, base64Data } = parsed;
            const buffer = Buffer.from(base64Data, "base64");
            const contentHash = hashContent(buffer);
            const extension = getExtensionFromMimeType(mimeType);
            const key = generateStorageKey(
              { ...context, messageId: message.id },
              partIndex,
              contentHash,
              extension,
            );

            await storage.put(key, buffer, mimeType);

            // Replace the data URL with storage:// URL
            return {
              ...part,
              url: `${STORAGE_URL_PREFIX}${key}`,
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

/**
 * Rewrite storage:// URLs to HTTP URLs for serving.
 *
 * If STORAGE_PUBLIC_URL is set, URLs are rewritten to that base.
 * Otherwise, URLs are rewritten to the /files/{key} endpoint.
 *
 * @param messages - Array of chat messages with parts
 * @param baseUrl - The base URL of the backend server
 * @returns Modified messages with storage:// URLs replaced by HTTP URLs
 */
export function rewriteStorageUrls(
  messages: PlatypusUIMessage[],
  baseUrl: string,
): PlatypusUIMessage[] {
  const publicUrl = process.env.STORAGE_PUBLIC_URL;
  const filesBaseUrl = publicUrl || `${baseUrl}/files`;

  return messages.map((message) => {
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

      const url = part.url;
      if (!url.startsWith(STORAGE_URL_PREFIX)) {
        return part;
      }

      const key = url.slice(STORAGE_URL_PREFIX.length);
      return {
        ...part,
        url: `${filesBaseUrl}/${key}`,
      };
    });

    return {
      ...message,
      parts: processedParts,
    };
  });
}

/**
 * Extract all storage:// keys from messages.
 * Useful for cleanup operations (e.g., when deleting a chat).
 *
 * @param messages - Array of chat messages
 * @returns Array of storage keys found in the messages
 */
export function extractStorageKeys(messages: PlatypusUIMessage[]): string[] {
  const keys: string[] = [];

  for (const message of messages) {
    if (!message.parts || !Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts) {
      if (
        part.type === "file" &&
        "url" in part &&
        typeof part.url === "string" &&
        part.url.startsWith(STORAGE_URL_PREFIX)
      ) {
        keys.push(part.url.slice(STORAGE_URL_PREFIX.length));
      }
    }
  }

  return keys;
}

/**
 * Delete all files associated with a chat's messages.
 * Best-effort operation - errors are logged but don't fail the operation.
 *
 * @param messages - Array of chat messages
 */
export async function deleteFiles(
  messages: PlatypusUIMessage[],
): Promise<void> {
  const keys = extractStorageKeys(messages);
  if (keys.length === 0) {
    return;
  }

  const storage = getStorage();

  await Promise.all(
    keys.map(async (key) => {
      try {
        await storage.delete(key);
      } catch (error) {
        logger.error({ error, key }, "Failed to delete file from storage");
      }
    }),
  );

  logger.info({ count: keys.length }, "Deleted files from storage");
}
